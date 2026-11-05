import { newId } from "@alca/protocol";
import { failedWorkerNote } from "../agents/honesty.ts";
import type { PhaseVerdict } from "../pipeline.ts";
import type { TurnContext, TurnState } from "../turn.ts";

/**
 * Phase 7: loop guard over this pass's host-run calls, then decide whether
 * another engine pass is needed (results to hand back) or the turn is done.
 */
export async function reflect(state: TurnState, ctx: TurnContext): Promise<PhaseVerdict<TurnState>> {
  const { deps } = ctx;
  for (const c of state.calls) {
    if (!c.result) continue;
    const v = ctx.guard.observe({ tool: c.tool, args: c.args, ok: c.result.ok, output: c.result.output });
    if (v.kind !== "ok" && v.fresh) {
      deps.emit("error", {
        code: `loop_guard.${v.kind}`,
        message: `偵測到可能的迴圈（${v.pattern}，重複 ${v.repeats} 次）`,
        retryable: v.kind === "warn",
      });
    }
    if (v.kind === "stop") {
      return {
        kind: "halt",
        reason: "loop_guard",
        state: {
          ...state,
          finish: { reason: "failed", error: { code: "loop_guard.stop", message: String(v.pattern) } },
        },
      };
    }
  }
  if (state.calls.length > 0 && !deps.engine.capabilities.ownsToolLoop) {
    if (state.pass >= deps.maxPasses) {
      return { kind: "halt", reason: "max_turns", state: { ...state, finish: { reason: "max_turns" } } };
    }
    const note = deps.passBoundary?.();
    const results =
      note && state.toolResults.length
        ? state.toolResults.map((r, i, all) =>
            i === all.length - 1 ? { ...r, output: `${r.output}\n\n${note}` } : r,
          )
        : state.toolResults;
    return { kind: "repeat", state: { ...state, calls: [], batches: [], toolResults: results } };
  }
  return { kind: "continue", state: { ...state, finish: state.finish ?? { reason: "completed" } } };
}

/** Phase 8: close the run with its reason and settle the turn job. */
export async function persist(state: TurnState, ctx: TurnContext): Promise<PhaseVerdict<TurnState>> {
  const { deps } = ctx;
  const finish = state.finish ?? { reason: "completed" as const };
  // C2: a router that calls a failed worker's task "done" gets a note under its reply.
  const note = ctx.role === "router" ? failedWorkerNote(state.userText, state.assistantTexts) : undefined;
  if (note) {
    const id = newId("message");
    deps.store.threads.addMessage(
      {
        id,
        threadId: ctx.threadId,
        runId: ctx.runId,
        role: "system",
        content: note,
      },
      deps.now(),
    );
    deps.emit(
      "message.completed",
      { messageId: id, role: "system", text: note },
      { kind: "system", id: "alca" },
    );
  }
  const u = state.usage;
  deps.emit("run.finished", {
    reason: finish.reason,
    ...(u.inputTokens || u.outputTokens
      ? {
          usage: {
            inputTokens: u.inputTokens,
            outputTokens: u.outputTokens,
            ...(u.cachedInputTokens ? { cachedInputTokens: u.cachedInputTokens } : {}),
          },
        }
      : {}),
  });
  deps.store.runs.finish(ctx.runId, finish.reason);
  const job = ctx.ownsJob ? deps.jobs.get(ctx.jobId) : undefined;
  if (job && (job.status === "running" || job.status === "waiting")) {
    if (job.status === "waiting") deps.jobs.resume(ctx.jobId);
    if (finish.reason === "completed") deps.jobs.complete(ctx.jobId, { texts: state.assistantTexts.length });
    else if (finish.reason === "interrupted" || finish.reason === "cancelled")
      deps.jobs.cancel(ctx.jobId, finish.reason);
    else deps.jobs.fail(ctx.jobId, finish.error?.code ?? finish.reason);
  }
  deps.store.threads.touch(ctx.threadId, deps.now());
  return {
    kind: "halt",
    reason: finish.reason === "completed" ? "completed" : "failed",
    state: { ...state, finish },
  };
}
