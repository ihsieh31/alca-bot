import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CancelledError, openStore, perfSnapshot, resetPerf, type Store } from "../src/index.ts";
import { ago, seedConversation } from "./seed-conversation.ts";

const dirs: string[] = [];
const open: Store[] = [];
function tmpDb(): string {
  const d = mkdtempSync(join(tmpdir(), "alca-dbw-"));
  dirs.push(d);
  return join(d, "state.sqlite");
}
afterEach(async () => {
  for (const s of open.splice(0)) await s.stop().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  resetPerf();
});

const OLD = ago(200);

/** n finished-long-ago run events in one thread (fake data). */
function seedOld(s: Store, n: number, thread = "t_old") {
  s.db
    .prepare("INSERT INTO threads (id, title, created_at, updated_at) VALUES (?, 't', ?, ?)")
    .run(thread, OLD, OLD);
  s.db
    .prepare(
      `INSERT INTO runs (id, thread_id, initiator_kind, initiator_id, started_at, status, finish_reason, finished_at)
       VALUES (?, ?, 'user', 'u', ?, 'finished', 'completed', ?)`,
    )
    .run(`${thread}_r`, thread, OLD, OLD);
  s.db.exec("BEGIN");
  const ins = s.db.prepare(
    "INSERT INTO run_events (run_id, seq, type, payload, created_at) VALUES (?, ?, 'text', '{\"t\":\"x\"}', ?)",
  );
  for (let i = 0; i < n; i++) ins.run(`${thread}_r`, i, OLD);
  s.db.exec("COMMIT");
}

const count = (s: Store, sql: string) => Number((s.db.prepare(sql).get() as { n: number }).n);
const policy = { runEventsDays: 90, jobEventsDays: 90, externalDays: 90 };

describe("database worker (R2.3)", () => {
  it("inline and worker give the same prune result", async () => {
    const results: unknown[] = [];
    for (const inlineJobs of [true, false]) {
      const s = openStore(tmpDb(), undefined, { inlineJobs });
      open.push(s);
      expect(s.jobs.mode).toBe(inlineJobs ? "inline" : "worker");
      seedOld(s, 3000);
      results.push(await s.jobs.run("prune", policy, new Date().toISOString()));
      expect(count(s, "SELECT COUNT(*) AS n FROM run_events")).toBe(0);
    }
    expect(results[0]).toEqual({ pruned: { run_events: 3000 }, trails: 0 });
    expect(results[1]).toEqual(results[0]);
  });

  it(":memory: is always inline", () => {
    const s = openStore(":memory:");
    open.push(s);
    expect(s.jobs.mode).toBe("inline");
  });

  it("while the worker opens the retention gate, the main connection never sees it open", async () => {
    const s = openStore(tmpDb(), undefined, { batchMs: () => 5 });
    open.push(s);
    seedOld(s, 40_000);
    let seenOpen = 0;
    let looks = 0;
    let done = false;
    const job = s.jobs.run("prune", policy, new Date().toISOString());
    void job.finally(() => {
      done = true;
    });
    while (!done) {
      const g = s.db.prepare("SELECT COUNT(*) AS n FROM retention_gate WHERE before IS NOT NULL").get() as {
        n: number;
      };
      looks += 1;
      seenOpen += g.n;
      await new Promise((r) => setTimeout(r, 1));
    }
    expect((await job).pruned.run_events).toBe(40_000);
    expect(looks).toBeGreaterThan(3);
    expect(seenOpen).toBe(0);
  });

  it("main-thread writes keep going while the worker deletes; no 517, short lock waits", async () => {
    const s = openStore(tmpDb(), undefined, { batchMs: () => 25 });
    open.push(s);
    seedOld(s, 200_000);
    s.db
      .prepare("INSERT INTO threads (id, title, created_at, updated_at) VALUES ('live', 't', ?, ?)")
      .run(OLD, OLD);
    const job = s.jobs.run("prune", policy, new Date().toISOString());
    let done = false;
    void job.finally(() => {
      done = true;
    });
    const ins = s.db.prepare(
      "INSERT INTO messages (id, thread_id, role, content, created_at) VALUES (?, 'live', 'user', 'hi', ?)",
    );
    // Measure only while the worker is really deleting.
    for (let i = 0; i < 2000 && count(s, "SELECT COUNT(*) AS n FROM run_events") === 200_000; i++)
      await new Promise((r) => setTimeout(r, 2));
    let maxWait = 0;
    let writes = 0;
    while (!done) {
      const t0 = performance.now();
      ins.run(`m${writes}`, new Date().toISOString());
      maxWait = Math.max(maxWait, performance.now() - t0);
      writes += 1;
      await new Promise((r) => setTimeout(r, 1));
    }
    const r = await job;
    expect(r.pruned.run_events).toBe(200_000);
    expect(writes).toBeGreaterThan(20);
    expect(count(s, "SELECT COUNT(*) AS n FROM messages WHERE thread_id = 'live'")).toBe(writes);
    // Design: < 100 ms on a quiet machine; CI and a shared sandbox get 250 ms.
    expect(maxWait).toBeLessThan(250);
    expect(perfSnapshot().jobs.prune?.lastMs).toBeGreaterThan(0);
  }, 60_000);

  it("close() mid-job: the batch in progress commits, the job and the queued ones are cancelled", async () => {
    const s = openStore(tmpDb(), undefined, { batchMs: () => 5 });
    seedOld(s, 100_000);
    const first = s.jobs.run("prune", policy, new Date().toISOString()).catch((e: unknown) => e);
    const queued = s.jobs.run("maintain", new Date().toISOString(), null).catch((e: unknown) => e);
    for (let i = 0; i < 500 && count(s, "SELECT COUNT(*) AS n FROM run_events") === 100_000; i++)
      await new Promise((r) => setTimeout(r, 5));
    await s.jobs.close();
    expect(await first).toBeInstanceOf(CancelledError);
    expect(await queued).toBeInstanceOf(CancelledError);
    await expect(s.jobs.run("maintain", new Date().toISOString(), null)).rejects.toBeInstanceOf(
      CancelledError,
    );
    const left = count(s, "SELECT COUNT(*) AS n FROM run_events");
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThan(100_000);
    expect(count(s, "SELECT COUNT(*) AS n FROM retention_gate WHERE before IS NOT NULL")).toBe(0);
    s.close();
  });

  it("the trail of a deleted conversation goes on the worker", async () => {
    const s = openStore(tmpDb());
    open.push(s);
    seedConversation(s, "t1", "FAKE");
    s.threads.erase("t1", new Date(), { trail: "later" });
    expect(count(s, "SELECT COUNT(*) AS n FROM run_events")).toBe(5);
    expect(await s.jobs.run("eraseTrail", ["t1"])).toEqual({ run_events: 5, job_events: 1, spills: 1 });
    expect(count(s, "SELECT COUNT(*) AS n FROM run_events")).toBe(0);
  });
});
