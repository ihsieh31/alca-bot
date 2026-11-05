import {
  changesFiles,
  emptyActions,
  type HarnessActions,
  isOutwardCall,
  noteAction,
} from "../../harness/actions.ts";
import { CONTRACT_TOOL_NAMES, type WorkerReport } from "../../harness/contract.ts";
import type { HandoffRecord } from "../../harness/dispatch.ts";
import type { AwaitRequest } from "../../harness/general/waits.ts";
import type { HarnessKind } from "../../harness/kinds.ts";
import { freshRetryBudget, type RetryBudget } from "../../harness/retry.ts";
import { verifyStale } from "./verify.ts";

/**
 * The bookkeeping of one worker execution, fed with its tool events (plan
 * §2.4: the old tracker's counting, without its stop rules — those live in
 * LoopGuard and the watchdog now). It keeps the action ledger, the report
 * or handover the worker gave, the edit / check ordering for the
 * verification, and what the outer loop's rules need.
 */

/** What one finished call meant (for the ledger's progress and outward rows). */
export interface CompletedCall {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  outward: boolean;
  edited: boolean;
}

const CONTRACT = new Set<string>(CONTRACT_TOOL_NAMES);

export class RunTally {
  readonly kind: HarnessKind | undefined;
  readonly actions: HarnessActions = emptyActions();
  readonly retry: RetryBudget = freshRetryBudget();
  report: WorkerReport | undefined;
  /** A report the check turned red (kept for the final record when no new one comes). */
  staleReport: WorkerReport | undefined;
  handoff: HandoffRecord | undefined;
  awaiting = false;
  /** What the worker waits for (await_event), when `awaiting`. */
  awaitRequest: AwaitRequest | undefined;
  reminders = 0;
  budgetHit = false;
  budgetPass = false;
  overflowCompacted = false;
  compactions = 0;
  ineffectiveCompactions = 0;
  /** Research audit A5: the context filled up between passes; compact once the turn ends. */
  passCompactPending = false;
  /** A handover summary written ahead at ~70 % of the ceiling, used by the next compaction. */
  prepared: { summary: string; textsAt: number; tokens: number } | undefined;
  verifyRounds = 0;
  /** Research audit C3: the report the reviewer last read (a new report is reviewed again). */
  reviewedReport: WorkerReport | undefined;
  /** Reviews run, and gap lists fed back to the worker. */
  reviewRuns = 0;
  reviewFeedbacks = 0;
  /** The reviewer's last verdict (gaps left when it ends unmet). */
  review: { met: boolean; gaps: string[] } | undefined;
  reviewUnmet = false;
  /** The last red check's output, for the unverified report. */
  lastVerifyFeedback: string | undefined;
  /** Ordering of edits and passing checks (a counter, never the clock). */
  private seq = 0;
  private lastEditSeq = 0;
  private lastPassSeq: number | undefined;
  /** Successful tool calls in the current turn (progress gives the retry allowance back). */
  okThisTurn = 0;
  callsThisTurn = 0;
  /** Research audit A4: successful non-contract calls and file changes in the current turn. */
  progressThisTurn = 0;
  editedThisTurn = false;
  /** Turns in a row that tried tools, got none to succeed and changed no file. */
  stalledTurns = 0;
  /** The last input-token reading (context size of the session). */
  lastInputTokens = 0;
  /** Mac test B3: usage readings booked, and the step count at the last one (tokenBudgetDue). */
  usageReadings = 0;
  stepsAtUsage = 0;
  private readonly calls = new Map<
    string,
    { tool: string; args: Record<string, unknown>; actionClass?: string }
  >();

  constructor(kind: HarnessKind | undefined) {
    this.kind = kind;
  }

  requested(callId: string, tool: string, args: Record<string, unknown>, actionClass?: string): void {
    this.calls.set(callId, { tool, args, ...(actionClass ? { actionClass } : {}) });
    this.callsThisTurn++;
  }

  completed(callId: string, ok: boolean, output: string): CompletedCall | undefined {
    const c = this.calls.get(callId);
    this.calls.delete(callId);
    if (!c) return undefined;
    this.seq++;
    if (ok) this.okThisTurn++;
    if (CONTRACT.has(c.tool)) return { tool: c.tool, args: c.args, ok, outward: false, edited: false };
    if (ok) this.progressThisTurn++;
    noteAction(this.actions, {
      tool: c.tool,
      args: c.args,
      ok,
      output,
      ...(c.actionClass ? { actionClass: c.actionClass } : {}),
    });
    const edited = changesFiles(c.tool, c.args, ok);
    if (edited) {
      this.lastEditSeq = this.seq;
      this.editedThisTurn = true;
    }
    const outward = isOutwardCall({
      tool: c.tool,
      args: c.args,
      ok,
      ...(c.actionClass ? { actionClass: c.actionClass } : {}),
    });
    return { tool: c.tool, args: c.args, ok, outward, edited };
  }

  /** A turn starts: per-turn counters go back to zero. */
  turnStarted(): void {
    this.okThisTurn = 0;
    this.callsThisTurn = 0;
    this.progressThisTurn = 0;
    this.editedThisTurn = false;
  }

  /**
   * Research audit A4: count a turn that tried tools, had none succeed and
   * changed no file. Progress (a successful call, a change) or a report /
   * handover resets the count; a turn with no tool call at all (an answer in
   * text, governed by the reminders) neither counts nor resets.
   */
  turnEnded(): void {
    if (this.report || this.handoff || this.progressThisTurn > 0 || this.editedThisTurn)
      this.stalledTurns = 0;
    else if (this.callsThisTurn > 0) this.stalledTurns++;
  }

  /** The host's check passed now: it covers every change before it. */
  verified(): void {
    this.seq++;
    this.lastPassSeq = this.seq;
  }

  get edited(): boolean {
    return this.lastEditSeq > 0;
  }

  get verifyStale(): boolean {
    return verifyStale(this.lastEditSeq, this.lastPassSeq);
  }
}
