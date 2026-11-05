import type { EngineEvent } from "@alca/engines";
import { nextRetry, type RetryBudget, sleepAbortable } from "../harness/retry.ts";

/**
 * Plan §2.6: a model call of an API engine that failed before it streamed
 * anything (no text, no tool call) is tried again inside `infer`: up to 4
 * retries, 2 s doubling, at most 30 s a gap with ±20 % jitter, a
 * retry-after as the floor, at most 2 timeouts. The back-off is an abortable
 * sleep. Once something was streamed the error stands (the pass is not
 * replayable). Without a budget the engine's stream passes through as is.
 */

const COMMITTING = new Set<EngineEvent["type"]>(["text.delta", "tool.call", "tool.result"]);

export async function* retryingTurn(
  start: () => AsyncIterable<EngineEvent>,
  budget: RetryBudget | undefined,
  signal: AbortSignal,
  onRetry?: (info: { code: string; message: string; delayMs: number; attempt: number }) => void,
): AsyncIterable<EngineEvent> {
  if (!budget) {
    yield* start();
    return;
  }
  for (;;) {
    let committed = false;
    let failed: (EngineEvent & { type: "error" }) | undefined;
    for await (const e of start()) {
      if (committed) {
        yield e;
        continue;
      }
      if (failed) continue; // the rest of a failed try (its `done`) is dropped
      if (e.type === "error") {
        failed = e;
        continue;
      }
      if (COMMITTING.has(e.type)) committed = true;
      yield e;
    }
    if (!failed) return;
    const delayMs = signal.aborted
      ? undefined
      : nextRetry(budget, { code: failed.code, message: failed.message });
    if (delayMs === undefined) {
      yield failed;
      yield { type: "done", stop: "error" };
      return;
    }
    onRetry?.({ code: failed.code, message: failed.message, delayMs, attempt: budget.retries });
    try {
      await sleepAbortable(delayMs, signal);
    } catch {
      yield { type: "done", stop: "interrupted" };
      return;
    }
  }
}
