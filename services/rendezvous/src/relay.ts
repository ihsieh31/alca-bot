// The rendezvous hub: everything is in memory and disappears with the
// process. It knows which cores are online (by mailbox = hash of the core's
// public key, proven with a signed challenge), which short nameplates are open,
// and which channels join a device socket to a core socket. Channel payloads
// (`d`) are forwarded as they are and never inspected.
import { fromB64u, randomBytes, toB64u } from "@alca/link/bytes";
import { fingerprint, mailboxOf, verify } from "@alca/link/identity";
import { coreAuthPayload, RELAY_VERSION, type RelayErrorCode } from "@alca/link/relay-protocol";
import type { WsConnection } from "@alca/link/ws";
import type { AccountRegistry } from "./accounts.ts";
import type { TokenVerifier } from "./google.ts";
import { RateLimiter } from "./rate.ts";

/** Uniform integer in [lo, hi) from WebCrypto (the Worker build has no node:crypto). */
function randomInt(lo: number, hi: number): number {
  const span = hi - lo;
  const lim = Math.floor(0x1_0000_0000 / span) * span;
  const b = new Uint32Array(1);
  do crypto.getRandomValues(b);
  while ((b[0] as number) >= lim);
  return lo + ((b[0] as number) % span);
}

export interface RelayLimits {
  /** Pairing-code claims per client address: burst and refill per minute. */
  claimBurst: number;
  claimsPerMinute: number;
  dialBurst: number;
  dialsPerMinute: number;
  coreHellosPerMinute: number;
  /** Messages per second per connection (burst = 2×). */
  messagesPerSecond: number;
  maxNameplatesPerCore: number;
  maxChannelsPerCore: number;
  maxNameplateTtlSec: number;
  maxCores: number;
  /** Claims one pairing code allows (a wrong code reopens it until this many). */
  maxClaimsPerNameplate: number;
  /** P10: Google tokens checked per client address (list, connect, register): burst and per minute. */
  tokenBurst: number;
  tokensPerMinute: number;
  /** P10: computer lists and connect requests per Google account per minute. */
  accountOpsPerMinute: number;
  /**
   * Review M2: seconds a new socket has to say who it is (a core's signed hello, a device's
   * claim / dial / list / connect); then it is closed. 0 = no limit.
   */
  helloTimeoutSec: number;
  /**
   * Seconds without a message before a socket is closed. Cores ping every 15 min (LinkHost
   * self-check) and phones every 25 s, so the default leaves room. 0 = no limit.
   */
  idleTimeoutSec: number;
  /** Open sockets per client address (any role). */
  maxSocketsPerAddress: number;
  /** Open sockets in this hub (one process, one Durable Object): past it new sockets are refused. */
  maxSockets: number;
  /** Bytes a connection may send per second (burst = `bytesBurst`). */
  bytesPerSecond: number;
  bytesBurst: number;
  /**
   * Channels one client address may hold open to one core at a time (dial / claim / connect):
   * a stranger who knows a mailbox id cannot take every channel of that core.
   */
  maxChannelsPerCorePerAddress: number;
}

export const DEFAULT_LIMITS: RelayLimits = {
  claimBurst: 5,
  claimsPerMinute: 5,
  dialBurst: 30,
  dialsPerMinute: 30,
  coreHellosPerMinute: 20,
  messagesPerSecond: 300,
  maxNameplatesPerCore: 4,
  maxChannelsPerCore: 64,
  maxNameplateTtlSec: 600,
  maxCores: 10_000,
  maxClaimsPerNameplate: 5,
  tokenBurst: 20,
  tokensPerMinute: 20,
  accountOpsPerMinute: 30,
  helloTimeoutSec: 10,
  idleTimeoutSec: 30 * 60,
  maxSocketsPerAddress: 32,
  maxSockets: 20_000,
  bytesPerSecond: 1024 * 1024,
  bytesBurst: 8 * 1024 * 1024,
  maxChannelsPerCorePerAddress: 8,
};

export interface RelayHubOptions {
  limits?: Partial<RelayLimits>;
  now?: () => number;
  /** Test hook: every channel payload the relay forwards, as it saw it. */
  tap?: (dir: "to_core" | "to_device", payload: unknown) => void;
  log?: (msg: string) => void;
  /**
   * P10: Google-account directory. Unset = the account ops answer
   * `not_enabled` (a relay for pairing codes only).
   */
  accounts?: { registry: AccountRegistry; verifier: TokenVerifier };
  /**
   * Why `accounts` is unset although the operator meant to turn it on (review L4: the Worker had
   * GOOGLE_CLIENT_IDS but no ALCA_RELAY_SECRET); the `not_enabled` error says it.
   */
  accountsOff?: string;
}

interface CoreConn {
  ws: WsConnection;
  mailbox?: string;
  nonce?: Uint8Array;
  pub?: Uint8Array;
  channels: Map<string, WsConnection>;
  /** Client address of each channel's device (the per-address channel cap). */
  channelAddr: Map<string, string>;
  nameplates: Set<string>;
}

/** What the hub tracks of every open socket (timeouts, per-address caps). */
interface SocketInfo {
  addr: string;
  lastAt: number;
  /** Said who it is (authenticated core, or a device that opened / asked something). */
  known: boolean;
}

type Msg = Record<string, unknown>;

class MessageBudget {
  private tokens: number;
  private at: number;
  private readonly rate: number;
  private readonly burst: number;
  private readonly now: () => number;
  constructor(rate: number, now: () => number, burst = rate * 2) {
    this.rate = rate;
    this.burst = burst;
    this.now = now;
    this.tokens = burst;
    this.at = now();
  }
  take(cost = 1): boolean {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.at) / 1000) * this.rate);
    this.at = t;
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}

const send = (ws: WsConnection, m: Msg) => ws.send(JSON.stringify(m));
const notEnabled = (req: unknown, why?: string): Msg => ({
  op: "error",
  code: "not_enabled",
  message: why ? `this relay's Google sign-in is off: ${why}` : "this relay has no Google sign-in",
  ...(req !== undefined ? { req } : {}),
});
const error = (ws: WsConnection, code: RelayErrorCode, message: string, close = true) => {
  send(ws, { op: "error", code, message });
  if (close) ws.close(4000, code);
};

export class RelayHub {
  readonly limits: RelayLimits;
  private readonly now: () => number;
  private cores = new Map<string, CoreConn>();
  /** `busy` while one claimer is pairing on it; `claims` counts every claim. */
  private nameplates = new Map<
    string,
    { mailbox: string; expiresAt: number; busy: boolean; claims: number }
  >();
  private claims: RateLimiter;
  private dials: RateLimiter;
  private hellos: RateLimiter;
  private tokens: RateLimiter;
  private accountOps: RateLimiter;
  private nextCh = 1;
  private sockets = new Map<WsConnection, SocketInfo>();
  private perAddress = new Map<string, number>();
  private idleTimer: ReturnType<typeof setInterval> | undefined;

  private readonly o: RelayHubOptions;

  constructor(o: RelayHubOptions = {}) {
    this.o = o;
    this.limits = { ...DEFAULT_LIMITS, ...o.limits };
    this.now = o.now ?? Date.now;
    this.claims = new RateLimiter(this.limits.claimBurst, this.limits.claimsPerMinute, this.now);
    this.dials = new RateLimiter(this.limits.dialBurst, this.limits.dialsPerMinute, this.now);
    this.hellos = new RateLimiter(this.limits.coreHellosPerMinute, this.limits.coreHellosPerMinute, this.now);
    this.tokens = new RateLimiter(this.limits.tokenBurst, this.limits.tokensPerMinute, this.now);
    this.accountOps = new RateLimiter(
      this.limits.accountOpsPerMinute,
      this.limits.accountOpsPerMinute,
      this.now,
    );
  }

  stats() {
    let channels = 0;
    for (const c of this.cores.values()) channels += c.channels.size;
    return {
      cores: this.cores.size,
      nameplates: this.nameplates.size,
      channels,
      sockets: this.sockets.size,
      ...(this.o.accounts ? this.o.accounts.registry.stats() : {}),
    };
  }

  /**
   * Close sockets that have been silent past `idleTimeoutSec` (and, as a backstop, ones that
   * never said who they are). Runs on a timer while sockets are open; tests call it directly.
   */
  sweepIdle(): number {
    const t = this.now();
    const idle = this.limits.idleTimeoutSec * 1000;
    const hello = this.limits.helloTimeoutSec * 1000;
    let closed = 0;
    for (const [ws, s] of this.sockets) {
      const silent = t - s.lastAt;
      const isIdle = idle > 0 && silent > idle;
      if (isIdle || (hello && !s.known && silent > hello)) {
        closed++;
        error(ws, "bad_request", isIdle ? "idle timeout" : "say hello first");
        this.forget(ws);
      }
    }
    return closed;
  }

  private forget(ws: WsConnection) {
    const s = this.sockets.get(ws);
    if (!s) return;
    this.sockets.delete(ws);
    const n = (this.perAddress.get(s.addr) ?? 1) - 1;
    if (n > 0) this.perAddress.set(s.addr, n);
    else this.perAddress.delete(s.addr);
    if (!this.sockets.size && this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  private track(ws: WsConnection, addr: string): SocketInfo | undefined {
    if (this.sockets.size >= this.limits.maxSockets) {
      error(ws, "too_many", "relay is full");
      return undefined;
    }
    const n = this.perAddress.get(addr) ?? 0;
    if (n >= this.limits.maxSocketsPerAddress) {
      error(ws, "rate_limited", "too many connections from this address");
      return undefined;
    }
    this.perAddress.set(addr, n + 1);
    const info: SocketInfo = { addr, lastAt: this.now(), known: false };
    this.sockets.set(ws, info);
    if (!this.idleTimer && (this.limits.idleTimeoutSec || this.limits.helloTimeoutSec)) {
      const every = Math.max(1, Math.min(this.limits.helloTimeoutSec || 30, 30)) * 1000;
      this.idleTimer = setInterval(() => this.sweepIdle(), every);
      (this.idleTimer as { unref?: () => void }).unref?.();
    }
    return info;
  }

  /** A new socket: its first message says whether it is a core or a device. */
  accept(ws: WsConnection, clientKey: string): void {
    const info = this.track(ws, clientKey);
    if (!info) return;
    const budget = new MessageBudget(this.limits.messagesPerSecond, this.now);
    const bytes = new MessageBudget(this.limits.bytesPerSecond, this.now, this.limits.bytesBurst);
    let role: "unknown" | "core" | "device" = "unknown";
    let core: CoreConn | undefined;
    let deviceCh: { core: CoreConn; ch: string } | undefined;
    if (this.limits.helloTimeoutSec) {
      const t = setTimeout(() => {
        if (ws.open && !info.known) {
          error(ws, "bad_request", "say hello first");
          this.forget(ws);
        }
      }, this.limits.helloTimeoutSec * 1000);
      (t as { unref?: () => void }).unref?.();
      ws.onClose(() => clearTimeout(t));
    }
    ws.onMessage((text) => {
      info.lastAt = this.now();
      if (!budget.take()) return error(ws, "rate_limited", "too many messages");
      if (!bytes.take(text.length)) return error(ws, "rate_limited", "too much data");
      let m: Msg;
      try {
        const v = JSON.parse(text) as unknown;
        if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
        m = v as Msg;
      } catch {
        return error(ws, "bad_request", "not a JSON object");
      }
      if (role === "unknown") {
        if (m.v !== RELAY_VERSION) return error(ws, "bad_request", "unsupported relay version");
        if (m.op === "core.hello") {
          role = "core";
          core = { ws, channels: new Map(), channelAddr: new Map(), nameplates: new Set() };
          return void this.coreHello(core, m, clientKey);
        }
        if (m.op === "probe") return void this.probe(ws, m, clientKey);
        if (m.op === "computers.list") {
          role = "device";
          info.known = true;
          return void this.listComputers(ws, m, clientKey);
        }
        if (m.op === "connect") {
          role = "device";
          info.known = true;
          void this.connectDevice(ws, m, clientKey).then((c) => {
            deviceCh = c;
          });
          return;
        }
        if (m.op === "claim" || m.op === "dial") {
          role = "device";
          info.known = true;
          deviceCh = this.deviceOpen(ws, m, clientKey);
          return;
        }
        return error(ws, "bad_request", "say hello first");
      }
      if (role === "core" && core)
        return void this.coreMessage(core, m).then(() => {
          if (core?.mailbox) info.known = true;
        });
      if (role === "device" && deviceCh && m.op === "msg") {
        const c = deviceCh;
        if (!c.core.channels.has(c.ch)) return ws.close(1000, "channel closed");
        this.o.tap?.("to_core", m.d);
        send(c.core.ws, { op: "ch.msg", ch: c.ch, d: m.d });
      }
    });
    ws.onClose(() => {
      this.forget(ws);
      if (core) this.coreGone(core);
      if (deviceCh?.core.channels.delete(deviceCh.ch)) {
        deviceCh.core.channelAddr.delete(deviceCh.ch);
        send(deviceCh.core.ws, { op: "ch.closed", ch: deviceCh.ch });
      }
    });
  }

  private async coreHello(c: CoreConn, m: Msg, clientKey: string) {
    if (!this.hellos.take(clientKey)) return error(c.ws, "rate_limited", "too many core connections");
    if (this.cores.size >= this.limits.maxCores) return error(c.ws, "too_many", "relay is full");
    try {
      c.pub = fromB64u(String(m.pub));
    } catch {
      return error(c.ws, "bad_request", "bad public key");
    }
    c.nonce = randomBytes(32);
    send(c.ws, { op: "challenge", nonce: toB64u(c.nonce) });
  }

  private async coreMessage(c: CoreConn, m: Msg) {
    if (!c.mailbox) {
      if (m.op !== "core.auth" || !c.pub || !c.nonce) return error(c.ws, "bad_request", "authenticate first");
      let ok = false;
      try {
        ok = await verify(c.pub, fromB64u(String(m.sig)), coreAuthPayload(c.nonce));
      } catch {
        ok = false;
      }
      if (!ok) return error(c.ws, "auth_failed", "signature check failed");
      const mailbox = await mailboxOf(c.pub);
      c.mailbox = mailbox;
      // The newest authenticated connection for a mailbox wins (the core reconnected).
      const old = this.cores.get(mailbox);
      if (old && old !== c) {
        this.coreGone(old);
        old.ws.close(4001, "replaced");
      }
      this.cores.set(mailbox, c);
      this.o.accounts?.registry.seen(mailbox);
      return send(c.ws, { op: "core.ready", mailbox });
    }
    switch (m.op) {
      case "nameplate.open": {
        this.sweep();
        if (c.nameplates.size >= this.limits.maxNameplatesPerCore)
          return error(c.ws, "too_many", "too many open pairing codes", false);
        const ttl = Math.min(Number(m.ttlSec) || 120, this.limits.maxNameplateTtlSec);
        const nameplate = this.allocate();
        const expiresAt = this.now() + ttl * 1000;
        this.nameplates.set(nameplate, { mailbox: c.mailbox, expiresAt, busy: false, claims: 0 });
        c.nameplates.add(nameplate);
        return send(c.ws, {
          op: "nameplate",
          req: m.req,
          nameplate,
          expiresAt: new Date(expiresAt).toISOString(),
        });
      }
      case "nameplate.reopen": {
        // The core saw a wrong code on this nameplate: let the person try again, up to the cap.
        const n = String(m.nameplate);
        const e = this.nameplates.get(n);
        if (!e || e.mailbox !== c.mailbox) return;
        if (e.claims >= this.limits.maxClaimsPerNameplate || e.expiresAt <= this.now()) {
          this.nameplates.delete(n);
          c.nameplates.delete(n);
          return;
        }
        e.busy = false;
        return;
      }
      case "nameplate.close": {
        const n = String(m.nameplate);
        if (c.nameplates.delete(n)) this.nameplates.delete(n);
        return;
      }
      case "ch.msg": {
        const dev = c.channels.get(String(m.ch));
        if (!dev) return send(c.ws, { op: "ch.closed", ch: m.ch });
        this.o.tap?.("to_device", m.d);
        return send(dev, { op: "msg", d: m.d });
      }
      case "ch.close": {
        const id = String(m.ch);
        const dev = c.channels.get(id);
        c.channels.delete(id);
        c.channelAddr.delete(id);
        dev?.close(1000, "closed by core");
        return;
      }
      case "ping":
        return send(c.ws, { op: "pong" });
      case "computer.register":
        return void this.registerComputer(c, m);
      case "computer.unregister": {
        if (!this.o.accounts) return send(c.ws, notEnabled(m.req, this.o.accountsOff));
        await this.o.accounts.registry.unregister(c.mailbox);
        return send(c.ws, { op: "computer.unregistered", req: m.req });
      }
      default:
        return error(c.ws, "bad_request", "unknown op", false);
    }
  }

  private deviceOpen(
    ws: WsConnection,
    m: Msg,
    clientKey: string,
  ): { core: CoreConn; ch: string } | undefined {
    let core: CoreConn | undefined;
    let nameplate: string | undefined;
    if (m.op === "claim") {
      // Every claim costs a token, found or not: guessing nameplates is slow.
      if (!this.claims.take(clientKey)) return void error(ws, "rate_limited", "too many pairing attempts");
      this.sweep();
      nameplate = String(m.nameplate ?? "");
      const n = this.nameplates.get(nameplate);
      // One claimer at a time; a wrong code is reopened by the core, at most
      // `maxClaimsPerNameplate` claims in all; success closes it.
      const usable = n && !n.busy && n.claims < this.limits.maxClaimsPerNameplate;
      core = usable ? this.cores.get(n.mailbox) : undefined;
      if (!core || !n) return void error(ws, "no_such_code", "no pairing with this code");
      n.busy = true;
      n.claims++;
    } else {
      if (!this.dials.take(clientKey)) return void error(ws, "rate_limited", "too many connection attempts");
      core = this.cores.get(String(m.mailbox ?? ""));
      if (!core) return void error(ws, "offline", "that core is not online");
    }
    if (!this.channelRoom(core, clientKey))
      return void error(ws, "too_many", "too many connections to this core");
    const ch = `c${this.nextCh++}`;
    core.channels.set(ch, ws);
    core.channelAddr.set(ch, clientKey);
    send(core.ws, { op: "ch.open", ch, via: m.op, ...(nameplate ? { nameplate } : {}) });
    send(ws, { op: "open" });
    return { core, ch };
  }

  /** Room for one more channel to `core` from `addr` (the core's cap and the per-address cap). */
  private channelRoom(core: CoreConn, addr: string): boolean {
    if (core.channels.size >= this.limits.maxChannelsPerCore) return false;
    let mine = 0;
    for (const a of core.channelAddr.values()) if (a === addr) mine++;
    return mine < this.limits.maxChannelsPerCorePerAddress;
  }

  /**
   * Reachability check without opening a channel: is this mailbox listening
   * here right now? Answers one bit and closes. Costs a dial token.
   */
  private probe(ws: WsConnection, m: Msg, clientKey: string) {
    if (!this.dials.take(clientKey)) return error(ws, "rate_limited", "too many connection attempts");
    send(ws, { op: "probe", online: this.cores.has(String(m.mailbox ?? "")) });
    ws.close(1000, "probed");
  }

  // ── P10: Google account ─────────────────────────────────────────────

  /** Verify a Google ID token (rate-limited per client address) → the account key, or answer an error. */
  private async account(ws: WsConnection, token: unknown, clientKey: string, req?: unknown, close = true) {
    const a = this.o.accounts;
    if (!a) {
      send(ws, notEnabled(req, this.o.accountsOff));
      if (close) ws.close(4000, "not_enabled");
      return undefined;
    }
    const fail = (code: RelayErrorCode, message: string) => {
      send(ws, { op: "error", code, message, ...(req !== undefined ? { req } : {}) });
      if (close) ws.close(4000, code);
      return undefined;
    };
    if (!this.tokens.take(clientKey)) return fail("rate_limited", "too many sign-in checks");
    try {
      const t = await a.verifier.verify(String(token ?? ""));
      return await a.registry.accountOf(t.sub);
    } catch (e) {
      const why = e instanceof Error && "reason" in e ? String((e as { reason: unknown }).reason) : "invalid";
      this.o.log?.(`relay: Google token refused (${why})`);
      return fail("bad_token", `Google sign-in not accepted (${why})`);
    }
  }

  private async registerComputer(c: CoreConn, m: Msg) {
    const a = this.o.accounts;
    if (!a) return send(c.ws, notEnabled(m.req, this.o.accountsOff));
    const account = await this.account(c.ws, m.idToken, `core:${c.mailbox}`, m.req, false);
    if (!account || !c.mailbox || !c.pub) return;
    const fp = await fingerprint(c.pub);
    const r = await a.registry.register(account, { mailbox: c.mailbox, name: m.name, fingerprint: fp });
    if (r === "too_many")
      return send(c.ws, {
        op: "error",
        req: m.req,
        code: "too_many",
        message: "too many computers on this account",
      });
    send(c.ws, { op: "computer.registered", req: m.req, mailbox: c.mailbox, fingerprint: fp });
  }

  private async listComputers(ws: WsConnection, m: Msg, clientKey: string) {
    const account = await this.account(ws, m.idToken, clientKey);
    if (!account || !this.o.accounts) return;
    if (!this.accountOps.take(account))
      return error(ws, "rate_limited", "too many requests for this account");
    const computers = await this.o.accounts.registry.list(account, (mb) => this.cores.has(mb));
    send(ws, { op: "computers", computers });
    ws.close(1000, "listed");
  }

  /** A device signed in with the account that owns `mailbox` asks to enroll: open a `connect` channel. */
  private async connectDevice(ws: WsConnection, m: Msg, clientKey: string) {
    if (!this.dials.take(clientKey)) return void error(ws, "rate_limited", "too many connection attempts");
    const account = await this.account(ws, m.idToken, clientKey);
    if (!account || !this.o.accounts) return undefined;
    if (!this.accountOps.take(account))
      return void error(ws, "rate_limited", "too many requests for this account");
    const mailbox = String(m.mailbox ?? "");
    // Same answer whether the mailbox is someone else's or unknown.
    if (!this.o.accounts.registry.owns(account, mailbox))
      return void error(ws, "no_such_computer", "no such computer on this account");
    const core = this.cores.get(mailbox);
    if (!core) return void error(ws, "offline", "that computer is not online");
    if (!ws.open) return undefined;
    if (!this.channelRoom(core, clientKey))
      return void error(ws, "too_many", "too many connections to this core");
    const ch = `c${this.nextCh++}`;
    core.channels.set(ch, ws);
    core.channelAddr.set(ch, clientKey);
    send(core.ws, { op: "ch.open", ch, via: "connect" });
    send(ws, { op: "open" });
    return { core, ch };
  }

  private coreGone(c: CoreConn) {
    if (c.mailbox && this.cores.get(c.mailbox) === c) this.cores.delete(c.mailbox);
    for (const n of c.nameplates) this.nameplates.delete(n);
    c.nameplates.clear();
    for (const dev of c.channels.values()) dev.close(1001, "core went away");
    c.channels.clear();
    c.channelAddr.clear();
  }

  private sweep() {
    const t = this.now();
    for (const [n, v] of this.nameplates) {
      if (v.expiresAt > t) continue;
      this.nameplates.delete(n);
      this.cores.get(v.mailbox)?.nameplates.delete(n);
    }
  }

  /** Shortest free nameplate: 3 digits while there is room, then 4. */
  private allocate(): string {
    for (const digits of [3, 4]) {
      const lo = 10 ** (digits - 1);
      for (let i = 0; i < 50; i++) {
        const n = String(randomInt(lo, 10 * lo));
        if (!this.nameplates.has(n)) return n;
      }
    }
    throw new Error("no free nameplate");
  }
}
