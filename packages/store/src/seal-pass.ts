import { readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { backupNow, listBackups } from "./backup.ts";
import type { BatchSizer, Steps } from "./batch.ts";
import { toSearchTerms } from "./cjk.ts";
import { atomic } from "./db.ts";
import { SEAL_GATED } from "./migrations/0030-seal-offers.ts";
import {
  pkOf,
  readSealProgress,
  SEALED,
  SealError,
  type Sealer,
  SQL_IS_SEALED,
  sealerOf,
  writeSealProgress,
} from "./seal.ts";

/**
 * Next round R7.5 step 4: the background pass that seals rows written before
 * the data key existed. It runs on the database worker (`DB_JOBS.sealPass`)
 * in time-targeted batches; each batch is one transaction that opens the
 * table's `seal_gate` row, rewrites plaintext → sealed, and closes the gate
 * again before commit. Where it got to is kept in `meta.seal_progress`
 * (`{ "<table>": "<last rowid>", …, "done": "<iso>" }`), so a restart goes on
 * from there.
 *
 * `memories` also gets its search terms recomputed as keyed tokens; the FTS
 * index is updated row by row in the same batch (delete the old terms,
 * insert the new), so it never disagrees with the table.
 */

export interface SealPassResult {
  /** Rows sealed per table by this call. */
  sealed: Record<string, number>;
  /** True when every table was walked to the end (the pass is finished). */
  done: boolean;
}

export interface SealStatus {
  /** Rows that still hold a plaintext value in a sealed column, per table (only tables with any). */
  plaintext: Record<string, number>;
  /** Sum of `plaintext`. */
  remaining: number;
  /** Rows already sealed, per table. */
  sealed: Record<string, number>;
  /** `meta.seal_progress.done`: when the pass last finished. */
  doneAt?: string;
}

const TABLES = Object.keys(SEALED);
const GATED = new Set<string>(SEAL_GATED);

const plainExpr = (col: string) => `(${col} IS NOT NULL AND ${col} <> '' AND NOT ${SQL_IS_SEALED(col)})`;

const exists = (db: DatabaseSync, t: string) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);

/** Count what is still plaintext (and what is sealed). Read only. */
export function sealStatus(db: DatabaseSync): SealStatus {
  const plaintext: Record<string, number> = {};
  const sealed: Record<string, number> = {};
  let remaining = 0;
  for (const t of TABLES) {
    if (!exists(db, t)) continue;
    const cols = (SEALED[t] as { cols: readonly string[] }).cols;
    const r = db
      .prepare(
        `SELECT
           SUM(CASE WHEN ${cols.map(plainExpr).join(" OR ")} THEN 1 ELSE 0 END) AS p,
           SUM(CASE WHEN ${cols.map(SQL_IS_SEALED).join(" OR ")} THEN 1 ELSE 0 END) AS s
         FROM ${t}`,
      )
      .get() as { p: number | null; s: number | null };
    if (r.p) {
      plaintext[t] = r.p;
      remaining += r.p;
    }
    if (r.s) sealed[t] = r.s;
  }
  const doneAt = readSealProgress(db).done;
  return { plaintext, remaining, sealed, ...(doneAt ? { doneAt } : {}) };
}

/**
 * Steps of the pass (one yield per committed batch). Needs the connection's
 * sealer; returns `done: false` when `maxRows` was reached first.
 */
export function* sealSteps(
  db: DatabaseSync,
  sizer: BatchSizer,
  o: { maxRows?: number; now?: () => Date } = {},
): Steps<SealPassResult> {
  const sealer = sealerOf(db);
  if (!sealer) throw new SealError("沒有資料金鑰，不能加密舊資料");
  const progress = readSealProgress(db);
  const result: SealPassResult = { sealed: {}, done: false };
  let budget = o.maxRows ?? Number.POSITIVE_INFINITY;
  for (const t of TABLES) {
    if (!exists(db, t)) continue;
    const spec = SEALED[t] as { cols: readonly string[]; pk: readonly string[] };
    const extra = t === "memories" ? ", n, subject, search_terms" : "";
    const select = db.prepare(
      `SELECT rowid AS rid, ${[...new Set([...spec.pk, ...spec.cols])].join(", ")}${extra}
         FROM ${t} WHERE rowid > ? ORDER BY rowid LIMIT ?`,
    );
    for (;;) {
      if (budget <= 0) return result;
      const after = Number(progress[t] ?? 0);
      const limit = Math.max(1, Math.min(sizer.size, budget));
      const { rows, n } = sizer.time(() => sealBatch(db, sealer, t, spec, select, after, limit, progress));
      if (rows === 0) break;
      result.sealed[t] = (result.sealed[t] ?? 0) + n;
      budget -= rows;
      yield n;
    }
  }
  progress.done = (o.now?.() ?? new Date()).toISOString();
  atomic(db, () => writeSealProgress(db, progress));
  result.done = true;
  return result;
}

function sealBatch(
  db: DatabaseSync,
  sealer: Sealer,
  t: string,
  spec: { cols: readonly string[]; pk: readonly string[] },
  select: ReturnType<DatabaseSync["prepare"]>,
  after: number,
  limit: number,
  progress: Record<string, string>,
): { rows: number; n: number } {
  return atomic(db, () => {
    const rows = select.all(after, limit) as Array<Record<string, SQLInputValue>>;
    if (rows.length === 0) return { rows: 0, n: 0 };
    const gated = GATED.has(t);
    if (gated) db.prepare("UPDATE seal_gate SET open = 1 WHERE tbl = ?").run(t);
    let n = 0;
    for (const r of rows) {
      const pk = pkOf(t, r);
      const sets: string[] = [];
      const vals: SQLInputValue[] = [];
      for (const c of spec.cols) {
        const v = r[c];
        if (typeof v !== "string" || v === "" || sealer.isSealed(v)) continue;
        sets.push(`${c} = ?`);
        vals.push(sealer.seal(t, c, pk, v));
      }
      if (t === "memories" && typeof r.body === "string" && !sealer.isSealed(r.body)) {
        // Keyed search terms, and the FTS index kept in step with them.
        const terms = toSearchTerms(`${r.subject ?? ""} ${r.body}`, sealer);
        db.prepare("INSERT INTO memories_fts(memories_fts, rowid, search_terms) VALUES ('delete', ?, ?)").run(
          r.n as number,
          r.search_terms as string,
        );
        db.prepare("INSERT INTO memories_fts(rowid, search_terms) VALUES (?, ?)").run(r.n as number, terms);
        sets.push("search_terms = ?");
        vals.push(terms);
      }
      if (!sets.length) continue;
      db.prepare(`UPDATE ${t} SET ${sets.join(", ")} WHERE rowid = ?`).run(...vals, r.rid as number);
      n += 1;
    }
    if (gated) db.prepare("UPDATE seal_gate SET open = 0 WHERE tbl = ?").run(t);
    // Where the pass got to commits with the batch, so a restart goes on from here.
    progress[t] = String(rows.at(-1)?.rid ?? after);
    writeSealProgress(db, progress);
    return { rows: rows.length, n };
  });
}

// ── R7.5 step 5: the old plaintext backups ────────────────────────────────

export interface PlaintextBackup {
  file: string;
  name: string;
  bytes: number;
  takenAt: string;
  /** "backup" = in backups/ (daily, manual, before a migration); "moved-aside" = a file a restore set aside. */
  kind: "backup" | "moved-aside";
}

/**
 * Files that may still hold content in plaintext: every backup taken before
 * the pass last finished (a backup's time is its start, to the second, so a
 * backup in the same second counts as plaintext), and the database files a
 * restore moved aside. Before the pass ever finished, that is all of them.
 */
export function plaintextBackups(db: DatabaseSync, dbPath: string): PlaintextBackup[] {
  const progress = readSealProgress(db);
  const done = progress.done ? Date.parse(progress.done) : Number.POSITIVE_INFINITY;
  const clean = new Set(cleanBackups(progress));
  const out: PlaintextBackup[] = listBackups(dbPath)
    .filter((b) => Date.parse(b.takenAt) <= done && !clean.has(b.name))
    .map((b) => ({
      file: b.file,
      name: b.name,
      bytes: b.bytes,
      takenAt: b.takenAt,
      kind: "backup" as const,
    }));
  const target = resolve(dbPath);
  const dir = dirname(target);
  const prefix = `${basename(target)}.before-restore-`;
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    names = [];
  }
  for (const name of names) {
    if (!name.startsWith(prefix) || name.endsWith("-wal") || name.endsWith("-shm")) continue;
    const file = join(dir, name);
    const st = statSync(file);
    out.push({ file, name, bytes: st.size, takenAt: st.mtime.toISOString(), kind: "moved-aside" });
  }
  return out;
}

/** Backups `dropPlaintextBackups` made (sealed content only, even when taken in the second the pass ended). */
function cleanBackups(progress: Record<string, string>): string[] {
  try {
    const v = JSON.parse(progress.clean ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export interface DropPlaintextResult {
  /** The new backup, taken first (sealed content only). */
  backup: string;
  removed: string[];
}

/**
 * User decision (2026-11-05): the plaintext backups go only after every row
 * is sealed. Refuses while any sealed column still holds plaintext or the
 * pass has not finished; otherwise takes a fresh backup first, then removes
 * the files `plaintextBackups` lists (with their -wal / -shm).
 */
export function dropPlaintextBackups(
  db: DatabaseSync,
  dbPath: string,
  now = new Date(),
): DropPlaintextResult {
  if (!sealerOf(db)) throw new SealError("沒有資料金鑰：資料還沒加密，舊備份不刪");
  const st = sealStatus(db);
  if (st.remaining > 0 || !st.doneAt)
    throw new SealError(`還有 ${st.remaining} 列尚未加密（或背景加密還沒跑完），舊的明文備份先不刪`);
  const drop = plaintextBackups(db, dbPath);
  const backup = backupNow(db, dbPath, now, { kind: "manual" });
  const progress = readSealProgress(db);
  progress.clean = JSON.stringify([...cleanBackups(progress), basename(backup)].slice(-20));
  atomic(db, () => writeSealProgress(db, progress));
  const removed: string[] = [];
  for (const b of drop) {
    if (resolve(b.file) === resolve(backup)) continue;
    for (const ext of ["", "-wal", "-shm"]) rmSync(b.file + ext, { force: true });
    removed.push(b.name);
  }
  return { backup, removed };
}
