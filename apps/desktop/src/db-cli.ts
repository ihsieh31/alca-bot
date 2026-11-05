// `alca db …` (P13 A5): the state database's backups.
//
//   alca db backups [--data-dir <dir>] [--json]   list the backups (newest first)
//   alca db backup  [--data-dir <dir>]            take one now
//   alca db restore <file|name> [--data-dir <dir>] restore one (the core must be stopped)
//   alca db verify  [--data-dir <dir>] [--json] [--file <backup>] [--full]
//                   check the audit log's hash chain against the outside anchor
//                   (exit 0 holds, 1 broken, 2 usage, 3 no database); runs
//                   beside a running core (a read-only WAL reader)
//   alca db compact [--data-dir <dir>]            switch to incremental vacuum and VACUUM (core stopped)
//
// A running core is found through `<data>/core.pid`, which startDesktop writes
// and removes; a stale file (its process gone) does not block.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  anchorPath,
  auditTail,
  backupDir,
  backupNow,
  KEEP_BACKUPS,
  KEEP_DAILY_BACKUPS,
  listBackups,
  MIGRATIONS,
  MigrationError,
  openDatabase,
  readAnchor,
  restoreBackup,
  verifyAudit,
} from "@alca/store";
import { defaultDataDir } from "./data-dir.ts";
import { verifyText } from "./verify-text.ts";

const PID_FILE = "core.pid";

/** Mark this process as the core running on `dataDir`. Returns the remover. */
export function writeCorePid(dataDir: string, pid = process.pid): () => void {
  const file = join(dataDir, PID_FILE);
  writeFileSync(file, `${pid}\n`, { mode: 0o600 });
  return () => {
    try {
      if (readFileSync(file, "utf8").trim() === String(pid)) rmSync(file, { force: true });
    } catch {
      /* already gone */
    }
  };
}

/** The pid of a core running on `dataDir`, if any (a stale file counts as none). */
export function runningCorePid(dataDir: string): number | undefined {
  const file = join(dataDir, PID_FILE);
  if (!existsSync(file)) return undefined;
  const pid = Number(readFileSync(file, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    process.kill(pid, 0);
    return pid;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM" ? pid : undefined;
  }
}

const USAGE = `用法：
  alca db backups [--data-dir <資料夾>] [--json]
  alca db backup [--data-dir <資料夾>]
  alca db restore <備份檔或名稱> [--data-dir <資料夾>]
  alca db verify [--data-dir <資料夾>] [--json] [--file <備份檔或名稱>] [--full]
  alca db compact [--data-dir <資料夾>]`;

function parse(args: string[]) {
  return parseArgs({
    args,
    allowPositionals: true,
    options: {
      "data-dir": { type: "string" },
      json: { type: "boolean" },
      file: { type: "string" },
      full: { type: "boolean" },
    },
  });
}

function size(n: number): string {
  return n < 1024 * 1024 ? `${Math.ceil(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function dbCli(argv: string[], out: (line: string) => void = console.log): number {
  const [sub, ...rest] = argv;
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(rest);
  } catch {
    out(USAGE);
    return 2;
  }
  const { values, positionals } = parsed;
  if (sub === undefined) {
    out(USAGE);
    return 0;
  }
  const root = resolve(values["data-dir"] ?? defaultDataDir());
  const dbPath = join(root, "state.sqlite");
  if (sub === "backups") {
    const list = listBackups(dbPath);
    if (values.json) {
      out(JSON.stringify(list, null, 2));
      return 0;
    }
    if (!list.length) {
      out(`  還沒有備份（${backupDir(dbPath)}）。升級資料庫前會自動備份。`);
      return 0;
    }
    out(
      `  備份（${backupDir(dbPath)}，最新的在上面；升級前與手動備份保留 ${KEEP_BACKUPS} 份，每日備份另外保留 ${KEEP_DAILY_BACKUPS} 份）：`,
    );
    for (const b of list)
      out(
        `    ${b.name}  ${b.kind === "daily" ? "每日" : "手動"}  schema ${b.version}  ${size(b.bytes)}  ${b.takenAt}`,
      );
    return 0;
  }
  if (sub === "backup") {
    if (!existsSync(dbPath)) {
      out(`  找不到資料庫：${dbPath}`);
      return 1;
    }
    const db = openDatabase({ path: dbPath });
    try {
      out(`  已備份到 ${backupNow(db, dbPath)}`);
    } finally {
      db.close();
    }
    return 0;
  }
  if (sub === "restore") {
    const arg = positionals[0];
    if (!arg) {
      out(USAGE);
      return 2;
    }
    const pid = runningCorePid(root);
    if (pid) {
      out(`  Alca 核心正在執行（pid ${pid}）。請先停止它（alca service uninstall 或關掉 app），再還原。`);
      return 3;
    }
    const file = isAbsolute(arg) || arg.includes("/") ? resolve(arg) : join(backupDir(dbPath), arg);
    try {
      const r = restoreBackup(dbPath, file, MIGRATIONS);
      out(`  已還原 ${basename(r.replacedBy)}（schema ${r.version}）。`);
      if (r.movedAside) out(`  原本的資料庫移到 ${r.movedAside}（沒有刪除）。`);
      if (r.audit) out(`  稽核紀錄回到第 ${r.audit.lastId} 筆（${r.audit.ts}）；錨點已跟著移回。`);
      out("  下次啟動時會再升級到這個版本的 schema（升級前會再備份一次）。");
      return 0;
    } catch (err) {
      if (!(err instanceof MigrationError)) throw err;
      out(`  無法還原：${err.message}`);
      return 1;
    }
  }
  if (sub === "verify") return verifyCli(dbPath, values, out);
  if (sub === "compact") {
    const pid = runningCorePid(root);
    if (pid) {
      out(`  Alca 核心正在執行（pid ${pid}）。請先停止它，再整理資料庫。`);
      return 3;
    }
    if (!existsSync(dbPath)) {
      out(`  找不到資料庫：${dbPath}`);
      return 3;
    }
    const db = openDatabase({ path: dbPath });
    try {
      const t0 = Date.now();
      db.exec("PRAGMA auto_vacuum = INCREMENTAL");
      db.exec("VACUUM");
      out(`  已整理資料庫（${Date.now() - t0} ms），之後會每週逐步回收空間。`);
    } finally {
      db.close();
    }
    return 0;
  }
  out(USAGE);
  return sub ? 2 : 0;
}

/** §3: `alca db verify` — the store's one verifier, read-only, beside a running core. */
function verifyCli(
  dbPath: string,
  values: { json?: boolean | undefined; file?: string | undefined },
  out: (line: string) => void,
): number {
  const arg = values.file;
  const target = arg
    ? isAbsolute(arg) || arg.includes("/")
      ? resolve(arg)
      : join(backupDir(dbPath), arg)
    : dbPath;
  if (!existsSync(target)) {
    out(`  找不到資料庫：${target}`);
    return 3;
  }
  let db: ReturnType<typeof openDatabase>;
  try {
    db = openDatabase({ path: target, readOnly: true });
  } catch (err) {
    out(`  打不開資料庫：${err instanceof Error ? err.message : String(err)}`);
    return 3;
  }
  try {
    const anchor = arg ? undefined : readAnchor(anchorPath(dbPath));
    const r = verifyAudit(db, { ...(anchor ? { anchor } : {}), integrity: true });
    const total = auditTail(db)?.count ?? r.count;
    const text = verifyText(r, { total, ...(arg ? { file: target } : {}) });
    if (values.json) out(JSON.stringify({ ...r, total, ok: text.ok }, null, 2));
    else for (const line of text.lines) out(`  ${line}`);
    return text.ok ? 0 : 1;
  } catch (err) {
    out(`  無法驗證：${err instanceof Error ? err.message : String(err)}`);
    return 3;
  } finally {
    db.close();
  }
}
