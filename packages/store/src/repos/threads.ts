import type { DatabaseSync } from "node:sqlite";
import { eraseThreadTrailNow, type ScrubOptions, scrubThread } from "../erase.ts";
import { openValue, sealValue } from "../seal.ts";

export interface Thread {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  /** Set when the person deleted it (P13): such a thread never lists or opens. */
  deletedAt: string | null;
  /** Owning bot (null only for a store opened without the bots migration). */
  botId: string | null;
  /** Set when this is a peer conversation (P7): the request a teammate sent this thread's bot. */
  peerRequestId: string | null;
}

export type MessageRole = "user" | "assistant" | "system" | "tool";

export interface StoredMessage {
  id: string;
  threadId: string;
  runId: string | null;
  role: MessageRole;
  content: string;
  createdAt: string;
}

interface ThreadRow {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  deleted_at?: string | null;
  bot_id?: string | null;
  peer_request_id?: string | null;
}

interface MessageRow {
  id: string;
  thread_id: string;
  run_id: string | null;
  role: MessageRole;
  content: string;
  created_at: string;
}

const thread = (r: ThreadRow): Thread => ({
  id: r.id,
  title: r.title,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  archivedAt: r.archived_at,
  deletedAt: r.deleted_at ?? null,
  botId: r.bot_id ?? null,
  peerRequestId: r.peer_request_id ?? null,
});

const message = (db: DatabaseSync, r: MessageRow): StoredMessage => ({
  id: r.id,
  threadId: r.thread_id,
  runId: r.run_id,
  role: r.role,
  content: openValue(db, "messages", "content", r.id, r.content),
  createdAt: r.created_at,
});

/** Threads, their messages, and the engine session each thread continues. */
export class ThreadRepo {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  create(id: string, title: string | null, now = new Date(), botId?: string): Thread {
    const ts = now.toISOString();
    if (botId)
      this.db
        .prepare("INSERT INTO threads (id, title, created_at, updated_at, bot_id) VALUES (?, ?, ?, ?, ?)")
        .run(id, title, ts, ts, botId);
    else
      this.db
        .prepare("INSERT INTO threads (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)")
        .run(id, title, ts, ts);
    return this.get(id) as Thread;
  }

  /** A deleted thread is gone for every caller (P13). */
  get(id: string): Thread | undefined {
    const r = this.db.prepare("SELECT * FROM threads WHERE id = ?").get(id) as ThreadRow | undefined;
    return r && !r.deleted_at ? thread(r) : undefined;
  }

  private deletedColumn: boolean | undefined;
  private hasDeletedColumn(): boolean {
    this.deletedColumn ??= (
      this.db.prepare("PRAGMA table_info(threads)").all() as Array<{ name: string }>
    ).some((c) => c.name === "deleted_at");
    return this.deletedColumn;
  }

  private peerColumn: boolean | undefined;
  private hasPeerColumn(): boolean {
    this.peerColumn ??= (this.db.prepare("PRAGMA table_info(threads)").all() as Array<{ name: string }>).some(
      (c) => c.name === "peer_request_id",
    );
    return this.peerColumn;
  }

  /**
   * Most recently active first; archived threads are hidden (or, with
   * `archived`, the only ones shown). Peer conversations (a teammate asked
   * this thread's bot, P7) are left out unless `peers` is set: the person
   * reaches them through the team view. Paged (P13): `before` is the last
   * thread of the previous page (its updatedAt and id).
   */
  list(
    limit = 100,
    o: { peers?: boolean; archived?: boolean; before?: { updatedAt: string; id: string } } = {},
  ): Thread[] {
    const where = [o.archived ? "archived_at IS NOT NULL" : "archived_at IS NULL"];
    const args: Array<string | number> = [];
    if (!o.peers && this.hasPeerColumn()) where.push("peer_request_id IS NULL");
    if (this.hasDeletedColumn()) where.push("deleted_at IS NULL");
    if (o.before) {
      where.push("(updated_at < ? OR (updated_at = ? AND id < ?))");
      args.push(o.before.updatedAt, o.before.updatedAt, o.before.id);
    }
    const n = Math.min(Math.max(Math.trunc(limit) || 1, 1), 500);
    const rows = this.db
      .prepare(`SELECT * FROM threads WHERE ${where.join(" AND ")} ORDER BY updated_at DESC, id DESC LIMIT ?`)
      .all(...args, n) as unknown as ThreadRow[];
    return rows.map(thread);
  }

  /** Archive (hide from the list, keep everything) or bring back. */
  setArchived(id: string, archived: boolean, now = new Date()): boolean {
    const r = this.db
      .prepare(
        `UPDATE threads SET archived_at = ? WHERE id = ?${this.hasDeletedColumn() ? " AND deleted_at IS NULL" : ""}`,
      )
      .run(archived ? now.toISOString() : null, id);
    return Number(r.changes) > 0;
  }

  /**
   * What still works in a thread: routines, enabled triggers and live
   * workers. A thread with any of them cannot be deleted (stop them first).
   */
  dependents(id: string): { routines: number; triggers: number; workers: number } {
    const one = (sql: string) => Number((this.db.prepare(sql).get(id) as { n: number }).n);
    return {
      routines: one("SELECT COUNT(*) AS n FROM routines WHERE thread_id = ? AND removed_at IS NULL"),
      triggers: one("SELECT COUNT(*) AS n FROM triggers WHERE thread_id = ? AND enabled = 1"),
      workers: one(
        "SELECT COUNT(*) AS n FROM workers WHERE thread_id = ? AND status IN ('queued','running','waiting')",
      ),
    };
  }

  /**
   * Delete a conversation (P13; next round §4, R5): the row stays as an
   * empty shell (runs, jobs and the audit log point at it) and everything
   * that carries the conversation's words goes — see `scrubThread`. The
   * event trail goes in batches: right away (`trail: "now"`, the default) or
   * by the caller on the database worker (`trail: "later"`; the hourly prune
   * also finishes any trail a crash left). Returns false when there was none.
   */
  erase(id: string, now = new Date(), o: ScrubOptions & { trail?: "now" | "later" } = {}): boolean {
    if (!this.get(id)) return false;
    scrubThread(this.db, id, now, o.memories ? { memories: true } : {});
    if (o.trail !== "later") eraseThreadTrailNow(this.db, id);
    return true;
  }

  /** Mark a thread as the peer conversation of a request (P7; set once, at creation). */
  setPeerRequest(id: string, requestId: string): void {
    this.db
      .prepare("UPDATE threads SET peer_request_id = ? WHERE id = ? AND peer_request_id IS NULL")
      .run(requestId, id);
  }

  /** Which bot spoke in each run of a thread (P7: a thread can hear from several bots). */
  runBots(threadId: string): Map<string, string> {
    const rows = this.db
      .prepare("SELECT id, bot_id FROM runs WHERE thread_id = ? AND bot_id IS NOT NULL")
      .all(threadId) as Array<{ id: string; bot_id: string }>;
    return new Map(rows.map((r) => [r.id, r.bot_id]));
  }

  touch(id: string, now = new Date()): void {
    this.db.prepare("UPDATE threads SET updated_at = ? WHERE id = ?").run(now.toISOString(), id);
  }

  setTitle(id: string, title: string): void {
    this.db.prepare("UPDATE threads SET title = ? WHERE id = ?").run(title, id);
  }

  addMessage(m: Omit<StoredMessage, "createdAt">, now = new Date()): StoredMessage {
    const ts = now.toISOString();
    this.db
      .prepare(
        "INSERT INTO messages (id, thread_id, run_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(m.id, m.threadId, m.runId, m.role, sealValue(this.db, "messages", "content", m.id, m.content), ts);
    this.touch(m.threadId, now);
    return { ...m, createdAt: ts };
  }

  /** P14 回覆檢查: replace a reply's text with its rewrite (the run's events keep the original). */
  reviseMessage(id: string, content: string): boolean {
    const r = this.db
      .prepare("UPDATE messages SET content = ? WHERE id = ? AND role = 'assistant'")
      .run(sealValue(this.db, "messages", "content", id, content), id);
    return Number(r.changes) > 0;
  }

  /**
   * The thread's conversation as people see it. Messages of worker runs (P3)
   * are left out: a worker's own text is its stream, watched separately.
   * A long thread gives its LATEST `limit` messages, oldest first.
   */
  messages(threadId: string, limit = 500): StoredMessage[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT m.*, m.rowid AS seq_ FROM messages m WHERE m.thread_id = ?
             AND (m.run_id IS NULL OR m.run_id NOT IN (SELECT id FROM runs WHERE worker_id IS NOT NULL))
           ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?
         ) ORDER BY created_at, seq_`,
      )
      .all(threadId, limit) as unknown as MessageRow[];
    return rows.map((r) => message(this.db, r));
  }

  getSession(threadId: string, engineId: string): string | undefined {
    const r = this.db
      .prepare("SELECT session_id FROM engine_sessions WHERE thread_id = ? AND engine_id = ?")
      .get(threadId, engineId) as { session_id: string } | undefined;
    return r?.session_id;
  }

  setSession(threadId: string, engineId: string, sessionId: string, now = new Date()): void {
    this.db
      .prepare(
        `INSERT INTO engine_sessions (thread_id, engine_id, session_id, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (thread_id, engine_id) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at`,
      )
      .run(threadId, engineId, sessionId, now.toISOString());
  }

  /** Review 2026-11-05 #4: forget a session the engine could not resume. */
  clearSession(threadId: string, engineId: string): void {
    this.db
      .prepare("DELETE FROM engine_sessions WHERE thread_id = ? AND engine_id = ?")
      .run(threadId, engineId);
  }
}
