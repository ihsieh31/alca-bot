import type { Store } from "@alca/store";
import { budgetUsage, tokenBudgetDue, type UsageReading } from "../../harness/usage.ts";
import type { RunTally } from "./tally.ts";

/**
 * Mac test B3: booking a harness worker's usage and ending its turn before
 * the token budget is crossed. Like the step budget (plan §2.3), the turn
 * ends and the worker gets its one report-only pass; the watchdog only stops
 * a worker that overruns that too.
 */

interface Stoppable {
  stop: () => Promise<void>;
  tally: RunTally;
}

/** End the turn for the budget (once). */
function budgetStop(live: Stoppable): void {
  const t = live.tally;
  if (t.budgetHit || t.budgetPass) return;
  t.budgetHit = true;
  void live.stop();
}

/** Book one usage reading: counted tokens and cache reads apart; stop when the budget is reached. */
export function bookUsage(
  store: Store,
  tally: RunTally,
  live: Stoppable,
  workerId: string,
  u: UsageReading,
  now: Date,
): void {
  const b = budgetUsage(u);
  store.workers.activity(workerId, now, { tokens: b.counted, cachedTokens: b.cached });
  const w = store.workers.get(workerId);
  tally.usageReadings++;
  tally.stepsAtUsage = w?.steps ?? tally.stepsAtUsage;
  const max = w?.budget.maxTokens;
  if (w && max && w.tokens >= max) budgetStop(live);
}

/** After a step: end the turn when the next model call would cross the budget. */
export function checkTokenBudget(
  w: { tokens: number; steps: number; budget: { maxTokens?: number | undefined } },
  live: Stoppable,
): void {
  const max = w.budget.maxTokens;
  if (!max) return;
  const t = live.tally;
  if (
    tokenBudgetDue({
      tokens: w.tokens,
      maxTokens: max,
      steps: w.steps,
      stepsAtUsage: t.stepsAtUsage,
      readings: t.usageReadings,
    })
  )
    budgetStop(live);
}
