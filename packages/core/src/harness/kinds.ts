import type { WorkerBudget } from "@alca/store";

/**
 * Plan §0.2: every harness worker runs under one of two harnesses. One shared
 * outer loop (`agents/harness-run/`); a harness is a profile (tools, prompt
 * rules, budget, stop rules), never a second program.
 */
export type HarnessKind = "coding" | "general";
export const HARNESS_KINDS: readonly HarnessKind[] = ["coding", "general"];

export const HARNESS_WORD: Record<HarnessKind, string> = { coding: "程式", general: "一般" };

export function isHarnessKind(v: unknown): v is HarnessKind {
  return v === "coding" || v === "general";
}

/** Default budget per harness (plan §2.3); tokens come from the bot or the workers policy. */
export const HARNESS_DEFAULTS: Record<HarnessKind, { maxSteps: number; maxWallSec: number }> = {
  coding: { maxSteps: 120, maxWallSec: 3600 },
  general: { maxSteps: 60, maxWallSec: 1800 },
};

/** A bot's own choice for one harness (A4): engine + model and budget caps; unset = the bot's engine / defaults. */
export interface BotHarnessSetting {
  engineId?: string | null;
  model?: string | null;
  maxSteps?: number;
  maxWallSec?: number;
  maxTokens?: number;
}

export type BotHarnessConfig = Partial<Record<HarnessKind, BotHarnessSetting>> & {
  /** Phase 5: the harness this bot's dispatches get when the router names none (bot settings). */
  default?: HarnessKind;
  /** Research audit C3: an independent reviewer reads a `done` report before it stands (default off). */
  reviewer?: boolean;
};

/** What `worker_start` may ask for a budget (it can only stay within the bot's caps). */
export interface BudgetOverride {
  maxSteps?: number;
  maxWallSec?: number;
  maxTokens?: number;
}

const posInt = (v: unknown, max: number): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= 1 ? Math.min(Math.floor(v), max) : undefined;

/** Parse a stored / submitted bot harness config; anything unreadable is dropped, never guessed. */
export function parseBotHarness(raw: unknown): BotHarnessConfig {
  let v = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return {};
    }
  }
  if (!v || typeof v !== "object") return {};
  const out: BotHarnessConfig = {};
  const def = (v as Record<string, unknown>).default;
  if (isHarnessKind(def)) out.default = def;
  if ((v as Record<string, unknown>).reviewer === true) out.reviewer = true;
  for (const kind of HARNESS_KINDS) {
    const s = (v as Record<string, unknown>)[kind];
    if (!s || typeof s !== "object") continue;
    const r = s as Record<string, unknown>;
    const one: BotHarnessSetting = {};
    if (typeof r.engineId === "string" && r.engineId.trim()) one.engineId = r.engineId.trim().slice(0, 200);
    if (typeof r.model === "string" && r.model.trim()) one.model = r.model.trim().slice(0, 200);
    const steps = posInt(r.maxSteps, 500);
    const wall = posInt(r.maxWallSec, 86_400);
    const tokens = posInt(r.maxTokens, 50_000_000);
    if (steps) one.maxSteps = steps;
    if (wall) one.maxWallSec = wall;
    if (tokens) one.maxTokens = tokens;
    if (Object.keys(one).length) out[kind] = one;
  }
  return out;
}

export function parseBudgetOverride(raw: unknown): BudgetOverride | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const o: BudgetOverride = {};
  const steps = posInt(r.maxSteps, 500);
  const wall = posInt(r.maxWallSec, 86_400);
  const tokens = posInt(r.maxTokens, 50_000_000);
  if (steps) o.maxSteps = steps;
  if (wall) o.maxWallSec = wall;
  if (tokens) o.maxTokens = tokens;
  return Object.keys(o).length ? o : undefined;
}

/**
 * The budget a worker runs with (plan §2.3): the harness default, lowered by
 * the bot's own cap for that harness, and lowered again by an override from
 * `worker_start` (never raised). Steps are `tool.completed` events.
 */
export function resolveBudget(
  kind: HarnessKind,
  bot: BotHarnessSetting | undefined,
  override: BudgetOverride | undefined,
  fallbackTokens: number,
): WorkerBudget {
  const d = HARNESS_DEFAULTS[kind];
  // Plan §2.3: a bot may lower the harness default, never raise it; a dispatch only lowers further.
  const capSteps = Math.min(bot?.maxSteps ?? d.maxSteps, d.maxSteps);
  const capWall = Math.min(bot?.maxWallSec ?? d.maxWallSec, d.maxWallSec);
  const capTokens = Math.min(bot?.maxTokens ?? fallbackTokens, fallbackTokens);
  const lower = (cap: number, v: number | undefined) => (v !== undefined && v < cap ? v : cap);
  return {
    maxSteps: lower(capSteps, override?.maxSteps),
    maxRunMs: lower(capWall, override?.maxWallSec) * 1000,
    maxTokens: lower(capTokens, override?.maxTokens),
  };
}

/** Plan §2.3: `maxPasses` is only a safety cap (steps × 2). */
export const passCap = (maxSteps: number): number => Math.max(2, maxSteps * 2);
