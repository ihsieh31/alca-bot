import { describe, expect, it } from "vitest";
import {
  bufferedChannel,
  channelWire,
  normalizeIceServers,
  RTC_CHUNK,
  type RtcChannel,
  type RtcFactory,
  RtcHost,
  type RtcPeer,
} from "../src/browser.ts";
import { loadNodeRtc } from "../src/node/werift.ts";

/** Two RtcChannels joined back to back (what a DataChannel pair looks like to the wire). */
function channelPair(): [ReturnType<typeof bufferedChannel>, ReturnType<typeof bufferedChannel>] {
  let b: ReturnType<typeof bufferedChannel>;
  const sent: string[] = [];
  const a = bufferedChannel({
    send: (d) => {
      sent.push(d);
      queueMicrotask(() => b.deliver(d));
    },
    close: () =>
      queueMicrotask(() => {
        a.ended();
        b.ended();
      }),
    bufferedAmount: () => 0,
  });
  b = bufferedChannel({
    send: (d) => queueMicrotask(() => a.deliver(d)),
    close: () =>
      queueMicrotask(() => {
        a.ended();
        b.ended();
      }),
    bufferedAmount: () => 0,
  });
  (a as unknown as { sent: string[] }).sent = sent;
  return [a, b];
}

describe("WebRTC direct path — pieces (P13)", () => {
  it("accepts STUN URLs only, nothing built in", () => {
    expect(normalizeIceServers(undefined)).toEqual([]);
    expect(normalizeIceServers([])).toEqual([]);
    expect(
      normalizeIceServers([
        "stun:stun.example.com:3478",
        "stuns:stun.example.com",
        "stun:[::1]:3478",
        "stun:192.0.2.1",
        "turn:turn.example.com",
        "stun:user:pass@stun.example.com",
        "stun:stun.example.com?transport=tcp",
        "stun:host:99999",
        "https://example.com",
        42,
        "stun:stun.example.com:3478",
      ]),
    ).toEqual(["stun:stun.example.com:3478", "stuns:stun.example.com", "stun:[::1]:3478", "stun:192.0.2.1"]);
    expect(normalizeIceServers(["stun:a", "stun:b", "stun:c", "stun:d", "stun:e"])).toHaveLength(4);
  });

  it("a DataChannel wire cuts big messages into chunks and puts them back together", async () => {
    const [a, b] = channelPair();
    const wa = channelWire(a);
    const wb = channelWire(b);
    const big = { t: "f", d: "x".repeat(RTC_CHUNK * 3 + 7) };
    wa.send(big);
    wa.send({ t: "hello", n: 1 });
    expect(await wb.recv(1000)).toEqual(big);
    expect(await wb.recv(1000)).toEqual({ t: "hello", n: 1 });
    const sent = (a as unknown as { sent: string[] }).sent;
    expect(sent.length).toBe(5);
    expect(sent.every((c) => c.length <= RTC_CHUNK + 1)).toBe(true);
    expect(sent.slice(0, 3).every((c) => c.startsWith("+"))).toBe(true);
    wa.close();
    await expect(wb.recv(1000)).rejects.toThrow();
  });

  it("anything that is not a chunk closes the wire", async () => {
    const [a, b] = channelPair();
    const wb = channelWire(b);
    let why = "";
    wb.onClose((r) => (why = r));
    a.send("{not a chunk}");
    await new Promise((r) => setTimeout(r, 10));
    expect(why).toBe("malformed");
    const [c, d] = channelPair();
    const wd = channelWire(d);
    c.send(".[1,2]");
    await new Promise((r) => setTimeout(r, 10));
    expect(wd.closed).toBe(true);
  });

  it("the core answers one setup per device, refuses when off, and closes a session that is another device", async () => {
    const closed: string[] = [];
    const [ca, cb] = channelPair();
    const fake: RtcFactory = () => {
      const p: RtcPeer = {
        offer: async () => "v=0 offer",
        answer: async (sdp) => `answer to ${sdp}`,
        accept: async () => undefined,
        channel: () => new Promise<RtcChannel>((r) => setTimeout(() => r(cb), 20)),
        onDown: () => undefined,
        close: () => closed.push("peer"),
      };
      return p;
    };
    void ca;
    const off = new RtcHost({ factory: fake, iceServers: [], accept: async () => undefined });
    expect(off.enabled).toBe(false);
    expect(off.readyInfo()).toEqual({});
    await expect(off.answer("dev_1", "v=0")).rejects.toThrow(/off/);

    const host = new RtcHost({
      factory: fake,
      iceServers: ["stun:stun.example.com", "turn:nope"],
      accept: async () => ({ deviceId: "dev_2", close: (why) => closed.push(why) }),
    });
    expect(host.readyInfo()).toEqual({ rtc: { iceServers: ["stun:stun.example.com"] } });
    await expect(host.answer("dev_1", "")).rejects.toThrow();
    await expect(host.answer("dev_1", "x".repeat(20_000))).rejects.toThrow();
    const first = host.answer("dev_1", "v=0");
    await expect(host.answer("dev_1", "v=0")).rejects.toThrow(/already/);
    expect(await first).toEqual({ sdp: "answer to v=0" });
    await new Promise((r) => setTimeout(r, 60));
    // The channel's session authenticated as dev_2, not the device that asked: closed.
    expect(closed).toContain("wrong device");
    host.close();
  });
});

describe("WebRTC direct path — werift on both ends (P13)", () => {
  it("two werift peers open a DataChannel with no ICE servers (host candidates) and carry a big frame", async () => {
    const factory = await loadNodeRtc();
    expect(factory).toBeDefined();
    if (!factory) return;
    const a = factory({ iceServers: [], gatherMs: 1500 });
    const b = factory({ iceServers: [], gatherMs: 1500 });
    try {
      const offer = await a.offer();
      expect(offer).toContain("a=fingerprint");
      const answer = await b.answer(offer);
      await a.accept(answer);
      const [ca, cb] = await Promise.all([a.channel(8000), b.channel(8000)]);
      const wa = channelWire(ca);
      const wb = channelWire(cb);
      const big = { t: "f", d: "y".repeat(200_000) };
      wa.send(big);
      expect(await wb.recv(8000)).toEqual(big);
      wb.send({ t: "back" });
      expect(await wa.recv(8000)).toEqual({ t: "back" });
    } finally {
      a.close();
      b.close();
    }
  }, 20_000);
});
