// P13: the core's RTCPeerConnection. Node 22 has no WebRTC, so the core uses
// werift (pure TypeScript ICE / DTLS / SCTP; an optional dependency loaded
// only when ICE servers are configured). Nothing here is trusted for
// secrecy: the Link session handshake and sealed frames run on top.
import { LinkError } from "../errors.ts";
import { bufferedChannel, RTC_LABEL, type RtcChannel, type RtcFactory, type RtcPeer } from "../rtc.ts";

interface Sub<T> {
  subscribe(h: (v: T) => void): unknown;
}
interface WDataChannel {
  label: string;
  readyState: string;
  bufferedAmount: number;
  stateChanged: Sub<string>;
  onMessage: Sub<string | Uint8Array>;
  send(d: string): void;
  close(): void;
}
interface WPeer {
  createDataChannel(label: string, o?: Record<string, unknown>): WDataChannel;
  createOffer(): Promise<{ type: string; sdp: string }>;
  createAnswer(): Promise<{ type: string; sdp: string }>;
  setLocalDescription(d: unknown): Promise<unknown>;
  setRemoteDescription(d: { type: string; sdp: string }): Promise<unknown>;
  localDescription?: { sdp: string };
  iceGatheringState: string;
  iceGatheringStateChange: Sub<string>;
  connectionStateChange: Sub<string>;
  onDataChannel: Sub<WDataChannel>;
  close(): Promise<void> | void;
}
type WCtor = new (c: { iceServers: Array<{ urls: string }> }) => WPeer;

function wrap(dc: WDataChannel): RtcChannel {
  const ch = bufferedChannel({
    send: (d) => dc.send(d),
    close: () => dc.close(),
    bufferedAmount: () => dc.bufferedAmount,
  });
  dc.onMessage.subscribe((m) => {
    if (typeof m === "string") ch.deliver(m);
    else dc.close();
  });
  dc.stateChanged.subscribe((s) => {
    if (s === "closed" || s === "closing") ch.ended();
  });
  return ch;
}

const opened = (dc: WDataChannel) =>
  new Promise<RtcChannel>((resolve, reject) => {
    // Wrap first: a message right after "open" must not be lost.
    const ch = wrap(dc);
    if (dc.readyState === "open") return resolve(ch);
    dc.stateChanged.subscribe((s) => {
      if (s === "open") resolve(ch);
      else if (s === "closed") reject(new LinkError("closed", "data channel closed before it opened"));
    });
  });

/** A factory over werift's RTCPeerConnection class. */
export function weriftFactory(Ctor: unknown): RtcFactory {
  const C = Ctor as WCtor;
  return ({ iceServers, gatherMs = 3000 }) => {
    const pc = new C({ iceServers: iceServers.map((urls) => ({ urls })) });
    let got: Promise<RtcChannel> | undefined;
    let made: WDataChannel | undefined;
    const downs: Array<(why: string) => void> = [];
    pc.connectionStateChange.subscribe((s) => {
      if (s === "failed" || s === "closed" || s === "disconnected") for (const h of downs) h(s);
    });
    const gathered = () =>
      new Promise<string>((resolve) => {
        const done = () => resolve(pc.localDescription?.sdp ?? "");
        if (pc.iceGatheringState === "complete") return done();
        const t = setTimeout(done, gatherMs);
        pc.iceGatheringStateChange.subscribe((s) => {
          if (s === "complete") {
            clearTimeout(t);
            done();
          }
        });
      });
    const peer: RtcPeer = {
      async offer() {
        made = pc.createDataChannel(RTC_LABEL, { ordered: true });
        got = opened(made);
        await pc.setLocalDescription(await pc.createOffer());
        return gathered();
      },
      async answer(sdp) {
        got = new Promise<RtcChannel>((resolve) => {
          pc.onDataChannel.subscribe((dc) => {
            if (dc.label === RTC_LABEL) void opened(dc).then(resolve, () => undefined);
          });
        });
        await pc.setRemoteDescription({ type: "offer", sdp });
        await pc.setLocalDescription(await pc.createAnswer());
        return gathered();
      },
      async accept(sdp) {
        await pc.setRemoteDescription({ type: "answer", sdp });
      },
      channel(timeoutMs) {
        const g = got;
        if (!g) return Promise.reject(new LinkError("protocol", "no offer or answer yet"));
        return new Promise<RtcChannel>((resolve, reject) => {
          const t = setTimeout(
            () => reject(new LinkError("timeout", "data channel did not open")),
            timeoutMs,
          );
          g.then(
            (c) => {
              clearTimeout(t);
              resolve(c);
            },
            (e: unknown) => {
              clearTimeout(t);
              reject(e);
            },
          );
        });
      },
      onDown: (h) => downs.push(h),
      close: () => {
        try {
          made?.close();
          void Promise.resolve(pc.close()).catch(() => undefined);
        } catch {
          // already closed
        }
      },
    };
    return peer;
  };
}

/**
 * The core's factory, or undefined when werift is not installed (then the
 * relay carries everything and a line says why).
 */
export async function loadNodeRtc(log?: (m: string) => void): Promise<RtcFactory | undefined> {
  const name = "werift";
  try {
    const mod = (await import(name)) as { RTCPeerConnection?: unknown };
    if (typeof mod.RTCPeerConnection !== "function") throw new Error("no RTCPeerConnection export");
    return weriftFactory(mod.RTCPeerConnection);
  } catch (e) {
    log?.(
      `link: WebRTC direct connection needs the optional "werift" package (${(e as Error).message}); relay only`,
    );
    return undefined;
  }
}
