import type { DatabaseSync } from "node:sqlite";
import { type VerifyOptions, type VerifyResult, verifyAuditAsync } from "./audit.ts";
import { backupNow, listBackups } from "./backup.ts";
import { BatchSizer, type DrainOptions, drainAsync } from "./batch.ts";
import { type BackupScrub, eraseTrailSteps, scrubBackupFile, threadsWithTrail } from "./erase.ts";
import {
  type ExportOptions,
  type ExportSummary,
  exportThread,
  type ImportOptions,
  type ImportSummary,
  importThread,
} from "./export.ts";
import { type MaintainResult, maintainSteps, pruneSteps, type RetentionPolicy } from "./retention.ts";
import {
  type DropPlaintextResult,
  dropPlaintextBackups,
  type PlaintextBackup,
  plaintextBackups,
  type SealPassResult,
  type SealStatus,
  sealStatus,
  sealSteps,
} from "./seal-pass.ts";

/**
 * Next round R2.3: the heavy store work, as one fixed list of jobs. Each job
 * is the store's own function; the database worker only runs it on another
 * thread over its own connection (`inline` runs the very same code on the
 * main connection — tests and `:memory:`). Arguments and results are plain
 * data so they cross `postMessage`.
 *
 * Deletes and the vacuum run as steps with a time-targeted batch size; the
 * driver hands the write lock back between batches, so a main-thread write
 * waits at most about one batch.
 */

export interface JobContext {
  db: DatabaseSync;
  dbPath: string;
  /** Target time of one batch (settings `engineering.perf.workerBatchMs`). */
  batchMs: number;
  /** Between batches: wait until the next may start (the worker sleeps about as long as the batch took). */
  pause: (lastBatchMs: number) => Promise<void>;
  /** Asked between batches (shutdown). */
  stop: () => boolean;
  /** Each batch's time and rows. */
  onBatch?: (job: string, ms: number, rows: number) => void;
}

export interface UpkeepPruneResult {
  pruned: Record<string, number>;
  /** Trails of deleted threads finished here (a crash between the two parts of a delete). */
  trails: number;
}

const drainOpts = (ctx: JobContext, job: string): DrainOptions => ({
  pause: ctx.pause,
  stop: ctx.stop,
  ...(ctx.onBatch ? { onBatch: (ms: number, rows: number) => ctx.onBatch?.(job, ms, rows) } : {}),
});

export const DB_JOBS = {
  /** Retention (gate of migration 21), then any trail a delete left behind. */
  async prune(ctx: JobContext, policy: RetentionPolicy, nowIso: string): Promise<UpkeepPruneResult> {
    const sizer = new BatchSizer({ targetMs: ctx.batchMs });
    const steps = pruneSteps(ctx.db, new Date(nowIso), policy, sizer);
    const pruned = await drainAsync(steps, sizer, drainOpts(ctx, "prune"));
    let trails = 0;
    for (const id of threadsWithTrail(ctx.db)) {
      const r = await drainAsync(eraseTrailSteps(ctx.db, id, sizer), sizer, drainOpts(ctx, "prune"));
      for (const [k, v] of Object.entries(r)) pruned[k] = (pruned[k] ?? 0) + v;
      trails += 1;
    }
    return { pruned, trails };
  },

  /** The event trail of conversations just deleted (R5: the content went on the main thread). */
  async eraseTrail(ctx: JobContext, threadIds: string[]): Promise<Record<string, number>> {
    const sizer = new BatchSizer({ targetMs: ctx.batchMs });
    const out: Record<string, number> = {};
    for (const id of threadIds) {
      const r = await drainAsync(eraseTrailSteps(ctx.db, id, sizer), sizer, drainOpts(ctx, "eraseTrail"));
      for (const [k, v] of Object.entries(r)) out[k] = (out[k] ?? 0) + v;
    }
    return out;
  },

  async maintain(ctx: JobContext, nowIso: string, lastVacuumAt: number | null): Promise<MaintainResult> {
    const sizer = BatchSizer.fixed(512);
    const g = maintainSteps(ctx.db, new Date(nowIso), lastVacuumAt === null ? {} : { lastVacuumAt });
    return drainAsync(g, sizer, drainOpts(ctx, "maintain"));
  },

  /** `VACUUM INTO` (a read transaction: writers go on in WAL). */
  async backup(
    ctx: JobContext,
    nowIso: string,
    kind: "manual" | "daily",
    keepDaily: number,
  ): Promise<string> {
    return backupNow(ctx.db, ctx.dbPath, new Date(nowIso), { kind, keepDaily });
  },

  async verifyAudit(ctx: JobContext, o: VerifyOptions): Promise<VerifyResult> {
    return verifyAuditAsync(ctx.db, o);
  },

  /** R5.4: take deleted conversations out of every backup file. */
  async scrubBackups(
    ctx: JobContext,
    threadIds: string[],
    nowIso: string,
    memories: boolean,
  ): Promise<BackupScrub[]> {
    const out: BackupScrub[] = [];
    for (const b of listBackups(ctx.dbPath)) {
      if (ctx.stop()) break;
      out.push(scrubBackupFile(b.file, threadIds, new Date(nowIso), memories ? { memories: true } : {}));
      await ctx.pause(0);
    }
    return out;
  },

  /** R5.6: one conversation to a `.alca-export` file. */
  async exportThread(
    ctx: JobContext,
    threadId: string,
    outPath: string,
    o: ExportOptions,
  ): Promise<ExportSummary> {
    return exportThread(ctx.db, threadId, outPath, o);
  },

  /** R5.6: one `.alca-export` file in, as a new conversation (one transaction). */
  async importThread(ctx: JobContext, file: string, o: ImportOptions): Promise<ImportSummary> {
    return importThread(ctx.db, file, o);
  },

  /**
   * R7.5 step 4: seal the rows written before the data key existed, in
   * time-targeted batches; when the pass finishes, the WAL is checkpointed
   * and truncated (secure_delete already zeroed the old cells).
   */
  async sealPass(ctx: JobContext, maxRows: number | null): Promise<SealPassResult> {
    const sizer = new BatchSizer({ targetMs: ctx.batchMs });
    const r = await drainAsync(
      sealSteps(ctx.db, sizer, maxRows === null ? {} : { maxRows }),
      sizer,
      drainOpts(ctx, "sealPass"),
    );
    if (r.done) ctx.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    return r;
  },

  /** R7: what is still plaintext, plus the backups that may hold plaintext (設定 → 資料). */
  async sealStatus(ctx: JobContext): Promise<SealStatus & { backups: PlaintextBackup[] }> {
    return { ...sealStatus(ctx.db), backups: plaintextBackups(ctx.db, ctx.dbPath) };
  },

  /** R7.5 step 5, user decision: only once nothing is plaintext; a new backup first. */
  async dropPlaintextBackups(ctx: JobContext, nowIso: string): Promise<DropPlaintextResult> {
    return dropPlaintextBackups(ctx.db, ctx.dbPath, new Date(nowIso));
  },
} as const;

export type DbJobs = typeof DB_JOBS;
export type JobName = keyof DbJobs;
type Rest<F> = F extends (ctx: JobContext, ...a: infer A) => unknown ? A : never;
export type JobArgs<K extends JobName> = Rest<DbJobs[K]>;
export type JobResult<K extends JobName> = Awaited<ReturnType<DbJobs[K]>>;
