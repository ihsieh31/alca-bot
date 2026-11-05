import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedEngine, streamText } from "@alca/engines";
import { generateIdentity, LinkClient, pairDevice, relayWsUrl } from "@alca/link";
import { startRendezvous } from "@alca/rendezvous";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type DesktopApp, startDesktop } from "../src/index.ts";
import { checkDirectUrl, checkRelayUrl } from "../src/link-prefs.ts";

/** P9 連線: a stable relay set on the desktop moves the core, survives a restart and reaches the phone. */

vi.setConfig({ testTimeout: 30_000 });

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const until = async (f: () => boolean, ms = 8000) => {
  const t = Date.now();
  while (!f()) {
    if (Date.now() - t > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 15));
  }
};

async function boot(dir: string, rendezvous: string) {
  const app: DesktopApp = await startDesktop({
    engine: "demo",
    dataDir: dir,
    port: 0,
    agents: "direct",
    browser: "off",
    engineOverride: new ScriptedEngine(() => streamText("好", 1)),
    rendezvous,
  });
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${app.server.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${app.token}`, ...app.uiHeaders, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  return { app, api };
}

describe("desktop 連線 (P9)", () => {
  it("checks the URLs it accepts", () => {
    expect(checkRelayUrl("https://example.com/")).toBe("https://example.com");
    expect(checkRelayUrl("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
    expect(() => checkRelayUrl("http://relay.example.com")).toThrow(/https/);
    expect(() => checkRelayUrl("https://u:p@relay.example.com")).toThrow();
    expect(checkDirectUrl("wss://mac.tailnet.ts.net")).toBe("wss://mac.tailnet.ts.net/v0/link");
    expect(() => checkDirectUrl("https://mac.tailnet.ts.net")).toThrow(/wss/);
  });

  it("a stable relay set in 連線 moves the core and the paired phone along, and survives a restart", async () => {
    const first = await startRendezvous({ port: 0 });
    const stable = await startRendezvous({ port: 0 });
    const dir = mkdtempSync(join(tmpdir(), "alca-conn-"));
    cleanups.push(
      () => rmSync(dir, { recursive: true, force: true }),
      () => first.close(),
      () => stable.close(),
    );
    let { app, api } = await boot(dir, first.url);
    let closed = false;
    cleanups.push(() => (closed ? undefined : app.close()));

    const conn = (await api("GET", "/api/link/connection")).body;
    expect(conn).toMatchObject({ status: "online", stableRelayUrl: null, selfCheckMinutes: 15 });
    expect(conn.relayUrl).toBe(relayWsUrl(first.url));

    // Pair a phone on the first relay.
    const pairing = (await api("POST", "/api/link/pairings", {})).body;
    const phone = await generateIdentity();
    const creds = await pairDevice({
      relayUrl: first.url,
      code: String(pairing.code),
      identity: phone,
      device: { name: "iPhone", kind: "phone", platform: "test" },
    });
    const c = new LinkClient({
      credentials: creds,
      identity: phone,
      backoff: { first: 50, max: 200 },
      pingSec: 0,
    });
    cleanups.push(() => c.stop());
    c.start();
    await until(() => c.status === "online");

    expect((await api("PUT", "/api/link/connection", { relayUrl: "http://relay.example.com" })).status).toBe(
      400,
    );
    const set = await api("PUT", "/api/link/connection", {
      relayUrl: stable.url,
      directUrls: ["wss://mac.tailnet.ts.net"],
    });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ relayUrl: relayWsUrl(stable.url), stableRelayUrl: stable.url });
    expect(set.body.relays).toEqual([relayWsUrl(stable.url), relayWsUrl(first.url)]);
    const file = join(dir, "link.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      relayUrl: stable.url,
      directUrls: ["wss://mac.tailnet.ts.net/v0/link"],
    });
    await until(() => c.status === "online" && c.credentials.relayUrl === relayWsUrl(stable.url));
    expect(c.credentials.direct).toEqual(["wss://mac.tailnet.ts.net/v0/link"]);
    const health = (await c.request("link.health")) as Record<string, unknown>;
    expect(health.status).toBe("online");

    // Restart the core: it comes back on the stable relay and the phone finds it again.
    await app.close();
    closed = true;
    await until(() => c.status !== "online");
    ({ app, api } = await boot(dir, first.url));
    cleanups.push(() => app.close());
    expect((await api("GET", "/api/link/connection")).body.relayUrl).toBe(relayWsUrl(stable.url));
    await until(() => c.status === "online");
    const checked = await api("POST", "/api/link/connection/check");
    expect(checked.body).toMatchObject({ health: { ok: true, reason: "" } });

    // Clearing the stable relay goes back to the default one.
    const cleared = await api("PUT", "/api/link/connection", { directUrls: [] });
    expect(cleared.body).toMatchObject({ relayUrl: relayWsUrl(first.url), stableRelayUrl: null });
    await until(() => c.status === "online" && c.credentials.relayUrl === relayWsUrl(first.url));
  });
});
