import { afterEach, describe, expect, it } from "vitest";
import {
  atomic,
  openDatabase,
  perfSnapshot,
  perfStatsSize,
  recordSql,
  resetPerf,
  STATS_MAX,
} from "../src/index.ts";

afterEach(() => resetPerf());

describe("SQL stats stay bounded (PERF-2026-11 item 4)", () => {
  it("nested atomic() blocks fold their savepoint names into one key", () => {
    const db = openDatabase({ path: ":memory:" });
    db.exec("CREATE TABLE t (v INTEGER)");
    const ins = () => db.prepare("INSERT INTO t (v) VALUES (1)").run();
    atomic(db, () => atomic(db, ins));
    const after1 = perfStatsSize();
    for (let i = 0; i < 200; i++) atomic(db, () => atomic(db, () => atomic(db, ins)));
    expect(perfStatsSize()).toBe(after1);
    const sp = perfSnapshot().top.find((s) => s.sql === "SAVEPOINT alca_sp_N");
    expect(sp?.calls).toBe(1 + 400);
    expect(perfSnapshot().top.some((s) => /alca_sp_\d/.test(s.sql))).toBe(false);
    db.close();
  });

  it("IN lists of any length are one statement in the stats", () => {
    recordSql("SELECT * FROM t WHERE id IN (?)", "all", 1);
    recordSql("SELECT * FROM t WHERE id IN (?, ?)", "all", 1);
    recordSql("SELECT * FROM t WHERE id IN (?,?,?,?)", "all", 1);
    const keys = perfSnapshot().top.map((s) => s.sql);
    expect(keys).toContain("SELECT * FROM t WHERE id IN (?, …)");
    expect(perfSnapshot().top.find((s) => s.sql === "SELECT * FROM t WHERE id IN (?, …)")?.calls).toBe(2);
  });

  it("never holds more than STATS_MAX keys, and keeps the costly ones", () => {
    recordSql("SELECT heavy", "get", 500);
    for (let i = 0; i < STATS_MAX * 2; i++) recordSql(`SELECT ${i} AS n`, "get", 0.01);
    expect(perfStatsSize()).toBe(STATS_MAX);
    expect(perfSnapshot().top[0]?.sql).toBe("SELECT heavy");
    perfSnapshot(true);
    expect(perfStatsSize()).toBe(0);
  });
});
