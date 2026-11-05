import type { FinishReasonT } from "@alca/protocol";
import type { ReportStatus } from "../../harness/contract.ts";
import type { HarnessKind } from "../../harness/kinds.ts";
import { classifyError, mayRetry, type RetryBudget } from "../../harness/retry.ts";

/**
 * Plan §2.2: what the outer loop does after a worker's turn, as one pure
 * function. Each rule is its own function; `decideNext` takes the first that
 * answers, in the plan's order:
 *
 * 1. stop asked or shutting down → end
 * 2. waiting for an event (await_event) → end this turn, wait for the wake
 * 3. context overflow → compact once
 * 4. a retryable error → retry
 * 5. budget spent and no report → one report-only pass (none when no tokens are left)
 * 5a. three turns in a row with no successful tool call and no change → end (partial)
 * 5b. the context filled up between passes and no report yet → compact, go on
 * 6. coding changed files and the check is missing, red or stale → verify
 * 6b. the bot's reviewer is on and a `done` report passed the host's check → review
 * 7. stream events waiting → follow up
 * 8. no report and fewer than two reminders → remind
 * 9. end
 */

export const MAX_REMINDERS = 2;
export const MAX_VERIFY_ROUNDS = 3;
/** Research audit A4: turns in a row without a successful call or a change that end the task. */
export const MAX_STALLED_TURNS = 3;

export interface DecideState {
  /** Absent for a plain (non-harness) worker: only rules 1, 2, 4, 7 and 9 apply. */
  harness?: HarnessKind;
  /** A stop was asked (person, router, watchdog) or Alca is shutting down. */
  stopping: boolean;
  /** The turn opened an event wait. */
  awaiting: boolean;
  finish?: { reason: FinishReasonT; error?: { code: string; message: string } };
  /** The engine runs its own tool loop (a CLI): model-call retries are not done inside `infer`. */
  ownsToolLoop: boolean;
  retry: RetryBudget;
  /** An overflow already got its one compaction in this session. */
  overflowCompacted: boolean;
  /** Research audit A5: the context filled up between passes of the last turn. */
  passCompactPending?: boolean;
  /** The step budget ran out during the turn (or the pass cap hit). */
  budgetHit: boolean;
  /** The one report-only pass was already given. */
  budgetPass: boolean;
  /**
   * Mac device test 2026-11-05 N4: the token budget is used up (booked
   * tokens reached `maxTokens`). The report-only pass is a model call too, so
   * it is skipped and the worker ends on its budget.
   */
  tokensSpent?: boolean;
  report?: ReportStatus;
  handedOff: boolean;
  /** Files changed after the last passing check (or with none yet). */
  verifyStale: boolean;
  /** Verification rounds already run in this task. */
  verifyRounds: number;
  /** There is a check command to run (dispatch checks, AGENTS.md, project files). */
  checksAvailable: boolean;
  inbox: number;
  reminders: number;
  /** Research audit A4: turns in a row that tried tools without one succeeding or a change. */
  stalledTurns?: number;
  /** Research audit C3: the bot's reviewer is on and the current report has not been reviewed yet. */
  reviewDue?: boolean;
  /** The reviewer still found gaps after the last feedback round: the report ends unverified. */
  reviewUnmet?: boolean;
}

export type EndWhy =
  | "stopped"
  | "awaiting"
  | "budget"
  | "failed"
  | "interrupted"
  | "done"
  | "handoff"
  | "unverified"
  | "stalled";

export type Decision =
  | { kind: "end"; why: EndWhy }
  | { kind: "retry" }
  | { kind: "compact" }
  | { kind: "compactResume" }
  | { kind: "verify" }
  | { kind: "review" }
  | { kind: "remind" }
  | { kind: "followUp" }
  | { kind: "budgetReport" };

type Rule = (s: DecideState) => Decision | undefined;

const completed = (s: DecideState) => s.finish?.reason === "completed";
const failedWith = (s: DecideState) => (s.finish?.reason === "failed" ? s.finish.error : undefined);

export const ruleStop: Rule = (s) => (s.stopping ? { kind: "end", why: "stopped" } : undefined);

export const ruleAwait: Rule = (s) => (s.awaiting ? { kind: "end", why: "awaiting" } : undefined);

export const ruleOverflow: Rule = (s) => {
  const e = failedWith(s);
  if (!s.harness || !e || s.overflowCompacted || s.ownsToolLoop) return undefined;
  return classifyError({ code: e.code, message: e.message }) === "overflow" ? { kind: "compact" } : undefined;
};

/**
 * A CLI turn that failed on a retryable error is tried again at this level
 * (API engines already retried inside `infer`, so their failure stands).
 */
export const ruleRetry: Rule = (s) => {
  const e = failedWith(s);
  if (!e || !s.ownsToolLoop) return undefined;
  return mayRetry(classifyError({ code: e.code, message: e.message }), s.retry.retries, s.retry.timeouts)
    ? { kind: "retry" }
    : undefined;
};

export const ruleBudget: Rule = (s) => {
  if (!(s.budgetHit || s.finish?.reason === "max_turns")) return undefined;
  if (s.harness && s.report === undefined && !s.handedOff && !s.budgetPass && !s.tokensSpent)
    return { kind: "budgetReport" };
  if (s.report === undefined && !s.handedOff) return { kind: "end", why: "budget" };
  // A report came in the last pass: no more turns, the report stands (verified or not).
  return ruleEnd({ ...s, finish: { reason: "completed" } });
};

/** Research audit A4: a worker that keeps trying and getting nowhere is stopped with a partial report. */
export const ruleStall: Rule = (s) => {
  if (!s.harness || (s.stalledTurns ?? 0) < MAX_STALLED_TURNS) return undefined;
  if (s.report !== undefined || s.handedOff) return undefined;
  return { kind: "end", why: "stalled" };
};

/**
 * Research audit A5: the turn was asked to wind up because the context
 * filled between passes. Without a report it is compacted and goes on (a
 * report ends it as usual).
 */
export const rulePassCompact: Rule = (s) => {
  if (!s.harness || !s.passCompactPending || s.ownsToolLoop || !completed(s)) return undefined;
  if (s.report !== undefined || s.handedOff) return undefined;
  return { kind: "compactResume" };
};

export const ruleVerify: Rule = (s) => {
  if (s.harness !== "coding" || !completed(s) || s.handedOff || !s.verifyStale) return undefined;
  if (s.report === "needs_input" || s.report === "blocked") return undefined;
  if (!s.checksAvailable || s.verifyRounds >= MAX_VERIFY_ROUNDS) return undefined;
  return { kind: "verify" };
};

/**
 * Research audit C3: a `done` report is read by the independent reviewer
 * once the host's own check passed (a coding change with a stale check is
 * verified first; without checks it ends unverified and is not reviewed).
 */
export const ruleReview: Rule = (s) => {
  if (!s.harness || !s.reviewDue || !completed(s) || s.handedOff || s.report !== "done") return undefined;
  if (s.harness === "coding" && s.verifyStale) return undefined;
  return { kind: "review" };
};

export const ruleFollowUp: Rule = (s) => (completed(s) && s.inbox > 0 ? { kind: "followUp" } : undefined);

export const ruleRemind: Rule = (s) => {
  if (!s.harness || !completed(s) || s.report !== undefined || s.handedOff) return undefined;
  return s.reminders < MAX_REMINDERS ? { kind: "remind" } : undefined;
};

export function ruleEnd(s: DecideState): Decision {
  if (s.handedOff) return { kind: "end", why: "handoff" };
  if (s.finish?.reason === "interrupted" || s.finish?.reason === "cancelled")
    return { kind: "end", why: "interrupted" };
  if (s.report !== undefined)
    return {
      kind: "end",
      why: (s.harness === "coding" && s.verifyStale) || s.reviewUnmet ? "unverified" : "done",
    };
  if (!completed(s) && s.finish?.reason !== "max_turns") return { kind: "end", why: "failed" };
  return { kind: "end", why: "done" };
}

export const RULES: readonly Rule[] = [
  ruleStop,
  ruleAwait,
  ruleOverflow,
  ruleRetry,
  ruleBudget,
  ruleStall,
  rulePassCompact,
  ruleVerify,
  ruleReview,
  ruleFollowUp,
  ruleRemind,
  ruleEnd,
];

export function decideNext(s: DecideState): Decision {
  for (const rule of RULES) {
    const d = rule(s);
    if (d) return d;
  }
  return { kind: "end", why: "done" };
}
