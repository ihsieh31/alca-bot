import { randomUUID } from "node:crypto";
import type { DispatchOutcome, Store, TurnEnd, WorkerRecord } from "@alca/store";
import type { HarnessActions } from "../../harness/actions.ts";
import type { NeedsInputQuestion, WorkerReport } from "../../harness/contract.ts";
import type { AwaitRequest } from "../../harness/general/waits.ts";
import { expiresAt } from "../../harness/needs-input.ts";

/**
 * Plan §2.9: the supervisor's side of the dispatch ledger. Every harness
 * worker serves a dispatch row; a continuation worker (an answer, a wake, a
 * restart) serves the same one. The execution token (`<worker>:<n>`) is the
 * writer fence: a superseded execution can neither report nor settle.
 */

/** What the ledger keeps as a dispatch's report (and the router reads back). */
export interface HarnessResult {
  workerId: string;
  report: WorkerReport;
  actions: HarnessActions;
  /** A coding task's verification: fresh green check after the last change. */
  verified?: boolean;
  checkFeedback?: string;
  /** Research audit C3: the independent reviewer's last verdict (when the bot's reviewer is on). */
  review?: { met: boolean; gaps: string[] };
  handoff?: { to: string; reason: string; context?: string };
}

export const PROGRESS_EVERY_MS = 1000;

/** How much of a check's output the panel keeps (its end, where the error usually is). */
export const CHECK_SUMMARY_CHARS = 400;

const tail = (s: string, n: number): string => {
  const t = s.trim();
  return t.length > n ? `…${t.slice(-n)}` : t;
};

export class WorkerLedger {
  private readonly store: Store;
  private readonly now: () => Date;
  private readonly lastProgress = new Map<string, number>();

  constructor(store: Store, now: () => Date) {
    this.store = store;
    this.now = now;
  }

  private get t(): number {
    return this.now().getTime();
  }

  /** A new task: its dispatch row (queued). */
  open(w: { botId: string; threadId: string; harness: "coding" | "general"; level: string }): string {
    return this.store.dispatches.open(
      { botId: w.botId, threadId: w.threadId, harness: w.harness, level: w.level },
      this.t,
    ).id;
  }

  /** An execution of `w` starts; its token, or undefined when `w` was superseded (it must not run). */
  begin(w: WorkerRecord): string | undefined {
    const id = w.grants.dispatchId;
    if (!id) return undefined;
    const token = `${w.id}:${randomUUID().slice(0, 8)}`;
    return this.store.dispatches.begin(id, w.id, token, this.t) ? token : undefined;
  }

  fenced(w: WorkerRecord, token: string | undefined): boolean {
    const id = w.grants.dispatchId;
    return !!id && !!token && this.store.dispatches.fenced(id, token);
  }

  /** Progress after a tool call, at most once a second per dispatch (plan §2.9). */
  progress(w: WorkerRecord, token: string | undefined, detail: { steps: number; tool: string }): void {
    const id = w.grants.dispatchId;
    if (!id || !token) return;
    const t = this.t;
    if (t - (this.lastProgress.get(id) ?? 0) < PROGRESS_EVERY_MS) return;
    this.lastProgress.set(id, t);
    this.safe(() => this.store.dispatches.event(id, "harness.progress", t, { runId: token, detail }));
  }

  /** An outward action happened: written at once (a restart must never redo it). */
  outward(w: WorkerRecord, token: string | undefined, tool: string): void {
    const id = w.grants.dispatchId;
    if (!id) return;
    this.safe(() =>
      this.store.dispatches.event(id, "outward", this.t, { runId: token ?? null, detail: { tool } }),
    );
  }

  /** Phase 6: a verification round starts (the panel shows 驗證中 until its result). */
  verifying(w: WorkerRecord, token: string | undefined, round: number): void {
    const id = w.grants.dispatchId;
    if (!id || !token) return;
    this.safe(() =>
      this.store.dispatches.event(id, "verify.started", this.t, { runId: token, detail: { round } }),
    );
  }

  /** Phase 6: a verification round's checks, red or green, each with the end of its output. */
  verified(
    w: WorkerRecord,
    token: string | undefined,
    round: number,
    ok: boolean,
    checks: ReadonlyArray<{ command: string; exitCode: number | null; output: string }>,
  ): void {
    const id = w.grants.dispatchId;
    if (!id || !token) return;
    const list = checks.slice(0, 10).map((c) => ({
      command: c.command.slice(0, 300),
      exitCode: c.exitCode,
      summary: tail(c.output, CHECK_SUMMARY_CHARS),
    }));
    this.safe(() =>
      this.store.dispatches.event(id, "verify.result", this.t, {
        runId: token,
        detail: { round, ok, checks: list },
      }),
    );
  }

  /** B4: the independent reviewer's verdict (met, or not met with its gaps). */
  reviewed(
    w: WorkerRecord,
    token: string | undefined,
    round: number,
    v: { met: boolean; gaps: string[] },
  ): void {
    const id = w.grants.dispatchId;
    if (!id || !token) return;
    const gaps = v.met ? [] : v.gaps.slice(0, 10).map((g) => g.slice(0, 300));
    this.safe(() =>
      this.store.dispatches.event(id, "review.result", this.t, {
        runId: token,
        detail: { round, met: v.met, gaps },
      }),
    );
  }

  /** B4: a review that was due but gave no verdict, and why. */
  reviewSkipped(w: WorkerRecord, token: string | undefined, round: number, reason: string): void {
    const id = w.grants.dispatchId;
    if (!id || !token) return;
    this.safe(() =>
      this.store.dispatches.event(id, "review.skipped", this.t, {
        runId: token,
        detail: { round, reason: reason.slice(0, 80) },
      }),
    );
  }

  turnEnded(w: WorkerRecord, token: string | undefined, turnId: string, kind: TurnEnd): void {
    const id = w.grants.dispatchId;
    if (id && token) this.store.dispatches.turnEnded(id, token, turnId, kind, this.t);
  }

  /** Settle with the execution's result; false = superseded or already settled. */
  settle(
    w: WorkerRecord,
    token: string | undefined,
    outcome: DispatchOutcome,
    result: HarnessResult,
  ): boolean {
    const id = w.grants.dispatchId;
    if (!id || !token) return false;
    return this.safe(() => this.store.dispatches.settle(id, token, outcome, result, this.t)) ?? false;
  }

  /** A NEEDS_INPUT: the dispatch waits with an open wait (text questions expire after 72 h). */
  askInput(
    w: WorkerRecord,
    token: string | undefined,
    result: HarnessResult,
    qs: NeedsInputQuestion[],
  ): boolean {
    const id = w.grants.dispatchId;
    if (!id || !token) return false;
    const t = this.t;
    const wt = this.safe(() =>
      this.store.dispatches.askInput(
        id,
        token,
        result,
        { workerId: w.id, questions: qs, expiresAt: expiresAt(qs, t) },
        t,
      ),
    );
    return !!wt;
  }

  /** Plan §5: the worker awaits an outside event — the dispatch waits with an open event wait. */
  awaitEvent(w: WorkerRecord, token: string | undefined, result: HarnessResult, req: AwaitRequest): boolean {
    const id = w.grants.dispatchId;
    if (!id || !token) return false;
    const t = this.t;
    return !!this.safe(() =>
      this.store.dispatches.awaitEvent(id, token, result, { workerId: w.id, ...req }, t),
    );
  }

  /** The last result recorded for a worker's dispatch (its report and counted actions). */
  result(w: WorkerRecord): HarnessResult | undefined {
    const id = w.grants.dispatchId;
    const r = id ? (this.store.dispatches.get(id)?.report as HarnessResult | null | undefined) : undefined;
    return r && r.workerId === w.id ? r : undefined;
  }

  private safe<T>(fn: () => T): T | undefined {
    try {
      return fn();
    } catch {
      return undefined;
    }
  }
}
