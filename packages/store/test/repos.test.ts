import { describe, expect, it } from "vitest";
import { openStore } from "../src/index.ts";

const user = { kind: "user" as const, id: "local" };

function fresh() {
  const s = openStore(":memory:");
  s.threads.create("t1", "第一個對話", new Date("2026-11-03T00:00:00Z"));
  s.runs.start({ id: "r1", threadId: "t1", initiator: user, engine: "scripted" });
  return s;
}

describe("thread and run repos", () => {
  it("a long thread gives its latest messages, oldest first", () => {
    const s = fresh();
    const t0 = Date.parse("2026-11-03T02:00:00Z");
    for (let i = 0; i < 8; i++)
      s.threads.addMessage(
        { id: `m${i}`, threadId: "t1", runId: "r1", role: i % 2 ? "assistant" : "user", content: `#${i}` },
        new Date(t0 + i * 1000),
      );
    expect(s.threads.messages("t1", 3).map((m) => m.content)).toEqual(["#5", "#6", "#7"]);
    expect(s.threads.messages("t1").length).toBe(8);
    s.close();
  });

  it("stores threads, messages, sessions and orders threads by activity", () => {
    const s = fresh();
    s.threads.create("t2", null, new Date("2026-11-03T01:00:00Z"));
    expect(s.threads.list().map((t) => t.id)).toEqual(["t2", "t1"]);
    s.threads.addMessage(
      { id: "m1", threadId: "t1", runId: "r1", role: "user", content: "你好" },
      new Date("2026-11-03T02:00:00Z"),
    );
    expect(s.threads.list()[0]?.id).toBe("t1");
    expect(s.threads.messages("t1").map((m) => m.content)).toEqual(["你好"]);
    expect(s.threads.getSession("t1", "claude-code")).toBeUndefined();
    s.threads.setSession("t1", "claude-code", "sess-a");
    s.threads.setSession("t1", "claude-code", "sess-b");
    expect(s.threads.getSession("t1", "claude-code")).toBe("sess-b");
    s.close();
  });

  it("finishes a run once and replays its events in order", () => {
    const s = fresh();
    s.runs.appendEvent({ runId: "r1", seq: 0, type: "run.started", payload: { a: 1 } });
    s.runs.appendEvent({ runId: "r1", seq: 1, type: "run.finished", payload: { b: 2 } });
    expect(() => s.runs.appendEvent({ runId: "r1", seq: 1, type: "dup", payload: {} })).toThrow();
    expect(s.runs.events("r1").map((e) => e.seq)).toEqual([0, 1]);
    expect(s.runs.events("r1", 0).map((e) => e.type)).toEqual(["run.finished"]);
    expect(s.runs.open("t1")).toHaveLength(1);
    s.runs.finish("r1", "completed");
    s.runs.finish("r1", "failed");
    expect(s.runs.get("r1")?.finishReason).toBe("completed");
    expect(s.runs.open()).toHaveLength(0);
    s.close();
  });
});

describe("human input repo", () => {
  it("resolves an approval exactly once", () => {
    const s = fresh();
    s.human.requestApproval({
      id: "a1",
      runId: "r1",
      callId: "c1",
      actionClass: "delete",
      summary: "刪除檔案",
      detail: { path: "/tmp/x" },
    });
    expect(s.human.pendingApprovals("r1")).toHaveLength(1);
    expect(s.human.resolveApproval("a1", "approved", user)).toBe(true);
    expect(s.human.resolveApproval("a1", "denied", user)).toBe(false);
    expect(s.human.approval("a1")).toMatchObject({
      status: "approved",
      resolvedBy: user,
      detail: { path: "/tmp/x" },
    });
    expect(s.human.resolveApproval("missing", "approved", user)).toBe(false);
    s.close();
  });

  it("answers a question exactly once and keeps it", () => {
    const s = fresh();
    s.human.askQuestion({ id: "q1", runId: "r1", prompt: "要用哪個？", choices: ["A", "B"] });
    expect(s.human.answerQuestion("q1", "B")).toBe(true);
    expect(s.human.answerQuestion("q1", "A")).toBe(false);
    expect(s.human.question("q1")).toMatchObject({ status: "answered", answer: "B", choices: ["A", "B"] });
    expect(() => s.db.exec("DELETE FROM questions")).toThrow(/kept for audit/);
    s.close();
  });

  it("finished jobs cannot change status", () => {
    const s = fresh();
    const ts = new Date().toISOString();
    s.db
      .prepare(
        "INSERT INTO jobs (id, kind, status, created_at, updated_at) VALUES ('j1','turn','succeeded',?,?)",
      )
      .run(ts, ts);
    expect(() => s.db.exec("UPDATE jobs SET status = 'running' WHERE id = 'j1'")).toThrow(/already finished/);
    s.close();
  });
});
