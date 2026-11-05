import type { DispatchOutcome } from "@alca/store";
import { defuseAlcaTags } from "@alca/tools";
import { actionLines } from "../../harness/actions.ts";
import {
  reportLines,
  synthesizedReport,
  type WorkerReport,
  withVerification,
} from "../../harness/contract.ts";
import type { EndWhy } from "./decide.ts";
import type { HarnessResult } from "./ledger.ts";
import type { RunResult } from "./run.ts";
import type { RunTally } from "./tally.ts";

/**
 * Plan §2.7: what a harness worker's execution comes to — the report the
 * router reads (the worker's own words, made `unverified` by the host when
 * a coding task has no fresh green check), the counted actions next to it,
 * and the outcome the dispatch settles with.
 */

export interface Settlement {
  result: HarnessResult;
  outcome: DispatchOutcome;
  /** The worker record's final status. */
  status: "succeeded" | "failed" | "stopped";
  why?: string;
}

const OUTCOME_OF: Partial<Record<EndWhy, DispatchOutcome>> = {
  stopped: "stopped",
  budget: "budget",
  failed: "failed",
  interrupted: "interrupted",
};

export function settlement(
  workerId: string,
  tally: RunTally,
  run: RunResult,
  noChecks: string,
  stopReason: string | undefined,
): Settlement {
  let report: WorkerReport =
    tally.report ?? tally.staleReport ?? synthesizedReport(run.beforeRemind ?? run.texts.at(-1) ?? "");
  if (tally.handoff)
    report = {
      status: "blocked",
      summary: `工人判斷這件事該換 ${tally.handoff.to} 工人：${tally.handoff.reason}`,
      changes: [],
      claims: [],
      unblock: `用 harness=${tally.handoff.to} 再派一次（handoffFrom=${workerId}）`,
    };
  if (run.why === "stalled" && !tally.report) report = stalledReport(report, tally.stalledTurns);
  if (run.verified === false) report = withVerification(report, false, tally.lastVerifyFeedback ?? noChecks);
  else if (tally.reviewUnmet && tally.review) report = withReviewGaps(report, tally.review.gaps);
  const result: HarnessResult = {
    workerId,
    report,
    actions: tally.actions,
    ...(run.verified !== undefined ? { verified: run.verified } : {}),
    ...(tally.lastVerifyFeedback ? { checkFeedback: tally.lastVerifyFeedback.slice(0, 4000) } : {}),
    ...(tally.review ? { review: tally.review } : {}),
    ...(tally.handoff ? { handoff: tally.handoff } : {}),
  };
  const why = stopReason ? "stopped" : run.why;
  const fixed = OUTCOME_OF[why];
  // An explicit report wins over a failed last turn (the worker said what it got to).
  const outcome: DispatchOutcome =
    fixed && !(why === "failed" && tally.report) ? fixed : (report.status as DispatchOutcome);
  const status =
    stopReason || why === "stopped" || why === "interrupted"
      ? "stopped"
      : fixed && outcome === fixed
        ? "failed"
        : "succeeded";
  const reason =
    stopReason ??
    (status === "succeeded"
      ? undefined
      : why === "budget"
        ? "budget：步數預算用完，沒有留下報告"
        : (run.last?.finish?.error?.code ?? run.error ?? why));
  return { result, outcome, status, ...(reason ? { why: reason } : {}) };
}

/** Research audit A4: the report of a worker stopped for making no progress. */
export function stalledReport(said: WorkerReport, turns: number): WorkerReport {
  const last = said.synthesized ? said.summary.trim() : "";
  return {
    status: "partial",
    summary: `Alca 先停下了這件工作：連續 ${turns} 輪嘗試工具都沒有成功，也沒有改到任何檔案，再做下去多半只是重複。${last && !last.startsWith("（") ? `工人最後的說明：${last.slice(0, 2000)}` : ""}`,
    changes: said.synthesized ? [] : said.changes,
    claims: said.synthesized ? [] : said.claims,
    unblock: "看一下工人最後碰到的錯誤，補上缺的條件（權限、路徑、登入、資料）後再派一次",
  };
}

/** Research audit C3: a report the reviewer still found gaps in is `unverified`, with the gaps as claims. */
export function withReviewGaps(r: WorkerReport, gaps: readonly string[]): WorkerReport {
  if (r.status !== "done" && r.status !== "partial") return r;
  return {
    ...r,
    status: "unverified",
    claims: [...r.claims, ...gaps.slice(0, 5).map((g) => ({ text: `獨立審查認為還缺：${g}` }))],
  };
}

/** Plan §5: the report a dispatch keeps while it waits for an outside event. */
export function awaitingReport(note: string, said: WorkerReport): WorkerReport {
  return {
    status: "partial",
    summary: `工人在等外部事件，事件到了會自動接著做：${note}`,
    changes: said.synthesized ? [] : said.changes,
    claims: said.synthesized ? [] : said.claims,
  };
}

/** The harness part of a worker's report to the router: counted actions, the check, and the worker's words. */
export function harnessLines(r: HarnessResult, mayAnswer: boolean): string[] {
  const out = actionLines(r.actions, defuseAlcaTags);
  if (r.verified === true) out.push("收工驗證：Alca 在最後一次改檔之後跑了專案的檢查，通過。");
  else if (r.verified === false)
    out.push(
      `收工驗證：沒有通過或沒有跑（status 已標成 unverified）${r.checkFeedback ? `；最後的輸出：${defuseAlcaTags(r.checkFeedback.slice(0, 1500))}` : ""}`,
    );
  if (r.review?.met) out.push("獨立審查：審查者讀過成果，認為已達成目標。");
  else if (r.review)
    out.push(
      `獨立審查：審查者認為還沒達成（status 已標成 unverified）：${defuseAlcaTags(r.review.gaps.join("；").slice(0, 1500))}`,
    );
  out.push(...reportLines(r.report, defuseAlcaTags, mayAnswer));
  return out;
}

/** Whether the router may call the task done. */
export const harnessOk = (r: HarnessResult | undefined): boolean => r?.report.status === "done";
