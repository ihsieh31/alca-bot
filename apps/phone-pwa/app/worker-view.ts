// Phase 6: what the phone's worker sheet says about a harness worker — phase,
// harness, doneWhen, verification, budget, the questions it waits on, the
// reviewer's gaps and the 完全授權 log. The same rules as the desktop panel
// (apps/desktop/ui/worker-view.ts), laid out for a phone card. Pure (no DOM),
// so it is unit-tested in Node.
import { t } from "./i18n/index.ts";

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

export interface WorkerHarness {
  kind: "coding" | "general";
  phase: HarnessPhase;
  dispatchId?: string;
  doneWhen?: string;
  verification?: {
    state: "running" | "passed" | "failed" | "none";
    round: number;
    checks: Array<{ command: string; exitCode: number | null; ok: boolean; summary: string }>;
    feedback?: string;
  };
  budget: {
    steps: number;
    maxSteps?: number;
    tokens: number;
    maxTokens?: number;
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
  const used = t("common.continuedTimes", { continues: cap.continues, max: cap.max });
  switch (cap.state) {
    case "waiting": {
      const ms = cap.expiresAt ? Date.parse(cap.expiresAt) - now : Number.NaN;
      const left =
        Number.isFinite(ms) && ms > 0
          ? t("common.withinHours", { p0: Math.max(1, Math.round(ms / 3_600_000)) })
          : "";
      return {
        title: t("common.stepBudgetUsedUp"),
        detail: t("common.pressContinueToHaveA", { used, left }),
        canContinue: true,
      };
    }
    case "continued":
      return {
        title: t("common.continued"),
        detail: t("common.aNewWorkerPicksUp", { used }),
        canContinue: false,
      };
    case "refused":
      return { title: t("common.cantContinueAgain"), detail: cap.refusal ?? used, canContinue: false };
    case "expired":
      return {
        title: t("common.notContinuedEnded"),
        detail: t("common.noOneContinuedWithin72"),
        canContinue: false,
      };
    case "stopped":
      return {
        title: t("common.stopped2"),
        detail: t("common.wontContinueAfterBeingStopped"),
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
      return { text: t("common.sandboxSeatbelt"), tone: "ok" };
    case "bwrap":
      return { text: t("common.sandboxBubblewrap"), tone: "ok" };
    case "off":
      return { text: t("common.sandboxOff"), tone: "quiet" };
    case "unavailable":
      return {
        text: t("common.sandboxUnavailable"),
        tone: "warn",
        warning: t("phone.workerView.thisComputerHasNoUsable"),
      };
    default:
      return undefined;
  }
}

export function snapshotSkippedLine(hs: Pick<WorkerHarness, "snapshotSkipped">): string | undefined {
  if (hs.snapshotSkipped === "not_git") return t("common.thisFolderIsntAGit");
  if (hs.snapshotSkipped === "snapshot_failed") return t("common.thisRoundsSnapshotFailed");
  return undefined;
}

export const HARNESS_WORD = { coding: t("common.code"), general: t("common.general") } as const;

export const PHASE_WORD: Record<HarnessPhase, string> = {
  queued: t("common.queued"),
  running: t("common.inProgress"),
  verifying: t("common.verifying"),
  waiting_input: t("common.waitingForYourAnswer"),
  waiting_event: t("common.waitingForAnEvent"),
  continued: t("common.handedToTheNextWorker"),
  done: t("common.done2"),
  partial: t("common.partlyDone"),
  unverified: t("common.notVerified"),
  needs_review: t("common.needsYourConfirmation"),
  blocked: t("common.stuck"),
  failed: t("common.notFinished"),
  stopped: t("common.stopped3"),
  expired: t("common.questionExpired"),
};

/** The card's data-status: the colours the sheet already has. */
export function cardStatus(p: HarnessPhase): "running" | "waiting" | "succeeded" | "failed" | "stopped" {
  if (p === "queued" || p === "running" || p === "verifying") return "running";
  if (p === "waiting_input" || p === "needs_review") return "waiting";
  if (p === "done" || p === "continued") return "succeeded";
  if (p === "failed" || p === "expired" || p === "blocked") return "failed";
  return "stopped";
}

/** One short line for the budget (the phone has room for one). */
export function budgetLine(b: WorkerHarness["budget"]): string {
  const part = (used: number, max: number | undefined, unit: string) =>
    max
      ? `${used.toLocaleString("zh-TW")}/${max.toLocaleString("zh-TW")} ${unit}`
      : `${used.toLocaleString("zh-TW")} ${unit}`;
  return [part(b.steps, b.maxSteps, t("phone.workerView.steps")), part(b.tokens, b.maxTokens, "tokens")].join(
    " · ",
  );
}

export function verificationLine(
  v: WorkerHarness["verification"],
): { text: string; ok: boolean | null } | undefined {
  if (!v) return undefined;
  if (v.state === "running")
    return { text: t("phone.workerView.verifyingRound", { round: v.round }), ok: null };
  if (v.state === "passed") return { text: t("phone.workerView.checksGreen"), ok: true };
  if (v.state === "failed") {
    const red = v.checks.find((c) => !c.ok);
    return {
      text: red
        ? t("phone.workerView.checksRed", { command: red.command })
        : t("phone.workerView.checksRed2"),
      ok: false,
    };
  }
  return { text: t("common.noChecksToRun"), ok: null };
}

export type AnswerCheck = { ok: true; answers: string[] } | { ok: false; error: string };

export function answerCheck(qs: readonly HarnessQuestion[], drafts: readonly string[]): AnswerCheck {
  if (!qs.length) return { ok: false, error: t("common.noQuestionsToAnswer") };
  const answers = qs.map((_, i) => (drafts[i] ?? "").trim());
  const missing = answers.findIndex((a) => !a);
  if (missing >= 0)
    return {
      ok: false,
      error:
        qs.length > 1
          ? t("common.questionIsntAnsweredYet", { p0: missing + 1 })
          : t("common.pleaseAnswerFirst"),
    };
  if (answers.some((a) => a.length > 4000)) return { ok: false, error: t("common.atMost4000CharactersPer") };
  return { ok: true, answers };
}

/** Who may answer here: answering as the person needs the paired phone's `approve` scope. */
export function canAnswer(h: WorkerHarness | undefined, can: (scope: string) => boolean): boolean {
  return !!h?.questions?.length && h.phase === "waiting_input" && can("approve");
}

/** B4: why a review was skipped, in words. */
export const REVIEW_SKIP_WORD: Record<string, string> = {
  engine_not_read_only: t("common.thisEngineCantReviewRead"),
  no_verdict: t("common.theReviewerGaveNoReadable"),
  no_report: t("common.noReportToReview"),
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
      ? { title: t("common.reviewNotAchieved"), tone: "warn", gaps: hs.gaps }
      : undefined;
  if (r.state === "met") return { title: t("common.reviewPassed"), tone: "ok", gaps: [] };
  if (r.state === "gaps")
    return { title: t("common.reviewNotAchieved"), tone: "warn", gaps: r.gaps ?? hs.gaps ?? [] };
  const why = (r.reason && REVIEW_SKIP_WORD[r.reason]) || t("common.reasonUnknown");
  return { title: t("common.reviewSkipped", { why }), tone: "quiet", gaps: [] };
}

/**
 * B6: whether a worker is still working (and can be stopped): a harness
 * worker by its phase — one waiting on the person's answer is not — a plain
 * worker by its status.
 */
export function working(w: { status: string; harness?: { phase: string } | undefined }): boolean {
  const p = w.harness?.phase;
  if (p) return p === "queued" || p === "running" || p === "verifying";
  return w.status === "queued" || w.status === "running" || w.status === "waiting";
}

/** B11: an option that already says it is the recommendation (older cores kept the model's mark). */
export const markedRecommended = (o: string): boolean => /[（(［[]\s*(?:recommended|推薦|建議)/i.test(o);

/**
 * BUG-13: the question as shown in the numbered list. Models often number
 * their own questions ("1. 今晚想吃…"), and the list numbers them again
 * ("1. 1. 今晚想吃…"); the core strips it too, this is the phone's own guard.
 */
export const questionText = (q: string): string =>
  q
    .replace(/^\s*(?:[(（]?\d{1,2}[)）]|\d{1,2}\s*[.．、:：)）](?!\d)|[QＱ]\d{1,2}\s*[.．、:：)）]?)\s*/, "")
    .trim() || q.trim();
