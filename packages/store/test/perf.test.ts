import { afterEach, describe, expect, it } from "vitest";
import {
  configurePerf,
  loopWarnings,
  openDatabase,
  perfSnapshot,
  recordJob,
  recordSql,
  resetPerf,
  startLoopMonitor,
  stopLoopMonitor,
} from "../src/index.ts";

afterEach(() => {
  resetPerf();
  stopLoopMonitor();
});

describe("store measurements (R2.2)", () => {
  it("times prepared statements and exec on every connection openDatabase makes", () => {
    const db = openDatabase({ path: ":memory:" });
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    const ins = db.prepare("INSERT INTO t (v) VALUES (?)");
    for (let i = 0; i < 3; i++) ins.run(`secret message ${i}`);
    expect(db.prepare("SELECT COUNT(*) AS n FROM t").get()).toEqual({ n: 3 });
    expect(db.prepare("SELECT v FROM t ORDER BY id").all()).toHaveLength(3);
    const seen = [...db.prepare("SELECT v FROM t").iterate()];
    expect(seen).toHaveLength(3);
    const top = perfSnapshot().top;
    const insert = top.find((s) => s.sql.startsWith("INSERT INTO t"));
    expect(insert?.calls).toBe(3);
    expect(top.find((s) => s.sql === "SELECT v FROM t")?.calls).toBe(1); // a whole iteration is one call
    expect(top.some((s) => s.sql.startsWith("CREATE TABLE t"))).toBe(true);
    db.close();
  });

  it("slow calls go into the ring buffer with the SQL text only, never the parameters", () => {
    const warns: string[] = [];
    configurePerf({ thresholds: { slowSqlMs: 0, warnSqlMs: 0 }, warn: (l) => warns.push(l) });
    const db = openDatabase({ path: ":memory:" });
    db.exec("CREATE TABLE t (v TEXT)");
    db.prepare("INSERT INTO t (v) VALUES (?)").run("身分證 A123456789");
    const snap = perfSnapshot();
    expect(snap.slow.some((s) => s.sql === "INSERT INTO t (v) VALUES (?)" && s.kind === "run")).toBe(true);
    expect(JSON.stringify(snap)).not.toContain("A123456789");
    expect(warns.join("\n")).not.toContain("A123456789");
    expect(warns.some((w) => w.startsWith("慢查詢"))).toBe(true);
    db.close();
  });

  it("under the thresholds nothing is recorded as slow or warned", () => {
    const warns: string[] = [];
    configurePerf({ thresholds: { slowSqlMs: 50, warnSqlMs: 200 }, warn: (l) => warns.push(l) });
    recordSql("SELECT 1", "get", 49);
    recordSql("SELECT 2", "get", 60);
    recordSql("SELECT 3", "get", 250);
    const s = perfSnapshot();
    expect(s.slow.map((x) => x.sql)).toEqual(["SELECT 2", "SELECT 3"]);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("SELECT 3");
  });

  it("a main-thread call far above its statement's mean counts as a lock wait; a worker call does not", () => {
    for (let i = 0; i < 6; i++) recordSql("INSERT INTO x VALUES (1)", "run", 1);
    recordSql("INSERT INTO x VALUES (1)", "run", 80);
    recordSql("INSERT INTO x VALUES (1)", "run", 90, "worker");
    expect(perfSnapshot().lockWaitMs).toEqual({ count: 1, max: 80 });
  });

  it("reset starts a new window; jobs keep their max", () => {
    recordSql("SELECT 1", "get", 1);
    recordJob("prune", 30);
    recordJob("prune", 10);
    expect(perfSnapshot(true).jobs.prune).toMatchObject({ lastMs: 10, maxMs: 30 });
    expect(perfSnapshot().top).toEqual([]);
  });

  it("the event-loop monitor reports a blocked loop", async () => {
    startLoopMonitor();
    await new Promise((r) => setTimeout(r, 60));
    const end = Date.now() + 120;
    while (Date.now() < end) {
      // block the loop
    }
    await new Promise((r) => setTimeout(r, 60));
    const s = perfSnapshot();
    expect(s.loop.samples).toBeGreaterThan(0);
    expect(s.loop.max).toBeGreaterThanOrEqual(100);
    configurePerf({ thresholds: { loopMaxMs: 100 } });
    expect(loopWarnings(perfSnapshot())).toHaveLength(1);
  });
});
