// 設定 → 資料 (was 備份) and 關於 (P13 B3; next round §3 / §4). Loopback only, like the rest of 設定.
// Backups: the list and 現在備份; restoring stays in the CLI (`alca db
// restore`) because the core must be stopped first. 關於: version, the data
// folder, and 打開記錄檔資料夾 (<data>/logs, where the service writes core.log).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { tSource } from "@alca/design/i18n";
import {
  anchorPath,
  auditTail,
  backupDir,
  backupNow,
  type DbWorker,
  type ExportSummary,
  type ImportSummary,
  KEEP_BACKUPS,
  KEEP_DAILY_BACKUPS,
  lastDailyBackup,
  listBackups,
  loopWarnings,
  openDatabase,
  type PerfSnapshot,
  perfSnapshot,
  readAnchor,
  type Upkeep,
  verifyAuditAsync,
} from "@alca/store";
import { exportFileName, scratchPath, transferDir, transferError } from "./data-transfer.ts";
import { HttpError } from "./http.ts";
import { log } from "./log.ts";
import type { UpdateChecker, UpdateView } from "./update-check.ts";
import { type VerifyText, verifyText } from "./verify-text.ts";

export interface BackupRow {
  name: string;
  version: number;
  kind: "manual" | "daily";
  bytes: number;
  takenAt: string;
}

export interface BackupsView {
  dir: string;
  keep: number;
  keepDaily: number;
  backups: BackupRow[];
  /** The restore command to run with the core stopped. */
  restoreHint: string;
}

/** 設定 → 資料: the retention policy and what the hourly data steps last did (§4.5). */
export interface DataView {
  retention: {
    runEventsDays: number;
    jobEventsDays: number;
    externalDays: number;
    dailyBackups: number;
  };
  /** False without the agents clock (`--agents direct`): nothing is pruned or checked hourly. */
  hourly: boolean;
  lastSweepAt?: string;
  nextSweepAt?: string;
  lastPruned?: Record<string, number>;
  lastDailyBackup?: { name: string; takenAt: string };
  /** The last daily backup took longer than 2 s (it now waits for a quiet hour). */
  slowBackupMs?: number;
  /** The last hourly audit check. */
  audit?: { ok: boolean; at: string; reason?: string; id?: number };
  anchor?: { lastId: number; at: string; restored: boolean };
}

/** 設定 → 資料: the event loop and slow SQL (R2.2; GET /api/settings/perf, read-only). */
export interface PerfView {
  /** Since the last hourly reset (the window still open). */
  now: PerfSnapshot;
  /** The window the last hourly slot closed (absent before the first one). */
  lastHour?: PerfSnapshot;
  /** Slow calls (≥ slowSqlMs) in the past hour, from the ring buffer. */
  slowLastHour: number;
  /** Of those, the ones at or above warnSqlMs. */
  warnLastHour: number;
  /** Lines to show as warnings (empty when quiet). */
  warnings: string[];
}

/** POST /api/import: what came in. */
export interface ImportView extends ImportSummary {
  /** Events older than the retention period go at the next hourly prune (R5.6). */
  note: string;
}

export interface VerifyView extends VerifyText {
  rows: number;
  at: string;
}

export interface AboutView {
  version: string;
  dataDir: string;
  logsDir: string;
  logFile: string;
  /** Only the always-on service writes core.log; a terminal start logs to the terminal. */
  logFileExists: boolean;
  node: string;
  platform: string;
  /** Phase E: the last update check and what to do about a newer version. */
  update?: UpdateView;
}

/** Open a folder in Finder / Explorer / the file manager. */
export function openFolder(dir: string): boolean {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [dir]]
      : process.platform === "win32"
        ? ["explorer", [dir]]
        : ["xdg-open", [dir]];
  try {
    const p = spawn(cmd, args, { stdio: "ignore", detached: true });
    p.on("error", () => undefined);
    p.unref();
    return true;
  } catch {
    return false;
  }
}

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export class SystemApi {
  private readonly o: {
    dataDir: string;
    dbPath: string;
    db: DatabaseSync;
    openFolder: (dir: string) => boolean;
    /** The hourly data steps (policy, last report); absent in tests that do not need them. */
    upkeep?: Upkeep;
    /** Whether the agents clock runs the hourly slot. */
    clock?: boolean;
    /** R2.3: the database worker (manual backup, export, import); absent → inline on `db`. */
    jobs?: Pick<DbWorker, "run">;
    /** Phase E: the daily update check (設定 → 關於). */
    updates?: UpdateChecker;
  };
  readonly version = readVersion();

  constructor(o: SystemApi["o"]) {
    this.o = o;
  }

  backups(): BackupsView {
    return {
      dir: backupDir(this.o.dbPath),
      keep: KEEP_BACKUPS,
      keepDaily: this.o.upkeep?.policy().dailyBackups ?? KEEP_DAILY_BACKUPS,
      backups: listBackups(this.o.dbPath).map(({ name, version, kind, bytes, takenAt }) => ({
        name,
        version,
        kind,
        bytes,
        takenAt,
      })),
      restoreHint: tSource("core.system.restoreHint"),
    };
  }

  /** 現在備份: `VACUUM INTO` on the database worker (R2.3), so the event loop is not held. */
  async backupNow(): Promise<BackupsView & { made: string }> {
    let file: string;
    try {
      const keepDaily = this.o.upkeep?.policy().dailyBackups ?? KEEP_DAILY_BACKUPS;
      file = this.o.jobs
        ? await this.o.jobs.run("backup", new Date().toISOString(), "manual", keepDaily)
        : backupNow(this.o.db, this.o.dbPath, new Date(), { keepDaily });
    } catch (e) {
      throw new HttpError(
        500,
        tSource("core.system.backupFailed", { reason: e instanceof Error ? e.message : String(e) }),
      );
    }
    log.info(tSource("core.system.backedUp", { file }));
    return { ...this.backups(), made: basename(file) };
  }

  data(): DataView {
    const p = this.o.upkeep?.policy();
    const st = this.o.upkeep?.status();
    const last = st?.last;
    const daily = lastDailyBackup(this.o.dbPath);
    const anchor = readAnchor(anchorPath(this.o.dbPath));
    const a = last?.audit;
    return {
      retention: {
        runEventsDays: p?.runEventsDays ?? 90,
        jobEventsDays: p?.jobEventsDays ?? 90,
        externalDays: p?.externalDays ?? 90,
        dailyBackups: p?.dailyBackups ?? KEEP_DAILY_BACKUPS,
      },
      hourly: !!this.o.clock && !!this.o.upkeep,
      ...(last
        ? {
            lastSweepAt: last.at,
            nextSweepAt: new Date(Date.parse(last.at) + 3600_000).toISOString(),
            lastPruned: last.pruned ?? {},
          }
        : {}),
      ...(daily ? { lastDailyBackup: { name: daily.name, takenAt: daily.takenAt } } : {}),
      ...(st?.slowBackupMs ? { slowBackupMs: st.slowBackupMs } : {}),
      ...(a
        ? {
            audit: {
              ok: a.ok,
              at: last?.at ?? "",
              ...(a.ok ? {} : { reason: a.brokenAt?.reason ?? "behind" }),
              ...(a.brokenAt ? { id: a.brokenAt.id } : {}),
            },
          }
        : {}),
      ...(anchor
        ? { anchor: { lastId: anchor.lastId, at: anchor.at, restored: anchor.note === "restored" } }
        : {}),
    };
  }

  perf(): PerfView {
    const now = perfSnapshot(false);
    const lastHour = this.o.upkeep?.status().perf;
    const since = Date.now() - 3600_000;
    const recent = now.slow.filter((x) => Date.parse(x.at) >= since);
    const warn = recent.filter((x) => x.ms >= now.thresholds.warnSqlMs);
    const warnings = [...loopWarnings(lastHour ?? now)];
    if (warn.length)
      warnings.push(tSource("core.system.slowQueries", { count: warn.length, ms: now.thresholds.warnSqlMs }));
    if (now.lockWaitMs.max >= 250) warnings.push(tSource("core.system.lockWait", { ms: now.lockWaitMs.max }));
    return {
      now,
      ...(lastHour ? { lastHour } : {}),
      slowLastHour: recent.length,
      warnLastHour: warn.length,
      warnings,
    };
  }

  /**
   * R5.6 匯出: one conversation to a file on the database worker, read back
   * for the download, and removed (the core keeps no copy). `passphrase`
   * seals it for another computer.
   */
  async exportThread(
    threadId: string,
    o: { passphrase?: string; memories?: boolean } = {},
  ): Promise<{ name: string; bytes: Buffer; summary: ExportSummary }> {
    if (!this.o.jobs) throw new HttpError(404, "not found");
    const tmp = scratchPath(transferDir(this.o.dataDir), "export");
    try {
      const summary = await this.o.jobs.run("exportThread", threadId, tmp, {
        ...(o.passphrase ? { passphrase: o.passphrase } : {}),
        ...(o.memories ? { memories: true } : {}),
      });
      const bytes = readFileSync(tmp);
      log.info(
        summary.sealed
          ? tSource("core.system.exportedSealed", { id: threadId, bytes: bytes.length })
          : tSource("core.system.exported", { id: threadId, bytes: bytes.length }),
      );
      return { name: exportFileName(threadId), bytes, summary };
    } catch (e) {
      if (e instanceof HttpError) throw e;
      const t = transferError(e);
      throw new HttpError(t.status, t.text);
    } finally {
      rmSync(tmp, { force: true });
    }
  }

  /**
   * R5.6 匯入 (approve key: it adds a conversation): the file the window
   * read, as a new conversation, in one transaction on the worker. Only adds.
   */
  async importThread(data: Buffer, o: { passphrase?: string } = {}): Promise<ImportView> {
    if (!this.o.jobs) throw new HttpError(404, "not found");
    if (!data.length) throw new HttpError(400, tSource("core.system.noExportFile"));
    const tmp = scratchPath(transferDir(this.o.dataDir), "import");
    writeFileSync(tmp, data, { mode: 0o600 });
    try {
      const r = await this.o.jobs.run("importThread", tmp, o.passphrase ? { passphrase: o.passphrase } : {});
      log.info(tSource("core.system.imported", { id: r.threadId }));
      return {
        ...r,
        note: tSource("core.system.importedNote"),
      };
    } catch (e) {
      const t = transferError(e);
      throw new HttpError(t.status, t.text);
    } finally {
      rmSync(tmp, { force: true });
    }
  }

  /**
   * 驗證稽核紀錄: the store's one verifier over its own read-only connection
   * (a WAL reader, so the core keeps writing), yielding every 5,000 rows,
   * with the anchor and quick_check. Read-only: no approve key needed.
   */
  async verify(): Promise<VerifyView> {
    const db = openDatabase({ path: this.o.dbPath, readOnly: true });
    try {
      const anchor = readAnchor(anchorPath(this.o.dbPath));
      const r = await verifyAuditAsync(db, { ...(anchor ? { anchor } : {}), integrity: true });
      const rows = auditTail(db)?.count ?? r.count;
      const text = verifyText(r, { total: rows });
      if (!text.ok) log.error(tSource("core.system.auditFailed", { diagnostic: text.diagnostic }));
      return { ...text, rows, at: new Date().toISOString() };
    } catch (e) {
      throw new HttpError(
        500,
        tSource("core.system.verifyFailed", { reason: e instanceof Error ? e.message : String(e) }),
      );
    } finally {
      db.close();
    }
  }

  about(): AboutView {
    const logsDir = join(this.o.dataDir, "logs");
    const logFile = join(logsDir, "core.log");
    return {
      version: this.version,
      dataDir: this.o.dataDir,
      logsDir,
      logFile,
      logFileExists: existsSync(logFile) && statSync(logFile).isFile(),
      node: process.versions.node,
      platform: `${process.platform}-${process.arch}`,
      ...(this.o.updates ? { update: this.o.updates.view() } : {}),
    };
  }

  /** 檢查更新: one GET to the release list (read-only; the local token, no approve key). Never installs. */
  async checkUpdate(): Promise<UpdateView> {
    if (!this.o.updates) throw new HttpError(404, "not found");
    await this.o.updates.checkNow();
    return this.o.updates.view();
  }

  /** 打開記錄檔資料夾 (made if missing). */
  openLogs(): { opened: boolean; dir: string } {
    const dir = join(this.o.dataDir, "logs");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const opened = this.o.openFolder(dir);
    if (!opened) throw new HttpError(500, tSource("core.system.cantOpenFolder", { dir }));
    return { opened, dir };
  }

  /** 打開資料夾 for the data folder itself. */
  openDataDir(): { opened: boolean; dir: string } {
    const opened = this.o.openFolder(this.o.dataDir);
    if (!opened) throw new HttpError(500, tSource("core.system.cantOpenFolder", { dir: this.o.dataDir }));
    return { opened, dir: this.o.dataDir };
  }
}
