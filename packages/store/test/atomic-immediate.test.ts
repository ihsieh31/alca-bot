import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { atomic, openDatabase, transaction } from "../src/index.ts";

/**
 * Next round R2.3 rule 2: once a second connection (the database worker)
 * writes, a deferred outer transaction that reads and then writes meets
 * SQLITE_BUSY_SNAPSHOT (517), which busy_timeout never retries. `atomic`
 * therefore takes the write lock up front.
 */
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function pair() {
  const d = mkdtempSync(join(tmpdir(), "alca-atomic-"));
  dirs.push(d);
  const path = join(d, "s.sqlite");
  const main = openDatabase({ path });
  main.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)");
  main.exec("INSERT INTO t (v) VALUES ('seed')");
  const other = openDatabase({ path });
  other.exec("PRAGMA busy_timeout = 0");
  return { main, other };
}

describe("atomic takes the write lock at the start (R2.3 rule 2)", () => {
  it("read, another connection writes, then write: no 517, the other connection waits", () => {
    const { main, other } = pair();
    let otherError: unknown;
    atomic(main, () => {
      main.prepare("SELECT v FROM t WHERE id = 1").get();
      try {
        other.exec("INSERT INTO t (v) VALUES ('from worker')");
      } catch (err) {
        otherError = err;
      }
      main.prepare("INSERT INTO t (v) VALUES ('from main')").run();
    });
    // The other connection could not write while atomic held the lock …
    expect((otherError as { errcode?: number } | undefined)?.errcode).toBe(5); // SQLITE_BUSY
    // … and the main block committed.
    const rows = main.prepare("SELECT v FROM t ORDER BY id").all() as Array<{ v: string }>;
    expect(rows.map((r) => r.v)).toEqual(["seed", "from main"]);
    main.close();
    other.close();
  });

  it("nested atomic is a savepoint: an inner throw rolls back only the inner block", () => {
    const { main, other } = pair();
    atomic(main, () => {
      main.exec("INSERT INTO t (v) VALUES ('outer')");
      expect(() =>
        atomic(main, () => {
          main.exec("INSERT INTO t (v) VALUES ('inner')");
          throw new Error("boom");
        }),
      ).toThrow("boom");
      expect(main.isTransaction).toBe(true);
    });
    expect(main.isTransaction).toBe(false);
    const rows = main.prepare("SELECT v FROM t ORDER BY id").all() as Array<{ v: string }>;
    expect(rows.map((r) => r.v)).toEqual(["seed", "outer"]);
    main.close();
    other.close();
  });

  it("an outer throw rolls back and leaves no transaction open; atomic nests inside transaction", () => {
    const { main, other } = pair();
    expect(() =>
      atomic(main, () => {
        main.exec("INSERT INTO t (v) VALUES ('gone')");
        throw new Error("x");
      }),
    ).toThrow("x");
    expect(main.isTransaction).toBe(false);
    transaction(main, () => atomic(main, () => main.exec("INSERT INTO t (v) VALUES ('in tx')")));
    const rows = main.prepare("SELECT v FROM t ORDER BY id").all() as Array<{ v: string }>;
    expect(rows.map((r) => r.v)).toEqual(["seed", "in tx"]);
    main.close();
    other.close();
  });
});
