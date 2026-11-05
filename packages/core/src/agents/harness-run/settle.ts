import type { JobRuntime } from "@alca/jobs";
import type { Store, WorkerRecord } from "@alca/store";
import type { TurnState } from "../../turn.ts";
import { shapeResult } from "../spill.ts";
import type { WorkersPolicy } from "../workers.ts";
import { exhaustCap, ranOut } from "./continue.ts";
import type { WorkerLedger } from "./ledger.ts";
import { awaitingReport, settlement } from "./report.ts";
import type { Live, RunResult } from "./run.ts";

/**
 * The end of one execution: the worker's final status, its result (inline or
 * spilled), its job and — for a harness worker — the dispatch ledger
 * (settled, or waiting with an open NEEDS_INPUT). A superseded execution's
 * result is not taken, and its router does not hear from it.
 */

export interface SettleDeps {
  store: Store;
  jobs: JobRuntime;
  ledger: WorkerLedger;
  now: () => Date;
  policy: () => WorkersPolicy;
  /** The "no checks ran" note, in the bot's language. */
  noChecks: (w: WorkerRecord) => string;
  changed: (id: string) => void;
  report: (w: WorkerRecord) => void;
  finished?: ((w: WorkerRecord) => void) | undefined;
  /** Design §0.2.5: where handoff files go, and the worker's todo snapshot for them. */
  handoffDir?: string | undefined;
  todos?: ((w: WorkerRecord) => string) | undefined;
}

/** Bring a worker's job to its end state (from whatever state it is in). */
export function settleJob(
  jobs: JobRuntime,
  w: WorkerRecord,
  how: "succeeded" | "failed" | "cancelled",
  reason: string,
): void {
  const j = jobs.get(w.jobId);
  if (!j || j.status === "succeeded" || j.status === "failed" || j.status === "cancelled") return;
  if (how === "cancelled") {
    jobs.cancel(j.id, reason);
    return;
  }
  if (j.status === "waiting") jobs.resume(j.id);
  else if (j.status === "queued") jobs.start(j.id, `worker:${w.id}`);
  if (how === "succeeded") jobs.complete(j.id, { workerId: w.id });
  else jobs.fail(j.id, reason);
}

export function finalizeWorker(d: SettleDeps, id: string, res: RunResult, live: Live): void {
  const w = d.store.workers.get(id);
  if (!w) return;
  let status: "succeeded" | "failed" | "stopped";
  let why: string | undefined;
  let full: string;
  if (w.grants.harness) {
    const s = settlement(w.id, live.tally, res, d.noChecks(w), live.stopReason);
    status = s.status;
    why = s.why;
    full = s.result.report.summary;
    const waitFor = res.why === "awaiting" && !live.stopReason ? live.tally.awaitRequest : undefined;
    if (waitFor) {
      s.result.report = awaitingReport(waitFor.note, s.result.report);
      full = s.result.report.summary;
    }
    const qs = s.outcome === "needs_input" ? s.result.report.questions : undefined;
    const taken = waitFor
      ? d.ledger.awaitEvent(w, live.token, s.result, waitFor)
      : qs?.length
        ? d.ledger.askInput(w, live.token, s.result, qs)
        : ranOut(s, live.tally, res, live.stopReason)
          ? exhaustCap(d, w, live.token, s, live.tally)
          : d.ledger.settle(w, live.token, s.outcome, s.result);
    if (!taken) {
      // A superseded execution: its result is not taken and the router does not hear from it.
      status = "stopped";
      why = "superseded";
    }
  } else {
    const last: TurnState | undefined = res.last;
    const reason = last?.finish?.reason ?? "failed";
    status = live.stopReason
      ? "stopped"
      : reason === "completed"
        ? "succeeded"
        : reason === "interrupted" || reason === "cancelled"
          ? "stopped"
          : "failed";
    why =
      live.stopReason ??
      (status === "succeeded"
        ? undefined
        : (last?.finish?.error?.code ?? res.error ?? (reason === "max_turns" ? "max_steps" : reason)));
    full = res.texts.join("\n\n").trim();
    if (!full) full = status === "succeeded" ? "（工人沒有留下文字結果）" : `沒有完成：${why ?? reason}`;
  }
  const p = d.policy();
  const shape = shapeResult(full, p);
  const spill =
    shape.mode === "spill"
      ? d.store.workers.addSpill(
          { botId: w.botId, ownerKind: "worker", ownerId: w.id, title: w.title, body: full },
          d.now(),
        )
      : undefined;
  settleJob(
    d.jobs,
    w,
    status === "succeeded" ? "succeeded" : status === "stopped" ? "cancelled" : "failed",
    why ?? status,
  );
  const closed = d.store.workers.finish(w.id, status, d.now(), {
    ...(why ? { stopReason: why } : {}),
    toolErrors: { count: live.toolErrors, last: live.lastToolError },
    result: {
      mode: shape.mode,
      summary: shape.summary,
      chars: shape.chars,
      ...(spill ? { spillId: spill.id } : {}),
    },
  });
  d.changed(w.id);
  if (closed && why !== "superseded") {
    const done = d.store.workers.get(w.id) as WorkerRecord;
    d.report(done);
    try {
      d.finished?.(done);
    } catch {
      // learning must not break the report
    }
  }
}
