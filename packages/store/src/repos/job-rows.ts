import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { openValue, sealValue } from "../seal.ts";

/**
 * Mac device test 2026-11-05 BUG-4: `jobs.title`, `jobs.input` and
 * `jobs.result` are sealed (R7.4) like `job_events.payload`, so the job rows'
 * reads and writes live here, in the store, and the jobs runtime calls these
 * instead of naming the content columns in its own SQL (the static scan in
 * seal-pass.test keeps it that way). Rows written before are opened as
 * plaintext until the background pass seals them.
 */

/** One `jobs` row with its content columns opened. */
export interface StoredJobRow {
  id: string;
  parent_id: string | null;
  thread_id: string | null;
  run_id: string | null;
  kind: string;
  status: string;
  title: string | null;
  attempt: number;
  outbound_observed: number;
  needs_review: number;
  lease_owner: string | null;
  lease_until: string | null;
  /** JSON text. */
  input: string;
  /** JSON text or null. */
  result: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
  bot_id: string | null;
}

const COLS = `id, parent_id, thread_id, run_id, kind, status, title, attempt, outbound_observed, needs_review,
  lease_owner, lease_until, input, result, created_at, updated_at, finished_at, bot_id`;

function opened(db: DatabaseSync, r: StoredJobRow): StoredJobRow {
  return {
    ...r,
    title: openValue(db, "jobs", "title", r.id, r.title),
    input: openValue(db, "jobs", "input", r.id, r.input),
    result: openValue(db, "jobs", "result", r.id, r.result),
  };
}

/** Insert a job row (inside the caller's transaction, if any). `input` is JSON text. */
export function insertJobRow(
  db: DatabaseSync,
  j: {
    id: string;
    parentId: string | null;
    threadId: string | null;
    runId: string | null;
    kind: string;
    title: string | null;
    input: string;
    at: string;
  },
): void {
  db.prepare(
    `INSERT INTO jobs (id, parent_id, thread_id, run_id, kind, title, input, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    j.id,
    j.parentId,
    j.threadId,
    j.runId,
    j.kind,
    sealValue(db, "jobs", "title", j.id, j.title),
    sealValue(db, "jobs", "input", j.id, j.input),
    j.at,
    j.at,
  );
}

/** One job row, opened. */
export function jobRow(db: DatabaseSync, id: string): StoredJobRow | undefined {
  const r = db.prepare(`SELECT ${COLS} FROM jobs WHERE id = ?`).get(id) as StoredJobRow | undefined;
  return r ? opened(db, r) : undefined;
}

/** Job rows of one parent, of one status, or flagged for review; oldest first, opened. */
export function jobRows(
  db: DatabaseSync,
  by: { parentId: string } | { status: string } | { needsReview: true },
): StoredJobRow[] {
  const [where, args]: [string, SQLInputValue[]] =
    "parentId" in by
      ? ["parent_id = ?", [by.parentId]]
      : "status" in by
        ? ["status = ?", [by.status]]
        : ["needs_review = 1", []];
  const rows = db
    .prepare(`SELECT ${COLS} FROM jobs WHERE ${where} ORDER BY created_at, rowid`)
    .all(...args) as unknown as StoredJobRow[];
  return rows.map((r) => opened(db, r));
}

/** Set a job's result (JSON text), sealed. */
export function setJobResult(db: DatabaseSync, id: string, result: string): void {
  db.prepare("UPDATE jobs SET result = ? WHERE id = ?").run(sealValue(db, "jobs", "result", id, result), id);
}
