import { openStore } from "@alca/store";
import { describe, expect, it } from "vitest";
import { ADDONS, AddonError, AddonService, localDay } from "../src/index.ts";

const make = (o: { canComplete?: boolean; now?: () => Date } = {}) => {
  const store = openStore(":memory:");
  const capped: unknown[] = [];
  const svc = new AddonService({
    store,
    timeZone: "Asia/Taipei",
    ...(o.now ? { now: o.now } : {}),
    env: { canComplete: () => o.canComplete ?? true },
    emit: (d) => capped.push(d),
    earlyMaxPerDay: () => 4,
  });
  return { store, svc, bot: store.bots.default()!.id, capped };
};

describe("add-on registry and service (P14)", () => {
  it("the registry is static, every add-on starts off, ids are unique", () => {
    expect(ADDONS.map((a) => a.id)).toEqual(["proactive", "reply-check", "early-work", "shell-review"]);
    expect(ADDONS.every((a) => a.defaultEnabled === false)).toBe(true);
    const { svc, bot } = make();
    const list = svc.list(bot);
    expect(list.every((a) => !a.enabled)).toBe(true);
    const p = list.find((a) => a.id === "proactive")!;
    expect(p).toMatchObject({ costClass: "proactive", name: "主動留意" });
    expect(p.settings).toMatchObject({
      maxPerDay: 2,
      quietHours: "22:00-08:00",
      minIntervalHours: 3,
      scanMinutes: 30,
      dailyTokenCap: 30_000,
      dailyRunCap: 6,
    });
    expect(p.usage).toMatchObject({ runs: 0, tokens: 0, tokenCap: 30_000, runCap: 6, capped: false });
    expect(list.find((a) => a.id === "reply-check")?.settings).toMatchObject({ dailyTokenCap: 20_000 });
  });

  it("settings are validated by the add-on's schema and merged; bad values are refused", () => {
    const { svc, bot } = make();
    const v = svc.set(bot, "proactive", { settings: { maxPerDay: 4, sources: { mail: false } } });
    expect(v.settings).toMatchObject({ maxPerDay: 4, sources: { calendar: true, mail: false } });
    expect(() => svc.set(bot, "proactive", { settings: { maxPerDay: 9 } })).toThrow(AddonError);
    expect(() => svc.set(bot, "proactive", { settings: { quietHours: "late" } })).toThrow(/安靜時段/);
    expect(() => svc.set(bot, "proactive", { enabled: "yes" })).toThrow(/true 或 false/);
    expect(() => svc.set(bot, "nothing", { enabled: true })).toThrow(/沒有這個擴充/);
  });

  it("an unmet requirement keeps it off", () => {
    const { svc, bot } = make({ canComplete: false });
    expect(svc.view(bot, "proactive").unmet).toHaveLength(1);
    expect(() => svc.set(bot, "proactive", { enabled: true })).toThrow(/還不能開啟/);
    expect(svc.isEnabled(bot, "proactive")).toBe(false);
  });

  it("提前做 and shell review are adapters over the bot's own columns (same meaning)", () => {
    const { store, svc, bot } = make();
    svc.set(bot, "early-work", { enabled: true, settings: { quietHours: "23:00-07:00" } });
    expect(store.bots.get(bot)).toMatchObject({ earlyWork: "on", quietHours: "23:00-07:00" });
    store.bots.update(bot, { earlyWork: "off" });
    expect(svc.isEnabled(bot, "early-work")).toBe(false);
    svc.set(bot, "shell-review", { enabled: true, settings: { engine: "openai", model: "small" } });
    expect(store.bots.get(bot)).toMatchObject({
      shellReview: "on",
      shellReviewEngine: "openai",
      shellReviewModel: "small",
    });
    expect(store.addons.list(bot)).toEqual([]);
    expect(svc.view(bot, "early-work").usage).toMatchObject({ runs: 0, runCap: 4 });
    expect(svc.view(bot, "shell-review").usage).toBeNull();
  });

  it("toggle listeners hear on / off; a cap stops it for the day and says so once", () => {
    let now = new Date("2026-11-04T03:00:00Z");
    const { svc, bot, capped } = make({ now: () => now });
    const heard: unknown[] = [];
    svc.onToggle((e) => heard.push(e));
    svc.set(bot, "proactive", { enabled: true, settings: { dailyRunCap: 2 } });
    expect(heard).toEqual([{ botId: bot, addonId: "proactive", enabled: true, was: false }]);
    expect(svc.allowance(bot, "proactive")).toEqual({ ok: true });
    expect(svc.charge(bot, "proactive", { runs: 1, inputTokens: 100 })).toBe(false);
    expect(svc.charge(bot, "proactive", { runs: 1 })).toBe(true);
    expect(svc.allowance(bot, "proactive")).toEqual({ ok: false, reason: "capped" });
    expect(svc.allowance(bot, "proactive")).toEqual({ ok: false, reason: "capped" });
    expect(capped).toEqual([{ botId: bot, addonId: "proactive", day: "2026-11-04", reason: "runs" }]);
    expect(svc.view(bot, "proactive").usage?.capped).toBe(true);
    // The next local day (Taipei) starts fresh.
    now = new Date("2026-11-04T17:00:00Z");
    expect(localDay(now, "Asia/Taipei")).toBe("2026-11-05");
    expect(svc.allowance(bot, "proactive")).toEqual({ ok: true });
    svc.set(bot, "proactive", { enabled: false });
    expect(svc.allowance(bot, "proactive")).toEqual({ ok: false, reason: "off" });
    expect(heard).toHaveLength(2);
  });
});
