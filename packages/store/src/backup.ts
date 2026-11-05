import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { anchorPath, auditTail, writeAnchor } from "./audit.ts";
import { openDatabase } from "./db.ts";
import { currentVersion, type Migration, MigrationError } from "./migrate.ts";
import { type Sealer, sealCheckOpens, sealRingOf } from "./seal.ts";

/**
 * Backups of the state database (P13). Before a start applies a migration to
 * a database that already has data, the whole file is copied with
 * `VACUUM INTO` (a consistent, compacted snapshot, WAL included) to
 * `<data>/backups/state-v<from>-<time>.sqlite`; the newest five are kept. A
 * backup is restored only with the core stopped: it is checked first
 * (integrity, a schema version this build knows), the current file is moved
 * aside (never deleted), then the backup is copied in.
 *
 * Next round §4.5: the agents sweep also takes a daily backup
 * (`state-v<ver>-<time>-daily.sqlite`), counted apart: the migration and
 * manual backups keep their newest five, the daily ones their own seven
 * (settings `engineering.retention.dailyBackups`).
 */

export const KEEP_BACKUPS = 5;
export const KEEP_DAILY_BACKUPS = 7;

export type BackupKind = "manual" | "daily";

export interface BackupInfo {
  file: string;
  name: string;
  /** Schema version the backup was taken at. */
  version: number;
  /** `manual` covers the pre-migration and 現在備份 backups. */
  kind: BackupKind;
  bytes: number;
  takenAt: string;
}

export function backupDir(dbPath: string): string {
  return join(dirname(resolve(dbPath)), "backups");
}

const NAME = /^state-v(\d+)-(\d{8}T\d{6}Z)(?:-(daily))?(?:-\d+)?\.sqlite$/;

function stamp(d: Date): string {
  return d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

export interface BackupOptions {
  kind?: BackupKind;
  /** Daily backups kept (the manual ones always keep KEEP_BACKUPS). */
  keepDaily?: number;
}

/** Take a backup now (the database stays open and usable). Returns the file. */
export function backupNow(db: DatabaseSync, dbPath: string, now = new Date(), o: BackupOptions = {}): string {
  const dir = backupDir(dbPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700); // review 2026-11-04b M5: also when the folder already existed
  const v = currentVersion(db);
  const tag = o.kind === "daily" ? "-daily" : "";
  let file = join(dir, `state-v${v}-${stamp(now)}${tag}.sqlite`);
  for (let i = 1; existsSync(file); i++) file = join(dir, `state-v${v}-${stamp(now)}${tag}-${i}.sqlite`);
  db.prepare("VACUUM INTO ?").run(file);
  chmodSync(file, 0o600); // VACUUM INTO writes with the process umask (often 0644)
  pruneBackups(dbPath, KEEP_BACKUPS, o.keepDaily ?? KEEP_DAILY_BACKUPS);
  return file;
}

export function listBackups(dbPath: string): BackupInfo[] {
  const dir = backupDir(dbPath);
  if (!existsSync(dir)) return [];
  const out: BackupInfo[] = [];
  for (const name of readdirSync(dir)) {
    const m = NAME.exec(name);
    if (!m) continue;
    const file = join(dir, name);
    const t = m[2] as string;
    out.push({
      file,
      name,
      version: Number(m[1]),
      kind: m[3] === "daily" ? "daily" : "manual",
      bytes: statSync(file).size,
      takenAt: `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}T${t.slice(9, 11)}:${t.slice(11, 13)}:${t.slice(13, 15)}Z`,
    });
  }
  return out.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
}

export function pruneBackups(dbPath: string, keep = KEEP_BACKUPS, keepDaily = KEEP_DAILY_BACKUPS): void {
  const all = listBackups(dbPath);
  const drop = [
    ...all.filter((b) => b.kind === "manual").slice(keep),
    ...all.filter((b) => b.kind === "daily").slice(keepDaily),
  ];
  for (const b of drop) rmSync(b.file, { force: true });
}

/** The newest daily backup, if any. */
export function lastDailyBackup(dbPath: string): BackupInfo | undefined {
  return listBackups(dbPath).find((b) => b.kind === "daily");
}

/** Called by `openStore` before migrating: back up only a database with data and something pending. */
export function backupBeforeMigrate(
  db: DatabaseSync,
  dbPath: string,
  migrations: readonly Migration[],
): string | undefined {
  if (dbPath === ":memory:" || dbPath.startsWith("file::memory:")) return undefined;
  const has = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get();
  if (!has) return undefined; // a brand-new file: nothing to lose
  const done = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>).map(
      (r) => r.version,
    ),
  );
  if (done.size === 0 || migrations.every((m) => done.has(m.version))) return undefined;
  return backupNow(db, dbPath);
}

/**
 * Restore a backup over `dbPath`. The core must not be running (the caller
 * checks; a running core keeps the old file open). Returns where the
 * replaced database was moved.
 */
export function restoreBackup(
  dbPath: string,
  backupFile: string,
  migrations: readonly Migration[],
  now = new Date(),
  o: { sealer?: Sealer } = {},
): {
  replacedBy: string;
  movedAside: string | undefined;
  version: number;
  /** §3: the audit log now ends at this row (the anchor was moved back to it). */
  audit?: { lastId: number; ts: string };
} {
  const src = resolve(backupFile);
  if (!existsSync(src)) throw new MigrationError(`backup ${basename(src)} not found`);
  const check = openDatabase({ path: src, readOnly: true });
  let version: number;
  try {
    const ok = check.prepare("PRAGMA integrity_check").get() as { integrity_check: string } | undefined;
    if (ok?.integrity_check !== "ok") throw new MigrationError(`backup ${basename(src)} is damaged`);
    version = currentVersion(check);
    // R7.6: a backup sealed with another data key would come back unreadable.
    // With the key: open its check value. Without (the CLI, an update rollback):
    // compare its ring fingerprint with the database it replaces.
    if (o.sealer ? sealCheckOpens(check, o.sealer) === false : otherRing(check, dbPath))
      throw new MigrationError(`${basename(src)} 是用另一把資料金鑰加密的，不能用目前的金鑰還原`);
  } catch (err) {
    if (err instanceof MigrationError) throw err;
    throw new MigrationError(`${basename(src)} is not an Alca database`);
  } finally {
    check.close();
  }
  if (!migrations.some((m) => m.version === version) && version !== 0)
    throw new MigrationError(`backup is at schema ${version}, which this build does not know`);
  const target = resolve(dbPath);
  let movedAside: string | undefined;
  if (existsSync(target)) {
    movedAside = `${target}.before-restore-${stamp(now)}`;
    renameSync(target, movedAside);
    for (const ext of ["-wal", "-shm"])
      if (existsSync(target + ext)) renameSync(target + ext, movedAside + ext);
  }
  copyFileSync(src, target);
  // §3: the anchor follows the restore, so the hourly check does not report
  // the older audit log as truncated every hour from now on.
  const audit = anchorRestored(target, now);
  return { replacedBy: src, movedAside, version, ...(audit ? { audit } : {}) };
}

function otherRing(backup: DatabaseSync, dbPath: string): boolean {
  const theirs = sealRingOf(backup);
  if (!theirs || !existsSync(resolve(dbPath))) return false;
  const cur = openDatabase({ path: resolve(dbPath), readOnly: true });
  try {
    const ours = sealRingOf(cur);
    return ours !== undefined && ours !== theirs;
  } catch {
    return false;
  } finally {
    cur.close();
  }
}

function anchorRestored(dbPath: string, now: Date): { lastId: number; ts: string } | undefined {
  const db = openDatabase({ path: dbPath, readOnly: true });
  try {
    const tail = auditTail(db);
    writeAnchor(anchorPath(dbPath), {
      lastId: tail?.id ?? 0,
      lastHash: tail?.hash ?? "",
      count: tail?.count ?? 0,
      at: now.toISOString(),
      note: "restored",
    });
    return tail ? { lastId: tail.id, ts: tail.ts } : undefined;
  } catch {
    return undefined; // a backup from before the audit log existed
  } finally {
    db.close();
  }
}
