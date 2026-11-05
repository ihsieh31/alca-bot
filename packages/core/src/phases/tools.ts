import { isAlwaysConfirm } from "@alca/config";
import { type ActionClass, isActionClass, PolicyDeniedError } from "@alca/policy";
import { canRunInParallel } from "@alca/tools";
import type { PhaseVerdict } from "../pipeline.ts";
import { abortedFinish } from "../run-limits.ts";
import { ASK_USER_TOOL, type PlannedCall, type TurnContext, type TurnState } from "../turn.ts";
import {
  askQuestion,
  authorizeGuarded,
  beforeRun,
  emitApprovalRequested,
  noteOutbound,
  questionFromToolInput,
  settleApproval,
  WORKER_CANNOT_ASK,
} from "./human.ts";
import { executeHarness } from "./tools-harness.ts";

/**
 * Group calls into batches that may run in parallel: a call joins the current
 * batch only if its path claims do not conflict with any call already in it.
 * Order is preserved, so a write never overtakes an earlier read of the same path.
 */
export function batchCalls(calls: readonly PlannedCall[]): string[][] {
  const batches: PlannedCall[][] = [];
  for (const c of calls) {
    const last = batches.at(-1);
    if (last?.every((o) => canRunInParallel(o.claims, c.claims))) last.push(c);
    else batches.push([c]);
  }
  return batches.map((b) => b.map((c) => c.callId));
}

/**
 * Ask a tool with `inspect` about live state. The result can only escalate
 * the declared class (to an always-confirm class, or a declared read to a
 * class that changes something); a failing inspection keeps
 * the declared class and the gateway decides as usual.
 */
async function inspectCall(c: PlannedCall, ctx: TurnContext): Promise<void> {
  const tool = ctx.deps.tools.get(c.tool);
  if (!tool?.inspect) return;
  try {
    const r = await tool.inspect(c.args, {
      signal: ctx.signal,
      threadId: ctx.threadId,
      botId: ctx.botId,
      ...(ctx.workerId ? { workerId: ctx.workerId } : {}),
    });
    const found: ActionClass | undefined = isActionClass(r.actionClass) ? r.actionClass : undefined;
    if (
      found &&
      found !== c.actionClass &&
      (isAlwaysConfirm(found) || (c.actionClass === "read" && found !== "read"))
    )
      c.actionClass = found;
    if (r.summary) c.summary = r.summary.slice(0, 500);
    if (r.target) c.target = r.target;
  } catch {
    // keep the declared class
  }
}

/** Phase 4: announce the requested calls and plan parallel batches. */
export async function planTools(state: TurnState, ctx: TurnContext): Promise<PhaseVerdict<TurnState>> {
  const calls = state.calls.map((c) => ({ ...c }));
  for (const c of calls) if (c.status === "planned") await inspectCall(c, ctx);
  for (const c of calls) {
    ctx.deps.emit("tool.requested", {
      callId: c.callId,
      tool: c.tool,
      args: c.args,
      actionClass: c.actionClass,
    });
    ctx.deps.jobs.record(ctx.jobId, "tool.requested", { callId: c.callId, tool: c.tool });
  }
  return { kind: "continue", state: { ...state, calls, batches: batchCalls(calls) } };
}

/**
 * Phase 5: the gateway decides each call (deny > ask > allow; always-confirm
 * classes forced to ask) and writes the audit row first. Calls that need a
 * person turn into approval / question cards and the phase answers `await`;
 * the runner re-enters it once a card is answered.
 */
export async function gate(state: TurnState, ctx: TurnContext): Promise<PhaseVerdict<TurnState>> {
  const calls = state.calls.map((c) => ({ ...c }));
  const waitFor: string[] = [];
  let reason: "approval" | "question" = "approval";

  for (const c of calls) {
    if (c.status === "planned") {
      if (c.tool === ASK_USER_TOOL && ctx.role === "worker") {
        c.status = "done";
        c.result = { ok: false, output: WORKER_CANNOT_ASK };
      } else if (c.tool === ASK_USER_TOOL) {
        const q = questionFromToolInput(c.args);
        c.questionId = askQuestion(ctx, q.prompt, q.choices);
        c.status = "asking";
      } else if (!ctx.deps.tools.has(c.tool)) {
        c.status = "denied";
        c.denyReason = `沒有這個工具：${c.tool}`;
      } else {
        const auth = await authorizeGuarded(ctx, c);
        c.auth = auth;
        c.actionClass = auth.request.actionClass;
        if (auth.decision.effect === "allow") c.status = "allowed";
        else if (auth.decision.effect === "deny") {
          c.status = "denied";
          c.denyReason = `主機政策拒絕：${auth.decision.reason}`;
        } else if (auth.approvalId) {
          c.approvalId = auth.approvalId;
          c.status = "awaiting";
          emitApprovalRequested(ctx, auth, c.callId);
        }
      }
    }
    if (c.status === "awaiting" && c.approvalId) {
      const outcome = settleApproval(ctx, c.approvalId);
      if (outcome === "approved") c.status = "allowed";
      else if (outcome) {
        c.status = "denied";
        c.denyReason = outcome === "expired" ? "批准已過期" : "使用者拒絕了這個動作";
      } else waitFor.push(c.approvalId);
    }
    if (c.status === "asking" && c.questionId) {
      const q = ctx.deps.store.human.question(c.questionId);
      if (q && q.status !== "pending") {
        const answer = q.answer ?? "";
        ctx.deps.emit("question.answered", { questionId: c.questionId, answer });
        c.status = "done";
        c.result = { ok: q.status === "answered", output: q.status === "answered" ? answer : "問題已過期" };
      } else {
        waitFor.push(c.questionId);
        reason = "question";
      }
    }
  }
  const next = { ...state, calls };
  if (waitFor.length > 0) return { kind: "await", reason, waitFor, state: next };
  return { kind: "continue", state: next };
}

/** Phase 6: run the allowed calls batch by batch, every one through the gateway. */
export async function execute(state: TurnState, ctx: TurnContext): Promise<PhaseVerdict<TurnState>> {
  const { deps } = ctx;
  const byId = new Map(state.calls.map((c) => [c.callId, { ...c }]));

  const runOne = async (c: PlannedCall): Promise<void> => {
    const started = Date.now();
    if (c.status === "allowed" && c.auth) {
      const tool = deps.tools.get(c.tool);
      try {
        noteOutbound(ctx, c.actionClass, { callId: c.callId, tool: c.tool });
        if (deps.gateway.isAuthorized(c.auth)) beforeRun(ctx, c, c.actionClass);
        const output = await deps.gateway.execute(c.auth, () =>
          tool
            ? tool.run(c.args, ctx.signal, {
                actionClass: c.actionClass,
                threadId: ctx.threadId,
                runId: ctx.runId,
                botId: ctx.botId,
                ...(ctx.workerId ? { workerId: ctx.workerId } : {}),
              })
            : Promise.reject(new Error("missing tool")),
        );
        c.result = { ok: true, output };
      } catch (err) {
        const msg =
          err instanceof PolicyDeniedError
            ? `未授權：${err.decision.reason}`
            : String((err as Error).message ?? err);
        c.result = { ok: false, output: msg };
      }
    } else if (c.status !== "done") {
      c.result = { ok: false, output: c.denyReason ?? "沒有執行" };
    }
    // The harness executor already gave this call an "aborted" result (history stays as sent).
    if ((c as { placed?: boolean }).placed) return;
    c.status = "done";
    const r = c.result ?? { ok: false, output: "沒有結果" };
    deps.emit("tool.completed", {
      callId: c.callId,
      ok: r.ok,
      ...(r.ok ? { result: r.output } : { error: r.output }),
      durationMs: Math.max(0, Date.now() - started),
    });
    deps.jobs.record(ctx.jobId, "tool.completed", { callId: c.callId, ok: r.ok });
  };

  if (deps.harnessExec) await executeHarness(state, ctx, byId, runOne);
  else
    for (const batch of state.batches) {
      if (ctx.signal.aborted) break;
      await Promise.all(
        batch
          .map((id) => byId.get(id))
          .filter((c): c is PlannedCall => !!c)
          .map(runOne),
      );
    }
  const calls = state.calls.map((c) => byId.get(c.callId) ?? c);
  const toolResults = calls
    .filter((c) => c.result)
    .map((c) => ({ id: c.engineCallId, ok: c.result!.ok, output: c.result!.output }));
  const next = { ...state, calls, toolResults };
  if (ctx.signal.aborted)
    return { kind: "halt", reason: "interrupted", state: { ...next, finish: abortedFinish(ctx.signal) } };
  return { kind: "continue", state: next };
}
