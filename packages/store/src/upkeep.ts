import type { DatabaseSync } from "node:sqlite";
import {
  type AuditAnchor,
  anchorPath,
  auditTail,
  readAnchor,
  type VerifyOptions,
  type VerifyResult,
  verifyAudit,
  writeAnchor,
} from "./audit.ts";
import { backupNow, lastDailyBackup } from "./backup.ts";
import type { DbWorker } from "./db-worker.ts";
import { loopWarnings, type PerfSnapshot, perfSnapshot } from "./perf.ts";
import {
  DEFAULT_RETENTION,
  type MaintainResult,
  maintain,
  pruneRetention,
  type RetentionPolicy,
} from "./retention.ts";

/**
 * Next round §3 + §4: the data steps of the agents sweep's hourly slot, in
 * the order the design gives (after `dispatches.prune`, before the git
 * snapshot sweep): retention, the daily backup, checkpoint / incremental
 * vacuum, the incremental audit check. Not a scheduler: the existing clock
 * calls `hourly()`. Each step has its own try/catch; one failing step does
 * not stop the others.
 */

export interface UpkeepPolicy extends RetentionPolicy {
  /** Daily backups kept; 0 = no daily backup. */
  dailyBackups: number;
}

export interface UpkeepOptions {
  db: DatabaseSync;
  dbPath: string;
  policy?: () => UpkeepPolicy;
  /** True while a run is in progress (a slow daily backup then waits for a quiet hour). */
  busy?: () => boolean;
  /** Once per distinct failure: the audit check found a broken chain or a cut-off tail. */
  onAuditBroken?: (r: VerifyResult) => void;
  log?: (level: "info" | "warn" | "error", line: string) => void;
  /**
   * R2.3: the database worker. With it, `runHourly` runs the heavy steps
   * there (retention, backup, checkpoint / vacuum, audit check) and the
   * anchor and alerts stay here.
   */
  jobs?: Pick<DbWorker, "run">;
}

export interface UpkeepReport {
  at: string;
  pruned?: Record<string, number>;
  backup?: { file: string; ms: number } | { skipped: "off" | "fresh" | "busy" | "memory" };
  maintain?: MaintainResult;
  audit?: VerifyResult;
  /** Set only the first time a given audit failure is seen (the alert goes out once). */
  alert?: VerifyResult;
  /** R2.3: deleted conversations whose event trail this hour finished (a crash in between). */
  trails?: number;
  errors: Record<string, string>;
}

const DAY = 86_400_000;
/** A daily backup slower than this waits for an hour with no run in progress. */
export const SLOW_BACKUP_MS = 2_000;

export class Upkeep {
  private readonly o: UpkeepOptions;
  private lastVerified: { id: number; hash: string } | undefined;
  private lastVacuumAt: number | undefined;
  private lastBackupMs = 0;
  private readonly alerted = new Set<string>();
  private last: UpkeepReport | undefined;
  private lastPerf: PerfSnapshot | undefined;
  private running: Promise<UpkeepReport> | undefined;

  constructor(o: UpkeepOptions) {
    this.o = o;
  }

  get anchorFile(): string {
    return anchorPath(this.o.dbPath);
  }

  private get memory(): boolean {
    return this.o.dbPath === ":memory:" || this.o.dbPath.startsWith("file::memory:");
  }

  policy(): UpkeepPolicy {
    return this.o.policy?.() ?? { ...DEFAULT_RETENTION, dailyBackups: 7 };
  }

  /** The last hourly report (設定 → 資料 shows it). */
  status(): { last?: UpkeepReport; slowBackupMs?: number; perf?: PerfSnapshot } {
    return {
      ...(this.last ? { last: this.last } : {}),
      ...(this.lastPerf ? { perf: this.lastPerf } : {}),
      ...(this.lastBackupMs > SLOW_BACKUP_MS ? { slowBackupMs: this.lastBackupMs } : {}),
    };
  }

  hourly(now: Date): UpkeepReport {
    const p = this.policy();
    const r: UpkeepReport = { at: now.toISOString(), errors: {} };
    const step = (name: string, fn: () => void) => {
      try {
        fn();
      } catch (err) {
        r.errors[name] = err instanceof Error ? err.message : String(err);
        this.o.log?.("warn", `資料維護（${name}）失敗：${r.errors[name]}`);
      }
    };
    step("retention", () => {
      r.pruned = pruneRetention(this.o.db, now, p);
    });
    step("backup", () => {
      r.backup = this.dailyBackup(now, p.dailyBackups);
    });
    step("maintain", () => {
      r.maintain = maintain(
        this.o.db,
        now,
        this.lastVacuumAt === undefined ? {} : { lastVacuumAt: this.lastVacuumAt },
      );
      if (r.maintain.vacuumedPages > 0) this.lastVacuumAt = now.getTime();
    });
    step("audit", () => {
      const before = this.alerted.size;
      r.audit = this.checkAudit(now);
      if (this.alerted.size > before) r.alert = r.audit;
    });
    this.finishHour(r);
    return r;
  }

  private finishHour(r: UpkeepReport): void {
    const n = Object.values(r.pruned ?? {}).reduce((a, b) => a + b, 0);
    if (n) this.o.log?.("info", `保留期清除：${n} 筆（${JSON.stringify(r.pruned)}）`);
    // R2.2: the hour's measurements (event loop, slow SQL) are kept for 設定 → 資料, then reset.
    this.lastPerf = perfSnapshot(true);
    for (const w of loopWarnings(this.lastPerf)) this.o.log?.("warn", w);
    this.last = r;
  }

  /** R2.3: the heavy steps run on the database worker (`runHourly`). */
  get usesWorker(): boolean {
    return !!this.o.jobs;
  }

  /** True while a `runHourly` is still going (the clock does not start another). */
  get inFlight(): boolean {
    return !!this.running;
  }

  /**
   * R2.3: the same hour, with the heavy steps on the database worker.
   * Order as in the design: prune → backup → maintain → verify (the backup's
   * read transaction would keep the checkpoint from folding that WAL).
   * Re-entry returns the hour already running.
   */
  runHourly(now: Date): Promise<UpkeepReport> {
    if (this.running) return this.running;
    const jobs = this.o.jobs;
    if (!jobs) return Promise.resolve(this.hourly(now));
    const run = this.hourlyOn(jobs, now).finally(() => {
      this.running = undefined;
    });
    this.running = run;
    return run;
  }

  private async hourlyOn(jobs: Pick<DbWorker, "run">, now: Date): Promise<UpkeepReport> {
    const p = this.policy();
    const iso = now.toISOString();
    const r: UpkeepReport = { at: iso, errors: {} };
    const step = async (name: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (err) {
        r.errors[name] = err instanceof Error ? err.message : String(err);
        this.o.log?.("warn", `資料維護（${name}）失敗：${r.errors[name]}`);
      }
    };
    await step("retention", async () => {
      const out = await jobs.run("prune", { ...p }, iso);
      r.pruned = out.pruned;
      if (out.trails) r.trails = out.trails;
    });
    await step("backup", async () => {
      const skip = this.backupSkip(now, p.dailyBackups);
      if (skip) {
        r.backup = skip;
        return;
      }
      const t0 = Date.now();
      const file = await jobs.run("backup", iso, "daily", p.dailyBackups);
      this.lastBackupMs = Date.now() - t0;
      r.backup = { file, ms: this.lastBackupMs };
    });
    await step("maintain", async () => {
      r.maintain = await jobs.run("maintain", iso, this.lastVacuumAt ?? null);
      if (r.maintain.vacuumedPages > 0) this.lastVacuumAt = now.getTime();
    });
    await step("audit", async () => {
      const before = this.alerted.size;
      const { opts, from, anchor } = this.auditPlan();
      r.audit = this.afterVerify(await jobs.run("verifyAudit", opts), from, anchor, now);
      if (this.alerted.size > before) r.alert = r.audit;
    });
    this.finishHour(r);
    return r;
  }

  /** Why the daily backup is not taken this hour, if it is not. */
  private backupSkip(now: Date, keep: number): { skipped: "off" | "fresh" | "busy" | "memory" } | undefined {
    if (keep <= 0) return { skipped: "off" };
    if (this.memory) return { skipped: "memory" };
    const prev = lastDailyBackup(this.o.dbPath);
    if (prev && now.getTime() - Date.parse(prev.takenAt) < DAY) return { skipped: "fresh" };
    // On the worker a slow backup no longer blocks the loop, but it still holds a long read transaction.
    if (this.lastBackupMs > SLOW_BACKUP_MS && this.o.busy?.()) return { skipped: "busy" };
    return undefined;
  }

  private dailyBackup(now: Date, keep: number): NonNullable<UpkeepReport["backup"]> {
    const skip = this.backupSkip(now, keep);
    if (skip) return skip;
    const t0 = Date.now();
    const file = backupNow(this.o.db, this.o.dbPath, now, { kind: "daily", keepDaily: keep });
    this.lastBackupMs = Date.now() - t0;
    if (this.lastBackupMs > SLOW_BACKUP_MS)
      this.o.log?.("warn", `每日備份花了 ${this.lastBackupMs} ms；之後改在沒有進行中的工作時才做`);
    return { file, ms: this.lastBackupMs };
  }

  /**
   * Only the rows added since the last verified one (after a restart: since
   * the anchor, which is where the last check ended). A pass that holds
   * moves the anchor; a failing one leaves it and alerts once.
   */
  checkAudit(now: Date): VerifyResult {
    const { opts, from, anchor } = this.auditPlan();
    return this.afterVerify(verifyAudit(this.o.db, opts), from, anchor, now);
  }

  private auditPlan(): {
    opts: VerifyOptions;
    from: { id: number; hash: string } | undefined;
    anchor: AuditAnchor | undefined;
  } {
    const anchor = this.memory ? undefined : readAnchor(this.anchorFile);
    const from = this.lastVerified ?? (anchor ? { id: anchor.lastId, hash: anchor.lastHash } : undefined);
    return {
      opts: { ...(from && from.id > 0 ? { from } : {}), ...(anchor ? { anchor } : {}) },
      from,
      anchor,
    };
  }

  private afterVerify(
    res: VerifyResult,
    from: { id: number; hash: string } | undefined,
    anchor: AuditAnchor | undefined,
    now: Date,
  ): VerifyResult {
    if (res.ok) {
      if (res.last) this.lastVerified = { id: res.last.id, hash: res.last.hash };
      if (!this.memory && res.last && (res.count > 0 || !anchor)) {
        const next: AuditAnchor = {
          lastId: res.last.id,
          lastHash: res.last.hash,
          count: from && anchor ? anchor.count + res.count : (auditTail(this.o.db)?.count ?? res.count),
          at: now.toISOString(),
        };
        writeAnchor(this.anchorFile, next);
      }
      return res;
    }
    const key = res.brokenAt ? `${res.brokenAt.id}:${res.brokenAt.reason}` : `anchor:${res.anchor?.state}`;
    this.o.log?.("error", `稽核紀錄驗證失敗（${key}）`);
    if (!this.alerted.has(key)) {
      this.alerted.add(key);
      this.o.onAuditBroken?.(res);
    }
    return res;
  }
}
