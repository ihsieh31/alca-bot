import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { appendJobEvent, atomic, insertJobRow, jobEvents, jobRow, jobRows, setJobResult } from "@alca/store";
import {
  canTransition,
  isOutboundEvent,
  type Job,
  type JobEvent,
  type JobKind,
  type JobStatus,
  TERMINAL,
} from "./model.ts";

export class JobStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobStateError";
  }
}

interface JobRow {
  id: string;
  parent_id: string | null;
  thread_id: string | null;
  run_id: string | null;
  kind: JobKind;
  status: JobStatus;
  title: string | null;
  attempt: number;
  outbound_observed: number;
  needs_review: number;
  lease_owner: string | null;
  lease_until: string | null;
  input: string;
  result: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
  bot_id?: string | null;
}

function toJob(r: JobRow): Job {
  return {
    id: r.id,
    parentId: r.parent_id,
    threadId: r.thread_id,
    runId: r.run_id,
    kind: r.kind,
    status: r.status,
    title: r.title,
    attempt: r.attempt,
    outboundObserved: r.outbound_observed === 1,
    needsReview: r.needs_review === 1,
    leaseOwner: r.lease_owner,
    leaseUntil: r.lease_until,
    input: JSON.parse(r.input) as Record<string, unknown>,
    result: r.result === null ? null : (JSON.parse(r.result) as unknown),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    finishedAt: r.finished_at,
    botId: r.bot_id ?? null,
  };
}

export interface CreateJobInput {
  id?: string;
  kind: JobKind;
  parentId?: string;
  threadId?: string;
  runId?: string;
  title?: string;
  input?: Record<string, unknown>;
  /** Owning bot; defaults to the parent job's, then the thread's. */
  botId?: string;
}

export interface JobRuntimeOptions {
  now?: () => Date;
  /** How long a claim is valid before recovery may take the job back. */
  leaseMs?: number;
}

/**
 * The job tree over `jobs` + append-only `job_events`.
 * Every state change writes an event in the same transaction, so the event
 * log alone is enough to explain (and recover) a job.
 */
export class JobRuntime {
  readonly db: DatabaseSync;
  private readonly now: () => Date;
  private readonly leaseMs: number;

  constructor(db: DatabaseSync, opts: JobRuntimeOptions = {}) {
    this.db = db;
    this.now = opts.now ?? (() => new Date());
    this.leaseMs = opts.leaseMs ?? 60_000;
  }

  private ts(): string {
    return this.now().toISOString();
  }

  get(id: string): Job | undefined {
    // BUG-4: title / input / result are sealed; the store reads them.
    const r = jobRow(this.db, id) as JobRow | undefined;
    return r ? toJob(r) : undefined;
  }

  private must(id: string): Job {
    const j = this.get(id);
    if (!j) throw new JobStateError(`no job ${id}`);
    return j;
  }

  children(parentId: string): Job[] {
    return (jobRows(this.db, { parentId }) as JobRow[]).map(toJob);
  }

  byStatus(status: JobStatus): Job[] {
    return (jobRows(this.db, { status }) as JobRow[]).map(toJob);
  }

  needingReview(): Job[] {
    return (jobRows(this.db, { needsReview: true }) as JobRow[]).map(toJob);
  }

  events(jobId: string): JobEvent[] {
    // R7.4: the payload is sealed; the store reads it.
    return jobEvents(this.db, jobId);
  }

  /** Append an event (inside the caller's transaction if there is one). */
  private append(jobId: string, type: string, payload: Record<string, unknown> = {}): JobEvent {
    const createdAt = this.ts();
    const seq = appendJobEvent(this.db, jobId, type, payload, createdAt);
    if (isOutboundEvent(type)) {
      this.db
        .prepare("UPDATE jobs SET outbound_observed = 1, updated_at = ? WHERE id = ?")
        .run(createdAt, jobId);
    }
    return { jobId, seq, type, payload, createdAt };
  }

  /** Record something that happened to a job. Outbound types make the job sticky-outbound. */
  record(jobId: string, type: string, payload: Record<string, unknown> = {}): JobEvent {
    return atomic(this.db, () => {
      this.must(jobId);
      return this.append(jobId, type, payload);
    });
  }

  create(input: CreateJobInput): Job {
    const id = input.id ?? `job_${randomUUID()}`;
    return atomic(this.db, () => {
      if (input.parentId) {
        const parent = this.must(input.parentId);
        if (TERMINAL.has(parent.status)) throw new JobStateError(`parent ${parent.id} is ${parent.status}`);
      }
      const ts = this.ts();
      insertJobRow(this.db, {
        id,
        parentId: input.parentId ?? null,
        threadId: input.threadId ?? null,
        runId: input.runId ?? null,
        kind: input.kind,
        title: input.title ?? null,
        input: JSON.stringify(input.input ?? {}),
        at: ts,
      });
      this.db
        .prepare(
          `UPDATE jobs SET bot_id = COALESCE(?, (SELECT bot_id FROM jobs WHERE id = ?),
             (SELECT bot_id FROM threads WHERE id = ?)) WHERE id = ?`,
        )
        .run(input.botId ?? null, input.parentId ?? null, input.threadId ?? null, id);
      this.append(id, "created", { kind: input.kind });
      return this.must(id);
    });
  }

  private transition(
    id: string,
    to: JobStatus,
    type: string,
    payload: Record<string, unknown>,
    extra: { result?: unknown } = {},
  ): Job {
    return atomic(this.db, () => {
      const j = this.must(id);
      if (!canTransition(j.status, to)) throw new JobStateError(`job ${id}: ${j.status} → ${to} not allowed`);
      const ts = this.ts();
      const finished = TERMINAL.has(to) ? ts : null;
      this.db
        .prepare(
          `UPDATE jobs SET status = ?, updated_at = ?, finished_at = COALESCE(?, finished_at),
             lease_owner = CASE WHEN ? THEN NULL ELSE lease_owner END,
             lease_until = CASE WHEN ? THEN NULL ELSE lease_until END
           WHERE id = ?`,
        )
        .run(to, ts, finished, finished ? 1 : 0, finished ? 1 : 0, id);
      if (extra.result !== undefined) setJobResult(this.db, id, JSON.stringify(extra.result));
      this.append(id, type, payload);
      return this.must(id);
    });
  }

  /**
   * Atomically take one queued job (oldest first), optionally of a given kind.
   * Sets a lease and increments the attempt counter.
   */
  claim(worker: string, kinds?: readonly JobKind[]): Job | undefined {
    return atomic(this.db, () => {
      const filter = kinds?.length ? `AND kind IN (${kinds.map(() => "?").join(",")})` : "";
      const row = this.db
        .prepare(
          `SELECT id FROM jobs WHERE status = 'queued' AND needs_review = 0 ${filter} ORDER BY created_at, rowid LIMIT 1`,
        )
        .get(...(kinds ?? [])) as { id: string } | undefined;
      if (!row) return undefined;
      const ts = this.ts();
      const until = new Date(this.now().getTime() + this.leaseMs).toISOString();
      this.db
        .prepare(
          `UPDATE jobs SET status = 'running', attempt = attempt + 1, lease_owner = ?, lease_until = ?, updated_at = ?
           WHERE id = ? AND status = 'queued'`,
        )
        .run(worker, until, ts, row.id);
      const j = this.must(row.id);
      this.append(row.id, "claimed", { worker, attempt: j.attempt });
      return j;
    });
  }

  /** Start a specific job now (used for turns, which are created and run in-process). */
  start(id: string, worker: string): Job {
    return atomic(this.db, () => {
      const j = this.must(id);
      if (j.status !== "queued") throw new JobStateError(`job ${id} is ${j.status}, not queued`);
      const until = new Date(this.now().getTime() + this.leaseMs).toISOString();
      this.db
        .prepare(
          `UPDATE jobs SET status = 'running', attempt = attempt + 1, lease_owner = ?, lease_until = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(worker, until, this.ts(), id);
      this.append(id, "claimed", { worker, attempt: j.attempt + 1 });
      return this.must(id);
    });
  }

  heartbeat(id: string, worker: string): void {
    const until = new Date(this.now().getTime() + this.leaseMs).toISOString();
    const r = this.db
      .prepare(
        "UPDATE jobs SET lease_until = ? WHERE id = ? AND lease_owner = ? AND status IN ('running','waiting')",
      )
      .run(until, id, worker);
    if (Number(r.changes) !== 1) throw new JobStateError(`job ${id} is not leased by ${worker}`);
  }

  wait(id: string, reason: string): Job {
    return this.transition(id, "waiting", "waiting", { reason });
  }

  resume(id: string): Job {
    return this.transition(id, "running", "resumed", {});
  }

  complete(id: string, result?: unknown): Job {
    return this.transition(id, "succeeded", "succeeded", {}, { result: result ?? null });
  }

  fail(id: string, error: string): Job {
    return this.transition(id, "failed", "failed", { error });
  }

  cancel(id: string, reason = "cancelled"): Job {
    return atomic(this.db, () => {
      const j = this.must(id);
      if (TERMINAL.has(j.status)) return j;
      for (const c of this.children(id)) if (!TERMINAL.has(c.status)) this.cancel(c.id, `parent ${reason}`);
      return this.transition(id, "cancelled", "cancelled", { reason });
    });
  }

  /** A person looked at a job flagged for review and decided what happens to it. */
  review(id: string, decision: "requeue" | "fail", by: string): Job {
    return atomic(this.db, () => {
      const j = this.must(id);
      if (!j.needsReview) throw new JobStateError(`job ${id} is not waiting for review`);
      this.db.prepare("UPDATE jobs SET needs_review = 0, updated_at = ? WHERE id = ?").run(this.ts(), id);
      this.append(id, "reviewed", { decision, by });
      if (decision === "fail") return this.transition(id, "failed", "failed", { error: "failed by review" });
      if (j.status === "waiting") {
        this.db.prepare("UPDATE jobs SET status = 'queued', updated_at = ? WHERE id = ?").run(this.ts(), id);
        this.append(id, "requeued", { by });
      }
      return this.must(id);
    });
  }
}
