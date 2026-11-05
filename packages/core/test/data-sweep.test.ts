import { appendAudit, openStore, Upkeep, type UpkeepReport } from "@alca/store";
import { describe, expect, it } from "vitest";
import { makeAgents } from "./agents-helpers.ts";

// Next round §4.4: the data steps ride the agents sweep's hourly slot (no
// scheduler of their own), in order, and a failed audit check alerts once.

const DAY = 86_400_000;

describe("hourly data steps in the agents sweep", () => {
  it("runs once per hour, after the dispatch prune, and each step stands alone", async () => {
    const calls: string[] = [];
    let at = Date.UTC(2026, 10, 5, 0, 0, 0);
    const h = makeAgents({
      router: [],
      worker: [],
      system: {
        now: () => new Date(at),
        upkeep: {
          hourly: (now: Date): UpkeepReport => {
            calls.push(`upkeep@${now.toISOString()}`);
            throw new Error("boom"); // even a throw here does not stop the sweep
          },
        },
      },
    });
    const prune = h.store.dispatches.prune.bind(h.store.dispatches);
    h.store.dispatches.prune = (n: number) => {
      calls.push("prune");
      return prune(n);
    };
    expect(() => h.agents.sweep()).not.toThrow();
    h.agents.sweep(); // same hour: nothing again
    at += 3600_000;
    h.agents.sweep();
    expect(calls).toEqual([
      "prune",
      "upkeep@2026-11-05T00:00:00.000Z",
      "prune",
      "upkeep@2026-11-05T01:00:00.000Z",
    ]);
    await h.close();
  });

  it("deletes past-retention events through the real store and alerts once on a broken audit log", async () => {
    const store = openStore(":memory:");
    const upkeep = new Upkeep({ db: store.db, dbPath: ":memory:" });
    let at = Date.now();
    const h = makeAgents({ router: [], worker: [], store, system: { now: () => new Date(at), upkeep } });
    const old = new Date(Date.now() - 200 * DAY).toISOString();
    store.db
      .prepare("INSERT INTO threads (id, created_at, updated_at) VALUES ('t_fake', ?, ?)")
      .run(old, old);
    store.db
      .prepare(
        "INSERT INTO runs (id, thread_id, initiator_kind, initiator_id, started_at, status, finish_reason, finished_at) VALUES ('r_fake', 't_fake', 'user', 'u', ?, 'finished', 'completed', ?)",
      )
      .run(old, old);
    store.db
      .prepare(
        "INSERT INTO run_events (run_id, seq, type, payload, created_at) VALUES ('r_fake', 0, 't', '{}', ?)",
      )
      .run(old);
    for (let i = 0; i < 3; i++)
      appendAudit(store.db, {
        initiator: { kind: "user", id: "u" },
        actor: { kind: "bot", id: "b" },
        action: "shell",
        actionClass: "write",
        decision: "allow",
      });
    const first = h.agents.sweep();
    expect(first.upkeep?.pruned).toEqual({ run_events: 1 });
    expect(first.upkeep?.audit?.ok).toBe(true);
    // A row added after the last check is changed outside Alca (the hourly
    // pass reads only rows it has not verified yet).
    appendAudit(store.db, {
      initiator: { kind: "user", id: "u" },
      actor: { kind: "bot", id: "b" },
      action: "shell",
      actionClass: "write",
      decision: "allow",
    });
    store.db.exec("DROP TRIGGER audit_log_no_update");
    store.db.prepare("UPDATE audit_log SET action = 'other' WHERE id = 4").run();
    for (let i = 1; i <= 3; i++) {
      at += 3600_000;
      h.agents.sweep();
    }
    const alerts = h.agentEvents.filter((e) => e.type === "system.alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.data).toMatchObject({ kind: "audit_broken", reason: "hash", id: 4 });
    await h.close();
  });

  it("with the database worker the clock does not wait, and an hour still running is not started twice", async () => {
    const store = openStore(":memory:");
    const calls: string[] = [];
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const jobs = {
      run: (async (job: string, ...args: unknown[]) => {
        calls.push(job);
        if (job === "prune" && calls.filter((c) => c === "prune").length === 1) await held;
        return (store.jobs.run as (j: string, ...a: unknown[]) => Promise<unknown>)(job, ...args);
      }) as unknown as typeof store.jobs.run,
    };
    const upkeep = new Upkeep({ db: store.db, dbPath: ":memory:", jobs });
    let at = Date.now();
    const h = makeAgents({ router: [], worker: [], store, system: { now: () => new Date(at), upkeep } });
    const first = h.agents.sweep();
    expect(first.upkeep).toBeUndefined(); // the result comes later, off the clock
    expect(upkeep.inFlight).toBe(true);
    at += 3600_000;
    h.agents.sweep(); // the next hour while the first is still on the worker
    expect(calls).toEqual(["prune"]);
    release();
    await upkeep.runHourly(new Date(at)); // the same run, now finishing
    expect(calls).toEqual(["prune", "maintain", "verifyAudit"]); // :memory: has no daily backup
    expect(upkeep.inFlight).toBe(false);
    expect(upkeep.status().last?.errors).toEqual({});
    at += 3600_000;
    h.agents.sweep();
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.filter((c) => c === "prune")).toHaveLength(2);
    await h.close();
  });
});
