// The device's side of Alca Link (phone PWA, hands daemon, headless test
// client). Pairs once with a code, then keeps a session open: LAN first when
// the core told us a LAN address and the page may use it, else the relay;
// reconnects with backoff; stops for good when the core says "revoked".
import { FIRST_RETRY_MS, jittered, MAX_RETRY_MS, nextRetry } from "./backoff.ts";
import { fromB64u, toB64u } from "./bytes.ts";
import { LinkError } from "./errors.ts";
import { type DeviceInfo, pairAsDevice, parseCode, sessionAsDevice } from "./handshake.ts";
import type { Identity } from "./identity.ts";
import { relayWsUrl } from "./relay-protocol.ts";
import { LinkPeer, type RequestHandler } from "./rpc.ts";
import { normalizeIceServers, type RtcFactory, rtcConnect } from "./rtc.ts";
import { openDeviceWire, probeRelay, type WebSocketCtor } from "./transport.ts";
import type { Wire } from "./wire.ts";

/** What a paired device keeps (besides its private key). Nothing here is secret. */
export interface LinkCredentials {
  relayUrl: string;
  mailbox: string;
  corePublicKey: string;
  coreFingerprint: string;
  coreName: string;
  deviceId: string;
  scopes: string[];
  /** Direct addresses the core reported (ws://…); tried before the relay when allowed. */
  lan?: string[];
  /**
   * Every relay the core said it can be reached on (newest list first). When
   * the one in `relayUrl` stops answering the others are tried, and the one
   * that works becomes `relayUrl`, so a moved relay needs no re-pairing.
   */
  relays?: string[];
  /** Direct wss:// addresses the person set up (Tailscale serve, own reverse proxy). */
  direct?: string[];
}

const strings = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;

export async function pairDevice(o: {
  relayUrl: string;
  code: string;
  identity: Identity;
  device: DeviceInfo;
  expectFingerprint?: string;
  WebSocketImpl?: WebSocketCtor;
}): Promise<LinkCredentials & { pake: number }> {
  const code = parseCode(o.code);
  const relayUrl = relayWsUrl(o.relayUrl);
  const wire = await openDeviceWire(
    relayUrl,
    { op: "claim", nameplate: code.nameplate },
    o.WebSocketImpl ? { WebSocketImpl: o.WebSocketImpl } : {},
  );
  const r = await pairAsDevice(wire, {
    code,
    identity: o.identity,
    device: o.device,
    ...(o.expectFingerprint ? { expectFingerprint: o.expectFingerprint } : {}),
  });
  return {
    relayUrl,
    mailbox: r.mailbox,
    corePublicKey: toB64u(r.corePublicRaw),
    coreFingerprint: r.coreFingerprint,
    coreName: r.coreName,
    deviceId: r.deviceId,
    scopes: r.scopes,
    pake: r.pake,
  };
}

export type ClientStatus = "idle" | "connecting" | "online" | "offline" | "revoked";

export interface LinkClientOptions {
  credentials: LinkCredentials;
  identity: Identity;
  WebSocketImpl?: WebSocketCtor;
  /** Requests the core sends to this device (hands daemon). */
  onRequest?: RequestHandler;
  /** Try `credentials.lan` first (Node: yes; an https page cannot open ws:// so: no). */
  preferLan?: boolean;
  /** Reconnect delays in ms (default 250 ms doubling to 30 s, each ±20 %; PERF-2026-11). */
  backoff?: { first: number; max: number };
  /** Seconds between keep-alive pings (0 = off). */
  pingSec?: number;
  /**
   * P13: a WebRTC factory (the page's RTCPeerConnection). When the core's
   * `ready` lists ICE servers, a relay session is moved onto a direct
   * DataChannel; when that drops, the client is back on the relay at once.
   */
  rtc?: RtcFactory;
  /** Wait after a failed or dropped direct path before trying again (default 2 min). */
  rtcRetryMs?: number;
  /** Time for one try: offer → answer → channel → handshake (default 12 s). */
  rtcTimeoutMs?: number;
}

export type LinkPath = "lan" | "relay" | "rtc";

export interface RtcStats {
  state: "off" | "trying" | "up" | "failed" | "unavailable";
  tries: number;
  lastError: string;
  upAt: number;
}

export class LinkClient {
  private peer: LinkPeer | undefined;
  private state: ClientStatus = "idle";
  private stopped = false;
  private retryMs: number;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private statusHandlers: Array<(s: ClientStatus, why?: string) => void> = [];
  private readyHandlers: Array<(ready: Record<string, unknown>, peer: LinkPeer) => void> = [];
  private eventHandlers: Array<(ch: string, e: unknown) => void> = [];
  credentials: LinkCredentials;
  ready: Record<string, unknown> | undefined;
  via: LinkPath | undefined;
  /** P13: the direct WebRTC path (診斷). */
  readonly rtcStats: RtcStats = { state: "off", tries: 0, lastError: "", upAt: 0 };
  private rtcTimer: ReturnType<typeof setTimeout> | undefined;
  /** No new direct try before this time (after one dropped). */
  private rtcHold = 0;
  /** Diagnostics (the phone's /diag): sessions opened, when the last one came up, last round trip. */
  readonly stats = {
    connects: 0,
    lastOnlineAt: 0,
    lastRttMs: -1,
    lastError: "",
    /** Failed tries since the last session came up (the reconnect screen). */
    retries: 0,
    nextRetryAt: 0,
  };
  private credentialHandlers: Array<(c: LinkCredentials) => void> = [];

  private readonly o: LinkClientOptions;

  constructor(o: LinkClientOptions) {
    this.o = o;
    this.credentials = { ...o.credentials };
    this.retryMs = o.backoff?.first ?? FIRST_RETRY_MS;
  }

  get status(): ClientStatus {
    return this.state;
  }

  onStatus(h: (s: ClientStatus, why?: string) => void): () => void {
    this.statusHandlers.push(h);
    return () => {
      this.statusHandlers = this.statusHandlers.filter((x) => x !== h);
    };
  }

  /** Every (re)connection: re-subscribe here. */
  onReady(h: (ready: Record<string, unknown>, peer: LinkPeer) => void): () => void {
    this.readyHandlers.push(h);
    return () => {
      this.readyHandlers = this.readyHandlers.filter((x) => x !== h);
    };
  }

  /** The credentials changed (a new relay or direct address): persist them. */
  onCredentials(h: (c: LinkCredentials) => void): () => void {
    this.credentialHandlers.push(h);
    return () => {
      this.credentialHandlers = this.credentialHandlers.filter((x) => x !== h);
    };
  }

  /** Ask every known relay whether this core is listening there (診斷). */
  async probeRelays(
    timeoutMs = 6000,
  ): Promise<Array<{ url: string; online: boolean | undefined; ms: number }>> {
    const urls = [this.credentials.relayUrl, ...(this.credentials.relays ?? [])].filter(
      (u, i, a) => a.indexOf(u) === i,
    );
    return Promise.all(
      urls.map(async (url) => {
        const t = Date.now();
        const online = await probeRelay(url, this.credentials.mailbox, {
          timeoutMs,
          ...(this.o.WebSocketImpl ? { WebSocketImpl: this.o.WebSocketImpl } : {}),
        });
        return { url, online, ms: Date.now() - t };
      }),
    );
  }

  /** Take the addresses the core reported (in `ready` or an `endpoints` event). */
  private learn(info: Record<string, unknown>): void {
    const c = this.credentials;
    const before = JSON.stringify([c.relays, c.direct, c.lan]);
    const relays = strings(info.relays);
    // The core's list first; older ones stay behind it (a core moved back still gets found).
    if (relays?.length) c.relays = [...new Set([...relays, ...(c.relays ?? [])])].slice(0, 6);
    const direct = strings(info.direct);
    if (direct) c.direct = direct.slice(0, 6);
    const lan = strings(info.lan);
    if (lan) c.lan = lan;
    if (JSON.stringify([c.relays, c.direct, c.lan]) !== before)
      for (const h of this.credentialHandlers) h({ ...c });
  }

  onEvent(h: (ch: string, e: unknown) => void): () => void {
    this.eventHandlers.push(h);
    return () => {
      this.eventHandlers = this.eventHandlers.filter((x) => x !== h);
    };
  }

  start(): void {
    this.stopped = false;
    if (this.state === "idle" || this.state === "offline") void this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearTimeout(this.rtcTimer);
    clearInterval(this.pingTimer);
    this.peer?.close("client stopped");
    this.peer = undefined;
    this.set("idle");
  }

  /** Reconnect now (e.g. the page became visible again). */
  nudge(): void {
    if (this.stopped || this.state === "online" || this.state === "connecting" || this.state === "revoked")
      return;
    clearTimeout(this.retryTimer);
    void this.connect();
  }

  /**
   * The app came back from the background (iOS freezes pages; a socket can
   * look open and be dead). Online: one quick ping, and a fresh connection at
   * once if it does not come back. Offline: forget the backoff and try now.
   */
  async resume(timeoutMs = 4000): Promise<boolean> {
    if (this.stopped || this.state === "revoked") return false;
    const peer = this.peer;
    if (this.state === "online" && peer) {
      const t = Date.now();
      try {
        await peer.request("ping", {}, timeoutMs);
        this.stats.lastRttMs = Date.now() - t;
        return true;
      } catch {
        if (this.peer !== peer) return false; // already replaced
        // Detach first, so the close below is not taken for a loss that schedules a second connect.
        this.peer = undefined;
        clearInterval(this.pingTimer);
        peer.close("stale after resume");
        this.retryMs = this.o.backoff?.first ?? FIRST_RETRY_MS;
        clearTimeout(this.retryTimer);
        void this.connect();
        return false;
      }
    }
    this.retryMs = this.o.backoff?.first ?? FIRST_RETRY_MS;
    this.nudge();
    return false;
  }

  request<T = unknown>(op: string, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    if (!this.peer || this.state !== "online")
      return Promise.reject(new LinkError("closed", "not connected"));
    return this.peer.request<T>(op, args, timeoutMs);
  }

  private set(s: ClientStatus, why?: string) {
    this.state = s;
    for (const h of this.statusHandlers) h(s, why);
  }

  private candidates(): Array<{ url: string; via: "lan" | "relay" }> {
    const c = this.credentials;
    const lan = this.o.preferLan ? (c.lan ?? []) : [];
    // A page served over https cannot open ws://, so only wss:// direct addresses there.
    const direct = (c.direct ?? []).filter((u) => this.o.preferLan || u.startsWith("wss:"));
    const relays = [c.relayUrl, ...(c.relays ?? [])].filter((u, i, a) => a.indexOf(u) === i);
    return [
      ...[...lan, ...direct].map((url) => ({ url, via: "lan" as const })),
      ...relays.map((url) => ({ url, via: "relay" as const })),
    ];
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.set("connecting");
    const c = this.credentials;
    let lastError: LinkError | undefined;
    for (const cand of this.candidates()) {
      try {
        const wire = await openDeviceWire(
          cand.url,
          { op: "dial", mailbox: c.mailbox },
          {
            ...(this.o.WebSocketImpl ? { WebSocketImpl: this.o.WebSocketImpl } : {}),
            timeoutMs: cand.via === "lan" ? 1500 : 10_000,
          },
        );
        const s = await sessionAsDevice(wire, {
          deviceId: c.deviceId,
          identity: this.o.identity,
          corePublicRaw: fromB64u(c.corePublicKey),
          mailbox: c.mailbox,
        });
        if (this.stopped) {
          wire.close("stopped");
          return;
        }
        if (cand.via === "relay" && cand.url !== c.relayUrl) {
          // This relay worked where the remembered one did not: remember it instead.
          const old = c.relayUrl;
          c.relayUrl = cand.url;
          c.relays = [cand.url, ...(c.relays ?? []).filter((u) => u !== cand.url && u !== old), old];
          for (const h of this.credentialHandlers) h({ ...c });
        }
        this.adopt(wire, s, cand.via);
        return;
      } catch (e) {
        lastError = e instanceof LinkError ? e : new LinkError("offline", String(e));
        if (
          lastError.code === "revoked" ||
          lastError.code === "unknown_device" ||
          lastError.code === "bad_signature"
        ) {
          this.stopped = true;
          return this.set("revoked", lastError.code);
        }
      }
    }
    this.stats.lastError = lastError?.code ?? "";
    this.set("offline", lastError?.code);
    this.retry();
  }

  /** A session came up on `wire`: make it the live one, tell everyone, and look for a direct path. */
  private adopt(wire: Wire, s: Awaited<ReturnType<typeof sessionAsDevice>>, via: LinkPath): LinkPeer {
    const peer = new LinkPeer(wire, s.channel);
    if (this.o.onRequest) peer.handle(this.o.onRequest);
    peer.onEvent((ch, e) => {
      // A session being replaced (relay → direct) may still deliver for a moment: only the live one counts.
      if (this.peer !== peer) return;
      if (ch === "link" && e && typeof e === "object" && (e as { type?: unknown }).type === "endpoints")
        this.learn(e as Record<string, unknown>);
      // The core changed this device's scopes while it is connected (same shape as `ready.scopes`).
      if (ch === "link" && e && typeof e === "object" && (e as { type?: unknown }).type === "scopes") {
        const scopes = (e as { scopes?: unknown }).scopes;
        if (Array.isArray(scopes)) {
          const list = scopes.filter((x): x is string => typeof x === "string");
          this.credentials.scopes = list;
          if (this.ready) this.ready = { ...this.ready, scopes: list };
          for (const h of this.credentialHandlers) h({ ...this.credentials });
        }
      }
      for (const h of this.eventHandlers) h(ch, e);
    });
    peer.onClose((reason) => this.lost(peer, reason));
    const before = this.peer;
    this.peer = peer;
    this.ready = s.ready;
    this.via = via;
    this.learn(s.ready);
    if (Array.isArray(s.ready.scopes))
      this.credentials.scopes = s.ready.scopes.filter((x) => typeof x === "string");
    peer.start();
    this.retryMs = this.o.backoff?.first ?? FIRST_RETRY_MS;
    this.stats.connects++;
    this.stats.lastOnlineAt = Date.now();
    this.stats.retries = 0;
    this.stats.nextRetryAt = 0;
    this.set("online");
    this.keepAlive(peer);
    for (const h of this.readyHandlers) h(s.ready, peer);
    // Answers still on their way over the old path get a moment to land.
    if (before && before !== peer) setTimeout(() => before.close("moved to a direct connection"), 3000);
    if (via !== "rtc") this.planRtc(peer, Math.max(0, this.rtcHold - Date.now()));
    return peer;
  }

  /** P13: try a direct DataChannel for this relay / LAN session (once now, again after a failure). */
  private planRtc(base: LinkPeer, delayMs: number) {
    clearTimeout(this.rtcTimer);
    const ice = normalizeIceServers((this.ready?.rtc as { iceServers?: unknown } | undefined)?.iceServers);
    if (!ice.length) {
      this.rtcStats.state = "off";
      return;
    }
    if (!this.o.rtc) {
      this.rtcStats.state = "unavailable";
      return;
    }
    this.rtcTimer = setTimeout(() => void this.tryRtc(base, ice), delayMs);
    (this.rtcTimer as { unref?: () => void }).unref?.();
  }

  private async tryRtc(base: LinkPeer, iceServers: string[]) {
    const factory = this.o.rtc;
    if (!factory || this.stopped || this.peer !== base || this.state !== "online") return;
    this.rtcStats.state = "trying";
    this.rtcStats.tries++;
    const timeoutMs = this.o.rtcTimeoutMs ?? 12_000;
    let wire: Wire | undefined;
    try {
      const up = await rtcConnect({
        factory,
        iceServers,
        request: (op, args, t) => base.request(op, args, t),
        timeoutMs,
      });
      wire = up.wire;
      const c = this.credentials;
      const s = await sessionAsDevice(wire, {
        deviceId: c.deviceId,
        identity: this.o.identity,
        corePublicRaw: fromB64u(c.corePublicKey),
        mailbox: c.mailbox,
      });
      if (this.stopped || this.peer !== base) {
        wire.close("not needed");
        return;
      }
      this.rtcStats.state = "up";
      this.rtcStats.upAt = Date.now();
      this.rtcStats.lastError = "";
      this.adopt(wire, s, "rtc");
    } catch (e) {
      wire?.close("rtc failed");
      this.rtcStats.state = "failed";
      this.rtcStats.lastError =
        e instanceof LinkError ? e.code : String((e as Error)?.message ?? e).slice(0, 80);
      if (this.peer === base) this.planRtc(base, this.o.rtcRetryMs ?? 120_000);
    }
  }

  private keepAlive(peer: LinkPeer) {
    clearInterval(this.pingTimer);
    const sec = this.o.pingSec ?? 25;
    if (!sec) return;
    this.pingTimer = setInterval(() => {
      const t = Date.now();
      peer
        .request("ping", {}, 10_000)
        .then(() => {
          this.stats.lastRttMs = Date.now() - t;
        })
        .catch(() => peer.close("ping timeout"));
    }, sec * 1000);
    (this.pingTimer as { unref?: () => void }).unref?.();
  }

  private lost(peer: LinkPeer, reason: string) {
    if (this.peer !== peer) return;
    this.peer = undefined;
    clearInterval(this.pingTimer);
    if (this.stopped) return;
    if (reason === "revoked") {
      this.stopped = true;
      return this.set("revoked", reason);
    }
    if (this.via === "rtc") {
      // The direct path went away: back on the relay now (no backoff), and wait before trying it again.
      this.rtcStats.state = "failed";
      this.rtcStats.lastError = reason.slice(0, 80);
      this.rtcHold = Date.now() + (this.o.rtcRetryMs ?? 120_000);
      this.set("connecting", reason);
      void this.connect();
      return;
    }
    this.set("offline", reason);
    this.retry();
  }

  private retry() {
    if (this.stopped) return;
    clearTimeout(this.retryTimer);
    // ±20 % jitter, so phones that lost the relay together do not all come back in the same instant.
    const wait = jittered(this.retryMs);
    this.stats.retries++;
    this.stats.nextRetryAt = Date.now() + wait;
    this.retryTimer = setTimeout(() => void this.connect(), wait);
    (this.retryTimer as { unref?: () => void }).unref?.();
    this.retryMs = nextRetry(this.retryMs, this.o.backoff?.max ?? MAX_RETRY_MS);
  }
}
