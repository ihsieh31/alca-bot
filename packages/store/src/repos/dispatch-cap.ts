import type { DatabaseSync } from "node:sqlite";
import { atomic } from "../db.ts";
import type { DispatchOutcome, DispatchRepo } from "./dispatches.ts";

/**
 * Design §0.2.5 (S10): a dispatch whose step budget ran out is not settled.
 * It waits in `needs_review` with a handoff file, and the router or the
 * person may "續做" it — a new worker on the same dispatch — at most
 * `MAX_CONTINUES` times, never after two continuations in a row made no
 * progress, and never on its own. One that nobody continues within 72 hours
 * settles as `budget`. All of it is the ledger's own rows: `cap.exhausted`
 * `{n, handoff, progress}`, `continued` `{n, workerId, by}`, `cap.expired`.
 */

export const MAX_CONTINUES = 6;
export const CAP_EXPIRE_MS = 72 * 3600_000;

export interface CapExhausted {
  /** 1 = the first execution ran out; n = after n − 1 continuations. */
  n: number;
  handoff: string | null;
  /** The execution changed a file, did something outward or ran a check. */
  progress: boolean;
  at: number;
}

export interface CapState {
  exhausted: CapExhausted[];
  /** Continuations so far. */
  continues: number;
  /** The dispatch waits to be continued right now. */
  waiting: boolean;
}

export class DispatchCaps {
  private readonly db: DatabaseSync;
  private readonly repo: DispatchRepo;
  constructor(db: DatabaseSync, repo: DispatchRepo) {
    this.db = db;
    this.repo = repo;
  }

  state(id: string): CapState {
    const evs = this.repo.eventsOf(id, ["cap.exhausted", "continued"]);
    const exhausted = evs
      .filter((e) => e.kind === "cap.exhausted")
      .map((e) => {
        const d = (e.detail ?? {}) as { n?: number; handoff?: string | null; progress?: boolean };
        return { n: d.n ?? 0, handoff: d.handoff ?? null, progress: d.progress === true, at: e.at };
      });
    const continues = evs.filter((e) => e.kind === "continued").length;
    const d = this.repo.get(id);
    const waiting =
      !!d && d.status === "needs_review" && d.finishedAt === null && evs.at(-1)?.kind === "cap.exhausted";
    return { exhausted, continues, waiting };
  }

  /**
   * Why a continuation is refused, or undefined when it may go ahead: the
   * limit, two continuations in a row without progress, or nothing to continue.
   */
  refusal(id: string): string | undefined {
    const s = this.state(id);
    if (!s.exhausted.length) return "這件工作沒有因為步數預算用完而停下，不能續做";
    if (s.continues >= MAX_CONTINUES) return `已經續做 ${MAX_CONTINUES} 次了，不能再續做`;
    const after = s.exhausted.filter((e) => e.n >= 2).slice(-2);
    if (after.length === 2 && after.every((e) => !e.progress))
      return "最近兩次續做都沒有進展（沒有改檔、沒有對外動作、沒有跑檢查），不再續做";
    if (!s.waiting) return "這件工作已經結束或已經在續做了";
    return undefined;
  }

  /**
   * The fenced execution ran out of budget: its report, `needs_review`
   * (not finished) and `cap.exhausted`, in one step. False = superseded.
   */
  exhaust(
    id: string,
    runId: string,
    outcome: DispatchOutcome,
    report: unknown,
    detail: { n: number; handoff: string | null; progress: boolean },
    now = Date.now(),
  ): boolean {
    return atomic(this.db, () => {
      const r = this.db
        .prepare(
          `UPDATE dispatches SET status = 'needs_review', outcome = ?, report = ?, updated_at = ?
           WHERE id = ? AND active_run_id = ? AND finished_at IS NULL AND status IN ('running','queued')`,
        )
        .run(outcome, JSON.stringify(report ?? null), now, id, runId);
      if (r.changes !== 1) return false;
      // The wait a continuation worker was started for closes when it reports (as in `settle`).
      this.db
        .prepare(
          "UPDATE harness_waits SET state = 'closed', closed_at = ? WHERE dispatch_id = ? AND state = 'claimed'",
        )
        .run(now, id);
      this.repo.event(id, "reported", now, { runId, detail: { outcome } });
      this.repo.event(id, "cap.exhausted", now, { runId, detail });
      return true;
    });
  }

  /**
   * 續做: the waiting dispatch goes back to `queued` for a worker id made up
   * front (compare-and-set; one of any number of calls wins). Call inside the
   * atomic block that inserts that worker. Returns the continuation's n.
   */
  resume(id: string, workerId: string, by: string, now = Date.now()): number | undefined {
    return atomic(this.db, () => {
      if (this.refusal(id)) return undefined;
      const r = this.db
        .prepare(
          `UPDATE dispatches SET status = 'queued', active_worker_id = ?, active_run_id = NULL, updated_at = ?
           WHERE id = ? AND status = 'needs_review' AND finished_at IS NULL`,
        )
        .run(workerId, now, id);
      if (r.changes !== 1) return undefined;
      const n = this.state(id).continues + 1;
      this.repo.event(id, "continued", now, { detail: { n, workerId, by: by.slice(0, 40) } });
      return n;
    });
  }

  /** Settle one waiting dispatch as `budget` (no continuation possible, or a stop). */
  close(id: string, reason: "cap.expired" | "cap.refused" | "stopped", now = Date.now()): boolean {
    return atomic(this.db, () => {
      if (!this.state(id).waiting) return false;
      const outcome = reason === "stopped" ? "stopped" : "budget";
      this.db
        .prepare(
          `UPDATE dispatches SET status = 'settled', outcome = ?, active_run_id = NULL, updated_at = ?, finished_at = ?
           WHERE id = ? AND finished_at IS NULL`,
        )
        .run(outcome, now, now, id);
      this.repo.event(id, reason, now);
      return true;
    });
  }

  /** Waiting dispatches nobody continued within 72 hours settle as `budget`; their ids. */
  expire(now = Date.now(), after = CAP_EXPIRE_MS): string[] {
    const ids = (
      this.db
        .prepare(
          "SELECT id FROM dispatches WHERE status = 'needs_review' AND finished_at IS NULL AND updated_at <= ?",
        )
        .all(now - after) as Array<{ id: string }>
    ).map((r) => r.id);
    return ids.filter((id) => this.close(id, "cap.expired", now));
  }
}
