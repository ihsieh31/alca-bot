import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendAudit,
  convertAutoVacuum,
  maintain,
  openStore,
  pruneRetention,
  RETENTION_BATCH,
  type Store,
} from "../src/index.ts";

// Fake data only. Dates are relative to the real clock because the gate
// trigger compares against SQLite's own 'now' (a gate must be ≥ 7 days old).
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const OLD = ago(200);
const RECENT = ago(3);

const dirs: string[] = [];
function tmpDb(): string {
  const d = mkdtempSync(join(tmpdir(), "alca-ret-"));
  dirs.push(d);
  return join(d, "state.sqlite");
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function bot(s: Store): string {
  return (s.db.prepare("SELECT id FROM bots LIMIT 1").get() as { id: string }).id;
}

function thread(s: Store, id: string) {
  s.db
    .prepare("INSERT INTO threads (id, title, created_at, updated_at) VALUES (?, 't', ?, ?)")
    .run(id, OLD, OLD);
}

function run(s: Store, id: string, threadId: string, finishedAt: string | null) {
  s.db
    .prepare(
      `INSERT INTO runs (id, thread_id, initiator_kind, initiator_id, started_at, status, finish_reason, finished_at)
       VALUES (?, ?, 'user', 'u', ?, ?, ?, ?)`,
    )
    .run(id, threadId, OLD, finishedAt ? "finished" : "running", finishedAt ? "completed" : null, finishedAt);
}

function runEvent(s: Store, runId: string, seq: number, at: string, text = "x") {
  s.db
    .prepare("INSERT INTO run_events (run_id, seq, type, payload, created_at) VALUES (?, ?, 'text', ?, ?)")
    .run(runId, seq, JSON.stringify({ text }), at);
}

function job(s: Store, id: string, threadId: string | null, status: string, updatedAt: string) {
  s.db
    .prepare(
      "INSERT INTO jobs (id, kind, thread_id, status, created_at, updated_at) VALUES (?, 'turn', ?, ?, ?, ?)",
    )
    .run(id, threadId, status, OLD, updatedAt);
  s.db
    .prepare(
      "INSERT INTO job_events (job_id, seq, type, payload, created_at) VALUES (?, 0, 'created', '{}', ?)",
    )
    .run(id, OLD);
}

function worker(s: Store, id: string, threadId: string, jobId: string) {
  s.db
    .prepare(
      `INSERT INTO workers (id, bot_id, thread_id, job_id, title, goal, initiator_kind, initiator_id, created_at)
       VALUES (?, ?, ?, ?, 'w', 'g', 'user', 'u', ?)`,
    )
    .run(id, bot(s), threadId, jobId, OLD);
}

function spill(s: Store, id: string, ownerKind: string, ownerId: string, at: string) {
  s.db
    .prepare(
      "INSERT INTO spills (id, bot_id, owner_kind, owner_id, title, body, chars, created_at) VALUES (?, ?, ?, ?, 't', 'body', 4, ?)",
    )
    .run(id, bot(s), ownerKind, ownerId, at);
}

const count = (s: Store, sql: string) => Number((s.db.prepare(sql).get() as { n: number }).n);
const gateOpen = (s: Store, tbl: string, before: string | null) =>
  s.db.prepare("UPDATE retention_gate SET before = ? WHERE tbl = ?").run(before, tbl);

function seedRuns(s: Store) {
  thread(s, "t1");
  run(s, "r_old", "t1", OLD); // finished long ago
  run(s, "r_live", "t1", null); // still running, old events
  run(s, "r_new", "t1", RECENT); // finished recently
  for (let i = 0; i < 3; i++) {
    runEvent(s, "r_old", i, OLD);
    runEvent(s, "r_live", i, OLD);
    runEvent(s, "r_new", i, RECENT);
  }
}

describe("controlled append-only (migration 21)", () => {
  it("refuses a DELETE that does not go through an open gate", () => {
    const s = openStore(":memory:");
    seedRuns(s);
    expect(() => s.db.prepare("DELETE FROM run_events WHERE run_id = 'r_old'").run()).toThrow(/append-only/);
    expect(() => s.db.prepare("DELETE FROM run_events").run()).toThrow(/append-only/);
    expect(count(s, "SELECT COUNT(*) AS n FROM run_events")).toBe(9);
    s.close();
  });

  it("an open gate allows only old rows of finished runs, and never a gate newer than seven days", () => {
    const s = openStore(":memory:");
    seedRuns(s);
    // A gate at 'now' (a bug, or a retention under the minimum) is refused outright.
    gateOpen(s, "run_events", new Date().toISOString());
    expect(() => s.db.prepare("DELETE FROM run_events WHERE run_id = 'r_old'").run()).toThrow(/append-only/);
    gateOpen(s, "run_events", ago(90));
    expect(() => s.db.prepare("DELETE FROM run_events WHERE run_id = 'r_live'").run()).toThrow(/append-only/);
    expect(() => s.db.prepare("DELETE FROM run_events WHERE run_id = 'r_new'").run()).toThrow(/append-only/);
    // One bad row aborts the whole statement.
    expect(() => s.db.prepare("DELETE FROM run_events").run()).toThrow(/append-only/);
    expect(Number(s.db.prepare("DELETE FROM run_events WHERE run_id = 'r_old'").run().changes)).toBe(3);
    // The gate of another table does not open this one.
    gateOpen(s, "run_events", null);
    gateOpen(s, "job_events", ago(90));
    runEvent(s, "r_old", 9, OLD);
    expect(() => s.db.prepare("DELETE FROM run_events WHERE run_id = 'r_old'").run()).toThrow(/append-only/);
    s.close();
  });

  it("audit_log can never be deleted or changed, with every gate open", () => {
    const s = openStore(":memory:");
    appendAudit(s.db, {
      ts: OLD,
      initiator: { kind: "user", id: "u" },
      actor: { kind: "bot", id: "b" },
      action: "read",
      actionClass: "read",
      decision: "allow",
    });
    s.db.prepare("UPDATE retention_gate SET before = ?").run(ago(30));
    expect(() => s.db.prepare("DELETE FROM audit_log").run()).toThrow(/append-only/);
    expect(() => s.db.prepare("UPDATE audit_log SET action = 'x'").run()).toThrow(/append-only/);
    expect(() =>
      s.db.prepare("INSERT INTO retention_gate (tbl, before) VALUES ('audit_log', ?)").run(OLD),
    ).toThrow();
    expect(() =>
      s.db.prepare("UPDATE retention_gate SET tbl = 'audit_log' WHERE tbl = 'spills'").run(),
    ).toThrow();
    expect(() => s.db.prepare("DELETE FROM retention_gate").run()).toThrow(/fixed/);
    expect(count(s, "SELECT COUNT(*) AS n FROM audit_log")).toBe(1);
    // no gate exists for it, and its delete trigger is still the unconditional one
    expect(count(s, "SELECT COUNT(*) AS n FROM retention_gate WHERE tbl = 'audit_log'")).toBe(0);
    const sql = (
      s.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'audit_log_no_delete'").get() as {
        sql: string;
      }
    ).sql;
    expect(sql).not.toMatch(/WHEN/i);
    s.close();
  });

  it("UPDATE stays refused on the gated tables", () => {
    const s = openStore(":memory:");
    seedRuns(s);
    gateOpen(s, "run_events", ago(90));
    expect(() => s.db.prepare("UPDATE run_events SET type = 'y'").run()).toThrow(/append-only/);
    s.close();
  });
});

describe("pruneRetention", () => {
  it("deletes what is past retention in every gated table and closes the gates", () => {
    const s = openStore(":memory:");
    seedRuns(s);
    job(s, "j_done", "t1", "succeeded", OLD);
    job(s, "j_open", "t1", "running", OLD);
    job(s, "j_recent", "t1", "failed", RECENT);
    worker(s, "w1", "t1", "j_done");
    spill(s, "sp_old", "worker", "w1", OLD);
    spill(s, "sp_new", "worker", "w1", RECENT);
    s.db
      .prepare(
        "INSERT INTO triggers (id, bot_id, thread_id, name, source, created_at) VALUES ('tr1', ?, 't1', 'n', 'manual', ?)",
      )
      .run(bot(s), OLD);
    for (const [id, at] of [
      ["te_old", OLD],
      ["te_new", RECENT],
    ] as const)
      s.db
        .prepare(
          "INSERT INTO trigger_events (id, trigger_id, payload, rule_verdict, outcome, created_at) VALUES (?, 'tr1', '{}', 'drop', 'dropped', ?)",
        )
        .run(id, at);
    for (const at of [OLD, RECENT])
      s.db
        .prepare(
          "INSERT INTO watchdog_events (worker_id, bot_id, kind, detail, created_at) VALUES ('w1', ?, 'stuck', 'd', ?)",
        )
        .run(bot(s), at);
    s.db.prepare("INSERT INTO bots (id, name, created_at) VALUES ('bot_peer', 'peer', ?)").run(OLD);
    for (const [id, status, fin] of [
      ["pr_done", "done", OLD],
      ["pr_run", "running", null],
    ] as const)
      s.db
        .prepare(
          `INSERT INTO peer_requests (id, kind, from_bot_id, to_bot_id, from_thread_id, root_thread_id, depth, chain, text, status, initiator_kind, initiator_id, created_at, finished_at)
           VALUES (?, 'ask', ?, ?, 't1', 't1', 1, '[]', 'q', ?, 'user', 'u', ?, ?)`,
        )
        .run(id, bot(s), "bot_peer", status, OLD, fin);
    for (const id of ["pr_done", "pr_run"])
      s.db
        .prepare("INSERT INTO peer_events (id, request_id, kind, created_at) VALUES (?, ?, 'requested', ?)")
        .run(`pe_${id}`, id, OLD);
    s.db
      .prepare(
        "INSERT INTO routines (id, bot_id, thread_id, name, kind, interval_sec, check_spec, created_at) VALUES ('ro1', ?, 't1', 'n', 'interval', 3600, '{}', ?)",
      )
      .run(bot(s), OLD);
    for (let i = 0; i < 25; i++)
      s.db
        .prepare(
          "INSERT INTO routine_runs (id, routine_id, bot_id, outcome, created_at) VALUES (?, 'ro1', ?, 'quiet', ?)",
        )
        .run(`rr_${String(i).padStart(2, "0")}`, bot(s), ago(300 - i));

    const out = pruneRetention(s.db, new Date());
    expect(out).toEqual({
      run_events: 3,
      job_events: 1,
      spills: 1,
      trigger_events: 1,
      watchdog_events: 1,
      peer_events: 1,
      routine_runs: 5,
    });
    expect(count(s, "SELECT COUNT(*) AS n FROM run_events WHERE run_id = 'r_old'")).toBe(0);
    expect(count(s, "SELECT COUNT(*) AS n FROM run_events WHERE run_id IN ('r_live','r_new')")).toBe(6);
    expect(count(s, "SELECT COUNT(*) AS n FROM job_events WHERE job_id IN ('j_open','j_recent')")).toBe(2);
    expect(count(s, "SELECT COUNT(*) AS n FROM peer_events WHERE request_id = 'pr_run'")).toBe(1);
    // the newest 20 of the routine stay, oldest went first
    expect(count(s, "SELECT COUNT(*) AS n FROM routine_runs")).toBe(20);
    expect(count(s, "SELECT COUNT(*) AS n FROM routine_runs WHERE id < 'rr_05'")).toBe(0);
    expect(count(s, "SELECT COUNT(*) AS n FROM retention_gate WHERE before IS NOT NULL")).toBe(0);
    // a second pass finds nothing
    expect(pruneRetention(s.db, new Date())).toEqual({});
    s.close();
  });

  it("works in bounded batches", () => {
    const s = openStore(":memory:");
    thread(s, "t1");
    run(s, "r_big", "t1", OLD);
    const n = RETENTION_BATCH * 2 + 20_000;
    s.db
      .prepare(
        `WITH RECURSIVE c(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM c WHERE i + 1 < ?)
         INSERT INTO run_events (run_id, seq, type, payload, created_at) SELECT 'r_big', i, 't', '{}', ? FROM c`,
      )
      .run(n, OLD);
    expect(pruneRetention(s.db, new Date()).run_events).toBe(n);
    expect(count(s, "SELECT COUNT(*) AS n FROM run_events")).toBe(0);
    s.close();
  });

  it("a retention shorter than seven days deletes nothing", () => {
    const s = openStore(":memory:");
    seedRuns(s);
    expect(pruneRetention(s.db, new Date(), { runEventsDays: 1, jobEventsDays: 1, externalDays: 1 })).toEqual(
      {},
    );
    expect(count(s, "SELECT COUNT(*) AS n FROM run_events")).toBe(9);
    s.close();
  });
});

describe("deleting a conversation deletes its trail", () => {
  it("run events, job events, spills and inbox rows go; other conversations keep theirs", () => {
    const s = openStore(":memory:");
    seedRuns(s);
    thread(s, "t2");
    run(s, "r_other", "t2", RECENT);
    runEvent(s, "r_other", 0, RECENT);
    job(s, "j1", "t1", "running", RECENT);
    worker(s, "w1", "t1", "j1");
    spill(s, "sp1", "worker", "w1", RECENT);
    s.db
      .prepare(
        "INSERT INTO triggers (id, bot_id, thread_id, name, source, created_at) VALUES ('tr1', ?, 't1', 'n', 'manual', ?)",
      )
      .run(bot(s), OLD);
    s.db
      .prepare(
        "INSERT INTO trigger_events (id, trigger_id, payload, rule_verdict, outcome, created_at) VALUES ('te1', 'tr1', '{}', 'candidate', 'router', ?)",
      )
      .run(RECENT);
    spill(s, "sp2", "trigger_event", "te1", RECENT);
    s.db
      .prepare(
        "INSERT INTO router_inbox (id, bot_id, thread_id, kind, ref_id, body, initiator_kind, initiator_id, created_at) VALUES ('ib1', ?, 't1', 'trigger', 'te1', 'b', 'user', 'u', ?)",
      )
      .run(bot(s), RECENT);
    // before the delete, the recent trail cannot be deleted by hand
    expect(() => s.db.prepare("DELETE FROM run_events WHERE run_id = 'r_new'").run()).toThrow(/append-only/);
    expect(() => s.db.prepare("DELETE FROM spills").run()).toThrow(/append-only/);

    expect(s.threads.erase("t1")).toBe(true);
    expect(count(s, "SELECT COUNT(*) AS n FROM run_events WHERE run_id IN ('r_old','r_live','r_new')")).toBe(
      0,
    );
    expect(count(s, "SELECT COUNT(*) AS n FROM job_events WHERE job_id = 'j1'")).toBe(0);
    expect(count(s, "SELECT COUNT(*) AS n FROM spills")).toBe(0);
    expect(count(s, "SELECT COUNT(*) AS n FROM router_inbox")).toBe(0);
    expect(count(s, "SELECT COUNT(*) AS n FROM run_events WHERE run_id = 'r_other'")).toBe(1);
    expect(() => s.db.prepare("DELETE FROM run_events WHERE run_id = 'r_other'").run()).toThrow(
      /append-only/,
    );
    // the mark the delete path keys off cannot be taken back
    expect(() => s.db.prepare("UPDATE threads SET deleted_at = NULL WHERE id = 't1'").run()).toThrow(
      /stays deleted/,
    );
    s.close();
  });
});

describe("secure_delete, checkpoint, auto_vacuum", () => {
  it("a deleted conversation's text is not left in the file or the WAL", () => {
    const path = tmpDb();
    const s = openStore(path);
    expect((s.db.prepare("PRAGMA secure_delete").get() as { secure_delete: number }).secure_delete).toBe(1);
    const marker = "ZEBRA-MARKER-4711-FAKE";
    thread(s, "t1");
    run(s, "r1", "t1", RECENT);
    for (let i = 0; i < 50; i++) runEvent(s, "r1", i, RECENT, `${marker}-${i}`);
    s.db
      .prepare(
        "INSERT INTO messages (id, thread_id, role, content, created_at) VALUES ('m1', 't1', 'user', ?, ?)",
      )
      .run(marker, RECENT);
    maintain(s.db, new Date());
    expect(readFileSync(path).includes(marker)).toBe(true); // the test can see it while it exists
    s.threads.erase("t1");
    const r = maintain(s.db, new Date());
    expect(r.checkpointed).toBe(true);
    const wal = (() => {
      try {
        return readFileSync(`${path}-wal`);
      } catch {
        return Buffer.alloc(0);
      }
    })();
    expect(readFileSync(path).includes(marker)).toBe(false);
    expect(wal.includes(marker)).toBe(false);
    s.close();
  });

  it("a new file starts INCREMENTAL without a VACUUM", () => {
    const s = openStore(tmpDb());
    expect(s.vacuum).toEqual({ converted: false, skipped: "already" });
    expect((s.db.prepare("PRAGMA auto_vacuum").get() as { auto_vacuum: number }).auto_vacuum).toBe(2);
    s.close();
  });

  it("an existing NONE file is switched to INCREMENTAL once; a large one is left", () => {
    const path = tmpDb();
    const raw = new DatabaseSync(path); // a file made before this round: auto_vacuum NONE
    raw.exec("CREATE TABLE filler (x TEXT)");
    expect((raw.prepare("PRAGMA auto_vacuum").get() as { auto_vacuum: number }).auto_vacuum).toBe(0);
    raw.close();
    const s = openStore(path);
    expect(s.vacuum.converted).toBe(true);
    expect((s.db.prepare("PRAGMA auto_vacuum").get() as { auto_vacuum: number }).auto_vacuum).toBe(2);
    s.close();
    const again = openStore(path);
    expect(again.vacuum).toEqual({ converted: false, skipped: "already" });
    again.close();
    const other = tmpDb();
    const db = new DatabaseSync(other);
    db.exec("CREATE TABLE filler (x TEXT)");
    expect(convertAutoVacuum(db, other, 10_000, 1_000)).toEqual({ converted: false, skipped: "too_large" });
    db.close();
  });

  it("maintain gives free pages back when a tenth of the file is free, at most weekly", () => {
    const path = tmpDb();
    const s = openStore(path);
    thread(s, "t1");
    run(s, "r1", "t1", OLD);
    s.db
      .prepare(
        `WITH RECURSIVE c(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM c WHERE i + 1 < 20000)
         INSERT INTO run_events (run_id, seq, type, payload, created_at) SELECT 'r1', i, 't', json_object('p', hex(randomblob(64))), ? FROM c`,
      )
      .run(OLD);
    pruneRetention(s.db, new Date());
    const now = new Date();
    expect(maintain(s.db, now, { lastVacuumAt: now.getTime() - DAY }).vacuumedPages).toBe(0);
    expect(maintain(s.db, now).vacuumedPages).toBeGreaterThan(0);
    s.close();
  });
});
