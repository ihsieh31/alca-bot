// P13: a paired phone moves its session from the relay onto a direct WebRTC
// DataChannel (signaled inside the sealed session, the Link handshake and
// sealed frames on top), and falls back to the relay by itself when the
// channel goes away. Both ends use werift here; the page's RTCPeerConnection
// is checked against Chromium by the phone screenshot run.
import {
  generateIdentity,
  type HostSession,
  LinkClient,
  LinkError,
  LinkHost,
  loadNodeRtc,
  type RtcFactory,
  RtcHost,
} from "@alca/link";
import { afterEach, describe, expect, it } from "vitest";
import { startRendezvous } from "../src/server.ts";
import { cleanup, cleanups, MemoryDevices, pairPhone, until } from "./helpers.ts";

afterEach(cleanup);

async function rig(iceServers: string[]) {
  const factory = (await loadNodeRtc()) as RtcFactory;
  const seen: string[] = [];
  const relay = await startRendezvous({
    port: 0,
    tap: (_dir, payload) => seen.push(JSON.stringify(payload)),
  });
  cleanups.push(() => relay.close());
  const sessions: HostSession[] = [];
  let rtc: RtcHost | undefined;
  const host: LinkHost = new LinkHost({
    relayUrl: relay.url,
    identity: await generateIdentity(true),
    coreName: "測試桌機",
    devices: new MemoryDevices(),
    backoff: { first: 50, max: 200 },
    readyInfo: () => rtc?.readyInfo() ?? {},
    onSession: (s) => {
      sessions.push(s);
      s.peer.handle(async (op, args) => {
        if (op === "ping") return "pong";
        if (op === "where") return s.via;
        if (op === "rtc.offer") return rtc?.answer(s.device.id, args.sdp);
        throw new LinkError("refused", "unknown op");
      });
    },
  });
  rtc = new RtcHost({
    factory,
    iceServers,
    accept: async (wire) => {
      const s = await host.acceptWire(wire, "rtc");
      return s ? { deviceId: s.device.id, close: (why) => s.peer.close(why) } : undefined;
    },
  });
  await host.start();
  cleanups.push(() => host.close());
  const { creds, phone } = await pairPhone(relay, host);
  const c = new LinkClient({
    credentials: creds,
    identity: phone,
    backoff: { first: 50, max: 200 },
    pingSec: 0,
    rtc: (o) => factory({ ...o, gatherMs: 1200 }),
    rtcRetryMs: 60_000,
  });
  cleanups.push(() => c.stop());
  return { relay, host, rtc, sessions, client: c, seen };
}

describe("WebRTC direct path (P13)", () => {
  it("moves onto a DataChannel; the relay never sees the SDP; the session is re-authenticated on it", async () => {
    // A STUN server nobody answers: host candidates still connect two peers on one machine.
    const { client: c, sessions, seen } = await rig(["stun:127.0.0.1:9"]);
    const readies: string[] = [];
    c.onReady(() => readies.push(c.via ?? ""));
    c.start();
    await until(() => c.status === "online");
    await until(() => c.via === "rtc", 15_000);
    expect(c.rtcStats.state).toBe("up");
    expect(readies).toEqual(["relay", "rtc"]); // the app re-subscribes on the new session
    expect(await c.request("where")).toBe("rtc");
    expect(sessions.map((s) => s.via)).toEqual(["relay", "rtc"]);
    // Signaling went inside sealed frames: no SDP, fingerprint or candidate on the relay.
    const all = seen.join("\n");
    expect(all).not.toMatch(/a=fingerprint|a=candidate|v=0/);
    // The old relay session is closed shortly after; requests keep going over the channel only.
    await until(() => sessions[0]?.peer.closed === true, 6000);
    await new Promise((r) => setTimeout(r, 200));
    const before = seen.length;
    for (let i = 0; i < 5; i++) expect(await c.request("ping")).toBe("pong");
    expect(seen.slice(before)).toEqual([]);
  }, 30_000);

  it("falls back to the relay by itself when the direct channel goes away", async () => {
    const { client: c, rtc, sessions } = await rig(["stun:127.0.0.1:9"]);
    c.start();
    await until(() => c.via === "rtc", 15_000);
    rtc.closePeers(); // the computer's side of every DataChannel goes away (ICE / DTLS torn down)
    await until(() => c.status === "online" && c.via === "relay", 10_000);
    expect(await c.request("where")).toBe("relay");
    expect(c.rtcStats.state).toBe("failed");
    expect(sessions.at(-1)?.via).toBe("relay");
  }, 30_000);

  it("no ICE servers configured: no WebRTC at all, the relay carries everything", async () => {
    const { client: c, seen } = await rig([]);
    c.start();
    await until(() => c.status === "online");
    await new Promise((r) => setTimeout(r, 400));
    expect(c.via).toBe("relay");
    expect(c.rtcStats).toMatchObject({ state: "off", tries: 0 });
    expect(c.ready).not.toHaveProperty("rtc");
    expect(seen.length).toBeGreaterThan(0);
  });

  it("a phone without WebRTC stays on the relay", async () => {
    const { client: base, host, relay } = await rig(["stun:127.0.0.1:9"]);
    base.stop();
    const { creds, phone } = await pairPhone(relay, host);
    const c = new LinkClient({
      credentials: creds,
      identity: phone,
      pingSec: 0,
      backoff: { first: 50, max: 200 },
    });
    cleanups.push(() => c.stop());
    c.start();
    await until(() => c.status === "online");
    expect(c.rtcStats.state).toBe("unavailable");
    expect(c.via).toBe("relay");
  });
});
