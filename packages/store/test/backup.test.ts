import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  backupDir,
  backupNow,
  KEEP_BACKUPS,
  listBackups,
  MIGRATIONS,
  MigrationError,
  openDatabase,
  openStore,
  restoreBackup,
} from "../src/index.ts";

const dirs: string[] = [];
function tmpDb(): string {
  const d = mkdtempSync(join(tmpdir(), "alca-backup-"));
  dirs.push(d);
  return join(d, "state.sqlite");
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const older = MIGRATIONS.slice(0, -1);

describe("backups before a migration (P13 A5)", () => {
  it("a brand-new database gets no backup", () => {
    const path = tmpDb();
    const s = openStore(path);
    expect(s.migration.backup).toBeUndefined();
    s.close();
    expect(listBackups(path)).toEqual([]);
  });

  it("an up-to-date database gets no backup", () => {
    const path = tmpDb();
    openStore(path).close();
    const s = openStore(path);
    expect(s.migration.applied).toEqual([]);
    expect(s.migration.backup).toBeUndefined();
    s.close();
  });

  it("a database with data and a pending migration is backed up first, and the backup restores", () => {
    const path = tmpDb();
    const a = openStore(path, older);
    const t = a.threads.create("thr_old", "舊的對話");
    a.close();

    const b = openStore(path);
    expect(b.migration.backup).toBeDefined();
    const list = listBackups(path);
    expect(list).toHaveLength(1);
    expect(list[0]?.version).toBe(older.at(-1)?.version);
    // Something written after the upgrade is gone after the restore.
    b.threads.create("thr_new", "升級後的");
    b.close();

    const r = restoreBackup(path, list[0]?.file as string, MIGRATIONS);
    expect(r.movedAside).toBeDefined();
    expect(existsSync(r.movedAside as string)).toBe(true);
    const c = openStore(path); // migrates again (and backs up again)
    expect(c.threads.get(t.id)?.title).toBe("舊的對話");
    expect(c.threads.list().map((x) => x.title)).not.toContain("升級後的");
    c.close();
  });

  it("keeps only the newest five", () => {
    const path = tmpDb();
    const s = openStore(path);
    for (let i = 0; i < KEEP_BACKUPS + 3; i++)
      backupNow(s.db, path, new Date(Date.UTC(2026, 10, 4, 8, 0, i)));
    s.close();
    const list = listBackups(path);
    expect(list).toHaveLength(KEEP_BACKUPS);
    expect(list[0]?.takenAt).toBe("2026-11-04T08:00:07Z");
    expect(readdirSync(backupDir(path))).toHaveLength(KEEP_BACKUPS);
  });

  it("refuses a damaged file, a non-Alca file and a missing one, and leaves the database alone", () => {
    const path = tmpDb();
    openStore(path).close();
    const junk = join(backupDir(path), "state-v1-20261104T080000Z.sqlite");
    mkdirSync(backupDir(path), { recursive: true });
    writeFileSync(junk, "not sqlite at all");
    expect(() => restoreBackup(path, junk, MIGRATIONS)).toThrow(MigrationError);
    const other = join(backupDir(path), "other.sqlite");
    const db = openDatabase({ path: other });
    db.exec("CREATE TABLE x (a)");
    db.close();
    expect(() => restoreBackup(path, other, MIGRATIONS)).toThrow(/not an Alca database/);
    expect(() => restoreBackup(path, join(backupDir(path), "nope.sqlite"), MIGRATIONS)).toThrow(/not found/);
    const s = openStore(path);
    expect(s.migration.applied).toEqual([]);
    s.close();
  });
});
