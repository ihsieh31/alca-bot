import { chmodSync, existsSync, renameSync, rmSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { BatchSizer, drainSync, type Steps } from "./batch.ts";
import { atomic, openDatabase } from "./db.ts";
import { currentVersion } from "./migrate.ts";
import { hasRetentionGate } from "./retention.ts";

/**
 * Next round R5 (Phase F1): deleting a conversation. One path, the one
 * migration 21 opened: `threads.deleted_at` is set (and is final), and from
 * then on the triggers let that thread's append-only rows go — run events,
 * job events, spills (migration 21) and approval / question cards
 * (migration 22). Nothing here deletes a row whose thread is not marked; the
 * triggers would refuse it.
 *
 * Two parts, so the main thread never holds the write lock for long (R2.3):
 *
 * 1. `scrubThread` — one short transaction: the mark, and every row or column
 *    that carries the conversation's words (messages, drafts, engine
 *    sessions, approval and question cards, worker goals and results, job
 *    titles and inputs, the dispatch ledger, early work, inbox rows, undo
 *    snapshot contents, offer cards; the thread's memories only when asked).
 * 2. `eraseTrailSteps` — the event trail, in batches (the database worker
 *    runs it, and the hourly prune finishes any a crash left behind).
 *
 * What stays, by design: the `threads` row as an empty shell (id and times;
 * runs, jobs and the audit log point at it), the runs' ids and times, and
 * `audit_log` (permanent, hash-chained; its `target` can name a recipient or
 * URL). Outside the database: the CLI engines' own session logs (Claude Code
 * keeps them in its own folder; user decision, Alca does not give it a
 * separate one), so they are out of scope.
 */

export interface ScrubOptions {
  /** Also forget the memories learned in this conversation (user default: keep them). */
  memories?: boolean;
}

const has = (db: DatabaseSync, table: string): boolean =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);

const hasColumn = (db: DatabaseSync, table: string, column: string): boolean =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === column);

/** Placeholder for NOT NULL text columns with a length check (worker titles, early work). */
export const ERASED_TEXT = "（已刪除）";

/**
 * Mark the thread deleted and remove its content in one transaction. Returns
 * rows touched per table. Returns `undefined` when there is no such thread.
 * The event trail is left to `eraseTrailSteps`.
 */
export function scrubThread(
  db: DatabaseSync,
  threadId: string,
  now: Date,
  o: ScrubOptions = {},
): Record<string, number> | undefined {
  if (!db.prepare("SELECT 1 FROM threads WHERE id = ?").get(threadId)) return undefined;
  const ts = now.toISOString();
  const out: Record<string, number> = {};
  const run = (name: string, sql: string, ...args: Array<string | null>) => {
    const n = Number(db.prepare(sql).run(...args).changes);
    if (n) out[name] = (out[name] ?? 0) + n;
  };
  atomic(db, () => {
    const del = hasColumn(db, "threads", "deleted_at");
    if (!del) throw new Error("this database predates conversation delete (migration 15)");
    db.prepare(
      `UPDATE threads SET title = NULL, deleted_at = COALESCE(deleted_at, ?),
         archived_at = COALESCE(archived_at, ?) WHERE id = ?`,
    ).run(ts, ts, threadId);
    if (o.memories && has(db, "memories")) forgetThreadMemories(db, threadId, out);
    run("messages", "DELETE FROM messages WHERE thread_id = ?", threadId);
    run("engine_sessions", "DELETE FROM engine_sessions WHERE thread_id = ?", threadId);
    if (has(db, "drafts")) run("drafts", "DELETE FROM drafts WHERE thread_id = ?", threadId);
    // Cards: the triggers (migration 22) allow these now that deleted_at is set.
    const ofThread = `run_id IN (SELECT id FROM runs WHERE thread_id = ?1)`;
    const workersOf = "SELECT id FROM workers WHERE thread_id = ?1";
    run("approvals", `DELETE FROM approvals WHERE ${ofThread} OR worker_id IN (${workersOf})`, threadId);
    run("questions", `DELETE FROM questions WHERE ${ofThread}`, threadId);
    if (has(db, "workers")) {
      run(
        "workers",
        `UPDATE workers SET title = ?2, goal = '', result_summary = NULL WHERE thread_id = ?1
           AND (title <> ?2 OR goal <> '' OR result_summary IS NOT NULL)`,
        threadId,
        ERASED_TEXT,
      );
    }
    run(
      "jobs",
      `UPDATE jobs SET title = NULL, input = '{}', result = NULL WHERE thread_id = ?
         AND (title IS NOT NULL OR input <> '{}' OR result IS NOT NULL)`,
      threadId,
    );
    if (has(db, "dispatches")) {
      // The ledger of a finished conversation: the same three deletes the
      // 30-day prune makes (events may go once their dispatch row is gone).
      const ids = (
        db.prepare("SELECT id FROM dispatches WHERE thread_id = ?").all(threadId) as Array<{ id: string }>
      ).map((r) => r.id);
      for (const id of ids) {
        run("dispatches", "DELETE FROM dispatches WHERE id = ?", id);
        run("dispatch_events", "DELETE FROM dispatch_events WHERE dispatch_id = ?", id);
        run("harness_waits", "DELETE FROM harness_waits WHERE dispatch_id = ?", id);
      }
    }
    if (has(db, "offers")) {
      // Review 2026-11-05 #1: a card of a deleted conversation is gone with it
      // (its text, action and topic, and nothing left to answer "yes" to).
      if (has(db, "proactive_candidates"))
        run(
          "proactive_candidates",
          `UPDATE proactive_candidates SET offer_id = NULL
             WHERE offer_id IN (SELECT id FROM offers WHERE thread_id = ?)`,
          threadId,
        );
      run("offers", "DELETE FROM offers WHERE thread_id = ?", threadId);
    }
    if (has(db, "early_work")) run("early_work", "DELETE FROM early_work WHERE thread_id = ?", threadId);
    if (has(db, "file_snapshots"))
      run(
        "file_snapshots",
        `UPDATE file_snapshots SET content = NULL, pruned_at = COALESCE(pruned_at, ?2)
           WHERE thread_id = ?1 AND (content IS NOT NULL OR pruned_at IS NULL)`,
        threadId,
        ts,
      );
    if (has(db, "router_inbox"))
      run("router_inbox", "DELETE FROM router_inbox WHERE thread_id = ?", threadId);
    if (has(db, "worker_inbox"))
      run("worker_inbox", `DELETE FROM worker_inbox WHERE worker_id IN (${workersOf})`, threadId);
    if (has(db, "care_log")) run("care_log", "DELETE FROM care_log WHERE thread_id = ?", threadId);
  });
  return out;
}

/** Every memory learned in the thread, with all its versions (the same delete as MemoryRepo.forgetChain). */
function forgetThreadMemories(db: DatabaseSync, threadId: string, out: Record<string, number>): void {
  const roots = db.prepare("SELECT id FROM memories WHERE source_thread_id = ?").all(threadId) as Array<{
    id: string;
  }>;
  const del = db.prepare("DELETE FROM memories WHERE id = ?");
  const seen = new Set<string>();
  for (const { id } of roots) {
    for (const m of memoryChain(db, id)) {
      if (seen.has(m)) continue;
      seen.add(m);
      out.memories = (out.memories ?? 0) + Number(del.run(m).changes);
    }
  }
}

function memoryChain(db: DatabaseSync, id: string): string[] {
  const rows = db
    .prepare(
      `WITH RECURSIVE up(id) AS (SELECT ? UNION SELECT m.supersedes FROM memories m JOIN up ON m.id = up.id
                                   WHERE m.supersedes IS NOT NULL),
                     down(id) AS (SELECT id FROM up UNION SELECT m.id FROM memories m JOIN down ON m.supersedes = down.id)
       SELECT id FROM down`,
    )
    .all(id) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

interface TrailPlan {
  tbl: string;
  /** Rowids of the thread's rows in `tbl` (?1 = thread id, ?2 = limit). */
  select: string;
}

const TRAIL: readonly TrailPlan[] = [
  {
    tbl: "run_events",
    select: "SELECT e.rowid FROM run_events e JOIN runs r ON r.id = e.run_id WHERE r.thread_id = ?1 LIMIT ?2",
  },
  {
    tbl: "job_events",
    select: "SELECT e.rowid FROM job_events e JOIN jobs j ON j.id = e.job_id WHERE j.thread_id = ?1 LIMIT ?2",
  },
  {
    tbl: "spills",
    select: `SELECT s.rowid FROM spills s WHERE (s.owner_kind = 'worker'
               AND s.owner_id IN (SELECT id FROM workers WHERE thread_id = ?1))
             OR (s.owner_kind = 'trigger_event' AND s.owner_id IN (
               SELECT e.id FROM trigger_events e JOIN triggers tr ON tr.id = e.trigger_id WHERE tr.thread_id = ?1))
             LIMIT ?2`,
  },
];

/**
 * The event trail of a deleted thread, one committed batch per step. Refuses
 * (by the triggers) a thread that is not marked deleted.
 */
export function* eraseTrailSteps(
  db: DatabaseSync,
  threadId: string,
  sizer: BatchSizer,
): Steps<Record<string, number>> {
  const out: Record<string, number> = {};
  if (!hasRetentionGate(db)) return out;
  for (const plan of TRAIL) {
    const del = db.prepare(`DELETE FROM ${plan.tbl} WHERE rowid IN (${plan.select})`);
    let total = 0;
    for (;;) {
      const size = sizer.size;
      const n = sizer.time(() => atomic(db, () => Number(del.run(threadId, size).changes)));
      total += n;
      if (n < size) break;
      yield n;
    }
    if (total) out[plan.tbl] = total;
  }
  return out;
}

/** Sync driver of `eraseTrailSteps` (tests, the CLI, a core with no worker). */
export function eraseThreadTrailNow(db: DatabaseSync, threadId: string): Record<string, number> {
  return drainSync(eraseTrailSteps(db, threadId, BatchSizer.fixed(50_000)));
}

/** Deleted threads whose trail is not gone yet (a crash between the two parts). */
export function threadsWithTrail(db: DatabaseSync, limit = 20): string[] {
  if (!hasRetentionGate(db)) return [];
  const rows = db
    .prepare(
      `SELECT t.id FROM threads t WHERE t.deleted_at IS NOT NULL AND (
         EXISTS (SELECT 1 FROM runs r JOIN run_events e ON e.run_id = r.id WHERE r.thread_id = t.id)
         OR EXISTS (SELECT 1 FROM jobs j JOIN job_events e ON e.job_id = j.id WHERE j.thread_id = t.id))
       LIMIT ?`,
    )
    .all(limit) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

export interface BackupScrub {
  file: string;
  ok: boolean;
  /** The thread was not in this backup (nothing to do). */
  absent?: boolean;
  error?: string;
}

/**
 * R5.4 (user default: on): take a deleted conversation out of the backup
 * files too. Each backup is opened on its own, the same `scrubThread` +
 * trail run there (so the same triggers decide), then the file is rewritten
 * with `VACUUM INTO` a temporary file and renamed over the old one (no freed
 * page keeps the text). A backup that cannot be scrubbed — for instance one
 * taken before migration 22, whose triggers still refuse to delete approval
 * cards — is left as it is and reported; it ages out with the daily
 * rotation (seven days) or the newest-five rule.
 */
export function scrubBackupFile(
  file: string,
  threadIds: readonly string[],
  now: Date,
  o: ScrubOptions = {},
): BackupScrub {
  if (!existsSync(file)) return { file, ok: false, error: "missing" };
  const tmp = `${file}.scrub-${process.pid}`;
  let db: DatabaseSync | undefined;
  try {
    // Look first without writing (a file this cannot scrub stays byte for byte as it was).
    const ro = openDatabase({ path: file, readOnly: true, conn: "worker" });
    let present: string[];
    let version: number;
    try {
      version = currentVersion(ro);
      present = threadIds.filter((id) => threadHasContent(ro, id));
    } finally {
      ro.close();
    }
    if (!present.length) return { file, ok: true, absent: true };
    if (version < 22) throw new Error(`backup is at schema ${version} (before migration 22)`);
    db = openDatabase({ path: file, conn: "worker" });
    // A backup file is a plain rollback-journal copy; keep it that way.
    db.exec("PRAGMA journal_mode = DELETE");
    for (const id of present) {
      scrubThread(db, id, now, o);
      eraseThreadTrailNow(db, id);
    }
    rmSync(tmp, { force: true });
    db.prepare("VACUUM INTO ?").run(tmp);
    db.close();
    db = undefined;
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
    for (const ext of ["-wal", "-shm", "-journal"]) rmSync(file + ext, { force: true });
    return { file, ok: true };
  } catch (err) {
    rmSync(tmp, { force: true });
    return { file, ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    db?.close();
  }
}

/** Does the backup still hold anything of this thread beyond an already-scrubbed shell? */
function threadHasContent(db: DatabaseSync, id: string): boolean {
  const any = (sql: string) => !!db.prepare(sql).get(id);
  return (
    any("SELECT 1 FROM threads WHERE id = ?") &&
    (any("SELECT 1 FROM threads WHERE id = ? AND (title IS NOT NULL OR deleted_at IS NULL)") ||
      any("SELECT 1 FROM messages WHERE thread_id = ? LIMIT 1") ||
      any("SELECT 1 FROM runs r JOIN run_events e ON e.run_id = r.id WHERE r.thread_id = ? LIMIT 1"))
  );
}
