import { openStore } from "@alca/store";
import { describe, expect, it } from "vitest";
import {
  type Candidate,
  estimateTokens,
  HashingEmbedder,
  type MemoryChange,
  MemoryService,
  matchesTombstone,
  StepsDrafter,
  scheduleOf,
  skillMatches,
  tombstoneDigest,
  tombstoneShingles,
} from "../src/index.ts";

const pref = (body: string, subject = ""): Candidate => ({
  kind: "preference",
  subject,
  body,
  quote: body,
  confidence: 0.7,
});

function svc(embedder?: HashingEmbedder) {
  const store = openStore(":memory:");
  const changes: MemoryChange[] = [];
  const s = new MemoryService({ store, onChange: (c) => changes.push(c), ...(embedder ? { embedder } : {}) });
  return { store, s, changes, bot: store.bots.ensureDefault().id };
}

describe("tombstones", () => {
  it("match rewordings of what was forgotten, not unrelated text", () => {
    const k = "00".repeat(32);
    const t = {
      digest: tombstoneDigest(k, "喜歡燕麥奶拿鐵"),
      shingles: tombstoneShingles(k, "我喜歡燕麥奶拿鐵"),
    };
    expect(matchesTombstone(k, "喜歡燕麥奶拿鐵", t)).toBe(true);
    expect(matchesTombstone(k, "使用者喜歡燕麥奶拿鐵，少冰", t)).toBe(true);
    expect(matchesTombstone(k, "喜歡喝豆漿", t)).toBe(false);
    expect(t.shingles.every((x) => /^[0-9a-f]{8}$/.test(x))).toBe(true);
  });
});

describe("MemoryService", () => {
  it("edit supersedes, rescope and confirm change only metadata, every change is reported", () => {
    const { s, store, changes, bot } = svc();
    const a = s.learn(bot, pref("喜歡貓", "pref:貓")).memory!;
    expect(a.origin).toBe("inferred");
    const b = s.edit(a.id, { body: "喜歡橘貓" }).memory!;
    expect(b).toMatchObject({ origin: "user", supersedes: a.id, source: { kind: "ui" } });
    expect(s.rescope(b.id, "bot")?.scope).toBe("bot");
    expect(changes.map((c) => c.op)).toEqual(["added", "superseded", "rescoped"]);
    const c = s.learn(bot, pref("住在台中", "home")).memory!;
    expect(s.confirm(c.id)?.origin).toBe("user");
    expect(store.memory.get(a.id)?.status).toBe("superseded");
  });

  it("remember lifts a matching tombstone; learn respects it", () => {
    const { s, store, bot } = svc();
    const a = s.learn(bot, pref("喜歡爵士樂")).memory!;
    s.forget(a.id);
    expect(s.learn(bot, pref("喜歡爵士樂")).status).toBe("forgotten");
    expect(s.remember(bot, { ...pref("喜歡爵士樂"), confidence: 1 }).status).toBe("stored");
    expect(store.memory.list()[0]?.origin).toBe("user");
  });

  it("dedupes, and a repeated statement by the person confirms an inferred item", () => {
    const { s, bot } = svc();
    const a = s.learn(bot, pref("喜歡貓")).memory!;
    expect(s.learn(bot, pref("喜歡貓")).status).toBe("duplicate");
    expect(s.remember(bot, { ...pref("喜歡貓"), confidence: 1 })).toMatchObject({
      status: "confirmed",
      memory: { id: a.id, origin: "user" },
    });
  });

  it("recall fits the token budget, matched items first, then standing ones", async () => {
    const { s, bot } = svc();
    for (let i = 0; i < 30; i++)
      s.remember(bot, { ...pref(`喜歡第${i}種茶葉，每天都要喝一壺`), confidence: 1 });
    s.remember(bot, { kind: "project", subject: "p", body: "正在重構 Alca", quote: "q", confidence: 1 });
    const r = await s.recall(bot, "Alca 重構進度", 60);
    expect(r[0]).toMatchObject({ body: "正在重構 Alca", why: "match" });
    const used = r.reduce((n, e) => n + estimateTokens(`- ${e.body}（xx・${e.id}）`) + 2, 0);
    expect(used).toBeLessThanOrEqual(80);
    expect(r.length).toBeGreaterThan(1);
    expect(await s.recall(bot, "x", 0)).toEqual([]);
  });

  it("per bot: a bot's own notes are invisible to other bots; the shared model is not", async () => {
    const { s, store, bot } = svc();
    const other = store.bots.create("研究員").id;
    s.remember(bot, { kind: "project", subject: "", body: "專案代號藍鯨", quote: "q", confidence: 1 });
    s.remember(bot, { ...pref("喜歡藍色"), confidence: 1 });
    expect((await s.search(other, "藍")).map((m) => m.body)).toEqual(["喜歡藍色"]);
    expect((await s.search(bot, "藍")).length).toBe(2);
  });

  it("hybrid search uses the embedding hook when one is plugged in (local, no network)", async () => {
    const { s, bot, store } = svc(new HashingEmbedder(64));
    s.remember(bot, { ...pref("喜歡燕麥奶拿鐵"), confidence: 1 });
    await new Promise((r) => setTimeout(r, 10));
    expect(store.memory.list()[0]?.embedded).toBe(true);
    expect((await s.search(bot, "燕麥奶")).length).toBe(1);
  });

  it("exports everything a bot can read with provenance and history", () => {
    const { s, bot } = svc();
    const a = s.learn(bot, pref("喜歡貓", "pref:貓"), { threadId: "thr_x", messageId: "msg_y" }).memory!;
    s.edit(a.id, { body: "喜歡橘貓" });
    const out = s.export(bot) as { memories: Array<{ body: string; history: unknown[] }>; format: string };
    expect(out.format).toBe("alca.memory.export.v1");
    expect(out.memories[0]).toMatchObject({ body: "喜歡橘貓", history: [{ body: "喜歡貓" }] });
  });
});

describe("skill drafting", () => {
  it("triggers keep a URL (and a time) whole instead of splitting at ':' (mac test #6)", async () => {
    const calls = [
      {
        tool: "browser_open",
        args: { url: "https://example.com" },
        actionClass: "network" as const,
        ok: true,
      },
      { tool: "browser_snapshot", args: {}, actionClass: "read" as const, ok: true },
    ];
    const d = await new StepsDrafter(2).draft({
      title: "讀標題",
      goal: "用瀏覽器打開 https://example.com，讀出標題: 只回覆標題",
      calls,
    });
    expect(d?.triggers).toContain("用瀏覽器打開 https://example.com");
    expect(d?.triggers).toContain("讀出標題");
    expect(d?.triggers).toContain("只回覆標題");
    expect(d?.triggers.some((t) => t.endsWith("https") || t.startsWith("//"))).toBe(false);
    const t = await new StepsDrafter(2).draft({ title: "x", goal: "每天 10:30 整理信件", calls });
    expect(t?.triggers).toContain("每天 10:30 整理信件");
    // A numbered procedure is not a trigger, nor is the second half of a step (mac test 2026-11-04).
    const steps = await new StepsDrafter(2).draft({
      title: "建立待辦檔",
      goal: "1) 先確認檔案存在，若不存在就建立 2) 寫入今天的待辦",
      calls,
    });
    expect(steps?.triggers).toEqual(["建立待辦檔"]);
    const half = await new StepsDrafter(2).draft({ title: "x", goal: "整理收件匣，然後回覆老闆", calls });
    expect(half?.triggers).toEqual(["整理收件匣"]);
  });

  it("keeps the time the person asked for (mac test 2026-11-04b A8)", async () => {
    expect(scheduleOf("以後每天 09:30 用瀏覽器打開 https://example.com/news 看標題")).toBe("每天 09:30");
    expect(scheduleOf("每週一 早上9點半 整理信件")).toBe("每週一 早上9點半");
    expect(scheduleOf("每隔 2 小時看一次")).toBe("每隔2小時");
    expect(scheduleOf("每天０９：３０")).toBe("每天 09:30");
    expect(scheduleOf("打開 https://example.com 10:30")).toBeUndefined();
    const calls = [
      {
        tool: "browser_open",
        args: { url: "https://example.com/news" },
        actionClass: "network" as const,
        ok: true,
      },
      { tool: "browser_snapshot", args: {}, actionClass: "read" as const, ok: true },
    ];
    // The worker's goal (the router's rewrite) has no time; the person's request does.
    const d = await new StepsDrafter(2).draft({
      title: "讀取 example.com/news 頁面標題",
      goal: "用瀏覽器打開 https://example.com/news，讀出頁面的標題",
      request: "以後每天 09:30 用瀏覽器打開 https://example.com/news 看標題。先學起來這個做法，現在先做一次",
      calls,
    });
    expect(d?.triggers[0]).toBe("每天 09:30");
    expect(d?.triggers).toContain("用瀏覽器打開 https://example.com/news");
    expect(d?.description).toMatch(/想定時做：每天 09:30.*例行工作/);
    expect(d!.description.length).toBeLessThanOrEqual(300);
    const none = await new StepsDrafter(2).draft({ title: "讀標題", goal: "讀出標題", calls });
    expect(none?.description).toBe("讀出標題");
  });

  it("keeps successful steps, drops page refs, masks secrets, folds repeats", async () => {
    const d = await new StepsDrafter(2).draft({
      title: "示範商店結帳",
      goal: "在示範商店結帳，密碼是 hunter2",
      calls: [
        {
          tool: "browser_open",
          args: { url: "http://shop.test/checkout" },
          actionClass: "network",
          ok: true,
        },
        { tool: "browser_snapshot", args: {}, actionClass: "read", ok: true },
        { tool: "browser_snapshot", args: {}, actionClass: "read", ok: true },
        {
          tool: "browser_type",
          args: { ref: "@4", text: "x", password: "hunter2" },
          actionClass: "write",
          ok: false,
        },
        {
          tool: "browser_click",
          args: { ref: "@7" },
          actionClass: "payment",
          ok: true,
          summary: "在 shop.test 按下「確認付款 NT$1,280」",
        },
      ],
    });
    expect(d?.steps.map((s) => s.tool)).toEqual(["browser_open", "browser_snapshot", "browser_click"]);
    expect(d?.steps[2]).toMatchObject({ args: {}, text: "按下：在 shop.test 按下「確認付款 NT$1,280」" });
    expect(d?.actionClasses).toEqual(["network", "payment", "read"]);
    expect(JSON.stringify(d)).not.toContain("hunter2");
    expect(d?.triggers).toContain("示範商店結帳");
    expect(skillMatches("幫我在示範商店結帳", d!)).toBe(true);
    expect(skillMatches("今天天氣如何", d!)).toBe(false);
    expect(await new StepsDrafter(2).draft({ title: "x", goal: "x", calls: [] })).toBeUndefined();
  });
});
