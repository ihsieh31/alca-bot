import { describe, expect, it } from "vitest";
import { AgentsChannelEmitter, AgentsEventSchema, ApprovalRequested, newId } from "../src/index.ts";

describe("agents channel", () => {
  const worker = {
    workerId: newId("worker"),
    botId: newId("bot"),
    threadId: newId("thread"),
    title: "比價",
    status: "running" as const,
    speculative: false,
    steps: 2,
    createdAt: new Date().toISOString(),
    subscriptions: [newId("stream")],
  };

  it("sequences and validates worker / trigger / watchdog events", () => {
    const em = new AgentsChannelEmitter();
    const a = em.emit("worker.updated", { worker });
    const b = em.emit("watchdog.flagged", {
      workerId: worker.workerId,
      botId: worker.botId,
      kind: "looping",
      detail: "同一個呼叫重複 6 次",
      action: "stopped",
    });
    expect([a.seq, b.seq]).toEqual([0, 1]);
    expect(() =>
      em.emit("trigger.fired", {
        triggerId: newId("trigger"),
        eventId: newId("triggerEvent"),
        botId: worker.botId,
        source: "timer",
        rule: "candidate",
        judged: "wake",
        outcome: "router",
      }),
    ).not.toThrow();
    expect(
      AgentsEventSchema.safeParse({ ...a, data: { worker: { ...worker, status: "sleeping" } } }).success,
    ).toBe(false);
    expect(() => em.emit("worker.updated", { worker: { ...worker, workerId: "wkr_bad" } })).toThrow();
  });

  it("approval.requested may name the worker", () => {
    const base = {
      v: 0,
      id: newId("event"),
      ts: new Date().toISOString(),
      threadId: newId("thread"),
      runId: newId("run"),
      seq: 3,
      initiator: { kind: "user", id: "me" },
      actor: { kind: "agent", id: "a" },
      type: "approval.requested",
    };
    const data = { approvalId: newId("approval"), actionClass: "payment", summary: "付款" };
    expect(
      ApprovalRequested.safeParse({ ...base, data: { ...data, workerId: newId("worker") } }).success,
    ).toBe(true);
    expect(ApprovalRequested.safeParse({ ...base, data: { ...data, workerId: "x" } }).success).toBe(false);
  });
});
