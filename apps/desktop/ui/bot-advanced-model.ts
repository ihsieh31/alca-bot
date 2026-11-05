// Phase 6: the bot editor's 進階 harness settings as data — the default
// harness, the independent reviewer switch, the budget caps, and the 完全授權
// switch with its warning and second confirm. Pure (no DOM), so it is
// unit-tested in Node; bot-advanced.ts draws it. The server checks every
// value again (bot-harness.ts, team-api.ts).
import { t as tx } from "./i18n/index.ts";

export type HarnessKind = "coding" | "general";
export type DefaultHarness = "auto" | HarnessKind;

/** Mac test 2026-11 B10: the token cap's placeholder; a longer one was cut short in the narrow field. */
export const TOKEN_CAP_PLACEHOLDER = tx("common.default");

/** Mac test 2026-11 B4: what the reviewer may do, beside its switch. */
export const REVIEWER_NOTE = tx("desktop.botAdvancedModel.theReviewerRunsReadOnly");

/** Harness defaults (core `HARNESS_DEFAULTS`); a bot's caps can only be lower. */
export const HARNESS_CAPS: Record<HarnessKind, { maxSteps: number; maxMinutes: number }> = {
  coding: { maxSteps: 120, maxMinutes: 60 },
  general: { maxSteps: 60, maxMinutes: 30 },
};

export interface CapsDraft {
  maxSteps: string;
  maxMinutes: string;
  maxTokens: string;
}

export interface HarnessDraft {
  default: DefaultHarness;
  reviewer: boolean;
  caps: Record<HarnessKind, CapsDraft>;
}

interface StoredSetting {
  maxSteps?: number;
  maxWallSec?: number;
  maxTokens?: number;
}

/** The stored harness JSON (TeamBot.harness) as the form opens; anything unreadable is the default. */
export function harnessDraft(stored: string | null | undefined): HarnessDraft {
  let v: Record<string, unknown> = {};
  try {
    const p = stored ? (JSON.parse(stored) as unknown) : {};
    if (p && typeof p === "object" && !Array.isArray(p)) v = p as Record<string, unknown>;
  } catch {
    v = {};
  }
  const caps = (k: HarnessKind): CapsDraft => {
    const s = (v[k] && typeof v[k] === "object" ? v[k] : {}) as StoredSetting;
    return {
      maxSteps: s.maxSteps ? String(s.maxSteps) : "",
      maxMinutes: s.maxWallSec ? String(Math.round(s.maxWallSec / 60)) : "",
      maxTokens: s.maxTokens ? String(s.maxTokens) : "",
    };
  };
  return {
    default: v.default === "coding" || v.default === "general" ? v.default : "auto",
    reviewer: v.reviewer === true,
    caps: { coding: caps("coding"), general: caps("general") },
  };
}

export type HarnessBody =
  | {
      ok: true;
      harness: {
        default?: HarnessKind;
        reviewer?: true;
        coding?: StoredSetting;
        general?: StoredSetting;
      };
    }
  | { ok: false; error: string };

const WORD: Record<HarnessKind, string> = { coding: tx("common.code"), general: tx("common.general") };

/** What PATCH /api/bots sends as `harness`; a cap must be a whole number and not above the default. */
export function harnessBody(d: HarnessDraft): HarnessBody {
  const out: Extract<HarnessBody, { ok: true }>["harness"] = {};
  if (d.default !== "auto") out.default = d.default;
  if (d.reviewer) out.reviewer = true;
  for (const k of ["coding", "general"] as const) {
    const c = d.caps[k];
    const one: StoredSetting = {};
    const num = (s: string, label: string, max?: number): number | undefined | string => {
      const t = s.trim();
      if (!t) return undefined;
      if (!/^\d+$/.test(t) || Number(t) < 1)
        return tx("desktop.botAdvancedModel.forMustBeAPositive", { p0: WORD[k], label });
      if (max !== undefined && Number(t) > max)
        return tx("desktop.botAdvancedModel.forCantExceedTheDefault", { p0: WORD[k], label, max });
      return Number(t);
    };
    const steps = num(c.maxSteps, tx("desktop.botAdvancedModel.stepLimit"), HARNESS_CAPS[k].maxSteps);
    const mins = num(
      c.maxMinutes,
      tx("desktop.botAdvancedModel.timeLimitMinutes"),
      HARNESS_CAPS[k].maxMinutes,
    );
    const tokens = num(c.maxTokens, tx("desktop.botAdvancedModel.tokenLimit"), 50_000_000);
    for (const v of [steps, mins, tokens]) if (typeof v === "string") return { ok: false, error: v };
    if (typeof steps === "number") one.maxSteps = steps;
    if (typeof mins === "number") one.maxWallSec = mins * 60;
    if (typeof tokens === "number") one.maxTokens = tokens;
    if (Object.keys(one).length) out[k] = one;
  }
  return { ok: true, harness: out };
}

// ── 完全授權 ────────────────────────────────────────────────

export type FullAccessStep = "off" | "warn" | "on";
export type Device = "desktop" | "phone";

export const FULL_ACCESS_WARNING = tx("desktop.botAdvancedModel.withFullAccessThisBot");

export const PHONE_REFUSAL = tx("common.fullAccessCanOnlyBe");

/**
 * The switch: turning it on goes through a warning that must be confirmed
 * (a second, explicit step); turning it off is immediate. A phone can only
 * turn it off (Phase 5): asking to turn it on there is refused.
 */
export function fullAccessNext(
  step: FullAccessStep,
  action: "toggle" | "confirm" | "cancel",
  device: Device = "desktop",
): { step: FullAccessStep; refused?: string } {
  if (action === "toggle") {
    if (step === "on" || step === "warn") return { step: "off" };
    if (device === "phone") return { step: "off", refused: PHONE_REFUSAL };
    return { step: "warn" };
  }
  if (action === "confirm") return { step: step === "warn" ? "on" : step };
  return { step: step === "warn" ? "off" : step };
}

export type LevelChoice = "team" | "confirm_each_step" | "autonomous";

/** How the form opens: 完全授權 is shown as 自主 + the switch on. */
export function levelDraft(level: string | null | undefined): { level: LevelChoice; full: FullAccessStep } {
  if (level === "full_access") return { level: "autonomous", full: "on" };
  if (level === "confirm_each_step" || level === "autonomous") return { level, full: "off" };
  return { level: "team", full: "off" };
}

/** The approval level to send: the switch wins only once it is confirmed on. */
export function levelToSend(level: LevelChoice, full: FullAccessStep): LevelChoice | "full_access" {
  return full === "on" ? "full_access" : level;
}

/**
 * Mac test 2026-11 B11: when Claude Code is the team's default engine, a bot
 * saved with `engineId: "claude-code"` (or config.json's `models.engines`
 * entry of that id) runs on the default engine itself — the server merges
 * the two, so the list has no separate Claude Code row. The editor says so
 * instead of showing it as plain 團隊預設.
 */
export function defaultEngineRow(
  engineId: string | null,
  defaultLabel: string,
  listed: readonly string[],
): { label: string; hint: string } {
  if (engineId === "claude-code" && !listed.includes("claude-code") && defaultLabel.startsWith("Claude Code"))
    return {
      label: "Claude Code",
      hint: tx("desktop.botAdvancedModel.sameEngineAsTheTeam"),
    };
  return { label: defaultLabel, hint: tx("desktop.botAdvancedModel.teamDefaultEngine") };
}
