import { type ActorT, type InitiatorT, newId, RunEmitter } from "../src/index.ts";

export const user: InitiatorT = { kind: "user", id: "local-user" };
export const agent: ActorT = { kind: "agent", id: "main" };

export function makeEmitter(start = Date.parse("2026-11-03T00:00:00.000Z")) {
  let t = start;
  const threadId = newId("thread");
  const runId = newId("run");
  const emitter = new RunEmitter({
    threadId,
    runId,
    initiator: user,
    actor: agent,
    now: () => {
      t += 10;
      return new Date(t);
    },
  });
  return { emitter, threadId, runId };
}

/** A complete, valid run touching every event type. */
export function happyRun() {
  const { emitter, threadId, runId } = makeEmitter();
  const msg = newId("message");
  const call = newId("call");
  const apr = newId("approval");
  const qst = newId("question");
  const events = [
    emitter.emit("run.started", { engine: "claude-code" }),
    emitter.emit("message.delta", { messageId: msg, role: "assistant", delta: "好的，" }),
    emitter.emit("message.delta", { messageId: msg, role: "assistant", delta: "我來查。" }),
    emitter.emit("message.completed", { messageId: msg, role: "assistant", text: "好的，我來查。" }),
    emitter.emit("question.asked", { questionId: qst, prompt: "寄給誰？", choices: ["自己"] }),
    emitter.emit("question.answered", { questionId: qst, answer: "自己" }, { kind: "user", id: "u" }),
    emitter.emit("tool.requested", {
      callId: call,
      tool: "mail.send",
      args: { to: "me" },
      actionClass: "send",
    }),
    emitter.emit("approval.requested", {
      approvalId: apr,
      callId: call,
      actionClass: "send",
      summary: "寄出一封信",
    }),
    emitter.emit("approval.resolved", {
      approvalId: apr,
      decision: "approved",
      by: { kind: "user", id: "u" },
    }),
    emitter.emit("tool.completed", { callId: call, ok: true, result: { id: 1 }, durationMs: 42 }),
    emitter.emit("handoff.requested", {
      handoffId: newId("handoff"),
      to: "user",
      surface: "browser",
      reason: "CAPTCHA",
    }),
    emitter.emit("error", { code: "net.timeout", message: "slow", retryable: true }),
    emitter.emit("run.finished", { reason: "completed", usage: { inputTokens: 10, outputTokens: 5 } }),
  ];
  return { events, threadId, runId };
}
