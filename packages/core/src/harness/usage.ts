/**
 * Mac test B3: what a worker's token budget counts.
 *
 * Every engine reports `inputTokens` as the whole prompt it read — new input,
 * prompt-cache writes and prompt-cache reads — with `cachedInputTokens` the
 * cache-read part of it (Claude stream-json, the Anthropic, OpenAI, Gemini
 * and Responses APIs and Codex are mapped to that one shape). A CLI such as
 * Claude Code re-reads its ~20k-token system prompt from the cache on every
 * call, so counting cache reads in full spent a 400k budget in 5–8 steps.
 *
 * The budget counts new tokens (input + cache writes + output) and cache
 * reads at a tenth. A tenth, not zero: that is what providers bill a cache
 * read at, so the budget still follows cost, and a worker that keeps
 * re-reading a huge context still reaches its cap. The cache reads are kept
 * whole beside it (`workers.cached_tokens`) and shown in the panel.
 */

export const CACHE_READ_WEIGHT = 0.1;

export interface UsageReading {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number | undefined;
}

export interface BudgetUsage {
  /** What counts against the budget. */
  counted: number;
  /** New tokens: input not read from the cache, cache writes, output. */
  fresh: number;
  /** Cache reads (booked apart). */
  cached: number;
}

const whole = (n: unknown): number =>
  typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.round(n) : 0;

export function budgetUsage(u: UsageReading): BudgetUsage {
  const input = whole(u.inputTokens);
  const cached = Math.min(whole(u.cachedInputTokens), input);
  const fresh = input - cached + whole(u.outputTokens);
  return { counted: fresh + Math.ceil(cached * CACHE_READ_WEIGHT), fresh, cached };
}

/**
 * Stop before the budget is crossed, not after (mac test B3: workers stopped
 * 18–19 % over). From what was booked so far, the cost of one model call is
 * estimated. Room is kept for two more calls — the next one (a stop lands
 * between passes, so one more may run) and the report-only pass that
 * follows a budget stop — plus the steps whose usage has not arrived yet (a
 * CLI books a whole turn at its end; the step right after a reading is
 * already in it). True when that would cross `maxTokens`.
 */
export function tokenBudgetDue(o: {
  tokens: number;
  maxTokens: number;
  /** Steps done now, and when usage was last booked. */
  steps: number;
  stepsAtUsage: number;
  /** Usage readings booked so far. */
  readings: number;
}): boolean {
  if (o.tokens >= o.maxTokens) return true;
  if (o.readings <= 0) return false;
  const perCall = o.tokens / Math.max(o.readings, o.stepsAtUsage + 1);
  const unbooked = Math.max(0, o.steps - o.stepsAtUsage - 1);
  return o.tokens + perCall * (unbooked + 2) > o.maxTokens;
}
