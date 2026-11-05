import { DatabaseSync } from "node:sqlite";
import { instrument } from "./perf.ts";

export interface OpenOptions {
  /** File path, or ":memory:" for tests. */
  path: string;
  readOnly?: boolean;
  /** R2.2: which connection the measurements are filed under (default main). */
  conn?: "main" | "worker";
}

/** Open a SQLite database with the pragmas every Alca store relies on. */
export function openDatabase(opts: OpenOptions): DatabaseSync {
  const db = new DatabaseSync(opts.path, { readOnly: opts.readOnly ?? false });
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  if (!opts.readOnly) {
    // Next round §4.6: deleted content is zeroed in the page, not left behind.
    // A per-connection setting, so every writable connection sets it.
    db.exec("PRAGMA secure_delete = ON");
  }
  if (opts.path !== ":memory:" && !opts.readOnly) {
    // Next round §4.6: a brand-new file starts with incremental vacuum (a no-op
    // on a file that already has tables; openStore converts those once).
    db.exec("PRAGMA auto_vacuum = INCREMENTAL");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
  }
  // R2.2: every connection is timed here, the one place they are made.
  return instrument(db, { conn: opts.conn ?? "main" });
}

export function journalMode(db: DatabaseSync): string {
  const row = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string } | undefined;
  return row?.journal_mode ?? "unknown";
}

/** Run fn inside BEGIN IMMEDIATE / COMMIT, rolling back on any throw. */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

let savepointCounter = 0;

/**
 * Like `transaction`, but nests: the outermost call opens `BEGIN IMMEDIATE`
 * (next round R2.3 rule 2: the write lock is taken up front, so a block that
 * reads and then writes never meets `SQLITE_BUSY_SNAPSHOT` (517) once a second
 * connection — the database worker — commits in between; a deferred start
 * would). Inside an open transaction it is a SAVEPOINT / RELEASE, so an atomic
 * block may call another atomic block (or run inside `transaction`).
 */
export function atomic<T>(db: DatabaseSync, fn: () => T): T {
  if (!db.isTransaction) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      db.exec("COMMIT");
      return out;
    } catch (err) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw err;
    }
  }
  savepointCounter += 1;
  const name = `alca_sp_${savepointCounter}`;
  db.exec(`SAVEPOINT ${name}`);
  try {
    const out = fn();
    db.exec(`RELEASE ${name}`);
    return out;
  } catch (err) {
    db.exec(`ROLLBACK TO ${name}`);
    db.exec(`RELEASE ${name}`);
    throw err;
  }
}
