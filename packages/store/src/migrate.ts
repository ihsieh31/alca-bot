import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { transaction } from "./db.ts";

export interface Migration {
  /** Strictly increasing positive integer. Never renumber a shipped migration. */
  version: number;
  name: string;
  sql: string;
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationError";
  }
}

export interface MigrateResult {
  applied: number[];
  current: number;
}

export function checksum(m: Migration): string {
  return createHash("sha256").update(m.sql).digest("hex");
}

function assertOrdered(migrations: readonly Migration[]): void {
  let prev = 0;
  for (const m of migrations) {
    if (!Number.isInteger(m.version) || m.version <= prev) {
      throw new MigrationError(`migration versions must strictly increase (got ${m.version} after ${prev})`);
    }
    prev = m.version;
  }
}

/**
 * Apply pending migrations, each in its own transaction.
 * Safe to call on every start: already-applied versions are skipped,
 * and an edited, already-applied migration is refused (checksum drift).
 */
export function migrate(db: DatabaseSync, migrations: readonly Migration[]): MigrateResult {
  assertOrdered(migrations);
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    checksum   TEXT NOT NULL,
    applied_at TEXT NOT NULL
  ) STRICT`);

  const rows = db.prepare("SELECT version, checksum FROM schema_migrations").all() as Array<{
    version: number;
    checksum: string;
  }>;
  const done = new Map(rows.map((r) => [r.version, r.checksum]));
  const known = new Set(migrations.map((m) => m.version));
  for (const v of done.keys()) {
    if (!known.has(v)) throw new MigrationError(`database has unknown migration ${v}; newer build?`);
  }

  const applied: number[] = [];
  const insert = db.prepare(
    "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
  );
  for (const m of migrations) {
    const sum = checksum(m);
    const existing = done.get(m.version);
    if (existing !== undefined) {
      if (existing !== sum) throw new MigrationError(`migration ${m.version} was edited after being applied`);
      continue;
    }
    transaction(db, () => {
      db.exec(m.sql);
      insert.run(m.version, m.name, sum, new Date().toISOString());
    });
    applied.push(m.version);
  }
  return { applied, current: migrations.at(-1)?.version ?? 0 };
}

export function currentVersion(db: DatabaseSync): number {
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as
    | { v: number | null }
    | undefined;
  return row?.v ?? 0;
}
