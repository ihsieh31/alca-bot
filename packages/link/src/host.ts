// The core's side of Alca Link. It connects OUT to a relay (no inbound port
// on the user's machine), proves it owns its mailbox, opens pairing codes on
// request, and turns every authenticated device connection into a LinkPeer.
// A LAN listener can hand it direct wires too (`acceptWire`).

import { FIRST_RETRY_MS, jittered, MAX_RETRY_MS, nextRetry } from "./backoff.ts";
import { fromB64u, toB64u } from "./bytes.ts";
import { type EnrollHandler, enrollAsCore } from "./enroll.ts";
import { LinkError } from "./errors.ts";
import {
  type DeviceKind,
  formatCode,
  newSecret,
  type PairedDevice,
  pairAsCore,
  sendSealed,
  sessionAsCore,
} from "./handshake.ts";
import { fingerprint, type Identity, mailboxOf, sign } from "./identity.ts";
import { coreAuthPayload, RELAY_VERSION, relayWsUrl } from "./relay-protocol.ts";
import { LinkPeer } from "./rpc.ts";
import { defaultWebSocket, probeRelay, type WebSocketCtor, type WebSocketLike } from "./transport.ts";
import { QueueWire, type Wire, type WireMessage } from "./wire.ts";

export interface DeviceRecord {
  id: string;
  name: string;
  kind: DeviceKind;
  publicRaw: Uint8Array;
  scopes: string[];
  revoked: boolean;
}

export interface DeviceDirectory {
  get(id: string): DeviceRecord | undefined;
  add(d: PairedDevice, scopes: string[]): DeviceRecord;
  seen(id: string): void;
}

export interface HostSession {
  device: DeviceRecord;
  peer: LinkPeer;
  via: "relay" | "lan" | "rtc";
  connectedAt: string;
}

export interface Pairing {
  /** Digits only, e.g. `381204957`. */
  code: string;
  /** Display form, e.g. `381-204-957`. */
  display: string;
  nameplate: string;
  expiresAt: string;
  scopes: string[];
  relayUrl: string;
  coreFingerprint: string;
}

export type PairingOutcome =
  | { nameplate: string; ok: true; device: DeviceRecord; pake?: number }
  | { nameplate: string; ok: false; error: string; attemptsLeft?: number; pake?: number };

/** G1: which PAKE version a pairing or enrollment ran, and how it ended (audit log / UI). */
export interface PakeEvent {
  flow: "pair" | "enroll";
  /** 2 = RFC 9382 with key confirmation; 0 = refused before any PAKE (a v1-only peer: `upgrade_required`). */
  version: number;
  ok: boolean;
  error?: string;
  deviceName?: string;
}

export interface LinkHostOptions {
  relayUrl: string;
  identity: Identity;
  coreName: string;
  devices: DeviceDirectory;
  /** Called for every authenticated session before it starts reading: set handlers here. */
  onSession(s: HostSession): void;
  /** Extra fields in the `ready` message (e.g. LAN addresses). */
  readyInfo?: (d: DeviceRecord) => Record<string, unknown>;
  WebSocketImpl?: WebSocketCtor;
  log?: (msg: string) => void;
  /** Reconnect delays in ms (default 250 ms doubling to 30 s, each ±20 %). */
  backoff?: { first: number; max: number };
  /**
   * Connections one pairing code allows that dropped before any PAKE started
   * (default 5). G1: once a device has sent its share, any failure burns the
   * code (a wrong code is one online guess, never two); success always does.
   */
  pairingMaxAttempts?: number;
  /** G1: every pairing / enrollment that reached a PAKE (or was refused for its version). */
  onPake?: (e: PakeEvent) => void;
  /** Reachability self-check period in ms (default 15 min; 0 = off). */
  selfCheckMs?: number;
  /**
   * P10/P12: a device signed in with this computer's Google account wants to
   * enroll: called once per channel for the handler that asks the person for
   * the code shown on the phone and stores the device. Unset = refused.
   */
  onEnroll?: () => EnrollHandler;
  /** Other ways a paired device can reach this core, told to it in `ready` and on change. */
  endpoints?: () => { relays?: string[]; direct?: string[] };
}

/** The core's own view of whether devices can reach it (shown in 連線 / 診斷). */
export interface LinkHealth {
  lastCheckAt: string | null;
  ok: boolean | null;
  /** Why the last check failed: offline, no_pong, not_listed, probe_failed. */
  reason: string;
  repairs: number;
  lastRepairAt: string | null;
  onlineSince: string | null;
}

export type HostStatus = "offline" | "connecting" | "online" | "closed";

interface PendingPairing extends Pairing {
  secret: string;
  timer: ReturnType<typeof setTimeout>;
  attempts: number;
  /** A device is pairing on this code right now. */
  busy: boolean;
}

export class LinkHost {
  relayUrl: string;
  mailbox = "";
  coreFingerprint = "";
  private ws: WebSocketLike | undefined;
  private state: HostStatus = "offline";
  private channels = new Map<string, QueueWire>();
  private pairings = new Map<string, PendingPairing>();
  private waitingNameplates = new Map<number, (m: WireMessage) => void>();
  private live = new Set<HostSession>();
  private statusHandlers: Array<(s: HostStatus) => void> = [];
  private pairingHandlers: Array<(p: PairingOutcome) => void> = [];
  private retryMs: number;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private nextReq = 1;
  private readyWaiters: Array<() => void> = [];
  private pongWaiters: Array<() => void> = [];
  private checkTimer: ReturnType<typeof setInterval> | undefined;
  readonly health: LinkHealth = {
    lastCheckAt: null,
    ok: null,
    reason: "",
    repairs: 0,
    lastRepairAt: null,
    onlineSince: null,
  };

  private readonly o: LinkHostOptions;

  constructor(o: LinkHostOptions) {
    this.o = o;
    this.relayUrl = relayWsUrl(o.relayUrl);
    this.retryMs = o.backoff?.first ?? FIRST_RETRY_MS;
  }

  get status(): HostStatus {
    return this.state;
  }

  onStatus(h: (s: HostStatus) => void): () => void {
    this.statusHandlers.push(h);
    return () => {
      this.statusHandlers = this.statusHandlers.filter((x) => x !== h);
    };
  }

  onPairing(h: (p: PairingOutcome) => void): () => void {
    this.pairingHandlers.push(h);
    return () => {
      this.pairingHandlers = this.pairingHandlers.filter((x) => x !== h);
    };
  }

  /** Connect to the relay (and keep reconnecting). Resolves once online or after `waitMs`. */
  async start(waitMs = 5000): Promise<void> {
    this.mailbox = await mailboxOf(this.o.identity.publicRaw);
    this.coreFingerprint = await fingerprint(this.o.identity.publicRaw);
    this.connect();
    const every = this.o.selfCheckMs ?? 15 * 60_000;
    if (every > 0) {
      this.checkTimer = setInterval(() => void this.selfCheck(), every);
      this.checkTimer.unref?.();
    }
    await this.whenOnline(waitMs).catch(() => undefined);
  }

  /** Every address a paired device may use for this core: this relay first. */
  endpoints(): { relays: string[]; direct: string[] } {
    const e = this.o.endpoints?.() ?? {};
    const relays = [this.relayUrl];
    for (const r of e.relays ?? []) {
      try {
        const u = relayWsUrl(r);
        if (!relays.includes(u)) relays.push(u);
      } catch {
        /* not a relay URL */
      }
    }
    return { relays, direct: [...new Set(e.direct ?? [])] };
  }

  /** Tell every live device where this core can be reached (after a settings change). */
  announceEndpoints(): void {
    const e = this.endpoints();
    for (const s of this.live) s.peer.emit("link", { type: "endpoints", ...e });
  }

  /**
   * Move to another relay without re-pairing anyone: live devices hear the
   * new address first (while the old path still works), then the core
   * re-registers there. Devices that were away try every relay they know.
   */
  async setRelayUrl(url: string, waitMs = 5000): Promise<void> {
    const next = relayWsUrl(url);
    if (next === this.relayUrl) return;
    const before = this.relayUrl;
    this.relayUrl = next;
    const e = this.endpoints();
    if (!e.relays.includes(before)) e.relays.push(before);
    // Seal and send the new list before the old path goes away.
    await Promise.race([
      Promise.all([...this.live].map((s) => s.peer.notify("link", { type: "endpoints", ...e }))),
      new Promise((r) => setTimeout(r, 2000)),
    ]);
    await new Promise((r) => setTimeout(r, 50));
    this.repair("relay_changed", false);
    await this.whenOnline(waitMs).catch(() => undefined);
  }

  /**
   * Can a device reach us? The relay socket must answer a ping, and the relay
   * must list our mailbox to an outside probe. Anything else: re-register now
   * (a half-open socket after a relay restart, a relay that lost us).
   */
  async selfCheck(timeoutMs = 10_000): Promise<LinkHealth> {
    if (this.state === "closed") return this.health;
    let reason = "";
    if (this.state !== "online" || !this.ws) reason = "offline";
    else if (!(await this.pingRelay(timeoutMs))) reason = "no_pong";
    else {
      const listed = await probeRelay(this.relayUrl, this.mailbox, {
        timeoutMs,
        ...(this.o.WebSocketImpl ? { WebSocketImpl: this.o.WebSocketImpl } : {}),
      });
      if (listed === false) reason = "not_listed";
      else if (listed === undefined) reason = "probe_failed";
    }
    this.health.lastCheckAt = new Date().toISOString();
    this.health.ok = !reason;
    this.health.reason = reason;
    if (reason) {
      this.o.log?.(`link: self-check failed (${reason}); re-registering`);
      this.repair(reason, true);
    }
    return this.health;
  }

  private pingRelay(timeoutMs: number): Promise<boolean> {
    const ws = this.ws;
    if (!ws) return Promise.resolve(false);
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.pongWaiters = this.pongWaiters.filter((w) => w !== done);
        resolve(false);
      }, timeoutMs);
      const done = () => {
        clearTimeout(t);
        resolve(true);
      };
      this.pongWaiters.push(done);
      try {
        ws.send(JSON.stringify({ op: "ping" }));
      } catch {
        clearTimeout(t);
        resolve(false);
      }
    });
  }

  /** Drop the relay socket (whatever state it is in) and register again at once. */
  private repair(_why: string, count: boolean) {
    if (this.state === "closed") return;
    if (count) {
      this.health.repairs++;
      this.health.lastRepairAt = new Date().toISOString();
    }
    const ws = this.ws;
    if (ws) {
      this.dropped(ws);
      try {
        ws.close(1000, "re-register");
      } catch {
        /* already gone */
      }
    }
    clearTimeout(this.retryTimer);
    this.retryMs = this.o.backoff?.first ?? FIRST_RETRY_MS;
    this.connect();
  }

  whenOnline(timeoutMs = 5000): Promise<void> {
    if (this.state === "online") return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new LinkError("timeout", "relay not reachable")), timeoutMs);
      this.readyWaiters.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  sessions(deviceId?: string): HostSession[] {
    return [...this.live].filter((s) => !deviceId || s.device.id === deviceId);
  }

  /** Relay socket is backed up (drop optional traffic such as video frames). */
  congested(): boolean {
    return (this.ws?.bufferedAmount ?? 0) > 768 * 1024;
  }

  /** One request to the relay that answers with the same `req` (nameplates, P10 registration). */
  private ask(m: Record<string, unknown>, timeoutMs = 10_000): Promise<WireMessage> {
    if (this.state !== "online" || !this.ws)
      return Promise.reject(new LinkError("offline", "not connected to the relay"));
    const req = this.nextReq++;
    const answer = new Promise<WireMessage>((resolve, reject) => {
      const t = setTimeout(() => {
        this.waitingNameplates.delete(req);
        reject(new LinkError("timeout", "the relay did not answer"));
      }, timeoutMs);
      this.waitingNameplates.set(req, (r) => {
        clearTimeout(t);
        resolve(r);
      });
    });
    this.ws.send(JSON.stringify({ ...m, req }));
    return answer;
  }

  /**
   * P10: list this computer under the Google account of `idToken` on the
   * relay (the relay keeps only a keyed hash of the account id). The token
   * is used once here and not kept.
   */
  async registerComputer(idToken: string, name: string): Promise<{ mailbox: string; fingerprint: string }> {
    const m = await this.ask({ op: "computer.register", idToken, name: name.slice(0, 60) }, 20_000);
    if (m.op === "error") {
      const code = String(m.code);
      throw new LinkError(code === "bad_token" ? "bad_token" : "relay", String(m.message ?? code));
    }
    return { mailbox: String(m.mailbox), fingerprint: String(m.fingerprint) };
  }

  /** P10: take this computer off its Google account's list (signed-in phones keep working by key). */
  async unregisterComputer(): Promise<void> {
    const m = await this.ask({ op: "computer.unregister" });
    if (m.op === "error") throw new LinkError("relay", String(m.message ?? m.code));
  }

  /** Open a single-use pairing code on the relay. */
  async createPairing(o: { scopes: string[]; ttlSec?: number }): Promise<Pairing> {
    if (this.state !== "online" || !this.ws) throw new LinkError("offline", "not connected to the relay");
    const req = this.nextReq++;
    const ttlSec = o.ttlSec ?? 120;
    const answer = new Promise<WireMessage>((resolve, reject) => {
      const t = setTimeout(() => {
        this.waitingNameplates.delete(req);
        reject(new LinkError("timeout", "relay did not open a code"));
      }, 5000);
      this.waitingNameplates.set(req, (m) => {
        clearTimeout(t);
        resolve(m);
      });
    });
    this.ws.send(JSON.stringify({ op: "nameplate.open", ttlSec, req }));
    const m = await answer;
    if (m.op === "error") throw new LinkError("relay", String(m.message ?? m.code));
    const nameplate = String(m.nameplate);
    const secret = newSecret();
    const p: PendingPairing = {
      code: `${nameplate}${secret}`,
      display: formatCode({ nameplate, secret }),
      nameplate,
      secret,
      expiresAt: String(m.expiresAt),
      scopes: o.scopes,
      relayUrl: this.relayUrl,
      coreFingerprint: this.coreFingerprint,
      timer: setTimeout(() => this.cancelPairing(nameplate, "expired"), ttlSec * 1000),
      attempts: 0,
      busy: false,
    };
    p.timer.unref?.();
    this.pairings.set(nameplate, p);
    const { secret: _s, timer: _t, attempts: _a, busy: _b, ...pub } = p;
    return pub;
  }

  cancelPairing(nameplate: string, why = "cancelled"): void {
    const p = this.pairings.get(nameplate);
    if (!p) return;
    clearTimeout(p.timer);
    this.pairings.delete(nameplate);
    this.ws?.send(JSON.stringify({ op: "nameplate.close", nameplate }));
    this.emitPairing({ nameplate, ok: false, error: why });
  }

  /** End every live session of a device now (after the directory marked it revoked). */
  disconnect(deviceId: string, reason = "revoked"): void {
    for (const s of this.sessions(deviceId)) s.peer.close(reason);
  }

  /** Run the session handshake on an incoming wire (relay dial or LAN). */
  async acceptWire(wire: Wire, via: "relay" | "lan" | "rtc"): Promise<HostSession | undefined> {
    try {
      const { channel, deviceId } = await sessionAsCore(wire, {
        identity: this.o.identity,
        mailbox: this.mailbox,
        lookup: (id) => {
          const d = this.o.devices.get(id);
          if (!d) return undefined;
          return d.revoked ? "revoked" : { publicRaw: d.publicRaw };
        },
      });
      // Re-read after the handshake: a revoke during it must win.
      const device = this.o.devices.get(deviceId);
      if (!device || device.revoked) {
        wire.close("revoked");
        return undefined;
      }
      const peer = new LinkPeer(wire, channel);
      const s: HostSession = { device, peer, via, connectedAt: new Date().toISOString() };
      this.live.add(s);
      peer.onClose(() => {
        this.live.delete(s);
        this.o.devices.seen(device.id);
      });
      this.o.devices.seen(device.id);
      // `ready` is the first sealed frame; anything onSession sends comes after it.
      await sendSealed(wire, channel, {
        k: "ready",
        deviceId: device.id,
        name: device.name,
        kind: device.kind,
        scopes: device.scopes,
        coreName: this.o.coreName,
        ...this.endpoints(),
        ...this.o.readyInfo?.(device),
      });
      this.o.onSession(s);
      peer.start();
      return s;
    } catch (e) {
      this.o.log?.(`link: session refused (${e instanceof LinkError ? e.code : "error"})`);
      wire.close("refused");
      return undefined;
    }
  }

  async close(): Promise<void> {
    this.state = "closed";
    clearTimeout(this.retryTimer);
    clearInterval(this.checkTimer);
    for (const s of this.live) s.peer.close("core shutting down");
    for (const p of this.pairings.values()) clearTimeout(p.timer);
    this.pairings.clear();
    this.ws?.close(1000, "bye");
    this.ws = undefined;
  }

  // ── relay connection ────────────────────────────────────────────────

  private setStatus(s: HostStatus) {
    if (this.state === "closed") return;
    this.state = s;
    for (const h of this.statusHandlers) h(s);
    if (s === "online") {
      this.health.onlineSince = new Date().toISOString();
      for (const w of this.readyWaiters.splice(0)) w();
    } else this.health.onlineSince = null;
  }

  private connect() {
    if (this.state === "closed") return;
    this.setStatus("connecting");
    const W = this.o.WebSocketImpl ?? defaultWebSocket();
    let ws: WebSocketLike;
    try {
      ws = new W(this.relayUrl);
    } catch {
      return this.retry();
    }
    this.ws = ws;
    ws.addEventListener("open", () =>
      ws.send(JSON.stringify({ op: "core.hello", v: RELAY_VERSION, pub: toB64u(this.o.identity.publicRaw) })),
    );
    ws.addEventListener("message", (ev) => {
      let m: WireMessage;
      try {
        m = JSON.parse(String(ev.data)) as WireMessage;
      } catch {
        return;
      }
      void this.onRelay(ws, m);
    });
    ws.addEventListener("close", () => {
      if (this.ws !== ws) return;
      this.dropped(ws);
      if (this.state !== "closed") this.retry();
    });
    ws.addEventListener("error", () => undefined);
  }

  /** Forget everything that lived on this relay socket. */
  private dropped(ws: WebSocketLike) {
    if (this.ws !== ws) return;
    this.ws = undefined;
    for (const w of this.channels.values()) w.end("relay connection lost");
    this.channels.clear();
    for (const n of [...this.pairings.keys()]) this.cancelPairing(n, "relay connection lost");
    this.pongWaiters = [];
    if (this.state !== "closed") this.setStatus("offline");
  }

  private retry() {
    if (this.state === "closed") return;
    clearTimeout(this.retryTimer);
    // PERF-2026-11: ±20 % jitter like the client (cores behind one relay restart
    // do not all come back in the same instant), and a short first retry: the
    // phone cannot be online before the core is, so the core's first wait is
    // every phone's reconnect floor.
    this.retryTimer = setTimeout(() => this.connect(), jittered(this.retryMs));
    this.retryTimer.unref?.();
    this.retryMs = nextRetry(this.retryMs, this.o.backoff?.max ?? MAX_RETRY_MS);
  }

  private async onRelay(ws: WebSocketLike, m: WireMessage) {
    switch (m.op) {
      case "challenge": {
        const sig = await sign(this.o.identity, coreAuthPayload(fromB64u(String(m.nonce))));
        ws.send(JSON.stringify({ op: "core.auth", sig: toB64u(sig) }));
        return;
      }
      case "core.ready":
        this.retryMs = this.o.backoff?.first ?? FIRST_RETRY_MS;
        if (m.mailbox !== this.mailbox) this.o.log?.("link: relay reported another mailbox");
        return this.setStatus("online");
      case "nameplate":
      case "computer.registered":
      case "computer.unregistered":
      case "error": {
        const w = typeof m.req === "number" ? this.waitingNameplates.get(m.req) : undefined;
        if (w) {
          this.waitingNameplates.delete(m.req as number);
          return w(m);
        }
        if (m.op === "error") this.o.log?.(`link: relay error ${String(m.code)}`);
        return;
      }
      case "pong":
        for (const w of this.pongWaiters.splice(0)) w();
        return;
      case "ch.open":
        return this.openChannel(ws, m);
      case "ch.msg": {
        const w = this.channels.get(String(m.ch));
        if (w && m.d && typeof m.d === "object") w.push(m.d as WireMessage);
        return;
      }
      case "ch.closed": {
        const id = String(m.ch);
        this.channels.get(id)?.end("peer left");
        this.channels.delete(id);
        return;
      }
    }
  }

  private openChannel(ws: WebSocketLike, m: WireMessage) {
    const ch = String(m.ch);
    const wire = new QueueWire(
      (d) => ws.send(JSON.stringify({ op: "ch.msg", ch, d })),
      () => {
        this.channels.delete(ch);
        ws.send(JSON.stringify({ op: "ch.close", ch }));
      },
    );
    this.channels.set(ch, wire);
    if (m.via === "dial") return void this.acceptWire(wire, "relay");
    if (m.via === "connect") return void this.enroll(wire);
    const nameplate = String(m.nameplate ?? "");
    const p = this.pairings.get(nameplate);
    if (!p || p.busy) return wire.close("no such pairing");
    // One device at a time on a code. Success spends it; so does any failure
    // once a share arrived (G1: a code is verified at most once). A connection
    // that dropped before that reopens it, up to `pairingMaxAttempts`.
    p.busy = true;
    p.attempts++;
    let accepted: DeviceRecord | undefined;
    let pake: number | undefined;
    pairAsCore(wire, {
      code: { nameplate, secret: p.secret },
      identity: this.o.identity,
      coreName: this.o.coreName,
      onPake: (v) => {
        pake = v;
      },
      accept: async (d) => {
        const rec = this.o.devices.add(d, d.kind === "hands" ? ["hands"] : p.scopes);
        accepted = rec;
        return { deviceId: rec.id, scopes: rec.scopes, mailbox: this.mailbox };
      },
    }).then(
      (d) => {
        this.spend(nameplate, p);
        this.o.onPake?.({ flow: "pair", version: d.pake, ok: true, deviceName: d.name });
        if (accepted) this.emitPairing({ nameplate, ok: true, device: accepted, pake: d.pake });
      },
      (e: unknown) => {
        const code = e instanceof LinkError ? e.code : "failed";
        const v = pake !== undefined ? { pake } : {};
        if (pake !== undefined || code === "upgrade_required")
          this.o.onPake?.({ flow: "pair", version: pake ?? 0, ok: false, error: code });
        if (this.pairings.get(nameplate) !== p) return;
        const left = (this.o.pairingMaxAttempts ?? 5) - p.attempts;
        // Burned: a PAKE ran (or was refused for its version), or our own directory refused.
        const final = pake !== undefined || code === "upgrade_required" || code === "refused";
        if (left > 0 && !final) {
          p.busy = false;
          this.ws?.send(JSON.stringify({ op: "nameplate.reopen", nameplate }));
          this.emitPairing({ nameplate, ok: false, error: code, attemptsLeft: left, ...v });
          return;
        }
        this.spend(nameplate, p);
        this.emitPairing({ nameplate, ok: false, error: code, attemptsLeft: 0, ...v });
      },
    );
  }

  /** P10/P12: a Google-account device on a `connect` channel; the person types the phone's code. */
  private async enroll(wire: Wire) {
    let handler: EnrollHandler | undefined;
    try {
      handler = this.o.onEnroll?.();
    } catch {
      handler = undefined;
    }
    if (!handler) {
      wire.send({
        t: "fail",
        code: "refused",
        message: "this computer does not take Google-account devices",
      });
      return wire.close("refused");
    }
    let pake: number | undefined;
    try {
      const d = await enrollAsCore(wire, {
        identity: this.o.identity,
        mailbox: this.mailbox,
        coreName: this.o.coreName,
        handler,
        onPake: (v) => {
          pake = v;
        },
      });
      this.o.onPake?.({ flow: "enroll", version: d.pake, ok: true, deviceName: d.name });
    } catch (e) {
      const code = e instanceof LinkError ? e.code : "error";
      if (pake !== undefined || code === "upgrade_required")
        this.o.onPake?.({ flow: "enroll", version: pake ?? 0, ok: false, error: code });
      this.o.log?.(`link: enrollment ended (${code})`);
    }
  }

  private spend(nameplate: string, p: PendingPairing) {
    clearTimeout(p.timer);
    if (this.pairings.get(nameplate) === p) this.pairings.delete(nameplate);
    this.ws?.send(JSON.stringify({ op: "nameplate.close", nameplate }));
  }

  private emitPairing(p: PairingOutcome) {
    for (const h of this.pairingHandlers) h(p);
  }
}
