import { randomUUID } from "node:crypto";
import { atomic } from "@alca/store";
import type { Job } from "./model.ts";
import type { JobRuntime } from "./runtime.ts";

export interface Schedule {
  id: string;
  name: string;
  kind: "once" | "interval";
  intervalSec: number | null;
  nextDueAt: string | null;
  lastDispatchedAt: string | null;
  enabled: boolean;
  payload: Record<string, unknown>;
}

interface ScheduleRow {
  id: string;
  name: string;
  kind: "once" | "interval";
  interval_sec: number | null;
  next_due_at: string | null;
  last_dispatched_at: string | null;
  enabled: number;
  payload: string;
}

const toSchedule = (r: ScheduleRow): Schedule => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  intervalSec: r.interval_sec,
  nextDueAt: r.next_due_at,
  lastDispatchedAt: r.last_dispatched_at,
  enabled: r.enabled === 1,
  payload: JSON.parse(r.payload) as Record<string, unknown>,
});

export interface Dispatch {
  schedule: Schedule;
  dueAt: string;
  job: Job;
}

/** Next due time strictly after `now`; missed slots are skipped, never replayed. */
export function nextAfter(dueAt: Date, intervalSec: number, now: Date): Date {
  const step = intervalSec * 1000;
  const behind = Math.max(0, now.getTime() - dueAt.getTime());
  const slots = Math.floor(behind / step) + 1;
  return new Date(dueAt.getTime() + slots * step);
}

/**
 * Scheduling stub with at-most-once dispatch: in one transaction the cursor
 * (`next_due_at`) is advanced with a compare-and-set and the schedule job is
 * created; only after that commits is `dispatch` called. A crash or a throwing
 * dispatch therefore loses at most one firing and never fires twice.
 */
export class Scheduler {
  private readonly rt: JobRuntime;
  constructor(rt: JobRuntime) {
    this.rt = rt;
  }

  add(
    s: { name: string; firstDueAt: Date; payload?: Record<string, unknown> } & (
      | { kind: "once" }
      | { kind: "interval"; intervalSec: number }
    ),
    now = new Date(),
  ): Schedule {
    const id = `sch_${randomUUID()}`;
    this.rt.db
      .prepare(
        `INSERT INTO schedules (id, name, kind, interval_sec, next_due_at, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        s.name,
        s.kind,
        s.kind === "interval" ? s.intervalSec : null,
        s.firstDueAt.toISOString(),
        JSON.stringify(s.payload ?? {}),
        now.toISOString(),
      );
    return this.get(id) as Schedule;
  }

  get(id: string): Schedule | undefined {
    const r = this.rt.db.prepare("SELECT * FROM schedules WHERE id = ?").get(id) as ScheduleRow | undefined;
    return r ? toSchedule(r) : undefined;
  }

  setEnabled(id: string, enabled: boolean): void {
    this.rt.db.prepare("UPDATE schedules SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
  }

  /** Claim every due schedule (cursor first), then dispatch each. Returns what was dispatched. */
  async tick(now: Date, dispatch: (d: Dispatch) => void | Promise<void>): Promise<Dispatch[]> {
    const claimed = this.claimDue(now);
    for (const d of claimed) {
      try {
        await dispatch(d);
        this.rt.record(d.job.id, "dispatched", { dueAt: d.dueAt });
      } catch (err) {
        // At-most-once: a failed dispatch is recorded, never retried by the scheduler.
        this.rt.record(d.job.id, "dispatch_failed", { error: String(err) });
      }
    }
    return claimed;
  }

  /** The commit point. Exposed so tests can simulate a crash right after it. */
  claimDue(now: Date): Dispatch[] {
    const nowIso = now.toISOString();
    return atomic(this.rt.db, () => {
      const due = this.rt.db
        .prepare(
          "SELECT * FROM schedules WHERE enabled = 1 AND next_due_at IS NOT NULL AND next_due_at <= ? ORDER BY next_due_at, id",
        )
        .all(nowIso) as unknown as ScheduleRow[];
      const out: Dispatch[] = [];
      for (const row of due) {
        const dueAt = row.next_due_at as string;
        const next =
          row.kind === "interval"
            ? nextAfter(new Date(dueAt), row.interval_sec as number, now).toISOString()
            : null;
        const r = this.rt.db
          .prepare(
            "UPDATE schedules SET next_due_at = ?, last_dispatched_at = ? WHERE id = ? AND next_due_at = ?",
          )
          .run(next, nowIso, row.id, dueAt);
        if (Number(r.changes) !== 1) continue; // someone else advanced it first
        const job = this.rt.create({
          kind: "schedule",
          title: row.name,
          input: { scheduleId: row.id, dueAt, payload: JSON.parse(row.payload) as unknown },
        });
        out.push({
          schedule: toSchedule({ ...row, next_due_at: next, last_dispatched_at: nowIso }),
          dueAt,
          job,
        });
      }
      return out;
    });
  }
}
