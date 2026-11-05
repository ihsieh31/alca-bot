import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateIdentity, LinkClient, pairDevice } from "@alca/link";
import type { AgentsEvent } from "@alca/protocol";
import { startRendezvous } from "@alca/rendezvous";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type DesktopApp, startDesktop } from "../src/index.ts";

/**
 * Add-ons per bot (P14) over the loopback API and Link: the list with
 * defaults and usage, on / off and settings through the add-on's checks,
 * 提前做 and shell review as adapters over the bot's columns, and the phone
 * ops (`chat` reads, `approve` changes).
 */
vi.setConfig({ testTimeout: 30_000 });

const until = async (f: () => boolean | Promise<boolean>, ms = 8000) => {
  const t = Date.now();
  while (!(await f())) {
    if (Date.now() - t > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

// biome-ignore lint/suspicious/noExplicitAny: test JSON
type Json = any;

describe("desktop × add-ons", () => {
  let app: DesktopApp;
  let relay: Awaited<ReturnType<typeof startRendezvous>>;
  let dir: string;
  let bot: string;
  const clients: LinkClient[] = [];
  const events: AgentsEvent[] = [];
  const api = async (
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: Json }> => {
    const res = await fetch(`${app.server.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${app.token}`, ...app.uiHeaders, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const phone = async (scopes: string[]) => {
    const p = (await api("POST", "/api/link/pairings", { scopes })).body;
    const identity = await generateIdentity();
    const credentials = await pairDevice({
      relayUrl: relay.url,
      code: String(p.display),
      identity,
      device: { name: "測試手機", kind: "phone", platform: "headless" },
      expectFingerprint: String(p.coreFingerprint),
    });
    const client = new LinkClient({ credentials, identity, pingSec: 0, backoff: { first: 50, max: 300 } });
    client.start();
    clients.push(client);
    await until(() => client.status === "online");
    return client;
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "alca-addons-"));
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
    bot = app.core.defaultBotId;
    app.agents?.subscribe((e) => events.push(e));
  }, 30_000);
  afterAll(async () => {
    for (const c of clients) c.stop();
    await app?.close();
    await relay?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists every built-in add-on, off, with defaults and today's usage", async () => {
    const r = await api("GET", `/api/bots/${bot}/addons`);
    expect(r.status).toBe(200);
    expect(r.body.addons.map((a: Json) => a.id)).toEqual([
      "proactive",
      "reply-check",
      "early-work",
      "shell-review",
    ]);
    expect(r.body.addons.every((a: Json) => a.enabled === false)).toBe(true);
    expect(r.body.addons[0]).toMatchObject({
      costClass: "proactive",
      usage: { tokenCap: 30000, runCap: 6, capped: false },
      // Gap analysis 2026-11 P14: 主動留意's precision over 30 days (no decisions yet → null rates).
      metrics: { windowDays: 30, candidates: 0, acceptRate: null, dismissRate: null, ignoredRate: null },
    });
    expect(r.body.addons[1].metrics).toBeUndefined();
    expect((await api("GET", "/api/bots/bot_nothing/addons")).status).toBe(404);
  });

  it("turns one on with settings; refuses bad values; adapters write the bot's own columns", async () => {
    const on = await api("PATCH", `/api/bots/${bot}/addons/proactive`, {
      enabled: true,
      settings: { maxPerDay: 3 },
    });
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ enabled: true, settings: { maxPerDay: 3 } });
    expect(
      (await api("PATCH", `/api/bots/${bot}/addons/proactive`, { settings: { maxPerDay: 0 } })).status,
    ).toBe(400);
    expect((await api("PATCH", `/api/bots/${bot}/addons/proactive`, { color: "x" })).status).toBe(400);
    expect((await api("PATCH", `/api/bots/${bot}/addons/nothing`, { enabled: true })).status).toBe(404);
    expect((await api("POST", `/api/bots/${bot}/addons/proactive`, {})).status).toBe(405);
    const early = await api("PATCH", `/api/bots/${bot}/addons/early-work`, {
      enabled: true,
      settings: { quietHours: "22:00-07:00" },
    });
    expect(early.status).toBe(200);
    const team = (await api("GET", "/api/team")).body;
    expect(team.bots.find((b: Json) => b.id === bot)).toMatchObject({
      earlyWork: "on",
      quietHours: "22:00-07:00",
    });
    expect(
      (await api("PATCH", `/api/bots/${bot}/addons/shell-review`, { settings: { engine: "no-such-engine" } }))
        .status,
    ).toBe(400);
    // The rest of /api/bots still belongs to the team area.
    expect((await api("PATCH", `/api/bots/${bot}`, { role: "總管" })).status).toBe(200);
  });

  it("the phone reads with chat and changes with approve", async () => {
    const chat = await phone(["chat"]);
    const list = await chat.request<{ addons: Json[] }>("team.bots.addons.list", { botId: bot });
    expect(list.addons).toHaveLength(4);
    await expect(
      chat.request("team.bots.addons.set", { botId: bot, addonId: "reply-check", enabled: true }),
    ).rejects.toThrow();
    const ok = await phone(["chat", "approve"]);
    const v = await ok.request<Json>("team.bots.addons.set", {
      botId: bot,
      addonId: "reply-check",
      enabled: true,
    });
    expect(v.enabled).toBe(true);
    await expect(
      ok.request("team.bots.addons.set", {
        botId: bot,
        addonId: "reply-check",
        settings: { timeoutSec: 99 },
      }),
    ).rejects.toThrow();
  });

  it("主動留意 cards: listed for the person, answered over the API and the phone", async () => {
    const offers = app.agents!.offers;
    const thread = app.core.createThread("主動留意", bot).id;
    const add = (text: string) =>
      offers.add({
        botId: bot,
        threadId: thread,
        source: "addon:proactive",
        category: "study",
        topic: "排進度",
        text,
        action: "排進度",
      });
    const a = add("報告 11 月 7 日截止。要我幫你排寫作進度嗎？");
    const b = add("模擬考 11 月 9 日。要我幫你排複習嗎？");
    expect(events.some((e) => e.type === "offer.created")).toBe(true);
    const listed = await api("GET", "/api/offers");
    expect(listed.body.offers.map((o: Json) => o.id).sort()).toEqual([a.id, b.id].sort());
    expect((await api("POST", `/api/offers/${a.id}/answer`, { choice: "maybe" })).status).toBe(400);
    expect((await api("POST", "/api/offers/ofr_nothing/answer", { choice: "later" })).status).toBe(404);
    const later = await api("POST", `/api/offers/${a.id}/answer`, { choice: "later" });
    expect(later.body.status).toBe("declined");

    const chat = await phone(["chat"]);
    const seen = await chat.request<{ offers: Json[] }>("offers.list", {});
    expect(seen.offers.map((o) => o.id)).toEqual([b.id]);
    await expect(chat.request("offers.answer", { offerId: b.id, choice: "never" })).rejects.toThrow();
    const ok = await phone(["chat", "approve"]);
    const never = await ok.request<Json>("offers.answer", { offerId: b.id, choice: "never" });
    expect(never.status).toBe("declined");
    expect(app.core.store.memory.list().some((m) => m.body === "不要主動提：讀書・排進度")).toBe(true);
  });

  it("回覆檢查's model: the bot's router model by default, or one of its configured model services", async () => {
    const before = (await api("GET", `/api/bots/${bot}/addons`)).body.addons.find(
      (a: Json) => a.id === "reply-check",
    );
    expect(before.settings).toMatchObject({ engine: null, model: null });
    expect(before.modelChoices[0]).toEqual({
      engine: null,
      model: null,
      label: "跟這個 bot 的總機模型一樣（預設）",
    });
    const added = await api("POST", "/api/providers", {
      kind: "openai",
      label: "小模型伺服器",
      baseUrl: "http://127.0.0.1:9/v1",
      models: "tiny-1",
      key: "sk-test-addon-model-0003",
    });
    expect(added.status).toBe(201);
    const engineId = added.body.id as string;
    const view = (await api("GET", `/api/bots/${bot}/addons`)).body.addons.find(
      (a: Json) => a.id === "reply-check",
    );
    const mine = view.modelChoices.filter((c: Json) => c.engine === engineId);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine[0].label).toContain("小模型伺服器");
    expect(JSON.stringify(view)).not.toContain("sk-test-addon-model-0003");
    // Something not configured for the bot is refused.
    const bad = await api("PATCH", `/api/bots/${bot}/addons/reply-check`, {
      settings: { engine: "no-such-service", model: null },
    });
    expect(bad.status).toBe(400);
    const pick = mine[0];
    const ok = await api("PATCH", `/api/bots/${bot}/addons/reply-check`, {
      settings: { engine: pick.engine, model: pick.model },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.settings).toMatchObject({ engine: pick.engine, model: pick.model });
    // The phone picks with approve, and can go back to the router model.
    const p = await phone(["chat", "approve"]);
    const back = await p.request<Json>("team.bots.addons.set", {
      botId: bot,
      addonId: "reply-check",
      settings: { engine: null, model: null },
    });
    expect(back.settings).toMatchObject({ engine: null, model: null });
  });
});
