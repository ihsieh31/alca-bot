// P13: a WebRTC DataChannel as a direct path between a paired device and the
// core. Browser-safe (no Node built-ins); the Node side plugs in its own
// RTCPeerConnection through `RtcFactory` (node/werift.ts).
//
// Signaling rides the existing sealed Link session (`rtc.offer` request →
// answer), so the relay never sees the SDP and cannot swap the DTLS
// fingerprints. Once the channel opens it is just another Wire: the full
// signed session handshake runs on it against the pinned keys and every frame
// is sealed again (AES-256-GCM, strict counters) — WebRTC's own DTLS is an
// extra layer, never the one we rely on. ICE servers come only from the
// core's settings (STUN only, nothing built in); an empty list means no
// WebRTC at all and the relay carries everything. Any failure leaves the
// relay session as it was.
import { LinkError } from "./errors.ts";
import { QueueWire, type Wire, type WireMessage } from "./wire.ts";

export const RTC_LABEL = "alca-link/v1";
/** DataChannel messages stay well under every implementation's max-message-size (werift: 64 KiB). */
export const RTC_CHUNK = 16 * 1024;
export const RTC_MAX_SDP = 16 * 1024;
/** One reassembled message at most (the relay's frame cap). */
export const RTC_MAX_MESSAGE = 4 * 1024 * 1024;

export interface RtcChannel {
  send(data: string): void;
  onMessage(h: (data: string) => void): void;
  onClose(h: () => void): void;
  close(): void;
  readonly bufferedAmount: number;
}

export interface RtcPeer {
  /** Offerer: create the data channel and return the offer SDP after ICE gathering (or `gatherMs`). */
  offer(): Promise<string>;
  /** Answerer: take an offer, return the answer SDP after gathering. */
  answer(offerSdp: string): Promise<string>;
  /** Offerer: apply the answer. */
  accept(answerSdp: string): Promise<void>;
  /** The data channel, once open (offerer: the one it made; answerer: the first one it receives). */
  channel(timeoutMs: number): Promise<RtcChannel>;
  /** ICE / DTLS went away (failed, disconnected, closed). */
  onDown(h: (why: string) => void): void;
  close(): void;
}

export type RtcFactory = (o: { iceServers: string[]; gatherMs?: number }) => RtcPeer;

/**
 * The ICE servers a core may hand out: `stun:` / `stuns:` URLs with a host and
 * an optional port, no credentials, no query, at most 4. TURN is not accepted
 * (it needs credentials, and the relay already is the fallback).
 */
export function normalizeIceServers(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const v of list) {
    if (typeof v !== "string") continue;
    const u = v.trim();
    if (!/^stuns?:(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+)(:\d{1,5})?$/.test(u)) continue;
    const port = /:(\d{1,5})$/.exec(u.replace(/^stuns?:/, ""))?.[1];
    if (port && (Number(port) < 1 || Number(port) > 65_535)) continue;
    if (!out.includes(u)) out.push(u);
  }
  return out.slice(0, 4);
}

/**
 * A Wire over a DataChannel. Each Link message is one JSON string, cut into
 * chunks of `RTC_CHUNK` characters: every chunk starts with `+` (more follow)
 * or `.` (last). Anything else, or a message over `RTC_MAX_MESSAGE`, closes
 * the wire.
 */
export function channelWire(ch: RtcChannel): Wire {
  let parts: string[] = [];
  let size = 0;
  const wire = new QueueWire(
    (m: WireMessage) => {
      const s = JSON.stringify(m);
      for (let i = 0; i < s.length || i === 0; i += RTC_CHUNK) {
        const last = i + RTC_CHUNK >= s.length;
        ch.send(`${last ? "." : "+"}${s.slice(i, i + RTC_CHUNK)}`);
      }
    },
    () => ch.close(),
  );
  ch.onMessage((d) => {
    const flag = d.charAt(0);
    if ((flag !== "+" && flag !== ".") || d.length > RTC_CHUNK + 1) return wire.end("malformed");
    parts.push(d.slice(1));
    size += d.length - 1;
    if (size > RTC_MAX_MESSAGE) return wire.end("too_big");
    if (flag === "+") return;
    const text = parts.join("");
    parts = [];
    size = 0;
    let m: unknown;
    try {
      m = JSON.parse(text);
    } catch {
      return wire.end("malformed");
    }
    if (!m || typeof m !== "object" || Array.isArray(m)) return wire.end("malformed");
    wire.push(m as WireMessage);
  });
  ch.onClose(() => wire.end("rtc closed"));
  return wire;
}

const withTimeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new LinkError("timeout", what)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });

// ── W3C adapter (the phone's browser) ───────────────────────────

interface W3cChannel {
  readyState: string;
  bufferedAmount: number;
  send(d: string): void;
  close(): void;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
}
interface W3cPeer {
  createDataChannel(label: string, init?: Record<string, unknown>): W3cChannel;
  createOffer(): Promise<{ type: string; sdp?: string }>;
  createAnswer(): Promise<{ type: string; sdp?: string }>;
  setLocalDescription(d: { type: string; sdp?: string }): Promise<void>;
  setRemoteDescription(d: { type: string; sdp: string }): Promise<void>;
  readonly localDescription: { sdp: string } | null;
  readonly iceGatheringState: string;
  readonly connectionState?: string;
  onicegatheringstatechange: (() => void) | null;
  onconnectionstatechange: (() => void) | null;
  ondatachannel: ((e: { channel: W3cChannel }) => void) | null;
  close(): void;
}
type W3cCtor = new (c: { iceServers: Array<{ urls: string[] }> }) => W3cPeer;

/** Wrap at open time: messages that arrive before `onMessage` is set are kept, not lost. */
export function bufferedChannel(o: {
  send(d: string): void;
  close(): void;
  bufferedAmount(): number;
}): RtcChannel & { deliver(d: string): void; ended(): void } {
  let handler: ((d: string) => void) | undefined;
  let closeHandler: (() => void) | undefined;
  let early: string[] = [];
  let gone = false;
  return {
    send: (d) => o.send(d),
    onMessage: (h) => {
      handler = h;
      for (const d of early) h(d);
      early = [];
    },
    onClose: (h) => {
      if (gone) h();
      else closeHandler = h;
    },
    close: () => o.close(),
    get bufferedAmount() {
      return o.bufferedAmount();
    },
    deliver: (d) => {
      if (handler) handler(d);
      else if (early.length < 64) early.push(d);
    },
    ended: () => {
      if (gone) return;
      gone = true;
      closeHandler?.();
    },
  };
}

function wrapW3cChannel(c: W3cChannel): RtcChannel {
  const ch = bufferedChannel({
    send: (d) => c.send(d),
    close: () => c.close(),
    bufferedAmount: () => c.bufferedAmount,
  });
  c.onmessage = (e) => {
    if (typeof e.data === "string") ch.deliver(e.data);
    else c.close(); // binary is never sent: close rather than guess
  };
  c.onclose = () => ch.ended();
  return ch;
}

/** `RTCPeerConnection` from the page (or any W3C-shaped constructor). Undefined when there is none. */
export function w3cRtc(Ctor?: unknown): RtcFactory | undefined {
  const C = (Ctor ?? (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection) as
    | W3cCtor
    | undefined;
  if (typeof C !== "function") return undefined;
  return ({ iceServers, gatherMs = 3000 }) => {
    const pc = new C({ iceServers: iceServers.length ? [{ urls: iceServers }] : [] });
    let made: W3cChannel | undefined;
    let got: Promise<RtcChannel> | undefined;
    const downs: Array<(why: string) => void> = [];
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === "failed" || s === "closed" || s === "disconnected") for (const h of downs) h(s);
    };
    const gathered = () =>
      new Promise<string>((resolve) => {
        const done = () => resolve(pc.localDescription?.sdp ?? "");
        if (pc.iceGatheringState === "complete") return done();
        const t = setTimeout(done, gatherMs);
        pc.onicegatheringstatechange = () => {
          if (pc.iceGatheringState === "complete") {
            clearTimeout(t);
            done();
          }
        };
      });
    const opened = (c: W3cChannel) =>
      new Promise<RtcChannel>((resolve, reject) => {
        if (c.readyState === "open") return resolve(wrapW3cChannel(c));
        c.onopen = () => resolve(wrapW3cChannel(c));
        c.onclose = () => reject(new LinkError("closed", "data channel closed before it opened"));
      });
    return {
      async offer() {
        made = pc.createDataChannel(RTC_LABEL, { ordered: true });
        got = opened(made);
        await pc.setLocalDescription(await pc.createOffer());
        return gathered();
      },
      async answer(sdp) {
        got = new Promise<RtcChannel>((resolve) => {
          pc.ondatachannel = (e) => {
            if (e.channel && (e.channel as { label?: string }).label === RTC_LABEL)
              void opened(e.channel).then(resolve, () => undefined);
          };
        });
        await pc.setRemoteDescription({ type: "offer", sdp });
        await pc.setLocalDescription(await pc.createAnswer());
        return gathered();
      },
      async accept(sdp) {
        await pc.setRemoteDescription({ type: "answer", sdp });
      },
      async channel(timeoutMs) {
        if (!got) throw new LinkError("protocol", "no offer or answer yet");
        return withTimeout(got, timeoutMs, "data channel did not open");
      },
      onDown: (h) => downs.push(h),
      close: () => {
        try {
          made?.close();
          pc.close();
        } catch {
          // already closed
        }
      },
    };
  };
}

// ── device side: upgrade a live relay session to a DataChannel ──

export interface RtcUpgradeOptions {
  factory: RtcFactory;
  iceServers: string[];
  /** A request on the current (relay) session. */
  request: (op: string, args: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>;
  timeoutMs?: number;
  gatherMs?: number;
}

/**
 * Offer, have the core answer over the sealed session, wait for the channel
 * and return it as a Wire (the caller runs the session handshake on it).
 * Throws on any failure, after closing what it opened.
 */
export async function rtcConnect(o: RtcUpgradeOptions): Promise<{ wire: Wire; peer: RtcPeer }> {
  const timeoutMs = o.timeoutMs ?? 10_000;
  const peer = o.factory({ iceServers: o.iceServers, ...(o.gatherMs ? { gatherMs: o.gatherMs } : {}) });
  try {
    const offer = await withTimeout(peer.offer(), timeoutMs, "offer took too long");
    if (!offer || offer.length > RTC_MAX_SDP) throw new LinkError("protocol", "offer too large");
    const ans = (await o.request("rtc.offer", { sdp: offer }, timeoutMs)) as { sdp?: unknown } | undefined;
    if (!ans || typeof ans.sdp !== "string" || !ans.sdp || ans.sdp.length > RTC_MAX_SDP)
      throw new LinkError("protocol", "bad answer");
    await peer.accept(ans.sdp);
    const ch = await peer.channel(timeoutMs);
    const wire = channelWire(ch);
    peer.onDown((why) => wire.close(`rtc ${why}`));
    wire.onClose(() => peer.close());
    return { wire, peer };
  } catch (e) {
    peer.close();
    throw e;
  }
}

// ── core side ───────────────────────────────────────────────────

export interface RtcHostOptions {
  factory: RtcFactory;
  iceServers: string[];
  /** Run the session handshake on the channel; resolves with the device it authenticated, if any. */
  accept: (wire: Wire) => Promise<{ deviceId: string; close: (why: string) => void } | undefined>;
  /** Peer connections being set up at once, over all devices (default 8). */
  maxPending?: number;
  /** How long a peer may take from offer to an open channel (default 20 s). */
  setupMs?: number;
  log?: (m: string) => void;
}

/**
 * Answers `rtc.offer` from an authenticated device session. One pending
 * setup per device; the session that comes up on the channel must
 * authenticate as that same device, or it is closed.
 */
export class RtcHost {
  readonly iceServers: string[];
  private readonly o: RtcHostOptions;
  private readonly pending = new Map<string, RtcPeer>();
  private readonly live = new Set<RtcPeer>();
  private closed = false;

  constructor(o: RtcHostOptions) {
    this.o = o;
    this.iceServers = normalizeIceServers(o.iceServers);
  }

  get enabled(): boolean {
    return !this.closed && this.iceServers.length > 0;
  }

  /** What `ready` tells devices (nothing when off, so they never try). */
  readyInfo(): Record<string, unknown> {
    return this.enabled ? { rtc: { iceServers: this.iceServers } } : {};
  }

  async answer(deviceId: string, sdp: unknown): Promise<{ sdp: string }> {
    if (!this.enabled) throw new LinkError("refused", "direct connection is off");
    if (typeof sdp !== "string" || !sdp || sdp.length > RTC_MAX_SDP)
      throw new LinkError("malformed", "sdp is required");
    if (this.pending.has(deviceId)) throw new LinkError("rate_limited", "already setting up");
    if (this.pending.size >= (this.o.maxPending ?? 8))
      throw new LinkError("rate_limited", "too many at once");
    const peer = this.o.factory({ iceServers: this.iceServers });
    this.pending.set(deviceId, peer);
    const setupMs = this.o.setupMs ?? 20_000;
    let answer: string;
    try {
      answer = await withTimeout(peer.answer(sdp), setupMs, "answer took too long");
    } catch (e) {
      this.pending.delete(deviceId);
      peer.close();
      throw e instanceof LinkError ? e : new LinkError("malformed", "could not use this offer");
    }
    void this.finish(deviceId, peer, setupMs);
    return { sdp: answer };
  }

  private async finish(deviceId: string, peer: RtcPeer, setupMs: number) {
    try {
      const ch = await peer.channel(setupMs);
      const wire = channelWire(ch);
      peer.onDown((why) => wire.close(`rtc ${why}`));
      wire.onClose(() => {
        this.live.delete(peer);
        peer.close();
      });
      this.pending.delete(deviceId);
      if (this.closed) return wire.close("closing");
      this.live.add(peer);
      const s = await this.o.accept(wire);
      if (!s) return wire.close("handshake failed");
      if (s.deviceId !== deviceId) {
        this.o.log?.(`link: rtc session for ${deviceId} authenticated as ${s.deviceId}; closed`);
        s.close("wrong device");
      }
    } catch (e) {
      this.pending.delete(deviceId);
      peer.close();
      this.o.log?.(`link: rtc setup for ${deviceId} failed: ${(e as Error).message}`);
    }
  }

  /** End every direct channel now (devices fall back to the relay); new ones may still be set up. */
  closePeers(): void {
    for (const p of this.pending.values()) p.close();
    for (const p of this.live) p.close();
    this.pending.clear();
    this.live.clear();
  }

  close(): void {
    this.closed = true;
    for (const p of this.pending.values()) p.close();
    for (const p of this.live) p.close();
    this.pending.clear();
    this.live.clear();
  }
}
