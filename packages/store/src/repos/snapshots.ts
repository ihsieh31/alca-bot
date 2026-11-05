import type { DatabaseSync } from "node:sqlite";
import { transaction } from "../db.ts";
import { newStoreId } from "../ids.ts";

/** A file as it was just before one of a bot's edits (P13 undo). */
export interface FileSnapshot {
  id: string;
  botId: string;
  threadId: string;
  runId: string;
  /** The person's turn the edit belongs to (the router run that dispatched the worker, or the run). */
  turnRunId: string;
  workerId: string | null;
  tool: string;
  path: string;
  /** false: the file did not exist (undo removes it). */
  existed: boolean;
  /** Present when the content was kept; absent with `skipped`. */
  content: Uint8Array | null;
  mode: number | null;
  size: number;
  /** Why the content was not kept (too big, not a regular file, unreadable): such an edit cannot be undone. */
  skipped: string | null;
  createdAt: string;
  undoneAt: string | null;
  prunedAt: string | null;
}

/** One person's turn that edited files, for the thread's undo list. */
export interface EditedTurn {
  turnRunId: string;
  threadId: string;
  botId: string;
  files: number;
  /** Edits whose content could not be kept. */
  skipped: number;
  undone: boolean;
  pruned: boolean;
  firstAt: string;
  lastAt: string;
}

interface Row {
  id: string;
  bot_id: string;
  thread_id: string;
  run_id: string;
  turn_run_id: string;
  worker_id: string | null;
  tool: string;
  path: string;
  existed: number;
  content: Uint8Array | null;
  mode: number | null;
  size: number;
  skipped: string | null;
  created_at: string;
  undone_at: string | null;
  pruned_at: string | null;
}

const snap = (r: Row): FileSnapshot => ({
  id: r.id,
  botId: r.bot_id,
  threadId: r.thread_id,
  runId: r.run_id,
  turnRunId: r.turn_run_id,
  workerId: r.worker_id,
  tool: r.tool,
  path: r.path,
  existed: r.existed === 1,
  content: r.content ?? null,
  mode: r.mode,
  size: r.size,
  skipped: r.skipped,
  createdAt: r.created_at,
  undoneAt: r.undone_at,
  prunedAt: r.pruned_at,
});

export class SnapshotRepo {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  add(s: {
    botId: string;
    threadId: string;
    runId: string;
    turnRunId: string;
    workerId?: string | null;
    tool: string;
    path: string;
    existed: boolean;
    content?: Uint8Array | null;
    mode?: number | null;
    size?: number;
    skipped?: string | null;
    now?: Date;
  }): FileSnapshot {
    const now = s.now ?? new Date();
    const id = newStoreId("fsn", now.getTime());
    this.db
      .prepare(
        `INSERT INTO file_snapshots (id, bot_id, thread_id, run_id, turn_run_id, worker_id, tool, path, existed, content, mode, size, skipped, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        s.botId,
        s.threadId,
        s.runId,
        s.turnRunId,
        s.workerId ?? null,
        s.tool.slice(0, 200),
        s.path,
        s.existed ? 1 : 0,
        s.content ?? null,
        s.mode ?? null,
        s.size ?? s.content?.byteLength ?? 0,
        s.skipped ?? null,
        now.toISOString(),
      );
    return this.get(id) as FileSnapshot;
  }

  get(id: string): FileSnapshot | undefined {
    const r = this.db.prepare("SELECT * FROM file_snapshots WHERE id = ?").get(id) as Row | undefined;
    return r ? snap(r) : undefined;
  }

  /** Has this turn already snapshotted this path (the first snapshot of a turn is the one undo restores)? */
  has(turnRunId: string, path: string): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM file_snapshots WHERE turn_run_id = ? AND path = ? LIMIT 1")
      .get(turnRunId, path);
  }

  /** A turn's snapshots, oldest first. */
  ofTurn(turnRunId: string): FileSnapshot[] {
    return (
      this.db
        .prepare("SELECT * FROM file_snapshots WHERE turn_run_id = ? ORDER BY created_at, rowid")
        .all(turnRunId) as unknown as Row[]
    ).map(snap);
  }

  /** Turns of a thread that edited files, newest first. */
  turns(threadId: string, limit = 50): EditedTurn[] {
    const rows = this.db
      .prepare(
        `SELECT turn_run_id, thread_id, bot_id, COUNT(DISTINCT path) AS files,
                SUM(CASE WHEN skipped IS NOT NULL THEN 1 ELSE 0 END) AS skipped,
                MAX(CASE WHEN undone_at IS NOT NULL THEN 1 ELSE 0 END) AS undone,
                MAX(CASE WHEN pruned_at IS NOT NULL THEN 1 ELSE 0 END) AS pruned,
                MIN(created_at) AS first_at, MAX(created_at) AS last_at
         FROM file_snapshots WHERE thread_id = ? GROUP BY turn_run_id ORDER BY last_at DESC LIMIT ?`,
      )
      .all(threadId, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      turnRunId: r.turn_run_id as string,
      threadId: r.thread_id as string,
      botId: r.bot_id as string,
      files: Number(r.files),
      skipped: Number(r.skipped),
      undone: Number(r.undone) === 1,
      pruned: Number(r.pruned) === 1,
      firstAt: r.first_at as string,
      lastAt: r.last_at as string,
    }));
  }

  /** Is there a live (not undone) snapshot of this path from another turn made after `after`? */
  laterEdit(path: string, turnRunId: string, after: string): FileSnapshot | undefined {
    const r = this.db
      .prepare(
        `SELECT * FROM file_snapshots WHERE path = ? AND turn_run_id <> ? AND created_at >= ? AND undone_at IS NULL
         ORDER BY created_at LIMIT 1`,
      )
      .get(path, turnRunId, after) as Row | undefined;
    return r ? snap(r) : undefined;
  }

  markUndone(turnRunId: string, now = new Date()): number {
    const r = this.db
      .prepare("UPDATE file_snapshots SET undone_at = ? WHERE turn_run_id = ? AND undone_at IS NULL")
      .run(now.toISOString(), turnRunId);
    return Number(r.changes);
  }

  /**
   * Retention: per thread keep the newest `keepTurns` turns, and overall at
   * most `maxBytes` of content (oldest dropped first). A pruned turn keeps its
   * rows (what was edited) but loses the content, so it can no longer be undone.
   */
  prune(o: { threadId?: string; keepTurns: number; maxBytes: number; now?: Date }): number {
    const now = (o.now ?? new Date()).toISOString();
    return transaction(this.db, () => {
      let n = 0;
      if (o.threadId) {
        const old = this.db
          .prepare(
            `SELECT turn_run_id FROM file_snapshots WHERE thread_id = ? GROUP BY turn_run_id
             ORDER BY MAX(created_at) DESC LIMIT -1 OFFSET ?`,
          )
          .all(o.threadId, o.keepTurns) as Array<{ turn_run_id: string }>;
        const drop = this.db.prepare(
          "UPDATE file_snapshots SET content = NULL, pruned_at = ? WHERE turn_run_id = ? AND pruned_at IS NULL",
        );
        for (const t of old) n += Number(drop.run(now, t.turn_run_id).changes);
      }
      const total = () =>
        Number(
          (
            this.db
              .prepare("SELECT COALESCE(SUM(size), 0) AS b FROM file_snapshots WHERE content IS NOT NULL")
              .get() as { b: number }
          ).b,
        );
      let bytes = total();
      while (bytes > o.maxBytes) {
        const oldest = this.db
          .prepare(
            "SELECT turn_run_id FROM file_snapshots WHERE content IS NOT NULL ORDER BY created_at, rowid LIMIT 1",
          )
          .get() as { turn_run_id: string } | undefined;
        if (!oldest) break;
        n += Number(
          this.db
            .prepare(
              "UPDATE file_snapshots SET content = NULL, pruned_at = COALESCE(pruned_at, ?) WHERE turn_run_id = ? AND content IS NOT NULL",
            )
            .run(now, oldest.turn_run_id).changes,
        );
        bytes = total();
      }
      return n;
    });
  }
}
