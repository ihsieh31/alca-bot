import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { newStoreId } from "../ids.ts";

/** One row of the care log (migration 32). */
export type CareLogKind = "decision" | "shown" | "mention";
export type CareReaction = "positive" | "ignored" | "negative";

export interface CareLogInput {
  botId: string;
  threadId?: string | null;
  runId?: string | null;
  kind: CareLogKind;
  memoryId?: string | null;
  /** A life category (`exam` …), `rest`, or empty. */
  category?: string;
  /** A fixed reason word (`chosen`, `heavy`, `thread-cooldown` …). */
  reason?: string;
  score?: number | null;
}

export interface CareLogRecord {
  id: string;
  botId: string;
  threadId: string | null;
  runId: string | null;
  kind: CareLogKind;
  memoryId: string | null;
  category: string;
  reason: string;
  score: number | null;
  reaction: CareReaction | null;
  createdAt: string;
  reactedAt: string | null;
}

interface Row {
  id: string;
  bot_id: string;
  thread_id: string | null;
  run_id: string | null;
  kind: CareLogKind;
  memory_id: string | null;
  category: string;
  reason: string;
  score: number | null;
  reaction: CareReaction | null;
  created_at: string;
  reacted_at: string | null;
}

const fromRow = (r: Row): CareLogRecord => ({
  id: r.id,
  botId: r.bot_id,
  threadId: r.thread_id,
  runId: r.run_id,
  kind: r.kind,
  memoryId: r.memory_id,
  category: r.category,
  reason: r.reason,
  score: r.score,
  reaction: r.reaction,
  createdAt: r.created_at,
  reactedAt: r.reacted_at,
});

const WORD = /^[a-z0-9_:-]{0,40}$/;
const word = (s: string | undefined) => (s && WORD.test(s) ? s : "");

export interface CareLogQuery {
  botId: string;
  since: Date;
  threadId?: string;
  kinds?: readonly CareLogKind[];
  memoryId?: string;
  limit?: number;
}

/**
 * The care log (migration 32): plain ids, words and numbers. The care
 * service writes; the decision policy (cooldowns, weights) and the metrics read.
 */
export class CareLogRepo {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  add(i: CareLogInput, now = new Date()): string {
    const id = newStoreId("care", now.getTime());
    this.db
      .prepare(
        `INSERT INTO care_log (id, bot_id, thread_id, run_id, kind, memory_id, category, reason, score, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        i.botId,
        i.threadId ?? null,
        i.runId ?? null,
        i.kind,
        i.memoryId ?? null,
        word(i.category),
        word(i.reason),
        i.score == null ? null : Math.round(i.score * 1000) / 1000,
        now.toISOString(),
      );
    return id;
  }

  get(id: string): CareLogRecord | undefined {
    const r = this.db.prepare("SELECT * FROM care_log WHERE id = ?").get(id) as Row | undefined;
    return r ? fromRow(r) : undefined;
  }

  /** Rows since a time, newest first. */
  list(q: CareLogQuery): CareLogRecord[] {
    const where = ["bot_id = ?", "created_at >= ?"];
    const args: SQLInputValue[] = [q.botId, q.since.toISOString()];
    if (q.threadId) {
      where.push("thread_id = ?");
      args.push(q.threadId);
    }
    if (q.memoryId) {
      where.push("memory_id = ?");
      args.push(q.memoryId);
    }
    if (q.kinds?.length) {
      where.push(`kind IN (${q.kinds.map(() => "?").join(",")})`);
      args.push(...q.kinds);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM care_log WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(...args, Math.min(Math.max(q.limit ?? 200, 1), 1000)) as unknown as Row[];
    return rows.map(fromRow);
  }

  /** The person's reaction to a shown line (set once). */
  react(id: string, reaction: CareReaction, now = new Date()): boolean {
    const r = this.db
      .prepare(
        "UPDATE care_log SET reaction = ?, reacted_at = ? WHERE id = ? AND kind = 'shown' AND reaction IS NULL",
      )
      .run(reaction, now.toISOString(), id);
    return Number(r.changes) > 0;
  }

  /** Delete rows older than `before` (the care service keeps 90 days). */
  prune(before: Date): number {
    return Number(
      this.db.prepare("DELETE FROM care_log WHERE created_at < ?").run(before.toISOString()).changes,
    );
  }
}
