import { atomic } from "@alca/store";
import { isOutboundEvent, type Job, type JobKind } from "./model.ts";
import type { JobRuntime } from "./runtime.ts";

export type RecoveryAction = "needs_review" | "requeued" | "failed" | "cancelled";

export interface RecoveryOutcome {
  jobId: string;
  action: RecoveryAction;
  reason: string;
}

export interface RecoveryOptions {
  /** Only take back jobs whose lease ran out (periodic sweep); default: every unfinished job (process restart). */
  expiredLeasesOnly?: boolean;
  maxAttempts?: number;
  /** Kinds that make no sense to re-run after a restart (a chat turn: the person re-sends). */
  nonResumableKinds?: readonly JobKind[];
}

/** True when the job's own event log shows something left the machine. */
export function hasOutboundActivity(rt: JobRuntime, job: Job): boolean {
  if (job.outboundObserved) return true;
  return rt.events(job.id).some((e) => isOutboundEvent(e.type));
}

/**
 * Restart recovery. The rule that matters: a job whose events show an
 * outbound action (sent / paid / posted) is NEVER re-run automatically; it is
 * parked as needs_review for a person. Everything else is requeued while it
 * has attempts left, failed after that, or cancelled if it is not resumable.
 */
export function recoverJobs(rt: JobRuntime, now: Date, opts: RecoveryOptions = {}): RecoveryOutcome[] {
  const maxAttempts = opts.maxAttempts ?? 3;
  const nonResumable = new Set<JobKind>(opts.nonResumableKinds ?? ["turn"]);
  const nowIso = now.toISOString();
  const candidates = [...rt.byStatus("running"), ...rt.byStatus("waiting")].filter((j) => {
    if (j.needsReview) return false;
    if (!opts.expiredLeasesOnly) return true;
    return j.status === "running" && j.leaseUntil !== null && j.leaseUntil < nowIso;
  });

  const out: RecoveryOutcome[] = [];
  for (const job of candidates) {
    atomic(rt.db, () => {
      const set = (sql: string, ...args: Array<string | number>) =>
        rt.db.prepare(`UPDATE jobs SET ${sql}, updated_at = ? WHERE id = ?`).run(...args, nowIso, job.id);
      const clearLease = "lease_owner = NULL, lease_until = NULL";

      if (hasOutboundActivity(rt, job)) {
        set(`status = 'waiting', needs_review = 1, ${clearLease}`);
        rt.record(job.id, "needs_review", {
          reason: "outbound activity before restart",
          previous: job.status,
        });
        out.push({ jobId: job.id, action: "needs_review", reason: "outbound activity observed" });
        return;
      }
      if (nonResumable.has(job.kind)) {
        set(`status = 'cancelled', finished_at = ?, ${clearLease}`, nowIso);
        rt.record(job.id, "cancelled", { reason: "interrupted by restart" });
        out.push({ jobId: job.id, action: "cancelled", reason: "not resumable" });
        return;
      }
      if (job.attempt < maxAttempts) {
        set(`status = 'queued', ${clearLease}`);
        rt.record(job.id, "requeued", { reason: "recovered after restart", attempt: job.attempt });
        out.push({ jobId: job.id, action: "requeued", reason: "no outbound activity" });
        return;
      }
      set(`status = 'failed', finished_at = ?, ${clearLease}`, nowIso);
      rt.record(job.id, "failed", { error: "attempts exhausted during recovery" });
      out.push({ jobId: job.id, action: "failed", reason: "attempts exhausted" });
    });
  }
  return out;
}
