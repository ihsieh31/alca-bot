import { persist, reflect } from "./phases/finish.ts";
import { infer } from "./phases/infer.ts";
import { prepare, recall } from "./phases/prepare.ts";
import { execute, gate, planTools } from "./phases/tools.ts";
import { isForwardJump, nextPhase, type TurnPhase, type TurnPipeline } from "./pipeline.ts";
import { abortedFinish } from "./run-limits.ts";
import type { TurnContext, TurnState } from "./turn.ts";

export const DEFAULT_PIPELINE: TurnPipeline<TurnState, TurnContext> = Object.freeze({
  prepare,
  recall,
  infer,
  plan_tools: planTools,
  gate,
  execute,
  reflect,
  persist,
});

export interface PhaseTrace {
  phase: TurnPhase;
  verdict: string;
}

export class PipelineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PipelineError";
  }
}

/**
 * Sequence the phases. The runner owns control flow; phases only return
 * verdicts. `persist` always runs last, whatever stopped the turn (a halt,
 * an interrupt, or a thrown error), so a run is never left open.
 */
export async function runPipeline(
  initial: TurnState,
  ctx: TurnContext,
  pipeline: TurnPipeline<TurnState, TurnContext> = DEFAULT_PIPELINE,
  trace?: PhaseTrace[],
): Promise<TurnState> {
  let state = initial;
  let phase: TurnPhase = "prepare";
  for (let steps = 0; steps < 10_000; steps++) {
    if (ctx.signal.aborted && phase !== "persist") {
      state = { ...state, finish: state.finish ?? abortedFinish(ctx.signal) };
      phase = "persist";
    }
    let verdict: Awaited<ReturnType<(typeof pipeline)[TurnPhase]>>;
    try {
      verdict = await pipeline[phase](state, ctx);
    } catch (err) {
      if (phase === "persist") throw err;
      const aborted = ctx.signal.aborted;
      if (!aborted) {
        ctx.deps.emit("error", {
          code: `phase.${phase}`,
          message: String((err as Error)?.message ?? err),
          retryable: false,
        });
      }
      state = {
        ...state,
        finish:
          state.finish ??
          (aborted
            ? abortedFinish(ctx.signal)
            : { reason: "failed", error: { code: `phase.${phase}`, message: String(err) } }),
      };
      phase = "persist";
      continue;
    }
    trace?.push({ phase, verdict: verdict.kind === "jump" ? `jump:${verdict.to}` : verdict.kind });
    state = verdict.state;
    switch (verdict.kind) {
      case "continue": {
        const n = nextPhase(phase);
        if (!n) return state;
        phase = n;
        break;
      }
      case "jump":
        if (!isForwardJump(phase, verdict.to))
          throw new PipelineError(`backward jump ${phase} → ${verdict.to}`);
        phase = verdict.to;
        break;
      case "await":
        try {
          ctx.deps.store.runs.setStatus(ctx.runId, "waiting");
          ctx.deps.jobs.wait(ctx.jobId, verdict.reason);
          await Promise.all(verdict.waitFor.map((id) => ctx.deps.human.wait(id, ctx.signal)));
        } catch {
          // interrupted while waiting; the top of the loop routes to persist
        } finally {
          ctx.deps.store.runs.setStatus(ctx.runId, "running");
          const j = ctx.deps.jobs.get(ctx.jobId);
          if (j?.status === "waiting") ctx.deps.jobs.resume(ctx.jobId);
        }
        break; // same phase again
      case "repeat":
        if (phase !== "reflect") throw new PipelineError(`repeat from ${phase}`);
        phase = "infer";
        break;
      case "halt":
        if (phase === "persist") return state;
        phase = "persist";
        break;
    }
  }
  throw new PipelineError("pipeline did not terminate");
}
