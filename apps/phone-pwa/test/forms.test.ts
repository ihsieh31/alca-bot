import { describe, expect, it } from "vitest";
import { botArgs, botDraft, routineArgs, routineDraft } from "../app/forms-view.ts";
import type { TeamBot } from "../app/team-view.ts";

const bot = (over: Partial<TeamBot> = {}): TeamBot => ({
  id: "bot_1",
  name: "研究員",
  isDefault: false,
  avatar: "研",
  color: "jade",
  role: "查資料",
  instructions: null,
  engineId: "openai",
  model: "gpt-x",
  approvalLevel: null,
  browserProfile: "shared",
  memoryMode: "team",
  isLead: false,
  activity: { workers: 0, waiting: 0, peersOpen: 0, working: [] },
  threads: 0,
  ...over,
});

describe("phone × bot form (P13)", () => {
  it("a new bot sends only what was filled, never provider / model", () => {
    const d = { ...botDraft(), name: "  寫手 ", role: "寫文章" };
    expect(botArgs(d)).toEqual({ ok: true, args: { name: "寫手", role: "寫文章" } });
    expect(botArgs({ ...d, color: "plum", approvalLevel: "confirm_each_step" })).toEqual({
      ok: true,
      args: { name: "寫手", role: "寫文章", color: "plum", approvalLevel: "confirm_each_step" },
    });
    expect(botArgs({ ...d, name: " " })).toEqual({ ok: false, error: "請幫 bot 取個名字" });
    expect(botArgs({ ...d, avatar: "一二三四五" }).ok).toBe(false);
    expect(botArgs({ ...d, name: "名".repeat(41) }).ok).toBe(false);
  });

  it("an edit sends only the fields that changed", () => {
    const b = bot();
    const d = botDraft(b);
    expect(botArgs(d, b)).toEqual({ ok: false, error: "沒有改到任何東西" });
    expect(botArgs({ ...d, role: "比價" }, b)).toEqual({ ok: true, args: { role: "比價" } });
    expect(botArgs({ ...d, approvalLevel: "autonomous", role: "" }, b)).toEqual({
      ok: true,
      args: { role: null, approvalLevel: "autonomous" },
    });
    const args = botArgs({ ...d, name: "研究員二號" }, b);
    expect(args).toEqual({ ok: true, args: { name: "研究員二號" } });
    expect(JSON.stringify(args)).not.toMatch(/engineId|model|browserProfile|memoryMode/);
  });
});

describe("phone × routine form (P13)", () => {
  const base = { ...routineDraft("gmail"), name: "工作信箱" };
  const now = Date.parse("2026-11-04T08:00:00Z");

  it("every N minutes / hours → an interval in seconds", () => {
    expect(routineArgs({ ...base, everyN: 2, everyUnit: "hour" }, { tz: "Asia/Taipei" })).toEqual({
      ok: true,
      args: { name: "工作信箱", check: { kind: "app", app: "gmail" }, kind: "interval", intervalSec: 7200 },
    });
    expect(
      routineArgs({ ...base, everyN: 15, everyUnit: "min", account: "工作" }, { tz: "UTC" }),
    ).toMatchObject({
      ok: true,
      args: { intervalSec: 900, check: { kind: "app", app: "gmail", account: "工作" } },
    });
    expect(routineArgs({ ...base, everyN: 0 }, { tz: "UTC" }).ok).toBe(false);
    expect(routineArgs({ ...base, everyN: 200, everyUnit: "hour" }, { tz: "UTC" }).ok).toBe(false);
  });

  it("daily at a time → a cron in the phone's zone", () => {
    expect(routineArgs({ ...base, schedule: "daily", at: "07:05" }, { tz: "Asia/Taipei" })).toMatchObject({
      ok: true,
      args: { kind: "cron", cron: "5 7 * * *", tz: "Asia/Taipei" },
    });
    expect(routineArgs({ ...base, schedule: "daily", at: "25:00" }, { tz: "UTC" }).ok).toBe(false);
  });

  it("once → a future ISO time", () => {
    expect(
      routineArgs({ ...base, schedule: "once", onceAt: "2026-11-05T09:30:00Z" }, { tz: "UTC", now }),
    ).toMatchObject({ ok: true, args: { kind: "once", runAt: "2026-11-05T09:30:00.000Z" } });
    expect(
      routineArgs({ ...base, schedule: "once", onceAt: "2026-11-03T09:30:00Z" }, { tz: "UTC", now }),
    ).toEqual({
      ok: false,
      error: "這個時間已經過了",
    });
    expect(routineArgs({ ...base, schedule: "once", onceAt: "" }, { tz: "UTC", now }).ok).toBe(false);
  });

  it("needs a name and an app; carries the bot, instructions and 提前做", () => {
    expect(routineArgs({ ...base, name: "" }, { tz: "UTC" }).ok).toBe(false);
    expect(routineArgs({ ...base, app: "" }, { tz: "UTC" }).ok).toBe(false);
    expect(
      routineArgs({ ...base, botId: "bot_2", instructions: " 摘要 ", speculative: true }, { tz: "UTC" }),
    ).toMatchObject({ ok: true, args: { botId: "bot_2", instructions: "摘要", speculative: true } });
  });
});
