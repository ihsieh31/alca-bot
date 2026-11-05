import { openStore } from "@alca/store";
import { describe, expect, it } from "vitest";
import { JobRuntime, JobStateError, recoverJobs, Scheduler } from "../src/index.ts";

function setup(start = "2026-11-03T00:00:00.000Z") {
  const store = openStore(":memory:");
  let now = new Date(start);
  const rt = new JobRuntime(store.db, { now: () => now, leaseMs: 30_000 });
  return {
    store,
    rt,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
    get now() {
      return now;
    },
  };
}

describe("job runtime", () => {
  it("create → claim → complete writes a gapless event log", () => {
    const { rt } = setup();
    const j = rt.create({ kind: "tool", title: "讀檔" });
    expect(j.status).toBe("queued");
    const c = rt.claim("w1");
    expect(c).toMatchObject({ id: j.id, status: "running", attempt: 1, leaseOwner: "w1" });
    expect(rt.claim("w2")).toBeUndefined();
    rt.complete(j.id, { ok: true });
    const done = rt.get(j.id)!;
    expect(done).toMatchObject({ status: "succeeded", result: { ok: true }, leaseOwner: null });
    expect(rt.events(j.id).map((e) => [e.seq, e.type])).toEqual([
      [0, "created"],
      [1, "claimed"],
      [2, "succeeded"],
    ]);
  });

  it("refuses illegal transitions and children of finished parents", () => {
    const { rt } = setup();
    const p = rt.create({ kind: "turn" });
    expect(() => rt.complete(p.id)).toThrow(JobStateError);
    rt.start(p.id, "w");
    rt.fail(p.id, "boom");
    expect(() => rt.complete(p.id)).toThrow(JobStateError);
    expect(() => rt.create({ kind: "tool", parentId: p.id })).toThrow(/is failed/);
  });

  it("cancelling a parent cancels its unfinished children", () => {
    const { rt } = setup();
    const p = rt.create({ kind: "turn" });
    const a = rt.create({ kind: "tool", parentId: p.id });
    const b = rt.create({ kind: "tool", parentId: p.id });
    rt.start(b.id, "w");
    rt.complete(b.id);
    rt.cancel(p.id, "user stop");
    expect(rt.get(a.id)?.status).toBe("cancelled");
    expect(rt.get(b.id)?.status).toBe("succeeded");
    expect(rt.children(p.id)).toHaveLength(2);
  });

  it("outbound events make the job sticky-outbound", () => {
    const { rt, store } = setup();
    const j = rt.create({ kind: "tool" });
    rt.start(j.id, "w");
    rt.record(j.id, "outbound.sent", { to: "someone" });
    expect(rt.get(j.id)?.outboundObserved).toBe(true);
    expect(() => store.db.exec(`UPDATE jobs SET outbound_observed = 0 WHERE id = '${j.id}'`)).toThrow();
  });

  it("claim respects kinds and skips jobs waiting for review", () => {
    const { rt } = setup();
    rt.create({ kind: "watch" });
    const t = rt.create({ kind: "tool" });
    expect(rt.claim("w", ["tool"])?.id).toBe(t.id);
    expect(rt.claim("w", ["tool"])).toBeUndefined();
  });
});

describe("restart recovery", () => {
  it("never auto-reruns a job whose events show an outbound action", () => {
    const { rt } = setup();
    const sent = rt.create({ kind: "tool", title: "寄信" });
    rt.start(sent.id, "old-process");
    rt.record(sent.id, "outbound.sent", { channel: "mail" });
    const quiet = rt.create({ kind: "tool", title: "讀檔" });
    rt.start(quiet.id, "old-process");
    const turn = rt.create({ kind: "turn" });
    rt.start(turn.id, "old-process");

    const out = recoverJobs(rt, new Date());
    expect(out.map((o) => [o.jobId, o.action])).toEqual([
      [sent.id, "needs_review"],
      [quiet.id, "requeued"],
      [turn.id, "cancelled"],
    ]);
    expect(rt.get(sent.id)).toMatchObject({ status: "waiting", needsReview: true });
    // The parked job is invisible to workers until a person reviews it.
    expect(rt.claim("new-process")?.id).toBe(quiet.id);
    expect(rt.claim("new-process")).toBeUndefined();
    // Recovering again does not touch it.
    expect(recoverJobs(rt, new Date()).map((o) => o.jobId)).not.toContain(sent.id);
    rt.review(sent.id, "fail", "me");
    expect(rt.get(sent.id)).toMatchObject({ status: "failed", needsReview: false });
  });

  it("detects outbound activity from the event log even if the flag is missing", () => {
    const { rt, store } = setup();
    const j = rt.create({ kind: "browser_task" });
    rt.start(j.id, "old");
    // Simulate an event written without the flag (e.g. by an older build).
    store.db
      .prepare(
        "INSERT INTO job_events (job_id, seq, type, payload, created_at) VALUES (?, 99, 'outbound.posted', '{}', ?)",
      )
      .run(j.id, new Date().toISOString());
    expect(rt.get(j.id)?.outboundObserved).toBe(false);
    expect(recoverJobs(rt, new Date())[0]?.action).toBe("needs_review");
  });

  it("fails jobs out of attempts and only sweeps expired leases when asked", () => {
    const h = setup();
    const j = h.rt.create({ kind: "tool" });
    for (let i = 0; i < 3; i++) {
      h.rt.claim("w");
      if (i < 2) recoverJobs(h.rt, h.now);
    }
    expect(h.rt.get(j.id)?.attempt).toBe(3);
    expect(recoverJobs(h.rt, h.now, { expiredLeasesOnly: true })).toEqual([]);
    h.advance(31_000);
    expect(recoverJobs(h.rt, h.now, { expiredLeasesOnly: true })[0]?.action).toBe("failed");
  });
});

describe("scheduler (at-most-once)", () => {
  it("advances the cursor before dispatch; a crash after the commit never double-fires", async () => {
    const h = setup();
    const sch = new Scheduler(h.rt);
    const s = sch.add({ name: "晨報", kind: "interval", intervalSec: 60, firstDueAt: h.now }, h.now);
    // "Crash" right after the commit point: claimed but never dispatched.
    const claimed = sch.claimDue(h.now);
    expect(claimed).toHaveLength(1);
    expect(sch.get(s.id)?.nextDueAt).toBe(new Date(h.now.getTime() + 60_000).toISOString());
    const fired: string[] = [];
    expect(await sch.tick(h.now, (d) => void fired.push(d.dueAt))).toEqual([]);
    expect(fired).toEqual([]);
  });

  it("a throwing dispatch is recorded and not retried; missed slots are skipped", async () => {
    const h = setup();
    const sch = new Scheduler(h.rt);
    const s = sch.add({ name: "check", kind: "interval", intervalSec: 60, firstDueAt: h.now }, h.now);
    const [d] = await sch.tick(h.now, () => {
      throw new Error("down");
    });
    expect(h.rt.events(d!.job.id).map((e) => e.type)).toContain("dispatch_failed");
    expect(await sch.tick(h.now, () => {})).toEqual([]);
    h.advance(10 * 60_000 + 5_000); // ten slots missed
    const fired = await sch.tick(h.now, () => {});
    expect(fired).toHaveLength(1);
    expect(sch.get(s.id)?.nextDueAt).toBe(new Date(h.now.getTime() + 55_000).toISOString());
  });

  it("one-shot schedules fire once; concurrent claimers cannot both win", async () => {
    const h = setup();
    const sch = new Scheduler(h.rt);
    const other = new Scheduler(new JobRuntime(h.store.db, { now: () => h.now }));
    const s = sch.add({ name: "提醒", kind: "once", firstDueAt: h.now }, h.now);
    const a = sch.claimDue(h.now);
    const b = other.claimDue(h.now);
    expect(a.length + b.length).toBe(1);
    expect(sch.get(s.id)?.nextDueAt).toBeNull();
    h.advance(3600_000);
    expect(sch.claimDue(h.now)).toEqual([]);
  });
});

describe("sealed job content (mac device test 2026-11-05 BUG-4)", () => {
  it("title, input and result are stored sealed and read back as written", async () => {
    const { randomBytes } = await import("node:crypto");
    const { Sealer, isSealedText } = await import("@alca/store");
    const store = openStore(":memory:", undefined, {
      sealer: new Sealer({ current: 1, keys: { "1": randomBytes(32).toString("base64") } }),
    });
    const rt = new JobRuntime(store.db);
    const j = rt.create({ kind: "tool", title: "秘密標題", input: { q: "秘密輸入" } });
    rt.start(j.id, "w");
    rt.complete(j.id, { a: "秘密結果" });
    const raw = store.db.prepare("SELECT title, input, result FROM jobs WHERE id = ?").get(j.id) as Record<
      string,
      string
    >;
    for (const v of Object.values(raw)) {
      expect(isSealedText(v)).toBe(true);
      expect(v).not.toContain("秘密");
    }
    const back = rt.get(j.id);
    expect(back).toMatchObject({ title: "秘密標題", input: { q: "秘密輸入" }, result: { a: "秘密結果" } });
    expect(rt.byStatus("succeeded").map((x) => x.title)).toEqual(["秘密標題"]);
    store.close();
  });
});
