import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateIdentity, LinkClient, pairDevice } from "@alca/link";
import { startRendezvous } from "@alca/rendezvous";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type DesktopApp, startDesktop } from "../src/index.ts";

/**
 * The team over Alca Link (P7): the phone reads the roster and the trail with
 * `chat`, stopping a request needs `approve`, a message can name who answers
 * (@name or botId) and a new thread can start with a bot; no model-service
 * key or address crosses Link.
 */

vi.setConfig({ testTimeout: 30_000 });

const until = async (f: () => boolean | Promise<boolean>, ms = 8000) => {
  const t = Date.now();
  while (!(await f())) {
    if (Date.now() - t > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe("phone × team", () => {
  let app: DesktopApp;
  let relay: Awaited<ReturnType<typeof startRendezvous>>;
  let dir: string;
  let research: string;
  const clients: LinkClient[] = [];
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${app.server.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${app.token}`, ...app.uiHeaders, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    // biome-ignore lint/suspicious/noExplicitAny: test JSON
    return (await res.json()) as any;
  };
  const phone = async (scopes: string[]) => {
    const p = await api("POST", "/api/link/pairings", { scopes });
    const identity = await generateIdentity();
    const credentials = await pairDevice({
      relayUrl: relay.url,
      code: String(p.display),
      identity,
      device: { name: "測試 iPhone", kind: "phone", platform: "headless" },
      expectFingerprint: String(p.coreFingerprint),
    });
    const client = new LinkClient({ credentials, identity, pingSec: 0, backoff: { first: 50, max: 300 } });
    client.start();
    clients.push(client);
    await until(() => client.status === "online");
    return client;
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "alca-link-team-"));
    relay = await startRendezvous({ port: 0 });
    app = await startDesktop({
      engine: "demo",
      dataDir: dir,
      port: 0,
      browser: "off",
      composioMock: true,
      vaultKeySource: "file",
      rendezvous: relay.url,
    });
    research = (await api("POST", "/api/bots", { name: "研究員", role: "查資料" })).id;
    await api("POST", "/api/providers", {
      kind: "openai",
      label: "遠端服務",
      baseUrl: "https://models.example.test/v1",
      models: ["some-model"],
      key: "sk-never-on-the-phone-123",
    });
  }, 30_000);
  afterAll(async () => {
    for (const c of clients) c.stop();
    await app?.close();
    await relay?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("chat reads the roster and the trail; no service key or address crosses Link", async () => {
    const c = await phone(["chat"]);
    const t = await c.request<{ bots: Array<{ id: string; name: string }>; engines: unknown[] }>(
      "team.get",
      {},
    );
    expect(t.bots.map((b) => b.name)).toEqual(expect.arrayContaining(["Alca", "研究員"]));
    expect(t.engines.length).toBeGreaterThan(1);
    // P11: the registry's providers are listed read-only, with their default model.
    expect(t.engines).toContainEqual({ id: "openai", label: "OpenAI", kind: "api", model: "gpt-6-luna" });
    const raw = JSON.stringify(t);
    expect(raw).not.toContain("sk-never-on-the-phone");
    expect(raw).not.toContain("models.example.test");
    expect(t).not.toHaveProperty("presets");
    expect(await c.request("peers.list", {})).toEqual([]);
    await expect(c.request("peers.stop", { requestId: "prq_nothing" })).rejects.toThrow();
    // Bots are edited on the computer only.
    await expect(c.request("bots.update", { botId: research, name: "x" })).rejects.toThrow(
      /no such operation/,
    );
  });

  it("a new thread can start with a bot; @name answers as that bot; messages carry who spoke", async () => {
    const c = await phone(["chat"]);
    const own = await c.request<{ id: string; botId: string }>("threads.create", {
      title: "找研究員",
      botId: research,
    });
    expect(own.botId).toBe(research);
    await expect(c.request("threads.create", { botId: "bot_nope" })).rejects.toThrow();

    const t = await c.request<{ id: string }>("threads.create", { title: "一般" });
    const sent = await c.request<{ runId: string; botId?: string }>("threads.send", {
      threadId: t.id,
      text: "@研究員 你好",
    });
    expect(sent.botId).toBe(research);
    await until(() => !app.core.isBusy(t.id), 15_000);
    const got = await c.request<{ messages: Array<{ role: string; botId: string | null }> }>("threads.get", {
      threadId: t.id,
    });
    expect(got.messages.some((m) => m.role === "assistant" && m.botId === research)).toBe(true);
  });
});
