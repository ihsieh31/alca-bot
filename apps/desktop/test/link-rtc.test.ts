import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateIdentity, LinkClient, loadNodeRtc, pairDevice, type RtcFactory } from "@alca/link";
import { startRendezvous } from "@alca/rendezvous";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startDesktop } from "../src/index.ts";

/**
 * P13: the desktop answers a phone's WebRTC offer over the sealed session
 * when settings name STUN servers (engineering.rtc.iceServers); the phone's
 * session moves onto the DataChannel and the phone ops work there with the
 * same scopes. With no servers set (the default) nothing is advertised and
 * `rtc.offer` is refused.
 */

vi.setConfig({ testTimeout: 40_000 });

const until = async (f: () => boolean | Promise<boolean>, ms = 15_000) => {
  const t = Date.now();
  while (!(await f())) {
    if (Date.now() - t > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
};

async function boot(iceServers: string[] | undefined) {
  const dir = mkdtempSync(join(tmpdir(), "alca-link-rtc-"));
  if (iceServers)
    writeFileSync(join(dir, "config.json"), JSON.stringify({ engineering: { rtc: { iceServers } } }));
  const relay = await startRendezvous({ port: 0 });
  const app = await startDesktop({
    engine: "demo",
    dataDir: dir,
    port: 0,
    browser: "off",
    vaultKeySource: "file",
    rendezvous: relay.url,
  });
  return { dir, relay, app };
}

describe("desktop × WebRTC direct path", () => {
  let rig: Awaited<ReturnType<typeof boot>>;
  let plain: Awaited<ReturnType<typeof boot>>;
  let factory: RtcFactory;
  const clients: LinkClient[] = [];
  const phone = async (r: Awaited<ReturnType<typeof boot>>, scopes: string[], rtc = true) => {
    const res = await fetch(`${r.app.server.url}/api/link/pairings`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${r.app.token}`,
        ...r.app.uiHeaders,
        "content-type": "application/json",
      },
      body: JSON.stringify({ scopes }),
    });
    const p = (await res.json()) as { display: string; coreFingerprint: string };
    const identity = await generateIdentity();
    const credentials = await pairDevice({
      relayUrl: r.relay.url,
      code: p.display,
      identity,
      device: { name: "測試 iPhone", kind: "phone", platform: "headless" },
      expectFingerprint: p.coreFingerprint,
    });
    const c = new LinkClient({
      credentials,
      identity,
      pingSec: 0,
      backoff: { first: 50, max: 300 },
      ...(rtc ? { rtc: (o: Parameters<RtcFactory>[0]) => factory({ ...o, gatherMs: 1200 }) } : {}),
    });
    clients.push(c);
    c.start();
    await until(() => c.status === "online");
    return c;
  };

  beforeAll(async () => {
    factory = (await loadNodeRtc()) as RtcFactory;
    rig = await boot(["stun:127.0.0.1:9"]);
    plain = await boot(undefined);
  }, 40_000);
  afterAll(async () => {
    for (const c of clients) c.stop();
    for (const r of [rig, plain]) {
      await r?.app.close();
      await r?.relay.close();
      if (r) rmSync(r.dir, { recursive: true, force: true });
    }
  });

  it("advertises its STUN servers, answers the offer and serves the phone on the channel", async () => {
    const c = await phone(rig, ["chat"]);
    expect(c.ready?.rtc).toEqual({ iceServers: ["stun:127.0.0.1:9"] });
    await until(() => c.via === "rtc");
    const live = rig.app.link?.host.sessions().map((s) => s.via);
    expect(live).toContain("rtc");
    const t = await c.request<{ id: string }>("threads.create", { title: "直連" });
    expect((await c.request<Array<{ id: string }>>("threads.list")).some((x) => x.id === t.id)).toBe(true);
    // Scopes are the same on every path.
    await expect(
      c.request("approvals.answer", { approvalId: "apv_x", decision: "approved" }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("by default nothing is advertised and an offer is refused", async () => {
    const c = await phone(plain, ["chat"], false);
    expect(c.ready).not.toHaveProperty("rtc");
    expect(plain.app.link?.rtc).toBeUndefined();
    await expect(c.request("rtc.offer", { sdp: "v=0" })).rejects.toMatchObject({ code: "unavailable" });
  });
});
