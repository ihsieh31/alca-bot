import type { JobRuntime } from "@alca/jobs";
import type { Store, WorkerRecord } from "@alca/store";

/**
 * Plan §2.9: restart reconciliation of the dispatch ledger, after
 * `WorkerSupervisor.recover` (which already followed the jobs). For every
 * dispatch an execution was running in when Alca stopped:
 *
 * - it did something outward (send, payment, publish, delete, push) →
 *   `interrupted_after_outward`: never run again, parked for a person;
 * - it was already requeued once → failed;
 * - otherwise → requeued once; the worker resumes with a note that the last
 *   turn was cut off by a restart.
 *
 * The cut turn is recorded as `turn.interrupted`, so the ledger, the worker's
 * status and the dispatch outcome agree.
 *
 * Also (design §0.2.1): a dispatch `queued` for a worker that does not exist
 * (a wait claimed before the claim and the worker's rows were one atomic
 * block, and the worker was never created) is settled as failed. Nothing
 * else would ever pick it up.
 */

export interface ReconcileDeps {
  store: Store;
  jobs: JobRuntime;
  now: () => Date;
  report: (w: WorkerRecord) => void;
  changed: (id: string) => void;
}

export interface ReconcileResult {
  requeued: number;
  failed: number;
  review: number;
  closed: number;
  /** Queued for a worker that does not exist: settled as failed. */
  orphaned: number;
}

export function reconcileDispatches(d: ReconcileDeps): ReconcileResult {
  const out: ReconcileResult = { requeued: 0, failed: 0, review: 0, closed: 0, orphaned: 0 };
  const { store } = d;
  const t = d.now().getTime();
  for (const row of store.dispatches.unfinished()) {
    if (row.status === "queued" && row.activeWorkerId && !store.workers.get(row.activeWorkerId)) {
      if (store.dispatches.park(row.id, "failed", t, "settled")) out.orphaned++;
      continue;
    }
    if (row.status !== "running") continue; // never started: nothing was cut off
    const w = row.activeWorkerId ? store.workers.get(row.activeWorkerId) : undefined;
    if (w?.runId)
      store.dispatches.turnEnded(row.id, row.activeRunId ?? "restart", w.runId, "turn.interrupted", t);
    if (!w || w.finishedAt) {
      store.dispatches.park(row.id, "interrupted", t, "settled");
      out.closed++;
      continue;
    }
    const job = d.jobs.get(w.jobId);
    if (store.dispatches.hadOutward(row.id) || job?.needsReview || w.status === "needs_review") {
      store.dispatches.park(row.id, "interrupted_after_outward", t, "needs_review");
      if (w.status !== "needs_review") {
        store.workers.setStatus(w.id, "needs_review", { stopReason: "restart.outbound" });
        d.report(store.workers.get(w.id) as WorkerRecord);
      }
      d.changed(w.id);
      out.review++;
      continue;
    }
    if (row.requeues >= 1) {
      store.dispatches.park(row.id, "failed", t, "settled");
      if (job && (job.status === "queued" || job.status === "running" || job.status === "waiting")) {
        if (job.status === "queued") d.jobs.start(job.id, `worker:${w.id}`);
        if (job.status === "waiting") d.jobs.resume(job.id);
        d.jobs.fail(job.id, "restart.again");
      }
      if (
        store.workers.finish(w.id, "failed", d.now(), {
          stopReason: "restart.again：重啟後重跑過一次又被切斷",
        })
      )
        d.report(store.workers.get(w.id) as WorkerRecord);
      d.changed(w.id);
      out.failed++;
      continue;
    }
    store.dispatches.requeue(row.id, t);
    if (w.status !== "queued") store.workers.setStatus(w.id, "queued");
    d.changed(w.id);
    out.requeued++;
  }
  return out;
}
