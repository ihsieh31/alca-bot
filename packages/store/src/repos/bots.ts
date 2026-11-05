import type { DatabaseSync } from "node:sqlite";
import { transaction } from "../db.ts";
import { newStoreId } from "../ids.ts";

export const BOT_COLORS = ["ink", "vermilion", "jade", "indigo", "ochre", "plum"] as const;
export type BotColor = (typeof BOT_COLORS)[number];
export type BotBrowserProfile = "shared" | "isolated" | "isolated_keep";
export type BotMemoryMode = "team" | "own" | "off";
/** P9: rules only (default), or rules + the bot's own engine. */
export type BotMemoryExtract = "rules" | "model";
/**
 * `full_access` (Phase 5, 完全授權) is stored as its own switch (`bots.full_access`)
 * next to `approval_level = 'autonomous'`; only the bot editor turns it on.
 */
export type BotLevel = "autonomous" | "confirm_each_step" | "full_access";
/** P13 switches. */
export type BotSwitch = "off" | "on";

export interface Bot {
  id: string;
  name: string;
  /** Engine id: null = the team's default engine. */
  engineId: string | null;
  isDefault: boolean;
  createdAt: string;
  /** P7 profile. */
  avatar: string | null;
  color: BotColor | null;
  role: string | null;
  instructions: string | null;
  model: string | null;
  /** null = the team's permission level. */
  approvalLevel: BotLevel | null;
  browserProfile: BotBrowserProfile;
  memoryMode: BotMemoryMode;
  memoryExtract: BotMemoryExtract;
  isLead: boolean;
  archivedAt: string | null;
  updatedAt: string | null;
  /** P13: the bot's working folder; null = `<data>/bots/<id>/work`. */
  workDir: string | null;
  /** P13: ask a model about each shell command before it runs under 自主 (off by default). */
  shellReview: BotSwitch;
  /** P13: the engine choice (and model) the review asks; null = the bot's own. */
  shellReviewEngine: string | null;
  shellReviewModel: string | null;
  /** P13: 提前做 — prepare drafts ahead from trigger events (off by default). */
  earlyWork: BotSwitch;
  /** P13: `HH:MM-HH:MM` in the core's zone when no early work starts; null = none. */
  quietHours: string | null;
  /** Plan §2.9: per-harness engine / model / budget caps, JSON text; null = the bot's own engine and the defaults. */
  harness: string | null;
  /** Next round §5.4: the OS sandbox setting, JSON text; null = the default (auto, network open). */
  sandbox: string | null;
  /** R9.6: the language of the router and worker rules; `auto` = judged from the instructions. */
  language: BotLanguage;
}

export type BotLanguage = "auto" | "zh" | "en";

/** Fields a person can edit (P7). */
export interface BotProfileInput {
  name?: string;
  avatar?: string | null;
  color?: BotColor | null;
  role?: string | null;
  instructions?: string | null;
  engineId?: string | null;
  model?: string | null;
  approvalLevel?: BotLevel | null;
  browserProfile?: BotBrowserProfile;
  memoryMode?: BotMemoryMode;
  memoryExtract?: BotMemoryExtract;
  workDir?: string | null;
  shellReview?: BotSwitch;
  shellReviewEngine?: string | null;
  shellReviewModel?: string | null;
  earlyWork?: BotSwitch;
  quietHours?: string | null;
  harness?: string | null;
  sandbox?: string | null;
  language?: BotLanguage;
}

interface BotRow {
  id: string;
  name: string;
  engine_id: string | null;
  is_default: number;
  created_at: string;
  archived_at: string | null;
  avatar?: string | null;
  color?: string | null;
  role?: string | null;
  instructions?: string | null;
  model?: string | null;
  approval_level?: string | null;
  browser_profile?: string | null;
  memory_mode?: string | null;
  memory_extract?: string | null;
  is_lead?: number | null;
  updated_at?: string | null;
  work_dir?: string | null;
  shell_review?: string | null;
  shell_review_engine?: string | null;
  shell_review_model?: string | null;
  early_work?: string | null;
  quiet_hours?: string | null;
  harness?: string | null;
  full_access?: string | null;
  sandbox?: string | null;
  language?: string | null;
}

const bot = (r: BotRow): Bot => ({
  id: r.id,
  name: r.name,
  engineId: r.engine_id,
  isDefault: r.is_default === 1,
  createdAt: r.created_at,
  avatar: r.avatar ?? null,
  color: (r.color as BotColor | null | undefined) ?? null,
  role: r.role ?? null,
  instructions: r.instructions ?? null,
  model: r.model ?? null,
  approvalLevel:
    r.full_access === "on" ? "full_access" : ((r.approval_level as BotLevel | null | undefined) ?? null),
  browserProfile: (r.browser_profile as BotBrowserProfile | null | undefined) ?? "shared",
  memoryMode: (r.memory_mode as BotMemoryMode | null | undefined) ?? "team",
  memoryExtract: r.memory_extract === "model" ? "model" : "rules",
  isLead: r.is_lead === 1,
  archivedAt: r.archived_at ?? null,
  updatedAt: r.updated_at ?? null,
  workDir: r.work_dir ?? null,
  shellReview: r.shell_review === "on" ? "on" : "off",
  shellReviewEngine: r.shell_review_engine ?? null,
  shellReviewModel: r.shell_review_model ?? null,
  earlyWork: r.early_work === "on" ? "on" : "off",
  quietHours: r.quiet_hours ?? null,
  harness: r.harness ?? null,
  sandbox: r.sandbox ?? null,
  language: r.language === "zh" || r.language === "en" ? r.language : "auto",
});

const PROFILE_COLUMNS: Record<keyof BotProfileInput, string> = {
  name: "name",
  avatar: "avatar",
  color: "color",
  role: "role",
  instructions: "instructions",
  engineId: "engine_id",
  model: "model",
  approvalLevel: "approval_level",
  browserProfile: "browser_profile",
  memoryMode: "memory_mode",
  memoryExtract: "memory_extract",
  workDir: "work_dir",
  shellReview: "shell_review",
  shellReviewEngine: "shell_review_engine",
  shellReviewModel: "shell_review_model",
  earlyWork: "early_work",
  quietHours: "quiet_hours",
  harness: "harness",
  sandbox: "sandbox",
  language: "language",
};

/** `bot_` + 26 Crockford chars, same shape as protocol ids. */
export function newBotId(now = Date.now()): string {
  return newStoreId("bot", now);
}

export interface SpaceRecord {
  id: string;
  botId: string;
  threadId: string | null;
  /** Reserved (plan v4): worker session using the Space. */
  workerId?: string | null;
  title: string;
  profile: "shared" | "isolated";
  persistent: boolean;
  createdAt: string;
  closedAt: string | null;
}

interface SpaceRow {
  id: string;
  bot_id: string;
  thread_id: string | null;
  worker_id: string | null;
  title: string;
  profile: "shared" | "isolated";
  persistent: number;
  created_at: string;
  closed_at: string | null;
}

const space = (r: SpaceRow): SpaceRecord => ({
  id: r.id,
  botId: r.bot_id,
  threadId: r.thread_id,
  workerId: r.worker_id,
  title: r.title,
  profile: r.profile,
  persistent: r.persistent === 1,
  createdAt: r.created_at,
  closedAt: r.closed_at,
});

/** The team of bots, and the browser Spaces each one owns. */
export class BotRepo {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /**
   * First launch: create the default bot (a team of one) and back-fill any
   * thread / job / approval written before bots existed. Idempotent.
   */
  ensureDefault(name = "Alca", now = new Date()): Bot {
    const existing = this.default();
    if (existing) return existing;
    return transaction(this.db, () => {
      const id = newBotId(now.getTime());
      this.db
        .prepare("INSERT INTO bots (id, name, is_default, created_at) VALUES (?, ?, 1, ?)")
        .run(id, name, now.toISOString());
      for (const t of ["threads", "jobs", "approvals"])
        this.db.prepare(`UPDATE ${t} SET bot_id = ? WHERE bot_id IS NULL`).run(id);
      return this.get(id) as Bot;
    });
  }

  create(name: string, opts: { now?: Date } & BotProfileInput = {}): Bot {
    const now = opts.now ?? new Date();
    const id = newBotId(now.getTime());
    return transaction(this.db, () => {
      this.db
        .prepare("INSERT INTO bots (id, name, engine_id, created_at) VALUES (?, ?, ?, ?)")
        .run(id, name, opts.engineId ?? null, now.toISOString());
      const { now: _n, ...profile } = opts;
      if (Object.keys(profile).length) this.update(id, profile, now);
      return this.get(id) as Bot;
    });
  }

  /** Edit a bot's profile (P7). Only the given fields change. */
  update(id: string, input: BotProfileInput, now = new Date()): Bot {
    const sets: string[] = [];
    const vals: Array<string | null> = [];
    for (const [k, col] of Object.entries(PROFILE_COLUMNS) as Array<[keyof BotProfileInput, string]>) {
      if (!(k in input)) continue;
      let v = input[k];
      // Phase 5: 完全授權 is its own switch on top of 自主 (`bots.full_access`).
      if (k === "approvalLevel") {
        const full = v === "full_access";
        if (full) v = "autonomous";
        sets.push("full_access = ?");
        vals.push(full ? "on" : "off");
      }
      sets.push(`${col} = ?`);
      vals.push(v === undefined ? null : (v as string | null));
    }
    if (sets.length === 0) return this.get(id) as Bot;
    sets.push("updated_at = ?");
    vals.push(now.toISOString());
    const r = this.db.prepare(`UPDATE bots SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
    if (Number(r.changes) === 0) throw new Error(`bot ${id} not found`);
    return this.get(id) as Bot;
  }

  /** Archive a bot: it leaves the roster, keeps every row it owns. The default bot stays. */
  archive(id: string, now = new Date()): boolean {
    return transaction(this.db, () => {
      this.db.prepare("UPDATE bots SET is_lead = 0 WHERE id = ?").run(id);
      const r = this.db
        .prepare("UPDATE bots SET archived_at = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL")
        .run(now.toISOString(), now.toISOString(), id);
      return Number(r.changes) > 0;
    });
  }

  restore(id: string, now = new Date()): boolean {
    const r = this.db
      .prepare("UPDATE bots SET archived_at = NULL, updated_at = ? WHERE id = ? AND archived_at IS NOT NULL")
      .run(now.toISOString(), id);
    return Number(r.changes) > 0;
  }

  /** The lead routes the person's requests to teammates; at most one, or none. */
  setLead(id: string | null, now = new Date()): void {
    transaction(this.db, () => {
      this.db.prepare("UPDATE bots SET is_lead = 0 WHERE is_lead = 1").run();
      if (id)
        this.db
          .prepare("UPDATE bots SET is_lead = 1, updated_at = ? WHERE id = ?")
          .run(now.toISOString(), id);
    });
  }

  lead(): Bot | undefined {
    const r = this.db.prepare("SELECT * FROM bots WHERE is_lead = 1 AND archived_at IS NULL").get() as
      | BotRow
      | undefined;
    return r ? bot(r) : undefined;
  }

  /** Every bot, archived ones included (history views). */
  all(): Bot[] {
    const rows = this.db
      .prepare("SELECT * FROM bots ORDER BY is_default DESC, created_at")
      .all() as unknown as BotRow[];
    return rows.map(bot);
  }

  /** A bot by id, or by name (case-insensitive) among the active ones. */
  find(ref: string): Bot | undefined {
    const byId = this.get(ref);
    if (byId) return byId;
    const q = ref.trim().replace(/^@/, "").toLowerCase();
    return this.list().find((b) => b.name.toLowerCase() === q);
  }

  get(id: string): Bot | undefined {
    const r = this.db.prepare("SELECT * FROM bots WHERE id = ?").get(id) as BotRow | undefined;
    return r ? bot(r) : undefined;
  }

  default(): Bot | undefined {
    const r = this.db.prepare("SELECT * FROM bots WHERE is_default = 1").get() as BotRow | undefined;
    return r ? bot(r) : undefined;
  }

  list(): Bot[] {
    const rows = this.db
      .prepare("SELECT * FROM bots WHERE archived_at IS NULL ORDER BY is_default DESC, created_at")
      .all() as unknown as BotRow[];
    return rows.map(bot);
  }

  openSpace(s: Omit<SpaceRecord, "createdAt" | "closedAt">, now = new Date()): SpaceRecord {
    this.db
      .prepare(
        `INSERT INTO browser_spaces (id, bot_id, thread_id, worker_id, title, profile, persistent, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        s.id,
        s.botId,
        s.threadId,
        s.workerId ?? null,
        s.title,
        s.profile,
        s.persistent ? 1 : 0,
        now.toISOString(),
      );
    return this.space(s.id) as SpaceRecord;
  }

  space(id: string): SpaceRecord | undefined {
    const r = this.db.prepare("SELECT * FROM browser_spaces WHERE id = ?").get(id) as SpaceRow | undefined;
    return r ? space(r) : undefined;
  }

  /** Open Spaces, optionally of one bot. */
  spaces(botId?: string): SpaceRecord[] {
    const rows = (botId
      ? this.db
          .prepare("SELECT * FROM browser_spaces WHERE closed_at IS NULL AND bot_id = ? ORDER BY created_at")
          .all(botId)
      : this.db
          .prepare("SELECT * FROM browser_spaces WHERE closed_at IS NULL ORDER BY created_at")
          .all()) as unknown as SpaceRow[];
    return rows.map(space);
  }

  closeSpace(id: string, now = new Date()): void {
    this.db
      .prepare("UPDATE browser_spaces SET closed_at = ? WHERE id = ? AND closed_at IS NULL")
      .run(now.toISOString(), id);
  }

  /** On restart no Space window survives: close the records (persistent profiles stay on disk). */
  closeAllSpaces(now = new Date()): number {
    const r = this.db
      .prepare("UPDATE browser_spaces SET closed_at = ? WHERE closed_at IS NULL")
      .run(now.toISOString());
    return Number(r.changes);
  }
}
