import { describe, expect, it } from "vitest";
import { atomic, type DispatchEventRecord, openStore, transaction } from "../src/index.ts";

/**
 * Design §0.2.3: observers see a ledger row only once it is committed, in
 * seq order; a rolled-back row is never seen. A resume cursor that was
 * pruned is reported as gone with the oldest seq still kept.
 */

const tick = () => new Promise((r) => setImmediate(r));

const open = () => {
  const s = openStore(":memory:");
  const d = s.dispatches.open(
    { botId: "bot_a", threadId: "thr_a", harness: "general", level: "autonomous" },
    1000,
  );
  const seen: DispatchEventRecord[] = [];
  const off = s.dispatches.observe((e) => seen.push(e));
  return { s, d, seen, off };
};

describe("ledger events reach observers only after commit (design §0.2.3)", () => {
  it("committed rows arrive in seq order and match the database", async () => {
    const { s, d, seen } = open();
    s.dispatches.begin(d.id, "wkr_1", "r1", 1001);
    s.dispatches.event(d.id, "outward", 1002, { runId: "r1", detail: { tool: "mail_send" } });
    expect(s.dispatches.turnEnded(d.id, "r1", "run_x", "turn.completed", 1003)).toBe(true);
    await tick();
    const db = s.dispatches.events(d.id);
    // `open` ran before observe; everything after it was heard, once each, same seq.
    expect(seen.map((e) => e.seq)).toEqual(db.slice(1).map((e) => e.seq));
    expect(seen.map((e) => e.kind)).toEqual(db.slice(1).map((e) => e.kind));
    for (let i = 1; i < seen.length; i++) expect(seen[i]!.seq).toBeGreaterThan(seen[i - 1]!.seq);
  });

  it("a rolled-back block sends nothing, even when its seq is reused by a later row", async () => {
    const { s, d, seen } = open();
    expect(() =>
      transaction(s.db, () => {
        s.dispatches.event(d.id, "rolled.back", 1001);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    // A nested block rolled back inside a committed one: only the outer row is sent.
    atomic(s.db, () => {
      s.dispatches.event(d.id, "kept", 1002);
      try {
        atomic(s.db, () => {
          s.dispatches.event(d.id, "inner.rolled.back", 1003);
          throw new Error("inner");
        });
      } catch {
        // expected
      }
    });
    await tick();
    expect(seen.map((e) => e.kind)).toEqual(["kept"]);
    expect(s.dispatches.events(d.id).map((e) => e.kind)).toEqual(["queued", "kept"]);
  });

  it("an observer that throws does not break the write or other observers; unobserve stops it", async () => {
    const { s, d, seen, off } = open();
    s.dispatches.observe(() => {
      throw new Error("broken listener");
    });
    s.dispatches.event(d.id, "a", 1001);
    await tick();
    expect(seen.map((e) => e.kind)).toEqual(["a"]);
    off();
    s.dispatches.event(d.id, "b", 1002);
    await tick();
    expect(seen.map((e) => e.kind)).toEqual(["a"]);
  });
});

describe("resume cursors", () => {
  it("dispatch: 0 is the start; a kept cursor resumes; a pruned one is gone with the oldest kept seq", () => {
    const { s, d } = open();
    s.dispatches.event(d.id, "a", 1001);
    s.dispatches.event(d.id, "b", 1002);
    const [q, a, b] = s.dispatches.events(d.id);
    expect(s.dispatches.cursorGone(d.id, 0)).toBeUndefined();
    expect(s.dispatches.cursorGone(d.id, a!.seq)).toBeUndefined();
    expect(s.dispatches.eventsAfter(d.id, a!.seq).map((e) => e.kind)).toEqual(["b"]);
    // Simulate a partial prune (the append-only trigger normally forbids it).
    s.db.exec("DROP TRIGGER dispatch_events_append_only_d");
    s.db.prepare("DELETE FROM dispatch_events WHERE seq IN (?, ?)").run(q!.seq, a!.seq);
    expect(s.dispatches.cursorGone(d.id, a!.seq)).toEqual({ minSeq: b!.seq });
    expect(s.dispatches.cursorGone(d.id, b!.seq)).toBeUndefined();
  });

  it("run: a cursor whose rows were removed after the run finished is gone", () => {
    const s = openStore(":memory:");
    const t = s.threads.create("thr_r", "t");
    const r = s.runs.start({ id: "run_r", threadId: t.id, initiator: { kind: "user", id: "u" } });
    for (let seq = 0; seq < 3; seq++) s.runs.appendEvent({ runId: r.id, seq, type: "x", payload: { seq } });
    expect(s.runs.cursorGone(r.id, 1)).toBeUndefined();
    expect(s.runs.cursorGone(r.id, -1)).toBeUndefined();
    s.runs.finish(r.id, "completed");
    s.threads.erase(t.id);
    expect(s.runs.events(r.id)).toHaveLength(0);
    expect(s.runs.cursorGone(r.id, 1)).toEqual({ minSeq: null });
    expect(s.runs.cursorGone(r.id, -1)).toBeUndefined();
  });
});
