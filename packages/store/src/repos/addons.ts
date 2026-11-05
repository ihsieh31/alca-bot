import type { DatabaseSync } from "node:sqlite";
import { atomic } from "../db.ts";
import { openValue, sealValue } from "../seal.ts";

/** One bot's row for one add-on (P14). Absent row = never touched = off with defaults. */
export interface BotAddonRecord {
  botId: string;
  addonId: string;
  enabled: boolean;
  settings: Record<string, unknown>;
  /** The add-on's own small state (a scan cursor, the next run). Kept when turned off. */
  state: Record<string, unknown>;
  enabledAt: string | null;
  updatedAt: string;
}

export interface AddonUsageRecord {
  botId: string;
  addonId: string;
  /** Local day `YYYY-MM-DD` (the core's zone). */
  day: string;
  runs: number;
  inputTokens: number;
  outputTokens: number;
  cappedAt: string | null;
}

interface Row {
  bot_id: string;
  addon_id: string;
  enabled: number;
  settings_json: string;
  state_json: string;
  enabled_at: string | null;
  updated_at: string;
}

interface UsageRow {
  bot_id: string;
  addon_id: string;
  day: string;
  runs: number;
  input_tokens: number;
  output_tokens: number;
  capped_at: string | null;
}

const obj = (s: string): Record<string, unknown> => {
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/** Review 2026-11-05 #3 (migration 31): `state_json` is a sealed column (主動留意's queue holds mail-derived text). */
const statePk = (botId: string, addonId: string) => `${botId}:${addonId}`;

const fromRow = (db: DatabaseSync, r: Row): BotAddonRecord => ({
  botId: r.bot_id,
  addonId: r.addon_id,
  enabled: r.enabled === 1,
  settings: obj(r.settings_json),
  state: obj(openValue(db, "bot_addons", "state_json", statePk(r.bot_id, r.addon_id), r.state_json)),
  enabledAt: r.enabled_at,
  updatedAt: r.updated_at,
});

const fromUsage = (r: UsageRow): AddonUsageRecord => ({
  botId: r.bot_id,
  addonId: r.addon_id,
  day: r.day,
  runs: r.runs,
  inputTokens: r.input_tokens,
  outputTokens: r.output_tokens,
  cappedAt: r.capped_at,
});

/**
 * Add-ons per bot (migration 17). The registry of what an add-on is lives in
 * code (`@alca/core` addons); this repo only keeps the switch, the settings,
 * the add-on's state and the daily usage.
 */
export class AddonRepo {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  get(botId: string, addonId: string): BotAddonRecord | undefined {
    const r = this.db
      .prepare("SELECT * FROM bot_addons WHERE bot_id = ? AND addon_id = ?")
      .get(botId, addonId) as Row | undefined;
    return r ? fromRow(this.db, r) : undefined;
  }

  list(botId: string): BotAddonRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM bot_addons WHERE bot_id = ? ORDER BY addon_id")
      .all(botId) as unknown as Row[];
    return rows.map((r) => fromRow(this.db, r));
  }

  /** Every bot that has this add-on on. */
  enabledFor(addonId: string): BotAddonRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM bot_addons WHERE addon_id = ? AND enabled = 1 ORDER BY bot_id")
      .all(addonId) as unknown as Row[];
    return rows.map((r) => fromRow(this.db, r));
  }

  /** Switch and / or settings. Turning on stamps `enabled_at` (an add-on starts from then, never catches up). */
  set(
    botId: string,
    addonId: string,
    patch: { enabled?: boolean; settings?: Record<string, unknown> },
    now = new Date(),
  ): BotAddonRecord {
    const ts = now.toISOString();
    return atomic(this.db, () => {
      const old = this.get(botId, addonId);
      const enabled = patch.enabled ?? old?.enabled ?? false;
      const settings = patch.settings ?? old?.settings ?? {};
      const turnedOn = enabled && !old?.enabled;
      this.db
        .prepare(
          `INSERT INTO bot_addons (bot_id, addon_id, enabled, settings_json, state_json, enabled_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (bot_id, addon_id) DO UPDATE SET enabled = excluded.enabled,
             settings_json = excluded.settings_json,
             enabled_at = CASE WHEN ? THEN excluded.enabled_at ELSE bot_addons.enabled_at END,
             updated_at = excluded.updated_at`,
        )
        .run(
          botId,
          addonId,
          enabled ? 1 : 0,
          JSON.stringify(settings),
          sealValue(this.db, "bot_addons", "state_json", statePk(botId, addonId), "{}"),
          turnedOn ? ts : null,
          ts,
          turnedOn ? 1 : 0,
        );
      return this.get(botId, addonId) as BotAddonRecord;
    });
  }

  /** Replace the add-on's state (a cursor, the next run); the row must exist. */
  setState(botId: string, addonId: string, state: Record<string, unknown>, now = new Date()): void {
    this.db
      .prepare("UPDATE bot_addons SET state_json = ?, updated_at = ? WHERE bot_id = ? AND addon_id = ?")
      .run(
        sealValue(this.db, "bot_addons", "state_json", statePk(botId, addonId), JSON.stringify(state)),
        now.toISOString(),
        botId,
        addonId,
      );
  }

  usage(botId: string, addonId: string, day: string): AddonUsageRecord {
    const r = this.db
      .prepare("SELECT * FROM addon_usage WHERE bot_id = ? AND addon_id = ? AND day = ?")
      .get(botId, addonId, day) as UsageRow | undefined;
    return r
      ? fromUsage(r)
      : { botId, addonId, day, runs: 0, inputTokens: 0, outputTokens: 0, cappedAt: null };
  }

  /** Add what one run spent. Returns the day's totals after it. */
  charge(
    botId: string,
    addonId: string,
    day: string,
    spent: { runs?: number; inputTokens?: number; outputTokens?: number },
  ): AddonUsageRecord {
    const n = (v: number | undefined) => Math.max(0, Math.round(v ?? 0));
    this.db
      .prepare(
        `INSERT INTO addon_usage (bot_id, addon_id, day, runs, input_tokens, output_tokens)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (bot_id, addon_id, day) DO UPDATE SET runs = runs + excluded.runs,
           input_tokens = input_tokens + excluded.input_tokens,
           output_tokens = output_tokens + excluded.output_tokens`,
      )
      .run(botId, addonId, day, n(spent.runs), n(spent.inputTokens), n(spent.outputTokens));
    return this.usage(botId, addonId, day);
  }

  /** Mark the day as capped; true only the first time (so `addon.capped` goes out once a day). */
  markCapped(botId: string, addonId: string, day: string, now = new Date()): boolean {
    this.charge(botId, addonId, day, {});
    const r = this.db
      .prepare(
        "UPDATE addon_usage SET capped_at = ? WHERE bot_id = ? AND addon_id = ? AND day = ? AND capped_at IS NULL",
      )
      .run(now.toISOString(), botId, addonId, day);
    return Number(r.changes) > 0;
  }
}
