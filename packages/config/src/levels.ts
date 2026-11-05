import { PermissionLevel, type PermissionLevelT, type TeamLevelT } from "./schema.ts";

/**
 * Approval levels, one vocabulary everywhere (P13). The team has a level
 * (`permissions.level`); a bot either follows the team (`team`, stored as
 * null) or names its own. Engines map only the two real levels onto their
 * native modes, after `effectiveLevel` has resolved `team`. Payment, send,
 * delete and publish ask at every level (`ALWAYS_CONFIRM_ACTIONS`), except
 * that a bot's own 完全授權 (`full_access`, Phase 5) lets git push and file
 * deletes run; payment and outward sends ask even there.
 */
export const APPROVAL_LEVELS: readonly TeamLevelT[] = PermissionLevel.options;

/** Phase 5: the level only a bot's own setting may name (完全授權; off by default). */
export const FULL_ACCESS = "full_access" as const;

/** What a bot's own setting may be: a level, or "follow the team". */
export const TEAM_LEVEL = "team" as const;
export type BotLevelChoice = PermissionLevelT | typeof TEAM_LEVEL;
export const BOT_LEVEL_CHOICES: readonly BotLevelChoice[] = [TEAM_LEVEL, ...APPROVAL_LEVELS, FULL_ACCESS];

/** The words people see (desktop, phone, docs). */
export const LEVEL_WORDS: Readonly<Record<BotLevelChoice, string>> = Object.freeze({
  team: "跟團隊一樣",
  confirm_each_step: "每步確認",
  autonomous: "自主",
  full_access: "完全授權",
});

/** A level a bot may name (the team levels and 完全授權). */
export function isApprovalLevel(v: unknown): v is PermissionLevelT {
  return typeof v === "string" && ((APPROVAL_LEVELS as readonly string[]).includes(v) || v === FULL_ACCESS);
}

/** The level an engine's native modes are mapped from: 完全授權 never widens a CLI's own mode past 自主. */
export function nativeLevel(level: PermissionLevelT): TeamLevelT {
  return level === FULL_ACCESS ? "autonomous" : level;
}

/** A bot's stored level (null / "team" = the team's) as the level it runs at. */
export function effectiveLevel(
  bot: PermissionLevelT | typeof TEAM_LEVEL | null | undefined,
  team: PermissionLevelT,
): PermissionLevelT {
  return isApprovalLevel(bot) ? bot : team;
}

const RANK: Readonly<Record<PermissionLevelT, number>> = {
  confirm_each_step: 0,
  autonomous: 1,
  full_access: 2,
};

/** The strictest of several levels (a delegation chain runs at its strictest bot's level). */
export function strictestLevel(
  levels: Iterable<PermissionLevelT>,
  fallback: PermissionLevelT,
): PermissionLevelT {
  let out: PermissionLevelT | undefined;
  for (const l of levels) if (out === undefined || RANK[l] < RANK[out]) out = l;
  return out ?? fallback;
}
