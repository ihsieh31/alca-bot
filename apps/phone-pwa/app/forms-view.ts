// P13: what the phone's 新增 / 編輯 bot and 新增例行工作 forms send. The core
// checks everything again with the desktop's rules (TeamApi / the routine
// runner); these helpers only shape the request and catch the obvious slips
// before a round trip. Pure (no DOM), so they are unit-tested in Node.

import { t as tx } from "./i18n/index.ts";
import type { BotColor, TeamBot } from "./team-view.ts";

export const BOT_COLORS: readonly BotColor[] = ["ink", "vermilion", "jade", "indigo", "ochre", "plum"];

export type Level = "team" | "autonomous" | "confirm_each_step" | "full_access";

export interface BotDraft {
  name: string;
  avatar: string;
  color: BotColor | null;
  role: string;
  instructions: string;
  approvalLevel: Level;
}

export type Result = { ok: true; args: Record<string, unknown> } | { ok: false; error: string };

export function botDraft(b?: TeamBot): BotDraft {
  return {
    name: b?.name ?? "",
    avatar: b?.avatar ?? "",
    color: b?.color ?? null,
    role: b?.role ?? "",
    instructions: b?.instructions ?? "",
    approvalLevel: b?.approvalLevel ?? "team",
  };
}

const chars = (s: string) => [...s].length;

/** Phase 5 / 6: the phone may turn 完全授權 off, never on. */
export const PHONE_FULL_ACCESS_REFUSAL = tx("common.fullAccessCanOnlyBe");

/** Turning 完全授權 off on the phone leaves the bot at 自主 (the level it sits on). */
export function fullAccessOff(d: BotDraft): BotDraft {
  return d.approvalLevel === "full_access" ? { ...d, approvalLevel: "autonomous" } : d;
}

/** A new bot: every filled field. An edit: only what changed (`botId` added by the caller). */
export function botArgs(d: BotDraft, before?: TeamBot): Result {
  const name = d.name.trim();
  if (!name) return { ok: false, error: tx("phone.formsView.pleaseGiveTheBotA") };
  if (chars(name) > 40) return { ok: false, error: tx("phone.formsView.nameCanBeAtMost") };
  const avatar = d.avatar.trim();
  if (chars(avatar) > 4) return { ok: false, error: tx("phone.formsView.avatarCanBeAtMost") };
  const role = d.role.trim();
  if (chars(role) > 120) return { ok: false, error: tx("phone.formsView.roleCanBeAtMost") };
  const instructions = d.instructions.trim();
  if (chars(instructions) > 4000) return { ok: false, error: tx("phone.formsView.instructionsCanBeAtMost") };
  if (d.approvalLevel === "full_access" && before?.approvalLevel !== "full_access")
    return { ok: false, error: PHONE_FULL_ACCESS_REFUSAL };
  const all: Record<string, unknown> = {
    name,
    avatar: avatar || null,
    color: d.color,
    role: role || null,
    instructions: instructions || null,
    approvalLevel: d.approvalLevel,
  };
  if (!before) {
    const args: Record<string, unknown> = { name };
    for (const [k, v] of Object.entries(all)) if (k !== "name" && v !== null && v !== "team") args[k] = v;
    return { ok: true, args };
  }
  // An edit sends what differs from the form as it opened (an untouched default avatar is no edit).
  const was = botDraft(before);
  const wasAll: Record<string, unknown> = {
    name: was.name,
    avatar: was.avatar.trim() || null,
    color: was.color,
    role: was.role.trim() || null,
    instructions: was.instructions.trim() || null,
    approvalLevel: was.approvalLevel,
  };
  const args: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(all)) if (v !== wasAll[k]) args[k] = v;
  if (!Object.keys(args).length) return { ok: false, error: tx("phone.formsView.nothingWasChanged") };
  return { ok: true, args };
}

export type ScheduleKind = "every" | "daily" | "once";

export interface RoutineDraft {
  name: string;
  botId: string | null;
  app: string;
  account: string | null;
  schedule: ScheduleKind;
  everyN: number;
  everyUnit: "min" | "hour";
  /** HH:MM, daily. */
  at: string;
  /** YYYY-MM-DDTHH:MM in the phone's own zone, once. */
  onceAt: string;
  instructions: string;
  speculative: boolean;
}

export function routineDraft(app = ""): RoutineDraft {
  return {
    name: "",
    botId: null,
    app,
    account: null,
    schedule: "every",
    everyN: 1,
    everyUnit: "hour",
    at: "08:00",
    onceAt: "",
    instructions: "",
    speculative: false,
  };
}

/** The phone's IANA zone (a daily routine runs at that wall-clock time). */
export const phoneZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export function routineArgs(d: RoutineDraft, o: { tz: string; now?: number }): Result {
  const name = d.name.trim();
  if (!name) return { ok: false, error: tx("phone.formsView.pleaseGiveTheRoutineA") };
  if (chars(name) > 80) return { ok: false, error: tx("phone.formsView.nameCanBeAtMost2") };
  if (!d.app) return { ok: false, error: tx("phone.formsView.chooseAnAppToCheck") };
  const args: Record<string, unknown> = {
    name,
    check: { kind: "app", app: d.app, ...(d.account ? { account: d.account } : {}) },
    ...(d.instructions.trim() ? { instructions: d.instructions.trim().slice(0, 4000) } : {}),
    ...(d.speculative ? { speculative: true } : {}),
    ...(d.botId ? { botId: d.botId } : {}),
  };
  if (d.schedule === "every") {
    const n = Math.floor(Number(d.everyN));
    if (!Number.isFinite(n) || n < 1) return { ok: false, error: tx("phone.formsView.theIntervalMustBeAt") };
    const sec = n * (d.everyUnit === "hour" ? 3600 : 60);
    if (sec > 7 * 86_400) return { ok: false, error: tx("phone.formsView.theIntervalCanBeAt") };
    return { ok: true, args: { ...args, kind: "interval", intervalSec: sec } };
  }
  if (d.schedule === "daily") {
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(d.at);
    if (!m) return { ok: false, error: tx("phone.formsView.timeShouldLookLike08") };
    return {
      ok: true,
      args: { ...args, kind: "cron", cron: `${Number(m[2])} ${Number(m[1])} * * *`, tz: o.tz },
    };
  }
  const t = Date.parse(d.onceAt);
  if (!d.onceAt || !Number.isFinite(t)) return { ok: false, error: tx("phone.formsView.chooseATime") };
  if (t <= (o.now ?? Date.now())) return { ok: false, error: tx("phone.formsView.thatTimeHasAlreadyPassed") };
  return { ok: true, args: { ...args, kind: "once", runAt: new Date(t).toISOString() } };
}
