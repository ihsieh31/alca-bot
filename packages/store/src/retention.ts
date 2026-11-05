import type { DatabaseSync } from "node:sqlite";
import { BatchSizer, drainSync, type Steps } from "./batch.ts";
import { atomic } from "./db.ts";

/**
 * Next round §4: retention for the append-only event tables, as plain
 * functions (the scheduling is the agents sweep's hourly slot, not a timer
 * of its own). Deletes go through the gate of migration 21: the gate opens
 * and closes inside one transaction, and each DELETE selects only rows the
 * trigger also allows, so a mistake here aborts instead of deleting more.
 */

export interface RetentionPolicy {
  /** run_events of finished runs (user decision: 90). */
  runEventsDays: number;
  /** job_events of finished jobs (user decision: 90). */
  jobEventsDays: number;
  /** Outside content and side logs: trigger_events, spills, watchdog_events, peer_events, routine_runs (90). */
  externalDays: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = { runEventsDays: 90, jobEventsDays: 90, externalDays: 90 };

/**
 * Most rows one DELETE takes (R2.3: an upper bound — the database worker
 * sizes its batches to a time target instead). A call takes at most
 * `MAX_ROWS` rows per table; the next hour continues.
 */
export const RETENTION_BATCH = 50_000;
const MAX_ROWS = 20 * RETENTION_BATCH;

const DAY = 86_400_000;

interface Plan {
  tbl: string;
  days: (p: RetentionPolicy) => number;
  /** Rowids the trigger allows once the gate is `?1`. */
  select: string;
}

const PLANS: readonly Plan[] = [
  {
    tbl: "run_events",
    days: (p) => p.runEventsDays,
    select: `SELECT e.rowid AS rid FROM run_events e JOIN runs r ON r.id = e.run_id
             WHERE r.status = 'finished' AND r.finished_at < ?1 AND e.created_at < ?1`,
  },
  {
    tbl: "job_events",
    days: (p) => p.jobEventsDays,
    select: `SELECT e.rowid AS rid FROM job_events e JOIN jobs j ON j.id = e.job_id
             WHERE j.status IN ('succeeded','failed','cancelled') AND j.updated_at < ?1 AND e.created_at < ?1`,
  },
  {
    tbl: "spills",
    days: (p) => p.externalDays,
    select: "SELECT rowid AS rid FROM spills WHERE created_at < ?1",
  },
  {
    tbl: "trigger_events",
    days: (p) => p.externalDays,
    select: "SELECT rowid AS rid FROM trigger_events WHERE created_at < ?1",
  },
  {
    tbl: "watchdog_events",
    days: (p) => p.externalDays,
    select: "SELECT rowid AS rid FROM watchdog_events WHERE created_at < ?1",
  },
  {
    tbl: "peer_events",
    days: (p) => p.externalDays,
    select: `SELECT e.rowid AS rid FROM peer_events e JOIN peer_requests q ON q.id = e.request_id
             WHERE e.created_at < ?1 AND q.status <> 'running'`,
  },
  {
    tbl: "routine_runs",
    days: (p) => p.externalDays,
    // The newest 20 of each routine stay (the UI shows the last few runs).
    select: `SELECT rid FROM (
               SELECT rowid AS rid, created_at, ROW_NUMBER() OVER (
                 PARTITION BY routine_id ORDER BY created_at DESC, id DESC) AS n
               FROM routine_runs)
             WHERE n > 20 AND created_at < ?1`,
  },
];

/** True once migration 21 is in (older test stores do not have the gate). */
export function hasRetentionGate(db: DatabaseSync): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'retention_gate'").get();
}

/**
 * Delete what is past its retention. Returns rows deleted per table (only
 * tables that lost rows). Each batch is its own transaction: the gate is
 * opened, one bounded DELETE runs, the gate is closed again.
 */
export function pruneRetention(
  db: DatabaseSync,
  now: Date,
  policy: RetentionPolicy = DEFAULT_RETENTION,
): Record<string, number> {
  return drainSync(pruneSteps(db, now, policy, BatchSizer.fixed(RETENTION_BATCH)));
}

/**
 * The same deletes as steps (R2.3): one committed batch per step, so a driver
 * can yield the write lock between batches. `sizer` decides the batch size
 * (fixed for the sync call, time-targeted in the database worker).
 */
export function* pruneSteps(
  db: DatabaseSync,
  now: Date,
  policy: RetentionPolicy,
  sizer: BatchSizer,
): Steps<Record<string, number>> {
  const out: Record<string, number> = {};
  if (!hasRetentionGate(db)) return out;
  const openGate = db.prepare("UPDATE retention_gate SET before = ? WHERE tbl = ?");
  const closeGate = db.prepare("UPDATE retention_gate SET before = NULL WHERE tbl = ?");
  for (const plan of PLANS) {
    const days = plan.days(policy);
    if (!Number.isFinite(days) || days < 7) continue; // the trigger would refuse it anyway
    const before = new Date(now.getTime() - days * DAY).toISOString();
    const del = db.prepare(
      `DELETE FROM ${plan.tbl} WHERE rowid IN (SELECT rid FROM (${plan.select}) LIMIT ?)`,
    );
    let total = 0;
    while (total < MAX_ROWS) {
      const size = Math.min(sizer.size, MAX_ROWS - total);
      const n = sizer.time(() =>
        atomic(db, () => {
          openGate.run(before, plan.tbl);
          try {
            return Number(del.run(before, size).changes);
          } finally {
            closeGate.run(plan.tbl);
          }
        }),
      );
      total += n;
      if (n < size) break;
      yield n;
    }
    if (total) out[plan.tbl] = total;
  }
  const offers = pruneDecidedOffers(db, new Date(now.getTime() - OFFERS_KEEP_DAYS * DAY), sizer);
  if (offers) out.offers = offers;
  return out;
}

/** Review 2026-11-05 #1: a decided offer card is kept this long, then deleted (pending ones stay). */
export const OFFERS_KEEP_DAYS = 90;

/**
 * Decided offers (accepted / declined / ignored / expired) decided before
 * `before`, in batches; the telemetry rows that pointed at them lose the link
 * (`proactive_candidates.offer_id`). No gate: offers have no delete trigger.
 */
export function pruneDecidedOffers(db: DatabaseSync, before: Date, sizer: BatchSizer): number {
  const exists = (t: string) =>
    !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  if (!exists("offers")) return 0;
  const log = exists("proactive_candidates");
  const pick = `SELECT id FROM offers WHERE status <> 'pending' AND decided_at IS NOT NULL AND decided_at < ?1 ORDER BY id LIMIT ?2`;
  const unlink = log
    ? db.prepare(`UPDATE proactive_candidates SET offer_id = NULL WHERE offer_id IN (${pick})`)
    : undefined;
  const del = db.prepare(`DELETE FROM offers WHERE id IN (${pick})`);
  const ts = before.toISOString();
  let total = 0;
  while (total < MAX_ROWS) {
    const size = Math.min(sizer.size, MAX_ROWS - total);
    const n = sizer.time(() =>
      atomic(db, () => {
        unlink?.run(ts, size);
        return Number(del.run(ts, size).changes);
      }),
    );
    total += n;
    if (n < size) break;
  }
  return total;
}

/** Free-page share above which the hourly maintenance reclaims pages. */
const FREE_SHARE = 0.1;
const VACUUM_EVERY_MS = 7 * DAY;
const VACUUM_PAGES = 4096;

export interface MaintainResult {
  checkpointed: boolean;
  /** Pages handed back to the file system by incremental_vacuum (0 when not due). */
  vacuumedPages: number;
}

const pragma = (db: DatabaseSync, name: string): number =>
  Number((db.prepare(`PRAGMA ${name}`).get() as Record<string, number>)[name] ?? 0);

/** R2.3: incremental_vacuum runs in steps of this many pages (the write lock is yielded between them). */
const VACUUM_STEP_PAGES = 512;

/**
 * Hourly: fold the WAL into the main file and truncate it (deleted content
 * leaves the -wal), and when at least a tenth of the file is free pages and a
 * week has passed since the last time, give up to 4096 pages back. A busy
 * checkpoint is not retried (next hour).
 */
export function maintain(db: DatabaseSync, now: Date, o: { lastVacuumAt?: number } = {}): MaintainResult {
  return drainSync(maintainSteps(db, now, o));
}

/** `maintain` as steps: the vacuum gives pages back 512 at a time. */
export function* maintainSteps(
  db: DatabaseSync,
  now: Date,
  o: { lastVacuumAt?: number } = {},
): Steps<MaintainResult> {
  let checkpointed = false;
  const mode = (db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode;
  if (mode === "wal") {
    const r = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number } | undefined;
    checkpointed = (r?.busy ?? 1) === 0;
  }
  let vacuumedPages = 0;
  const due = o.lastVacuumAt === undefined || now.getTime() - o.lastVacuumAt >= VACUUM_EVERY_MS;
  if (pragma(db, "auto_vacuum") === 2 && due) {
    const free = pragma(db, "freelist_count");
    const pages = pragma(db, "page_count");
    if (pages > 0 && free / pages > FREE_SHARE) {
      let left = VACUUM_PAGES;
      while (left > 0) {
        const before = pragma(db, "freelist_count");
        if (before === 0) break;
        const step = Math.min(VACUUM_STEP_PAGES, left);
        db.exec(`PRAGMA incremental_vacuum(${step})`);
        const got = before - pragma(db, "freelist_count");
        vacuumedPages += got;
        left -= step;
        if (got === 0) break;
        if (left > 0) yield got;
      }
    }
  }
  return { checkpointed, vacuumedPages };
}

/** Databases above this size are not converted at start (the one-time VACUUM needs as much free disk). */
export const AUTO_VACUUM_LIMIT = 500 * 1024 * 1024;

export interface VacuumConversion {
  converted: boolean;
  skipped?: "memory" | "already" | "too_large" | "failed";
  ms?: number;
  error?: string;
}

/**
 * One-time switch of an existing file to `auto_vacuum = INCREMENTAL`
 * (`incremental_vacuum` does nothing on a NONE file). Runs after the
 * migrations — the pre-migration backup already exists — outside any
 * transaction because VACUUM cannot run inside one.
 */
export function convertAutoVacuum(
  db: DatabaseSync,
  path: string,
  bytes: number,
  limit = AUTO_VACUUM_LIMIT,
): VacuumConversion {
  if (path === ":memory:" || path.startsWith("file::memory:")) return { converted: false, skipped: "memory" };
  if (pragma(db, "auto_vacuum") === 2) return { converted: false, skipped: "already" };
  if (bytes > limit) return { converted: false, skipped: "too_large" };
  const t0 = Date.now();
  try {
    db.exec("PRAGMA auto_vacuum = INCREMENTAL");
    db.exec("VACUUM");
  } catch (err) {
    return { converted: false, skipped: "failed", error: err instanceof Error ? err.message : String(err) };
  }
  return { converted: true, ms: Date.now() - t0 };
}
