import type { DatabaseSync } from "node:sqlite";
import { openValue, sealValue } from "../seal.ts";

/**
 * R7.4: the job event log's reads and writes, kept in the store so the
 * sealed `payload` column is touched in one place (the jobs runtime calls
 * these instead of its own SQL).
 */

export interface StoredJobEvent {
  jobId: string;
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

/** Append the next event of a job (inside the caller's transaction, if any); returns its seq. */
export function appendJobEvent(
  db: DatabaseSync,
  jobId: string,
  type: string,
  payload: Record<string, unknown>,
  createdAt: string,
): number {
  const row = db
    .prepare("SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM job_events WHERE job_id = ?")
    .get(jobId) as { next: number };
  db.prepare("INSERT INTO job_events (job_id, seq, type, payload, created_at) VALUES (?, ?, ?, ?, ?)").run(
    jobId,
    row.next,
    type,
    sealValue(db, "job_events", "payload", `${jobId}:${row.next}`, JSON.stringify(payload)),
    createdAt,
  );
  return row.next;
}

export function jobEvents(db: DatabaseSync, jobId: string): StoredJobEvent[] {
  const rows = db
    .prepare("SELECT job_id, seq, type, payload, created_at FROM job_events WHERE job_id = ? ORDER BY seq")
    .all(jobId) as Array<{ job_id: string; seq: number; type: string; payload: string; created_at: string }>;
  return rows.map((r) => ({
    jobId: r.job_id,
    seq: r.seq,
    type: r.type,
    payload: JSON.parse(openValue(db, "job_events", "payload", `${r.job_id}:${r.seq}`, r.payload)) as Record<
      string,
      unknown
    >,
    createdAt: r.created_at,
  }));
}
