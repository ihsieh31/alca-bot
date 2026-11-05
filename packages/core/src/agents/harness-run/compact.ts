import type { Engine } from "@alca/engines";
import type { WorkerRecord } from "@alca/store";
import { defuseAlcaTags } from "@alca/tools";
import {
  compactionIneffective,
  compactionStalled,
  shouldAutoCompact,
  shouldPrepareSummary,
  summaryComplete,
  summaryPrompt,
  withOutwardLedger,
} from "../../harness/context.ts";
import type { Live, RunHost } from "./run.ts";
import type { RunTally } from "./tally.ts";

/**
 * Plan §2.6: compaction for API engines (a CLI compacts its own context).
 * Between turns, when the last measured context is over
 * `window − max(15 %·window, 16k)`, or once after an overflow error: the
 * session writes a handover summary (fixed sections; section 9 — outward
 * actions — is the host's own ledger, never the model's), the worker goes on
 * in a fresh session that starts with the task, the summary, the changed
 * files and the rules again. Two compactions in a row that did not bring the
 * context under the ceiling stop the worker.
 *
 * The flush before it (plan §2.6): the todo snapshot (the coding tools' list,
 * plan §4), the changed files and the outward ledger go into the handover
 * from the host's own records, never from the model's summary.
 *
 * Research audit A5: the check also runs between passes of a turn (the turn
 * is asked to wind up, then compacted, see `passBoundary` in run.ts), and at
 * ~70 % of the ceiling the summary is written ahead at a turn boundary
 * (`prepareSummary`). A compaction uses that summary, plus what the worker
 * wrote after it, and only writes one on the spot when none was prepared.
 */

export const DEFAULT_WINDOW = 128_000;

export function windowOf(engine: Engine): number {
  return engine.capabilities.maxContextTokens ?? DEFAULT_WINDOW;
}

export function dueForCompaction(tally: RunTally, engine: Engine): boolean {
  if (tally.lastInputTokens <= 0) return false;
  return shouldAutoCompact({ tokens: tally.lastInputTokens, measured: true, window: windowOf(engine) });
}

/** Whether a summary should be written ahead now (none prepared yet, context at ~70 % of the ceiling). */
export function duePreparedSummary(tally: RunTally, engine: Engine): boolean {
  if (tally.prepared || tally.lastInputTokens <= 0) return false;
  return shouldPrepareSummary(tally.lastInputTokens, windowOf(engine));
}

/** Ask the session for its handover summary (one pass, no tools). */
async function writeSummary(host: RunHost, w: WorkerRecord, live: Live, engine: Engine): Promise<string> {
  const l = host.core.launch({
    threadId: w.threadId,
    text: summaryPrompt(),
    initiator: w.initiator,
    attended: false,
    role: "worker",
    engine,
    tools: [],
    profile: host.profile(w),
    botId: w.botId,
    sessionKey: live.sessionKey,
    workerId: w.id,
    jobId: w.jobId,
    publish: (e) => host.onEvent(w.id, e),
    maxPasses: 1,
  });
  live.stop = l.stop;
  const st = await l.done.catch(() => undefined);
  return (st?.assistantTexts ?? []).join("\n").trim();
}

/**
 * Write the handover summary ahead (at a turn boundary, ~70 % of the
 * ceiling) and keep it in the tally. An incomplete one is not kept.
 */
export async function prepareSummary(
  host: RunHost,
  w: WorkerRecord,
  live: Live,
  engine: Engine,
  textsAt: number,
): Promise<boolean> {
  const tally = live.tally;
  const tokens = tally.lastInputTokens;
  const summary = await writeSummary(host, w, live, engine);
  if (!summaryComplete(summary)) return false;
  tally.prepared = { summary, textsAt, tokens };
  try {
    host.core.jobs.record(w.jobId, "harness.summary_prepared", { tokens });
  } catch {
    // the summary is kept all the same
  }
  return true;
}

/** What the worker wrote after a prepared summary (newest last, cut to a bounded size). */
function laterProgress(texts: readonly string[], from: number): string {
  const later = texts
    .slice(from)
    .map((t) => t.trim())
    .filter(Boolean);
  if (!later.length) return "";
  const joined = later.join("\n");
  return joined.length > 6000 ? `…${joined.slice(-6000)}` : joined;
}

export async function compactSession(
  host: RunHost,
  w: WorkerRecord,
  live: Live,
  engine: Engine,
  next: string,
  texts: readonly string[] = [],
): Promise<{ text: string; stalled?: string }> {
  const tally = live.tally;
  if (tally.compactions > 0 && compactionIneffective(tally.lastInputTokens, windowOf(engine))) {
    tally.ineffectiveCompactions++;
    if (compactionStalled(tally.ineffectiveCompactions))
      return { text: next, stalled: "harness.compaction_stalled：連續兩次壓縮後內容仍然超過上限" };
  } else tally.ineffectiveCompactions = 0;
  const prepared = tally.prepared;
  const later = prepared ? laterProgress(texts, prepared.textsAt) : "";
  const summary = prepared ? prepared.summary : await writeSummary(host, w, live, engine);
  tally.prepared = undefined;
  tally.passCompactPending = false;
  const old = live.sessionKey;
  tally.compactions++;
  live.sessionKey = `${w.id}~c${tally.compactions}`;
  void engine.release?.(old).catch(() => undefined);
  const todos = host.todos?.(w) ?? "";
  try {
    host.core.jobs.record(w.jobId, "harness.compacted", {
      n: tally.compactions,
      tokensBefore: tally.lastInputTokens,
      complete: summaryComplete(summary),
      ...(prepared ? { prepared: true } : {}),
      ...(todos ? { todos: todos.split("\n").length - 1 } : {}),
    });
  } catch {
    // the compaction still happened
  }
  tally.lastInputTokens = 0;
  const head = host.taskMessage(w, false);
  const body = withOutwardLedger(summary || "（沒有摘要）", tally.actions.outward);
  return {
    text: [
      head,
      "<alca:handover>",
      "前面的工作已經整理成下面的交接摘要（工作階段換新了）；照摘要接著做，規則與確認照舊。",
      defuseAlcaTags(body),
      ...(later ? [`摘要寫好之後的進展（工作者原文）：\n${defuseAlcaTags(later)}`] : []),
      ...(tally.actions.filesChanged.length
        ? [`已改過的檔案：${tally.actions.filesChanged.join("、")}`]
        : []),
      ...(todos ? [`壓縮前的待辦清單（todo）：\n${defuseAlcaTags(todos)}`] : []),
      "</alca:handover>",
      ...(next !== head ? [next] : []),
    ].join("\n"),
  };
}
