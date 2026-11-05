import { describe, expect, it } from "vitest";
import { type AlcaEvent, checkSequence, newId, orderBySeq, RunEmitter } from "../src/index.ts";
import { happyRun, makeEmitter } from "./fixtures.ts";

const codes = (events: AlcaEvent[]) => checkSequence(events).violations.map((v) => v.code);

describe("seq ordering", () => {
  it("accepts a complete well-formed run", () => {
    const { events } = happyRun();
    const r = checkSequence(events);
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.openRuns).toEqual([]);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
  });

  it("detects gaps, duplicates and a missing run.started", () => {
    const { events } = happyRun();
    expect(codes([events[0]!, events[2]!])).toContain("seq_gap");
    expect(codes([events[0]!, events[1]!, events[1]!])).toContain("seq_not_increasing");
    expect(codes(events.slice(1))).toContain("first_not_run_started");
  });

  it("detects events after run.finished", () => {
    const { events } = happyRun();
    const late = { ...events[1]!, seq: events.length };
    expect(codes([...events, late])).toContain("after_finish");
  });

  it("detects timestamp regressions and thread mismatches", () => {
    const { events } = happyRun();
    const back = { ...events[1]!, ts: "2020-01-01T00:00:00.000Z" };
    expect(codes([events[0]!, back])).toContain("ts_regressed");
    const other = { ...events[1]!, threadId: newId("thread") };
    expect(codes([events[0]!, other])).toContain("thread_mismatch");
  });

  it("detects unmatched and doubled completions", () => {
    const { emitter } = makeEmitter();
    const start = emitter.emit("run.started", {});
    const orphan = emitter.emit("tool.completed", { callId: newId("call"), ok: true, durationMs: 1 });
    const apr = emitter.emit("approval.resolved", {
      approvalId: newId("approval"),
      decision: "denied",
      by: { kind: "user", id: "u" },
    });
    const ans = emitter.emit("question.answered", { questionId: newId("question"), answer: "x" });
    expect(codes([start, orphan, apr, ans])).toEqual([
      "tool_completed_without_request",
      "approval_resolved_without_request",
      "question_answered_without_ask",
    ]);

    const call = newId("call");
    const e2 = makeEmitter().emitter;
    const s = e2.emit("run.started", {});
    const req = e2.emit("tool.requested", { callId: call, tool: "fs.read", args: {}, actionClass: "read" });
    const c1 = e2.emit("tool.completed", { callId: call, ok: true, durationMs: 1 });
    const c2 = e2.emit("tool.completed", { callId: call, ok: true, durationMs: 1 });
    expect(codes([s, req, c1, c2])).toEqual(["tool_completed_twice"]);
  });

  it("detects a delta after the message completed", () => {
    const { emitter } = makeEmitter();
    const m = newId("message");
    const events = [
      emitter.emit("run.started", {}),
      emitter.emit("message.completed", { messageId: m, role: "assistant", text: "hi" }),
      emitter.emit("message.delta", { messageId: m, role: "assistant", delta: "!" }),
    ];
    expect(codes(events)).toEqual(["delta_after_completed"]);
  });

  it("tracks interleaved runs independently and reports open runs", () => {
    const a = happyRun().events;
    const { emitter, runId } = makeEmitter();
    const b = [
      emitter.emit("run.started", {}),
      emitter.emit("error", { code: "x", message: "", retryable: false }),
    ];
    const mixed = [a[0]!, b[0]!, ...a.slice(1, 4), b[1]!, ...a.slice(4)];
    const r = checkSequence(mixed);
    expect(r.ok).toBe(true);
    expect(r.openRuns).toEqual([runId]);
  });

  it("orderBySeq repairs a shuffled relay batch", () => {
    const { events } = happyRun();
    const shuffled = [...events].reverse();
    expect(checkSequence(shuffled).ok).toBe(false);
    expect(checkSequence(orderBySeq(shuffled)).ok).toBe(true);
  });

  it("emitter never produces decreasing timestamps even if the clock goes back", () => {
    const times = [5000, 1000, 6000];
    const e = new RunEmitter({
      threadId: newId("thread"),
      runId: newId("run"),
      initiator: { kind: "schedule", id: "daily-brief" },
      actor: { kind: "system", id: "core" },
      now: () => new Date(times.shift() ?? 7000),
    });
    const evs: AlcaEvent[] = [
      e.emit("run.started", {}),
      e.emit("error", { code: "a", message: "", retryable: false }),
    ];
    evs.push(e.emit("run.finished", { reason: "failed" }));
    expect(checkSequence(evs).ok).toBe(true);
    expect(e.nextSeq).toBe(3);
  });
});
