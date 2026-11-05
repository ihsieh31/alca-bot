import type { DatabaseSync } from "node:sqlite";
import { newStoreId } from "../ids.ts";

export type EarlyStatus = "queued" | "running" | "ready" | "skipped" | "failed";

/** One thing a bot prepares ahead (提前做, P13). */
export interface EarlyWorkRecord {
  id: string;
  botId: string;
  threadId: string;
  source: "trigger" | "request";
  /** The trigger event (or caller's key) it came from; one item per bot and ref. */
  refId: string | null;
  title: string;
  goal: string;
  status: EarlyStatus;
  /** Not started before this time (quiet hours). */
  notBefore: string | null;
  workerId: string | null;
  draftIds: string[];
  detail: string;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: string;
  bot_id: string;
  thread_id: string;
  source: string;
  ref_id: string | null;
  title: string;
  goal: string;
  status: string;
  not_before: string | null;
  worker_id: string | null;
  draft_ids: string;
  detail: string;
  created_at: string;
  updated_at: string;
}

const rec = (r: Row): EarlyWorkRecord => ({
  id: r.id,
  botId: r.bot_id,
  threadId: r.thread_id,
  source: r.source === "trigger" ? "trigger" : "request",
  refId: r.ref_id,
  title: r.title,
  goal: r.goal,
  status: r.status as EarlyStatus,
  notBefore: r.not_before,
  workerId: r.worker_id,
  draftIds: JSON.parse(r.draft_ids) as string[],
  detail: r.detail,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class EarlyWorkRepo {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** Queue an item; a second offer with the same bot + ref returns the first one. */
  offer(i: {
    botId: string;
    threadId: string;
    source: EarlyWorkRecord["source"];
    refId?: string | null;
    title: string;
    goal: string;
    now?: Date;
  }): { item: EarlyWorkRecord; created: boolean } {
    if (i.refId) {
      const have = this.db
        .prepare("SELECT * FROM early_work WHERE bot_id = ? AND ref_id = ?")
        .get(i.botId, i.refId) as Row | undefined;
      if (have) return { item: rec(have), created: false };
    }
    const now = (i.now ?? new Date()).toISOString();
    const id = newStoreId("erl");
    this.db
      .prepare(
        `INSERT INTO early_work (id, bot_id, thread_id, source, ref_id, title, goal, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        i.botId,
        i.threadId,
        i.source,
        i.refId ?? null,
        i.title.slice(0, 120) || "提前準備",
        i.goal.slice(0, 8000) || i.title.slice(0, 120),
        now,
        now,
      );
    return { item: this.get(id) as EarlyWorkRecord, created: true };
  }

  get(id: string): EarlyWorkRecord | undefined {
    const r = this.db.prepare("SELECT * FROM early_work WHERE id = ?").get(id) as Row | undefined;
    return r ? rec(r) : undefined;
  }

  byWorker(workerId: string): EarlyWorkRecord | undefined {
    const r = this.db.prepare("SELECT * FROM early_work WHERE worker_id = ?").get(workerId) as
      | Row
      | undefined;
    return r ? rec(r) : undefined;
  }

  queued(): EarlyWorkRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM early_work WHERE status = 'queued' ORDER BY created_at, rowid")
        .all() as unknown as Row[]
    ).map(rec);
  }

  running(botId?: string): EarlyWorkRecord[] {
    const rows = botId
      ? this.db.prepare("SELECT * FROM early_work WHERE status = 'running' AND bot_id = ?").all(botId)
      : this.db.prepare("SELECT * FROM early_work WHERE status = 'running'").all();
    return (rows as unknown as Row[]).map(rec);
  }

  /** Items of a bot that started a worker since `since` (the daily cap). */
  startedSince(botId: string, since: Date): number {
    return Number(
      (
        this.db
          .prepare(
            "SELECT COUNT(*) AS n FROM early_work WHERE bot_id = ? AND worker_id IS NOT NULL AND updated_at >= ?",
          )
          .get(botId, since.toISOString()) as { n: number }
      ).n,
    );
  }

  list(o: { botId?: string; threadId?: string; limit?: number } = {}): EarlyWorkRecord[] {
    const where: string[] = [];
    const args: string[] = [];
    if (o.botId) {
      where.push("bot_id = ?");
      args.push(o.botId);
    }
    if (o.threadId) {
      where.push("thread_id = ?");
      args.push(o.threadId);
    }
    return (
      this.db
        .prepare(
          `SELECT * FROM early_work ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ?`,
        )
        .all(...args, o.limit ?? 100) as unknown as Row[]
    ).map(rec);
  }

  defer(id: string, notBefore: Date, detail: string, now = new Date()): void {
    this.db
      .prepare(
        "UPDATE early_work SET not_before = ?, detail = ?, updated_at = ? WHERE id = ? AND status = 'queued'",
      )
      .run(notBefore.toISOString(), detail.slice(0, 500), now.toISOString(), id);
  }

  /** Queued → running with its worker (compare-and-set: false when someone else took it). */
  started(id: string, workerId: string, now = new Date()): boolean {
    const r = this.db
      .prepare(
        "UPDATE early_work SET status = 'running', worker_id = ?, detail = '', updated_at = ? WHERE id = ? AND status = 'queued'",
      )
      .run(workerId, now.toISOString(), id);
    return Number(r.changes) === 1;
  }

  finish(
    id: string,
    status: "ready" | "skipped" | "failed",
    o: { detail?: string; draftIds?: string[]; now?: Date } = {},
  ): boolean {
    const r = this.db
      .prepare(
        `UPDATE early_work SET status = ?, detail = ?, draft_ids = ?, updated_at = ?
         WHERE id = ? AND status IN ('queued','running')`,
      )
      .run(
        status,
        (o.detail ?? "").slice(0, 500),
        JSON.stringify(o.draftIds ?? []),
        (o.now ?? new Date()).toISOString(),
        id,
      );
    return Number(r.changes) === 1;
  }
}
