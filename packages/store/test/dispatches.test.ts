import { describe, expect, it } from "vitest";
import { openStore } from "../src/index.ts";

const open = () => {
  const s = openStore(":memory:");
  const d = s.dispatches.open(
    { botId: "bot_a", threadId: "thr_a", harness: "coding", level: "autonomous" },
    1000,
  );
  return { s, d };
};

describe("dispatch ledger (migration 18)", () => {
  it("fences writers: a superseded execution cannot report", () => {
    const { s, d } = open();
    expect(s.dispatches.begin(d.id, "wkr_1", "wkr_1:1", 1001)).toBe(true);
    expect(s.dispatches.fenced(d.id, "wkr_1:1")).toBe(true);
    // a restart requeues: the fence drops, a new execution takes it
    expect(s.dispatches.requeue(d.id, 1002)).toBe(true);
    expect(s.dispatches.begin(d.id, "wkr_1", "wkr_1:2", 1003)).toBe(true);
    expect(s.dispatches.settle(d.id, "wkr_1:1", "done", { status: "done" }, 1004)).toBe(false);
    expect(s.dispatches.settle(d.id, "wkr_1:2", "done", { status: "done" }, 1005)).toBe(true);
    expect(s.dispatches.settle(d.id, "wkr_1:2", "partial", {}, 1006)).toBe(false);
    expect(s.dispatches.get(d.id)).toMatchObject({ status: "settled", outcome: "done", requeues: 1 });
  });

  it("only the assigned worker may begin", () => {
    const { s, d } = open();
    s.dispatches.assign(d.id, "wkr_2");
    expect(s.dispatches.begin(d.id, "wkr_1", "wkr_1:1")).toBe(false);
    expect(s.dispatches.begin(d.id, "wkr_2", "wkr_2:1")).toBe(true);
  });

  it("events are append-only and one end per turn", () => {
    const { s, d } = open();
    s.dispatches.begin(d.id, "wkr_1", "r1");
    expect(s.dispatches.turnEnded(d.id, "r1", "run_x", "turn.completed")).toBe(true);
    expect(s.dispatches.turnEnded(d.id, "r1", "run_x", "turn.interrupted")).toBe(false);
    expect(() => s.db.prepare("UPDATE dispatch_events SET kind = 'x'").run()).toThrow(/append-only/);
    expect(() => s.db.prepare("DELETE FROM dispatch_events").run()).toThrow(/append-only/);
  });

  it("a wait is claimed once, however many wakes race (B4, B5)", () => {
    const { s, d } = open();
    s.dispatches.begin(d.id, "wkr_1", "r1");
    const w = s.dispatches.askInput(
      d.id,
      "r1",
      { status: "needs_input" },
      {
        workerId: "wkr_1",
        questions: [{ question: "q" }],
        expiresAt: null,
      },
    );
    expect(w?.state).toBe("open");
    const wins = ["wkr_a", "wkr_b", "wkr_c"].map((id) =>
      s.dispatches.claim(w?.id ?? "", id, 2000, { answers: ["x"], by: "router" }),
    );
    expect(wins).toEqual([true, false, false]);
    expect(s.dispatches.get(d.id)).toMatchObject({ status: "queued", activeWorkerId: "wkr_a" });
    expect(s.dispatches.begin(d.id, "wkr_b", "wkr_b:1")).toBe(false);
    expect(s.dispatches.begin(d.id, "wkr_a", "wkr_a:1")).toBe(true);
    // the answer is unique per wait at the database level
    expect(() => s.dispatches.event(d.id, "answered", 3000, { waitId: w?.id ?? "" })).toThrow();
    // the continuation reports: its wait closes
    expect(s.dispatches.settle(d.id, "wkr_a:1", "done", {}, 4000)).toBe(true);
    expect(s.dispatches.wait(w?.id ?? "")?.state).toBe("closed");
  });

  it("text questions expire once; the dispatch settles as expired", () => {
    const { s, d } = open();
    s.dispatches.begin(d.id, "wkr_1", "r1");
    const w = s.dispatches.askInput(d.id, "r1", {}, { workerId: "wkr_1", questions: [], expiresAt: 5000 });
    expect(s.dispatches.expireWaits(4999)).toHaveLength(0);
    expect(s.dispatches.expireWaits(5000).map((x) => x.id)).toEqual([w?.id]);
    expect(s.dispatches.expireWaits(9000)).toHaveLength(0);
    expect(s.dispatches.get(d.id)).toMatchObject({ status: "settled", outcome: "expired" });
    expect(s.dispatches.claim(w?.id ?? "", "wkr_2")).toBe(false);
  });

  it("a stop closes an open wait once and settles the dispatch as stopped; a claimed wait is not stopped", () => {
    const ask = () => {
      const { s, d } = open();
      s.dispatches.begin(d.id, "wkr_1", "r1");
      const w = s.dispatches.askInput(
        d.id,
        "r1",
        { status: "needs_input" },
        { workerId: "wkr_1", questions: [{ question: "q" }], expiresAt: 5000 },
      );
      return { s, d, w: w?.id ?? "" };
    };
    const a = ask();
    expect(a.s.dispatches.stopWait(a.w, "router: 不用了", 3000)).toBe(true);
    expect(a.s.dispatches.stopWait(a.w, "again", 3001)).toBe(false);
    expect(a.s.dispatches.wait(a.w)).toMatchObject({ state: "closed", closedAt: 3000, claimedBy: null });
    expect(a.s.dispatches.get(a.d.id)).toMatchObject({
      status: "settled",
      outcome: "stopped",
      finishedAt: 3000,
    });
    const ev = a.s.dispatches.events(a.d.id).filter((e) => e.kind === "stopped");
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ waitId: a.w, detail: { workerId: "wkr_1", reason: "router: 不用了" } });
    // stopped first: no claim, and it never expires
    expect(a.s.dispatches.claim(a.w, "wkr_2", 3002)).toBe(false);
    expect(a.s.dispatches.expireWaits(9000)).toHaveLength(0);
    // claimed first: the stop does nothing to the continuation's dispatch
    const b = ask();
    expect(b.s.dispatches.claim(b.w, "wkr_2", 3000)).toBe(true);
    expect(b.s.dispatches.stopWait(b.w, "late", 3001)).toBe(false);
    expect(b.s.dispatches.get(b.d.id)).toMatchObject({ status: "queued", activeWorkerId: "wkr_2" });
  });

  it("prunes settled dispatches after 30 days, with their events", () => {
    const { s, d } = open();
    s.dispatches.begin(d.id, "wkr_1", "r1", 1000);
    s.dispatches.settle(d.id, "r1", "done", {}, 1000);
    expect(s.dispatches.prune(1000 + 29 * 86_400_000)).toBe(0);
    expect(s.dispatches.prune(1001 + 30 * 86_400_000)).toBe(1);
    expect(s.dispatches.get(d.id)).toBeUndefined();
    expect(s.dispatches.events(d.id)).toHaveLength(0);
  });
});
