// Phase 6: what the worker panel says about a harness worker — its phase,
// the verification checks, the budget used, the questions it is waiting on,
// the reviewer's gaps and the calls that ran only at 完全授權. Pure (no DOM),
// so it is unit-tested in Node; workers.ts / worker-harness.ts draw it.
import { locale, t as tx } from "./i18n/index.ts";

export type HarnessPhase =
  | "queued"
  | "running"
  | "verifying"
  | "waiting_input"
  | "waiting_event"
  | "continued"
  | "done"
  | "partial"
  | "unverified"
  | "needs_review"
  | "blocked"
  | "failed"
  | "stopped"
  | "expired";

export interface HarnessCheck {
  command: string;
  exitCode: number | null;
  ok: boolean;
  summary: string;
}

export interface HarnessReview {
  state: "met" | "gaps" | "skipped";
  round: number;
  gaps?: string[];
  reason?: string;
}

export interface HarnessQuestion {
  question: string;
  options?: string[];
  personOnly: boolean;
}

/** The harness part of a worker's state (protocol `WorkerHarness`; absent from older cores). */
export interface WorkerHarness {
  kind: "coding" | "general";
  phase: HarnessPhase;
  dispatchId?: string;
  doneWhen?: string;
  verification?: {
    state: "running" | "passed" | "failed" | "none";
    round: number;
    checks: HarnessCheck[];
    feedback?: string;
  };
  budget: {
    steps: number;
    maxSteps?: number;
    tokens: number;
    maxTokens?: number;
    /** Prompt-cache reads (a tenth of them is in tokens). */
    cachedTokens?: number;
    waitedMs: number;
    maxRunMs?: number;
  };
  questions?: HarnessQuestion[];
  questionsExpireAt?: string;
  gaps?: string[];
  /** B4: the independent reviewer's last outcome (absent from older cores). */
  review?: HarnessReview;
  autoAllowed?: Array<{ at: string; tool: string; summary: string }>;
  /** 11-05: why turns at 完全授權 have no snapshot (absent from older cores). */
  snapshotSkipped?: "not_git" | "snapshot_failed";
  /** Next round §5.4: the OS sandbox the worker's commands run in (absent from older cores). */
  sandbox?: "seatbelt" | "bwrap" | "off" | "unavailable";
  /** Design §0.2.5: the step budget ran out (absent from older cores). */
  cap?: HarnessCap;
}

/** Design §0.2.5: a task whose step budget ran out, and whether it may be continued (續做). */
export interface HarnessCap {
  state: "waiting" | "continued" | "refused" | "expired" | "stopped";
  n: number;
  continues: number;
  max: number;
  refusal?: string;
  expiresAt?: string;
}

/** The 續做 block's words; `canContinue` only while it waits (the core checks again). */
export function capView(
  cap: HarnessCap | undefined,
  now = Date.now(),
): { title: string; detail: string; canContinue: boolean } | undefined {
  if (!cap) return undefined;
  const used = tx("common.continuedTimes", { continues: cap.continues, max: cap.max });
  switch (cap.state) {
    case "waiting": {
      const ms = cap.expiresAt ? Date.parse(cap.expiresAt) - now : Number.NaN;
      const left =
        Number.isFinite(ms) && ms > 0
          ? tx("common.withinHours", { p0: Math.max(1, Math.round(ms / 3_600_000)) })
          : "";
      return {
        title: tx("common.stepBudgetUsedUp"),
        detail: tx("common.pressContinueToHaveA", { used, left }),
        canContinue: true,
      };
    }
    case "continued":
      return {
        title: tx("common.continued"),
        detail: tx("common.aNewWorkerPicksUp", { used }),
        canContinue: false,
      };
    case "refused":
      return { title: tx("common.cantContinueAgain"), detail: cap.refusal ?? used, canContinue: false };
    case "expired":
      return {
        title: tx("common.notContinuedEnded"),
        detail: tx("common.noOneContinuedWithin72"),
        canContinue: false,
      };
    case "stopped":
      return {
        title: tx("common.stopped2"),
        detail: tx("common.wontContinueAfterBeingStopped"),
        canContinue: false,
      };
  }
}

/** 11-05: the 完全授權 list's line for a coding worker that has no snapshot to go back to. */
/**
 * Next round §5.4 / 5.7: the panel's sandbox label. `unavailable` means the
 * bot's setting wants the sandbox at this level and this computer has none:
 * the work still runs (完全授權 included, the person's decision 2026-11-05)
 * and the panel says so plainly.
 */
export function sandboxBadge(
  hs: Pick<WorkerHarness, "sandbox">,
): { text: string; tone: "ok" | "quiet" | "warn"; warning?: string } | undefined {
  switch (hs.sandbox) {
    case "seatbelt":
      return { text: tx("common.sandboxSeatbelt"), tone: "ok" };
    case "bwrap":
      return { text: tx("common.sandboxBubblewrap"), tone: "ok" };
    case "off":
      return { text: tx("common.sandboxOff"), tone: "quiet" };
    case "unavailable":
      return {
        text: tx("common.sandboxUnavailable"),
        tone: "warn",
        warning: tx("desktop.workerView.thisComputerHasNoUsable"),
      };
    default:
      return undefined;
  }
}

export function snapshotSkippedLine(hs: Pick<WorkerHarness, "snapshotSkipped">): string | undefined {
  if (hs.snapshotSkipped === "not_git") return tx("common.thisFolderIsntAGit");
  if (hs.snapshotSkipped === "snapshot_failed") return tx("common.thisRoundsSnapshotFailed");
  return undefined;
}

export const HARNESS_WORD: Record<WorkerHarness["kind"], string> = {
  coding: tx("desktop.workerView.codeCoding"),
  general: tx("desktop.workerView.generalGeneral"),
};

export const PHASE_WORD: Record<HarnessPhase, string> = {
  queued: tx("common.queued"),
  running: tx("common.inProgress"),
  verifying: tx("common.verifying"),
  waiting_input: tx("common.waitingForYourAnswer"),
  waiting_event: tx("common.waitingForAnEvent"),
  continued: tx("common.handedToTheNextWorker"),
  done: tx("common.done2"),
  partial: tx("common.partlyDone"),
  unverified: tx("common.notVerified"),
  needs_review: tx("common.needsYourConfirmation"),
  blocked: tx("common.stuck"),
  failed: tx("common.notFinished"),
  stopped: tx("common.stopped2"),
  expired: tx("common.questionExpired"),
};

/** The tone a phase is drawn in (the chip's data-status, reusing the worker colours). */
export function phaseTone(p: HarnessPhase): "live" | "waiting" | "ok" | "warn" | "bad" | "quiet" {
  if (p === "queued" || p === "running" || p === "verifying") return "live";
  if (p === "waiting_input" || p === "waiting_event" || p === "needs_review") return "waiting";
  if (p === "done") return "ok";
  if (p === "partial" || p === "unverified" || p === "blocked") return "warn";
  if (p === "failed" || p === "expired") return "bad";
  return "quiet";
}

/** Whether the panel should draw attention to this worker (a person has to act). */
export const needsPerson = (p: HarnessPhase): boolean => p === "waiting_input" || p === "needs_review";

const fmt = (n: number) => n.toLocaleString(locale());

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return tx("common.s", { s });
  const m = Math.floor(s / 60);
  return m < 60
    ? tx("desktop.workerView.min", { m })
    : tx("common.hrMin", { p0: Math.floor(m / 60), p1: m % 60 });
}

export interface BudgetRow {
  label: string;
  text: string;
  /** 0–1 of the cap, or undefined with no cap. */
  ratio: number | undefined;
  /** At or past 80 % of its cap. */
  high: boolean;
}

/**
 * The budget used against its caps. Running time leaves out time spent
 * waiting for a person (the same rule the harness counts by).
 */
export function budgetRows(
  b: WorkerHarness["budget"],
  run: { startedAt?: string | undefined; finishedAt?: string | undefined },
  now = Date.now(),
): BudgetRow[] {
  const row = (label: string, used: number, max: number | undefined, show: (n: number) => string) => {
    const ratio = max ? Math.min(1, used / max) : undefined;
    return {
      label,
      text: max ? `${show(used)} / ${show(max)}` : show(used),
      ratio,
      high: ratio !== undefined && ratio >= 0.8,
    };
  };
  const from = run.startedAt ? Date.parse(run.startedAt) : undefined;
  const to = run.finishedAt ? Date.parse(run.finishedAt) : now;
  const ranMs = from === undefined ? 0 : Math.max(0, to - from - b.waitedMs);
  const tokens = row("tokens", b.tokens, b.maxTokens, fmt);
  // Mac test B3: cache reads count at a tenth; the panel says how many there were.
  if (b.cachedTokens)
    tokens.text += tx("desktop.workerView.plusCacheReadsCountedAt", { cachedTokens: fmt(b.cachedTokens) });
  return [
    row(tx("desktop.workerView.steps"), b.steps, b.maxSteps, fmt),
    tokens,
    row(tx("desktop.workerView.time"), ranMs, b.maxRunMs, duration),
  ];
}

/** One line for the verification: 驗證中 / 綠燈 / 紅燈 (which check) / no checks. */
export function verificationLine(v: WorkerHarness["verification"]): string | undefined {
  if (!v) return undefined;
  if (v.state === "running") return tx("desktop.workerView.verifyingRound", { round: v.round });
  if (v.state === "passed")
    return v.checks.length
      ? tx("desktop.workerView.greenAllChecksPassed", {
          checksCount: v.checks.length,
          p1: v.round ? tx("desktop.workerView.round", { round: v.round }) : "",
        })
      : tx("desktop.workerView.greenChecksAfterTheLast");
  if (v.state === "failed") {
    const red = v.checks.find((c) => !c.ok);
    if (red)
      return tx("desktop.workerView.red", {
        command: red.command,
        p1:
          red.exitCode === null
            ? tx("desktop.workerView.interruptedOrTimedOut")
            : tx("desktop.workerView.exit", { exitCode: red.exitCode }),
      });
    return tx("desktop.workerView.redACheckAfterThe");
  }
  return tx("common.noChecksToRun");
}

/** 完全授權 log lines, newest first. */
export function autoAllowedLines(h: WorkerHarness, now = Date.now()): Array<{ when: string; text: string }> {
  return [...(h.autoAllowed ?? [])].reverse().map((a) => ({
    when: duration(now - Date.parse(a.at)),
    text: tx("common.text3", { tool: a.tool, summary: a.summary }),
  }));
}

/** When a text question stops taking answers, in words (undefined: it never expires). */
export function expiresIn(h: WorkerHarness, now = Date.now()): string | undefined {
  if (!h.questionsExpireAt) return undefined;
  const left = Date.parse(h.questionsExpireAt) - now;
  return left > 0 ? tx("desktop.workerView.expiresIn", { left: duration(left) }) : tx("common.expired");
}

export type AnswerCheck = { ok: true; answers: string[] } | { ok: false; error: string };

/** The answers to send (one per question, in order), or which one is still missing. */
export function answerCheck(qs: readonly HarnessQuestion[], drafts: readonly string[]): AnswerCheck {
  if (!qs.length) return { ok: false, error: tx("common.noQuestionsToAnswer") };
  const answers = qs.map((_, i) => (drafts[i] ?? "").trim());
  const missing = answers.findIndex((a) => !a);
  if (missing >= 0)
    return {
      ok: false,
      error:
        qs.length > 1
          ? tx("common.questionIsntAnsweredYet", { p0: missing + 1 })
          : tx("common.pleaseAnswerFirst"),
    };
  if (answers.some((a) => a.length > 4000)) return { ok: false, error: tx("common.atMost4000CharactersPer") };
  return { ok: true, answers };
}

/** B4: why a review was skipped, in words. */
export const REVIEW_SKIP_WORD: Record<string, string> = {
  engine_not_read_only: tx("common.thisEngineCantReviewRead"),
  no_verdict: tx("common.theReviewerGaveNoReadable"),
  no_report: tx("common.noReportToReview"),
};

/**
 * B4: the reviewer's line — 審查：通過 / 未達成（with its gaps）/ 跳過（why）.
 * An older core sends only `gaps`; no review at all → nothing to show.
 */
export function reviewView(
  hs: Pick<WorkerHarness, "review" | "gaps">,
): { title: string; tone: "ok" | "warn" | "quiet"; gaps: string[] } | undefined {
  const r = hs.review;
  if (!r)
    return hs.gaps?.length
      ? { title: tx("common.reviewNotAchieved"), tone: "warn", gaps: hs.gaps }
      : undefined;
  if (r.state === "met") return { title: tx("common.reviewPassed"), tone: "ok", gaps: [] };
  if (r.state === "gaps")
    return { title: tx("common.reviewNotAchieved"), tone: "warn", gaps: r.gaps ?? hs.gaps ?? [] };
  const why = (r.reason && REVIEW_SKIP_WORD[r.reason]) || tx("common.reasonUnknown");
  return { title: tx("common.reviewSkipped", { why }), tone: "quiet", gaps: [] };
}

/** The phases in which a worker is still working (it can be stopped). */
const WORKING: ReadonlySet<HarnessPhase> = new Set(["queued", "running", "verifying"]);

/**
 * B6: whether a worker is still working. A harness worker by its phase (a
 * question waiting on the person is not "running" and has nothing to stop),
 * a plain worker by its status.
 */
export function isWorking(w: {
  status: string;
  harness?: Pick<WorkerHarness, "phase"> | undefined;
}): boolean {
  if (w.harness) return WORKING.has(w.harness.phase);
  return w.status === "queued" || w.status === "running" || w.status === "waiting";
}

const STATUS_WORD: Record<string, string> = {
  queued: tx("common.queued"),
  running: tx("common.inProgress"),
  waiting: tx("common.waitingForYourApproval"),
  succeeded: tx("common.done2"),
  failed: tx("common.notFinished"),
  stopped: tx("common.stopped2"),
  needs_review: tx("common.needsYourConfirmation"),
};

/** B6: the header chip — a harness worker's phase (never 完成 while it waits), else its status. */
export function statusWord(w: {
  status: string;
  harness?: Pick<WorkerHarness, "phase"> | undefined;
}): string {
  return w.harness ? PHASE_WORD[w.harness.phase] : (STATUS_WORD[w.status] ?? w.status);
}

/** B6: the tone the header chip and glyph are drawn in (the worker colours' data-status). */
export function statusTone(w: {
  status: string;
  harness?: Pick<WorkerHarness, "phase"> | undefined;
}): string {
  if (!w.harness) return w.status;
  const t = phaseTone(w.harness.phase);
  return t === "live"
    ? "running"
    : t === "waiting"
      ? "waiting"
      : t === "ok"
        ? "succeeded"
        : t === "bad"
          ? "failed"
          : t === "warn"
            ? "needs_review"
            : "stopped";
}

/** B11: an option that already says it is the recommendation (older cores kept the model's mark). */
export const markedRecommended = (o: string): boolean => /[（(［[]\s*(?:recommended|推薦|建議)/i.test(o);

export type HarnessPart =
  | "cap"
  | "questions"
  | "allowed"
  | "doneWhen"
  | "checks"
  | "budget"
  | "review"
  | "snapshots";

/**
 * Mac test 2026-11 B10: the order of the harness parts in the worker panel. What
 * needs the person (the open questions) and what ran without asking (the
 * 完全授權 list) come first, so they are never pushed below the task's stream.
 */
export function harnessSections(
  hs: Pick<
    WorkerHarness,
    "kind" | "phase" | "dispatchId" | "doneWhen" | "questions" | "autoAllowed" | "snapshotSkipped" | "cap"
  > & {
    verification?: unknown;
  },
  hasVerificationLine: boolean,
): HarnessPart[] {
  const out: HarnessPart[] = [];
  if (hs.cap) out.push("cap");
  if (hs.questions?.length && hs.phase === "waiting_input") out.push("questions");
  if (hs.autoAllowed?.length || hs.snapshotSkipped) out.push("allowed");
  if (hs.doneWhen) out.push("doneWhen");
  if (hasVerificationLine) out.push("checks");
  out.push("budget", "review");
  if (hs.kind === "coding" && hs.dispatchId) out.push("snapshots");
  return out;
}
