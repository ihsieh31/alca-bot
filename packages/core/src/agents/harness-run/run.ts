import type { Engine } from "@alca/engines";
import type { AlcaEvent } from "@alca/protocol";
import type { TurnEnd, WorkerInboxItem, WorkerRecord } from "@alca/store";
import { defuseAlcaTags } from "@alca/tools";
import type { AlcaCore } from "../../agent.ts";
import type { PromptLanguage } from "../../conversation-rules.ts";
import { passCap } from "../../harness/kinds.ts";
import { HARNESS_NOTES } from "../../harness/profiles.ts";
import { nextRetry, noteProgress, sleepAbortable } from "../../harness/retry.ts";
import type { PromptProfile } from "../../prompt.ts";
import type { Emit, HostTool, TurnState } from "../../turn.ts";
import type { ConfineBox } from "../../workspace/sandbox.ts";
import { bookUsage } from "./budget.ts";
import { compactSession, dueForCompaction, duePreparedSummary, prepareSummary } from "./compact.ts";
import { type DecideState, decideNext, type EndWhy } from "./decide.ts";
import type { WorkerLedger } from "./ledger.ts";
import { MAX_REVIEW_FEEDBACK, runReview } from "./review.ts";
import type { RunTally } from "./tally.ts";
import { checkCommands, refusedChecks, runChecks } from "./verify.ts";

/**
 * Plan §2.2: the outer turn loop of one worker execution (HarnessRun). It
 * launches turns, and after each one asks `decideNext` what to do: end,
 * retry, compact, verify, remind, follow up with stream events, or give the
 * one report-only pass. The supervisor (`workers.ts`) only calls it and
 * settles what it returns. Plain workers (no harness) run through the same
 * loop; the harness-only rules simply do not apply to them.
 */

/** The live state of a running worker, shared with the supervisor's event handler. */
export interface Live {
  runId: string;
  stop: () => Promise<void>;
  emit?: Emit;
  /** Ends sleeps and checks between turns (a stop must not wait for a back-off or a build). */
  abort: AbortController;
  /** Outcome keys of the last tool calls (the watchdog's loop check). */
  recent: string[];
  calls: Map<string, string>;
  stopReason?: string;
  lastFlush: number;
  toolErrors: number;
  lastToolError: string | null;
  tally: RunTally;
  /** The dispatch fence of this execution (harness workers). */
  token?: string | undefined;
  sessionKey: string;
}

export interface RunHost {
  core: AlcaCore;
  ledger: WorkerLedger;
  now: () => Date;
  closing: () => boolean;
  engine: (w: WorkerRecord) => Engine;
  tools: (w: WorkerRecord, reportOnly: boolean) => readonly HostTool[];
  profile: (w: WorkerRecord) => PromptProfile;
  language: (w: WorkerRecord) => PromptLanguage;
  maxSteps: (w: WorkerRecord) => number;
  onEvent: (workerId: string, e: AlcaEvent) => void;
  taskMessage: (w: WorkerRecord, resumed: boolean) => string;
  followUp: (items: ReadonlyArray<WorkerInboxItem>) => string;
  /** The folder a coding worker's checks run in. */
  workDir: (w: WorkerRecord) => string | undefined;
  /** Next-round §5: the OS sandbox the checks and the reviewer's git run in (or a refusal). */
  confine?: (w: WorkerRecord) => ConfineBox;
  /** Plan §2.6 / §4: the worker's todo list, flushed into a compaction's handover ("" = none). */
  todos?: (w: WorkerRecord) => string;
  /** Keep a long text and return its handle (the full check output). */
  spill: (w: WorkerRecord, title: string, body: string) => string | undefined;
  /** Phase 5: before every turn (a git snapshot at 完全授權); a reason stops the run as failed. */
  beforeTurn?: (w: WorkerRecord) => string | undefined;
  /** Research audit C3: the bot's independent reviewer is on (`harness.reviewer`, default off). */
  reviewer?: (w: WorkerRecord) => boolean;
  /** Phase 6: the worker's panel state changed outside a tool call (a verification round). */
  changed?: (workerId: string) => void;
}

export interface RunResult {
  texts: string[];
  last: TurnState | undefined;
  error: string | undefined;
  why: EndWhy;
  /** Coding: a fresh, green check came after the last change (undefined = nothing to verify). */
  verified: boolean | undefined;
  /**
   * Phase 5: the worker's last words before the first "call report_result"
   * reminder — its own result when it never calls report_result (the reply
   * to the reminder is usually about the reminder).
   */
  beforeRemind?: string;
}

const endKind = (stopped: boolean, last: TurnState | undefined): TurnEnd => {
  if (stopped) return "turn.interrupted";
  const r = last?.finish?.reason;
  if (r === "completed") return "turn.completed";
  if (r === "interrupted" || r === "cancelled") return "turn.interrupted";
  return "turn.failed";
};

export async function runHarness(host: RunHost, first: WorkerRecord, live: Live): Promise<RunResult> {
  const { core } = host;
  const store = core.store;
  const tally = live.tally;
  const kind = first.grants.harness;
  const notes = HARNESS_NOTES[host.language(first)];
  const engine = host.engine(first);
  const owns = engine.capabilities.ownsToolLoop;
  const texts: string[] = [];
  let text = host.taskMessage(first, first.startedAt !== null);
  let reportOnly = false;
  let last: TurnState | undefined;
  let error: string | undefined;
  let inbox: WorkerInboxItem[] = [];
  let needTurn = true;
  const halted = () => host.closing() || !!live.stopReason;
  let beforeRemind: string | undefined;
  const result = (why: EndWhy): RunResult => ({
    texts,
    last,
    error,
    why,
    verified: kind === "coding" && tally.edited ? !tally.verifyStale : undefined,
    ...(beforeRemind ? { beforeRemind } : {}),
  });

  for (;;) {
    if (needTurn) {
      if (halted()) return result("stopped");
      const w = store.workers.get(first.id) as WorkerRecord;
      if (kind && !owns && dueForCompaction(tally, engine)) {
        const c = await compactSession(host, w, live, engine, text, texts);
        if (c.stalled) return { ...result("failed"), error: c.stalled };
        text = c.text;
      } else if (kind && !owns && duePreparedSummary(tally, engine)) {
        // Research audit A5: write the handover ahead, so the compaction does not have to.
        await prepareSummary(host, w, live, engine, texts.length);
      }
      if (halted()) return result("stopped");
      const blocked = host.beforeTurn?.(w);
      if (blocked) return { ...result("failed"), error: blocked };
      tally.turnStarted();
      error = undefined;
      const launched = core.launch({
        threadId: w.threadId,
        text,
        initiator: w.initiator,
        attended: false,
        role: "worker",
        engine,
        tools: host.tools(w, reportOnly),
        profile: host.profile(w),
        botId: w.botId,
        sessionKey: live.sessionKey,
        workerId: w.id,
        jobId: w.jobId,
        ...(w.parentRunId ? { parentRunId: w.parentRunId } : {}),
        publish: (e) => host.onEvent(w.id, e),
        ...(w.speculative ? { speculative: true } : {}),
        maxPasses: reportOnly ? 2 : passCap(host.maxSteps(w)),
        ...(kind
          ? {
              harnessExec: true,
              retry: tally.retry,
              ...(owns
                ? {}
                : {
                    passBoundary: () => {
                      if (tally.passCompactPending || !dueForCompaction(tally, engine)) return undefined;
                      tally.passCompactPending = true;
                      return notes.compactSoon;
                    },
                  }),
              onUsage: (u: { inputTokens: number; outputTokens: number; cachedInputTokens?: number }) => {
                tally.lastInputTokens = u.inputTokens;
                bookUsage(store, tally, live, w.id, u, host.now());
              },
            }
          : {}),
      });
      live.runId = launched.runId;
      live.stop = launched.stop;
      live.emit = launched.emit;
      store.workers.started(w.id, launched.runId, host.now());
      last = await launched.done.catch((err: unknown) => {
        error = String((err as Error)?.message ?? err);
        return undefined;
      });
      texts.push(...(last?.assistantTexts ?? []));
      // Plan §2.9 (B6): a stop that raced a completed turn is an interrupted turn, everywhere.
      host.ledger.turnEnded(w, live.token, launched.runId, endKind(!!live.stopReason, last));
      if (tally.okThisTurn > 0) noteProgress(tally.retry);
      tally.turnEnded();
      if (!last && !halted())
        last = {
          finish: { reason: "failed", error: { code: "worker.crashed", message: error ?? "" } },
        } as TurnState;
    }
    needTurn = true;
    inbox = halted() ? [] : store.workers.pendingWorkerInbox(first.id);
    const s: DecideState = {
      ...(kind ? { harness: kind } : {}),
      stopping: halted(),
      awaiting: tally.awaiting,
      ...(last?.finish ? { finish: last.finish } : {}),
      ownsToolLoop: owns,
      retry: tally.retry,
      overflowCompacted: tally.overflowCompacted,
      passCompactPending: tally.passCompactPending,
      budgetHit: tally.budgetHit,
      budgetPass: tally.budgetPass,
      tokensSpent: tokensSpent(store.workers.get(first.id)),
      ...(tally.report ? { report: tally.report.status } : {}),
      handedOff: !!tally.handoff,
      verifyStale: tally.verifyStale,
      verifyRounds: tally.verifyRounds,
      checksAvailable: kind === "coding" && checksFor(host, first).length > 0,
      inbox: inbox.length,
      reminders: tally.reminders,
      stalledTurns: tally.stalledTurns,
      reviewDue: reviewDue(host, first, tally),
      reviewUnmet: tally.reviewUnmet,
    };
    const d = decideNext(s);
    switch (d.kind) {
      case "end":
        return result(d.why);
      case "retry": {
        const e = last?.finish?.error;
        const delay = e ? nextRetry(tally.retry, { code: e.code, message: e.message }) : undefined;
        if (delay === undefined) return result("failed");
        try {
          await sleepAbortable(delay, live.abort.signal);
        } catch {
          return result("stopped");
        }
        break;
      }
      case "compact": {
        tally.overflowCompacted = true;
        const w = store.workers.get(first.id) as WorkerRecord;
        const c = await compactSession(host, w, live, engine, text, texts);
        if (c.stalled) return { ...result("failed"), error: c.stalled };
        text = c.text;
        break;
      }
      case "compactResume": {
        const w = store.workers.get(first.id) as WorkerRecord;
        const c = await compactSession(host, w, live, engine, notes.afterCompact, texts);
        if (c.stalled) return { ...result("failed"), error: c.stalled };
        text = c.text;
        break;
      }
      case "verify": {
        const w = store.workers.get(first.id) as WorkerRecord;
        const cwd = host.workDir(w);
        tally.verifyRounds++;
        host.ledger.verifying(w, live.token, tally.verifyRounds);
        host.changed?.(w.id);
        const box = host.confine?.(w) ?? {};
        const v = !cwd
          ? undefined
          : box.refuse
            ? refusedChecks(checksFor(host, w), box.refuse)
            : await runChecks(checksFor(host, w), cwd, live.abort.signal, box.spec);
        host.ledger.verified(w, live.token, tally.verifyRounds, v?.ok ?? false, v?.results ?? []);
        host.changed?.(w.id);
        if (halted()) return result("stopped");
        recordCheck(host, w, tally.verifyRounds, v?.ok ?? false);
        if (v?.ok) {
          tally.verified();
          tally.lastVerifyFeedback = undefined;
          needTurn = false; // decide again on the same turn: the report stands
          break;
        }
        const out = v ? v.feedback : notes.noChecks;
        const spilled = v ? host.spill(w, `檢查結果（第 ${tally.verifyRounds} 次）`, v.full) : undefined;
        tally.lastVerifyFeedback = out;
        if (tally.report) {
          tally.staleReport = tally.report;
          tally.report = undefined;
        }
        text = notes.verifyRed(
          `${defuseAlcaTags(out)}${spilled ? `\n（全文：${spilled}）` : ""}`,
          tally.verifyRounds,
        );
        break;
      }
      case "review": {
        const w = store.workers.get(first.id) as WorkerRecord;
        tally.reviewRuns++;
        tally.reviewedReport = tally.report;
        const v = await runReview(host, w, live, engine, tally.reviewRuns);
        if (halted()) return result("stopped");
        needTurn = false; // decide again on the same turn unless the gaps go back to the worker
        if (!v) break;
        tally.review = v;
        tally.reviewUnmet = false;
        if (v.met) break;
        if (tally.reviewFeedbacks >= MAX_REVIEW_FEEDBACK) {
          tally.reviewUnmet = true;
          break;
        }
        tally.reviewFeedbacks++;
        if (tally.report) {
          tally.staleReport = tally.report;
          tally.report = undefined;
        }
        text = notes.reviewGaps(
          v.gaps.map((g) => `- ${defuseAlcaTags(g)}`).join("\n"),
          tally.reviewFeedbacks,
        );
        needTurn = true;
        break;
      }
      case "remind":
        if (tally.reminders === 0) beforeRemind = texts.at(-1)?.trim() || undefined;
        tally.reminders++;
        text = notes.remind;
        break;
      case "followUp":
        store.workers.workerInboxDelivered(
          inbox.map((i) => i.id),
          host.now(),
        );
        text = host.followUp(inbox);
        break;
      case "budgetReport":
        tally.budgetPass = true;
        reportOnly = true;
        text = notes.budget;
        break;
    }
  }
}

/** N4: the worker's token budget is used up, so no model call (not even the report pass) is left. */
function tokensSpent(w: WorkerRecord | undefined): boolean {
  const max = w?.budget.maxTokens;
  return !!w && !!max && w.tokens >= max;
}

/** The current `done` report has not been read by the bot's reviewer yet. */
function reviewDue(host: RunHost, w: WorkerRecord, tally: RunTally): boolean {
  if (tally.report?.status !== "done" || tally.reviewedReport === tally.report) return false;
  try {
    return host.reviewer?.(w) === true;
  } catch {
    return false;
  }
}

function checksFor(host: RunHost, w: WorkerRecord): string[] {
  return checkCommands(w.grants.checks, host.workDir(w));
}

function recordCheck(host: RunHost, w: WorkerRecord, round: number, ok: boolean): void {
  try {
    host.core.jobs.record(w.jobId, "harness.verified", { round, ok });
  } catch {
    // the result still goes back to the worker
  }
}
