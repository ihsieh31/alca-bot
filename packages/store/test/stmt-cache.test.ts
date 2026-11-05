import { afterEach, describe, expect, it } from "vitest";
import {
  atomic,
  openDatabase,
  perfSnapshot,
  resetPerf,
  STMT_CACHE_MAX,
  stmtCacheSize,
} from "../src/index.ts";

afterEach(() => resetPerf());

function seeded() {
  const db = openDatabase({ path: ":memory:" });
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
  const ins = db.prepare("INSERT INTO t (v) VALUES (?)");
  for (const v of ["a", "b", "c"]) ins.run(v);
  return db;
}

describe("statement cache (PERF-2026-11 patch 01)", () => {
  it("returns the same statement for the same SQL text and still times every call", () => {
    const db = seeded();
    const a = db.prepare("SELECT v FROM t WHERE id = ?");
    const b = db.prepare("SELECT v FROM t WHERE id = ?");
    expect(a).toBe(b);
    expect(a.get(1)).toEqual({ v: "a" });
    expect(b.get(2)).toEqual({ v: "b" });
    expect(perfSnapshot().top.find((s) => s.sql === "SELECT v FROM t WHERE id = ?")?.calls).toBe(2);
    db.close();
  });

  it("a shared statement is reusable across transactions, savepoints and a rollback", () => {
    const db = seeded();
    const count = () => (db.prepare("SELECT COUNT(*) AS n FROM t").get() as { n: number }).n;
    atomic(db, () => {
      db.prepare("INSERT INTO t (v) VALUES (?)").run("d");
      expect(count()).toBe(4);
      expect(() =>
        atomic(db, () => {
          db.prepare("INSERT INTO t (v) VALUES (?)").run("e");
          expect(count()).toBe(5);
          throw new Error("undo");
        }),
      ).toThrow("undo");
      expect(count()).toBe(4);
    });
    expect(() =>
      atomic(db, () => {
        db.prepare("INSERT INTO t (v) VALUES (?)").run("f");
        throw new Error("undo all");
      }),
    ).toThrow("undo all");
    expect(count()).toBe(4);
    db.close();
  });

  it("an open iteration is not disturbed by other calls with the same SQL", () => {
    const db = seeded();
    const sql = "SELECT v FROM t ORDER BY id";
    const it = db.prepare(sql).iterate();
    expect((it.next().value as { v: string }).v).toBe("a");
    expect(db.prepare(sql).all()).toHaveLength(3);
    const inner = [...db.prepare(sql).iterate()].map((r) => (r as { v: string }).v);
    expect(inner).toEqual(["a", "b", "c"]);
    expect([...it].map((r) => (r as { v: string }).v)).toEqual(["b", "c"]);
    db.close();
  });

  it("a schema change through exec() (migrations) drops the cache, so SELECT * sees new columns", () => {
    const db = seeded();
    expect(Object.keys(db.prepare("SELECT * FROM t WHERE id = 1").get() as object)).toEqual(["id", "v"]);
    db.exec("ALTER TABLE t ADD COLUMN w TEXT DEFAULT 'x'");
    expect(db.prepare("SELECT * FROM t WHERE id = 1").get()).toEqual({ id: 1, v: "a", w: "x" });
    db.close();
  });

  it("prepared DDL is not cached and drops the cache when it runs", () => {
    const db = seeded();
    db.prepare("SELECT * FROM t").all();
    const before = stmtCacheSize(db);
    expect(before).toBeGreaterThan(0);
    db.prepare("ALTER TABLE t ADD COLUMN w TEXT DEFAULT 'y'").run();
    expect(stmtCacheSize(db)).toBe(0);
    expect((db.prepare("SELECT * FROM t WHERE id = 2").get() as { w: string }).w).toBe("y");
    db.close();
  });

  it("transaction control keeps the cache", () => {
    const db = seeded();
    db.prepare("SELECT v FROM t").all();
    const n = stmtCacheSize(db);
    atomic(db, () => atomic(db, () => db.prepare("SELECT v FROM t").all()));
    expect(stmtCacheSize(db)).toBe(n);
    db.close();
  });

  it("close() and open() drop the cache (a closed database finalizes its statements)", () => {
    const db = openDatabase({ path: ":memory:" });
    db.prepare("SELECT 1 AS one").get();
    expect(stmtCacheSize(db)).toBe(1);
    db.close();
    expect(stmtCacheSize(db)).toBe(0);
    db.open();
    expect(db.prepare("SELECT 1 AS one").get()).toEqual({ one: 1 });
    db.close();
  });

  it("is an LRU bounded at STMT_CACHE_MAX", () => {
    const db = openDatabase({ path: ":memory:" });
    const hot = db.prepare("SELECT 0 AS n");
    for (let i = 1; i <= STMT_CACHE_MAX + 50; i++) {
      db.prepare(`SELECT ${i} AS n`).get();
      if (i % 100 === 0) expect(db.prepare("SELECT 0 AS n")).toBe(hot); // touched: stays
    }
    expect(stmtCacheSize(db)).toBe(STMT_CACHE_MAX);
    expect(db.prepare("SELECT 0 AS n")).toBe(hot);
    const cold = db.prepare("SELECT 1 AS n"); // evicted long ago: a new statement
    expect(cold.get()).toEqual({ n: 1 });
    db.close();
  });
});
