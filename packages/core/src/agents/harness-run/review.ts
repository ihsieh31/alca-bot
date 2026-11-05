import type { Engine } from "@alca/engines";
import { type ConfineSpec, GIT_DIFF_SAFE_ARGS, hardenedGitPrefix } from "@alca/os";
import type { WorkerRecord } from "@alca/store";
import { defuseAlcaTags } from "@alca/tools";
import { runCommand } from "../../harness/coding/bash.ts";
import type { WorkerReport } from "../../harness/contract.ts";
import type { HarnessKind } from "../../harness/kinds.ts";
import { truncateText } from "../../harness/truncate.ts";
import type { HostTool } from "../../turn.ts";
import type { Live, RunHost } from "./run.ts";

/**
 * Research audit C3: an independent reviewer (one switch per bot,
 * `harness.reviewer`, off by default). After the host's own check passed
 * (coding) or on a `done` report (general), a separate, tool-less session
 * reads the work — the diff of the work folder (coding) or the report and its
 * counted actions (general) — against the goal and doneWhen, and answers
 * `{met, gaps[]}`. The outer loop (decide.ts `ruleReview`) feeds the gaps back
 * at most `MAX_REVIEW_FEEDBACK` times, then reports `unverified` with them.
 *
 * Read-only: the session gets one host tool, `review_verdict`, which only
 * hands the verdict to the host (design §0.2.4); an engine that runs its own
 * tools is only used when its native tools are read-only. Mac test 2026-11
 * B4: Claude Code's native tools can write, so every review on it was
 * skipped and the skip went only to the job log — the person saw nothing.
 * Now such an engine is asked for its read-only variant (Claude Code started
 * with `--tools ""`, `reviewerEngine`); only when there is none is the
 * review skipped. Every review and every skip goes into the dispatch ledger
 * (`review.result` / `review.skipped`) and the worker's panel.
 */

export const MAX_REVIEW_FEEDBACK = 2;
/** What the reviewer gets of a diff (head + tail). */
export const REVIEW_MATERIAL_BYTES = 24 * 1024;

export interface ReviewVerdict {
  met: boolean;
  gaps: string[];
}

/** Whether this engine can review without being able to change anything. */
export function reviewReadOnly(engine: Engine): boolean {
  return !engine.capabilities.ownsToolLoop || engine.capabilities.nativeToolsReadOnly === true;
}

/** The engine a review runs on: the worker's own when it is read-only, else its read-only variant. */
export function reviewerEngine(engine: Engine): Engine | undefined {
  if (reviewReadOnly(engine)) return engine;
  let v: Engine | undefined;
  try {
    v = engine.readOnlyVariant?.();
  } catch {
    v = undefined;
  }
  return v && reviewReadOnly(v) ? v : undefined;
}

/** Why a review gave no verdict (ledger `review.skipped`, the panel). */
export type ReviewSkip = "engine_not_read_only" | "no_verdict" | "no_report";

/** Design §0.2.4: what `review_verdict` takes (checked like any tool's arguments). */
export const REVIEW_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: { met: { type: "boolean" }, gaps: { type: "array", items: { type: "string" } } },
  required: ["met", "gaps"],
  additionalProperties: false,
};

export const REVIEW_TOOL = "review_verdict";

/** The reviewer's one tool: it only hands the verdict to the host (read-only, no effect anywhere). */
export function reviewTool(take: (v: ReviewVerdict) => void): HostTool {
  return {
    spec: {
      name: REVIEW_TOOL,
      description: "回報審查結論：met（是否達成）、gaps（沒達成時缺什麼）。",
      inputSchema: REVIEW_SCHEMA,
    },
    actionClass: "read",
    run: async (a) => {
      const v = verdictFrom(a);
      if (!v) throw new Error("需要 met（true／false）與 gaps（字串陣列）");
      take(v);
      return "已收到審查結論。";
    },
  };
}

/** A verdict object (structured, or parsed from text) → the verdict; undefined without a boolean `met`. */
export function verdictFrom(v: unknown): ReviewVerdict | undefined {
  if (!v || typeof v !== "object" || typeof (v as { met?: unknown }).met !== "boolean") return undefined;
  const o = v as { met: boolean; gaps?: unknown };
  const gaps = Array.isArray(o.gaps)
    ? o.gaps
        .filter((g): g is string => typeof g === "string" && !!g.trim())
        .map((g) => g.trim().slice(0, 300))
        .slice(0, 8)
    : [];
  // "Not met" with no gap named is not something the worker can act on: ask for one.
  if (!o.met && !gaps.length) return { met: false, gaps: ["審查者認為還沒達成，但沒有指出缺什麼"] };
  return { met: o.met, gaps: o.met ? [] : gaps };
}

/**
 * Legacy path (an engine that cannot call the tool, e.g. a CLI engine's
 * read-only variant): the first JSON object with a boolean `met` in the
 * reply; anything else → undefined.
 */
export function parseReview(text: string): ReviewVerdict | undefined {
  const t = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(t)?.[1];
  const raw = (fenced ?? t).trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  let v: unknown;
  try {
    v = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return undefined;
  }
  return verdictFrom(v);
}

export interface ReviewInput {
  kind: HarnessKind;
  goal: string;
  doneWhen?: string | undefined;
  report: WorkerReport;
  material: string;
}

export function reviewPrompt(i: ReviewInput): string {
  return [
    "你是獨立的審查者，不是做這件工作的人。只根據下面的資料判斷這件工作是否真的達成了目標與完成條件；不要做任何修改。",
    '用 review_verdict 回報：達成就是 {"met":true,"gaps":[]}；沒有達成就是 {"met":false,"gaps":["具體缺什麼、在哪裡"]}（最多 5 條，每條一句，能照著改）。沒有這個工具時，回覆只放這個 JSON。',
    "<alca:review-goal>",
    defuseAlcaTags(i.goal),
    ...(i.doneWhen ? [`完成條件（doneWhen）：${defuseAlcaTags(i.doneWhen)}`] : []),
    "</alca:review-goal>",
    '<alca:review-report trust="worker">',
    `status: ${i.report.status}`,
    `summary: ${defuseAlcaTags(i.report.summary)}`,
    ...(i.report.changes.length ? [`changes: ${defuseAlcaTags(i.report.changes.join("；"))}`] : []),
    ...i.report.claims.map(
      (c) => `claim: ${defuseAlcaTags(c.text)}${c.evidenceRef ? `（${c.evidenceRef}）` : ""}`,
    ),
    "</alca:review-report>",
    `<alca:review-material kind="${i.kind === "coding" ? "diff" : "result"}" trust="untrusted">`,
    defuseAlcaTags(i.material),
    "</alca:review-material>",
  ].join("\n");
}

/**
 * The reviewer's git: hardened (§5.6) so a repository's own config (an
 * fsmonitor, hooks, an external diff, a pager) never runs a program.
 */
export function reviewGitCommand(): string {
  const git = hardenedGitPrefix();
  const diff = `${git} diff ${GIT_DIFF_SAFE_ARGS.join(" ")}`;
  return `${git} rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 3; ${git} status --porcelain; echo ---; ${diff} HEAD 2>/dev/null || ${diff}`;
}

/** Coding: the work folder's status and diff (git), else the files the worker changed. */
export async function codingMaterial(
  cwd: string | undefined,
  filesChanged: readonly string[],
  signal?: AbortSignal,
  confine?: ConfineSpec,
): Promise<string> {
  const fallback = filesChanged.length ? `改過的檔案：${filesChanged.join("、")}` : "（沒有改檔紀錄）";
  if (!cwd) return fallback;
  const r = await runCommand({
    command: reviewGitCommand(),
    cwd,
    timeoutMs: 30_000,
    ...(signal ? { signal } : {}),
    ...(confine ? { confine } : {}),
  });
  if (r.exitCode !== 0 || !r.output.trim()) return fallback;
  return truncateText(r.output, { mode: "headtail", maxBytes: REVIEW_MATERIAL_BYTES, headShare: 0.5 }).text;
}

/** The coding material in the worker's sandbox; no git at all when the bot requires one and none is usable. */
function reviewMaterial(
  host: RunHost,
  w: WorkerRecord,
  filesChanged: readonly string[],
  signal: AbortSignal,
): Promise<string> {
  const box = host.confine?.(w) ?? {};
  return codingMaterial(box.refuse ? undefined : host.workDir(w), filesChanged, signal, box.spec);
}

/** General: what the host counted the worker doing (the report itself goes in its own block). */
export function generalMaterial(outward: readonly string[], filesChanged: readonly string[]): string {
  return [
    outward.length
      ? `對外動作（主機紀錄）：\n${outward.map((o) => `- ${o}`).join("\n")}`
      : "對外動作（主機紀錄）：（無）",
    ...(filesChanged.length ? [`改過的檔案：${filesChanged.join("、")}`] : []),
  ].join("\n");
}

/**
 * One review in its own fresh session (no tools, one pass). undefined = no
 * verdict (engine not read-only, no answer, an unreadable answer): the report
 * then stands as the host's check left it.
 */
export async function runReview(
  host: RunHost,
  w: WorkerRecord,
  live: Live,
  workerEngine: Engine,
  round: number,
): Promise<ReviewVerdict | undefined> {
  const tally = live.tally;
  const report = tally.report;
  const kind = w.grants.harness;
  if (!report || !kind) {
    skipped(host, w, live, round, "no_report");
    return undefined;
  }
  const engine = reviewerEngine(workerEngine);
  if (!engine) {
    skipped(host, w, live, round, "engine_not_read_only");
    return undefined;
  }
  const material =
    kind === "coding"
      ? await reviewMaterial(host, w, tally.actions.filesChanged, live.abort.signal)
      : generalMaterial(tally.actions.outward, tally.actions.filesChanged);
  // A fresh conversation every time (a later execution's round 1 must not resume an old review).
  const sessionKey = `${w.id}~review${round}~${host.now().getTime().toString(36)}`;
  // Design §0.2.4: the verdict arrives as checked tool arguments; the reply text is only a fallback.
  let given: ReviewVerdict | undefined;
  const l = host.core.launch({
    threadId: w.threadId,
    text: reviewPrompt({ kind, goal: w.goal, doneWhen: w.grants.doneWhen, report, material }),
    initiator: w.initiator,
    attended: false,
    role: "worker",
    engine,
    tools: [reviewTool((v) => (given ??= v))],
    profile: host.profile(w),
    botId: w.botId,
    sessionKey,
    workerId: w.id,
    jobId: w.jobId,
    publish: (e) => host.onEvent(w.id, e),
    // One more pass than the answer needs: a verdict that fails its schema is fixed once.
    maxPasses: 2,
  });
  live.stop = l.stop;
  const st = await l.done.catch(() => undefined);
  void engine.release?.(sessionKey).catch(() => undefined);
  const v = given ?? parseReview((st?.assistantTexts ?? []).join("\n"));
  if (!v) {
    skipped(host, w, live, round, "no_verdict");
    return undefined;
  }
  record(host, w, { round, met: v.met, gaps: v.gaps.length });
  host.ledger.reviewed(w, live.token, round, v);
  host.changed?.(w.id);
  return v;
}

function skipped(host: RunHost, w: WorkerRecord, live: Live, round: number, why: ReviewSkip): void {
  record(host, w, { round, skipped: why });
  host.ledger.reviewSkipped(w, live.token, round, why);
  host.changed?.(w.id);
}

function record(host: RunHost, w: WorkerRecord, data: Record<string, unknown>): void {
  try {
    host.core.jobs.record(w.jobId, "harness.reviewed", data);
  } catch {
    // the verdict still counts
  }
}
