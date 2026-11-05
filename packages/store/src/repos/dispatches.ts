import type { DatabaseSync } from "node:sqlite";
import { atomic, transaction } from "../db.ts";
import { newStoreId } from "../ids.ts";
import { openValue, sealValue } from "../seal.ts";
import { DispatchCaps } from "./dispatch-cap.ts";
import { DispatchEventFeed } from "./dispatch-feed.ts";

/**
 * Plan §2.9: the dispatch ledger. Every transition is a compare-and-set
 * that writes the row and its event in one transaction; the unique indexes
 * of migration 18 hold "one report per execution", "one end event per turn"
 * and "one answer per wait" even if code above calls twice.
 */

export type DispatchStatus =
  | "queued"
  | "running"
  | "needs_input"
  | "waiting_event"
  | "needs_review"
  | "settled";

export type DispatchOutcome =
  | "done"
  | "partial"
  | "needs_input"
  | "blocked"
  | "unverified"
  | "stopped"
  | "failed"
  | "budget"
  | "expired"
  | "interrupted"
  | "interrupted_after_outward";

export type TurnEnd = "turn.completed" | "turn.failed" | "turn.interrupted";

export const DISPATCH_RETENTION_DAYS = 30;

/** Plan §5: at most this many open event waits per bot. */
export const EVENT_WAIT_LIMIT = 20;

export interface DispatchRecord {
  id: string;
  botId: string;
  threadId: string;
  harness: "coding" | "general" | null;
  level: string;
  status: DispatchStatus;
  outcome: DispatchOutcome | null;
  activeWorkerId: string | null;
  activeRunId: string | null;
  requeues: number;
  report: unknown;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
}

export interface DispatchEventRecord {
  seq: number;
  dispatchId: string;
  kind: string;
  runId: string | null;
  turnId: string | null;
  waitId: string | null;
  detail: unknown;
  at: number;
}

export interface WaitRecord {
  id: string;
  dispatchId: string;
  botId: string;
  threadId: string;
  /** The worker that asked (or awaited). */
  workerId: string;
  kind: "needs_input" | "event";
  questions: unknown[];
  state: "open" | "claimed" | "closed" | "expired";
  claimedBy: string | null;
  expiresAt: number | null;
  createdAt: number;
  closedAt: number | null;
}

const toEvent = (e: Record<string, unknown>): DispatchEventRecord => ({
  seq: e.seq as number,
  dispatchId: e.dispatch_id as string,
  kind: e.kind as string,
  runId: (e.run_id as string | null) ?? null,
  turnId: (e.turn_id as string | null) ?? null,
  waitId: (e.wait_id as string | null) ?? null,
  detail: e.detail ? JSON.parse(e.detail as string) : null,
  at: e.at as number,
});

interface Row {
  id: string;
  bot_id: string;
  thread_id: string;
  harness: "coding" | "general" | null;
  level: string;
  status: DispatchStatus;
  outcome: DispatchOutcome | null;
  active_worker_id: string | null;
  active_run_id: string | null;
  requeues: number;
  report: string | null;
  created_at: number;
  updated_at: number;
  finished_at: number | null;
}

const toRecord = (db: DatabaseSync, r: Row): DispatchRecord => ({
  id: r.id,
  botId: r.bot_id,
  threadId: r.thread_id,
  harness: r.harness,
  level: r.level,
  status: r.status,
  outcome: r.outcome,
  activeWorkerId: r.active_worker_id,
  activeRunId: r.active_run_id,
  requeues: r.requeues,
  report: r.report ? JSON.parse(openValue(db, "dispatches", "report", r.id, r.report)) : null,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  finishedAt: r.finished_at,
});

interface WaitRow {
  id: string;
  dispatch_id: string;
  bot_id: string;
  thread_id: string;
  worker_id: string;
  kind: "needs_input" | "event";
  questions: string;
  state: WaitRecord["state"];
  claimed_by: string | null;
  expires_at: number | null;
  created_at: number;
  closed_at: number | null;
}

const toWait = (r: WaitRow): WaitRecord => ({
  id: r.id,
  dispatchId: r.dispatch_id,
  botId: r.bot_id,
  threadId: r.thread_id,
  workerId: r.worker_id,
  kind: r.kind,
  questions: JSON.parse(r.questions) as unknown[],
  state: r.state,
  claimedBy: r.claimed_by,
  expiresAt: r.expires_at,
  createdAt: r.created_at,
  closedAt: r.closed_at,
});

const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v));

export class DispatchRepo {
  private readonly db: DatabaseSync;
  private readonly feed: DispatchEventFeed;
  /** Design §0.2.5: budget ran out → needs_review, 續做 (at most 6), 72 h expiry. */
  readonly caps: DispatchCaps;
  constructor(db: DatabaseSync) {
    this.db = db;
    this.feed = new DispatchEventFeed(db);
    this.caps = new DispatchCaps(db, this);
  }

  /** Design §0.2.3: hear every ledger event once it is committed (the agents channel's projection). */
  observe(fn: (e: DispatchEventRecord) => void): () => void {
    return this.feed.observe(fn);
  }

  /**
   * Design §0.2.3: the client's cursor `afterSeq` (a seq of this dispatch it
   * saw) is gone — that row no longer exists and is older than the oldest
   * kept one. Seq is shared by all dispatches, so 0 (or less) means "from
   * the start" and is never gone. The caller handles a pruned dispatch.
   */
  cursorGone(id: string, afterSeq: number): { minSeq: number | null } | undefined {
    if (afterSeq <= 0) return undefined;
    const r = this.db
      .prepare("SELECT MIN(seq) AS min, SUM(seq = ?) AS hit FROM dispatch_events WHERE dispatch_id = ?")
      .get(afterSeq, id) as { min: number | null; hit: number | null };
    if (r.hit || (r.min !== null && afterSeq >= r.min)) return undefined;
    return { minSeq: r.min };
  }

  /** A dispatch's events after `afterSeq` (resume), oldest first. */
  eventsAfter(id: string, afterSeq: number, limit = 1000): DispatchEventRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM dispatch_events WHERE dispatch_id = ? AND seq > ? ORDER BY seq LIMIT ?")
      .all(id, afterSeq, limit) as Array<Record<string, unknown>>;
    return rows.map(toEvent);
  }

  /** R7: the report is sealed (it is the worker's words). */
  private sealReport(id: string, report: unknown): string | null {
    return sealValue(this.db, "dispatches", "report", id, json(report));
  }

  get(id: string): DispatchRecord | undefined {
    const r = this.db.prepare("SELECT * FROM dispatches WHERE id = ?").get(id) as Row | undefined;
    return r ? toRecord(this.db, r) : undefined;
  }

  events(id: string): DispatchEventRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM dispatch_events WHERE dispatch_id = ? ORDER BY seq")
      .all(id) as Array<Record<string, unknown>>;
    return rows.map(toEvent);
  }

  /** Phase 6: only some kinds of a dispatch's events (the panel skips the per-second progress rows). */
  eventsOf(id: string, kinds: readonly string[]): DispatchEventRecord[] {
    if (!kinds.length) return [];
    const marks = kinds.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT * FROM dispatch_events WHERE dispatch_id = ? AND kind IN (${marks}) ORDER BY seq`)
      .all(id, ...kinds) as Array<Record<string, unknown>>;
    return rows.map(toEvent);
  }

  /** Append one event. Throws on a unique-index violation (the caller asked twice). */
  event(
    id: string,
    kind: string,
    at: number,
    o: { runId?: string | null; turnId?: string; waitId?: string; detail?: unknown } = {},
  ): void {
    const r = this.db
      .prepare(
        "INSERT INTO dispatch_events (dispatch_id, kind, run_id, turn_id, wait_id, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, kind, o.runId ?? null, o.turnId ?? null, o.waitId ?? null, json(o.detail), at);
    this.feed.wrote({
      seq: Number(r.lastInsertRowid),
      dispatchId: id,
      kind,
      runId: o.runId ?? null,
      turnId: o.turnId ?? null,
      waitId: o.waitId ?? null,
      detail: o.detail ?? null,
      at,
    });
  }

  open(
    d: { id?: string; botId: string; threadId: string; harness?: "coding" | "general" | null; level: string },
    now = Date.now(),
  ): DispatchRecord {
    const id = d.id ?? newStoreId("dsp", now);
    // atomic, not transaction: a worker's insert opens its dispatch inside its own block.
    return atomic(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO dispatches (id, bot_id, thread_id, harness, level, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`,
        )
        .run(id, d.botId, d.threadId, d.harness ?? null, d.level, now, now);
      this.event(id, "queued", now, { detail: { level: d.level } });
      return this.get(id) as DispatchRecord;
    });
  }

  /** The worker meant to run next (set when a wait is claimed or a task requeued). */
  assign(id: string, workerId: string, now = Date.now()): void {
    this.db
      .prepare(
        "UPDATE dispatches SET active_worker_id = ?, updated_at = ? WHERE id = ? AND finished_at IS NULL",
      )
      .run(workerId, now, id);
  }

  /**
   * An execution starts: the fence moves to `runId`. Only the dispatch's
   * assigned worker (or any, before one is assigned) may begin; false = this
   * worker was superseded and must not run.
   */
  begin(id: string, workerId: string, runId: string, now = Date.now()): boolean {
    return transaction(this.db, () => {
      const r = this.db
        .prepare(
          `UPDATE dispatches SET status = 'running', active_worker_id = ?, active_run_id = ?, updated_at = ?
           WHERE id = ? AND status IN ('queued','running') AND (active_worker_id IS NULL OR active_worker_id = ?)`,
        )
        .run(workerId, runId, now, id, workerId);
      if (r.changes !== 1) return false;
      this.event(id, "run.started", now, { runId, detail: { workerId } });
      return true;
    });
  }

  /** Whether `runId` is the current writer of the dispatch. */
  fenced(id: string, runId: string): boolean {
    const r = this.get(id);
    return !!r && r.activeRunId === runId && r.finishedAt === null;
  }

  /** One end event per turn (the unique index refuses a second). */
  turnEnded(id: string, runId: string, turnId: string, kind: TurnEnd, now = Date.now()): boolean {
    try {
      this.event(id, kind, now, { runId, turnId });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Settle the dispatch with the execution's report: only the fenced writer,
   * only once (a second call, or a superseded run, returns false).
   */
  settle(
    id: string,
    runId: string,
    outcome: DispatchOutcome,
    report: unknown,
    now = Date.now(),
    status: DispatchStatus = "settled",
  ): boolean {
    return transaction(this.db, () => {
      const r = this.db
        .prepare(
          `UPDATE dispatches SET status = ?, outcome = ?, report = ?, updated_at = ?, finished_at = ?
           WHERE id = ? AND active_run_id = ? AND finished_at IS NULL AND status IN ('running','queued')`,
        )
        .run(status, outcome, this.sealReport(id, report), now, status === "settled" ? now : null, id, runId);
      if (r.changes !== 1) return false;
      this.closeClaimed(id, now);
      this.event(id, "reported", now, { runId, detail: { outcome } });
      return true;
    });
  }

  /** A NEEDS_INPUT: the report, the dispatch waiting and its open wait, in one step. */
  askInput(
    id: string,
    runId: string,
    report: unknown,
    w: { workerId: string; questions: unknown[]; expiresAt: number | null },
    now = Date.now(),
  ): WaitRecord | undefined {
    return transaction(this.db, () => {
      const d = this.get(id);
      if (!d || d.activeRunId !== runId || d.finishedAt !== null) return undefined;
      const u = this.db
        .prepare(
          `UPDATE dispatches SET status = 'needs_input', outcome = 'needs_input', report = ?, updated_at = ?
           WHERE id = ? AND active_run_id = ? AND status = 'running'`,
        )
        .run(this.sealReport(id, report), now, id, runId);
      if (u.changes !== 1) return undefined;
      this.closeClaimed(id, now);
      this.event(id, "reported", now, { runId, detail: { outcome: "needs_input" } });
      const waitId = newStoreId("hwt", now);
      this.db
        .prepare(
          `INSERT INTO harness_waits (id, dispatch_id, bot_id, thread_id, worker_id, kind, questions, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?, 'needs_input', ?, ?, ?)`,
        )
        .run(waitId, id, d.botId, d.threadId, w.workerId, JSON.stringify(w.questions), w.expiresAt, now);
      return this.wait(waitId);
    });
  }

  /**
   * Plan §5: the worker awaits an outside event (await_event): the dispatch
   * goes to `waiting_event` with an open `event` wait, in one step, only for
   * the fenced writer. `wakeAt` (ms) wakes it on the clock; it expires at
   * `expiresAt`. Undefined when superseded, or when the bot already has
   * `EVENT_WAIT_LIMIT` open event waits.
   */
  awaitEvent(
    id: string,
    runId: string,
    report: unknown,
    w: { workerId: string; note: string; wakeAt: number | null; expiresAt: number; streamId?: string },
    now = Date.now(),
  ): WaitRecord | undefined {
    return transaction(this.db, () => {
      const d = this.get(id);
      if (!d || d.activeRunId !== runId || d.finishedAt !== null) return undefined;
      if (this.openEventWaits(d.botId).length >= EVENT_WAIT_LIMIT) return undefined;
      const u = this.db
        .prepare(
          `UPDATE dispatches SET status = 'waiting_event', report = ?, updated_at = ?
           WHERE id = ? AND active_run_id = ? AND status = 'running'`,
        )
        .run(this.sealReport(id, report), now, id, runId);
      if (u.changes !== 1) return undefined;
      this.closeClaimed(id, now);
      const waitId = newStoreId("hwt", now);
      this.db
        .prepare(
          `INSERT INTO harness_waits (id, dispatch_id, bot_id, thread_id, worker_id, kind, questions, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?, 'event', ?, ?, ?)`,
        )
        .run(
          waitId,
          id,
          d.botId,
          d.threadId,
          w.workerId,
          JSON.stringify([
            { note: w.note, wakeAt: w.wakeAt, ...(w.streamId ? { streamId: w.streamId } : {}) },
          ]),
          w.expiresAt,
          now,
        );
      this.event(id, "awaiting", now, {
        runId,
        waitId,
        detail: { wakeAt: w.wakeAt, ...(w.streamId ? { streamId: w.streamId } : {}) },
      });
      return this.wait(waitId);
    });
  }

  /** A bot's open event waits, oldest first. */
  openEventWaits(botId: string): WaitRecord[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM harness_waits WHERE bot_id = ? AND kind = 'event' AND state = 'open' ORDER BY created_at, rowid",
        )
        .all(botId) as unknown as WaitRow[]
    ).map(toWait);
  }

  /**
   * Design §0.2.2: a bot's open, unexpired event waits on one stream (an
   * outside event on it wakes them), oldest first. At most EVENT_WAIT_LIMIT
   * per bot, so the scan is small.
   */
  streamWaits(botId: string, streamId: string, now = Date.now()): WaitRecord[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM harness_waits WHERE bot_id = ? AND kind = 'event' AND state = 'open'
             AND (expires_at IS NULL OR expires_at > ?) AND json_extract(questions, '$[0].streamId') = ?
           ORDER BY created_at, rowid`,
        )
        .all(botId, now, streamId) as unknown as WaitRow[]
    ).map(toWait);
  }

  /** Open event waits whose wake time has come (the clock wakes them). */
  dueEventWaits(now = Date.now()): WaitRecord[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM harness_waits WHERE kind = 'event' AND state = 'open' ORDER BY created_at, rowid",
        )
        .all() as unknown as WaitRow[]
    )
      .map(toWait)
      .filter((w) => {
        const at = (w.questions[0] as { wakeAt?: unknown } | undefined)?.wakeAt;
        return typeof at === "number" && at <= now;
      });
  }

  wait(id: string): WaitRecord | undefined {
    const r = this.db.prepare("SELECT * FROM harness_waits WHERE id = ?").get(id) as WaitRow | undefined;
    return r ? toWait(r) : undefined;
  }

  /** The wait a worker opened (its NEEDS_INPUT), if any. */
  waitOf(workerId: string): WaitRecord | undefined {
    const r = this.db
      .prepare("SELECT * FROM harness_waits WHERE worker_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(workerId) as WaitRow | undefined;
    return r ? toWait(r) : undefined;
  }

  /**
   * Plan §2.9 wake: claim an open wait for a worker id made up front, in one
   * transaction with the dispatch going back to `queued` for that worker.
   * Exactly one of any number of concurrent claims wins; the rest get false
   * and must not create a worker. An `answer` is recorded with the claim
   * (the unique index keeps it to one per wait).
   */
  claim(
    waitId: string,
    workerId: string,
    now = Date.now(),
    answer?: { answers: string[]; by: string },
  ): boolean {
    // atomic (a SAVEPOINT): the caller wraps claim + the continuation worker's
    // insert in one block, so a failed insert rolls the claim back (design §0.2.1).
    return atomic(this.db, () => {
      const r = this.db
        .prepare("UPDATE harness_waits SET state = 'claimed', claimed_by = ? WHERE id = ? AND state = 'open'")
        .run(workerId, waitId);
      if (r.changes !== 1) return false;
      const w = this.wait(waitId) as WaitRecord;
      const d = this.db
        .prepare(
          `UPDATE dispatches SET status = 'queued', active_worker_id = ?, active_run_id = NULL, updated_at = ?
           WHERE id = ? AND status IN ('needs_input','waiting_event') AND finished_at IS NULL`,
        )
        .run(workerId, now, w.dispatchId);
      if (d.changes !== 1) throw new Error("dispatch is not waiting");
      this.event(w.dispatchId, answer ? "answered" : "woken", now, {
        waitId,
        detail: { workerId, ...(answer ? answer : {}) },
      });
      return true;
    });
  }

  /** The wait a continuation worker was started for closes when that worker reports (B4). */
  private closeClaimed(dispatchId: string, now: number): void {
    this.db
      .prepare(
        "UPDATE harness_waits SET state = 'closed', closed_at = ? WHERE dispatch_id = ? AND state = 'claimed'",
      )
      .run(now, dispatchId);
  }

  /** The continuation worker finished: its wait closes (claimed → closed). */
  closeWait(waitId: string, now = Date.now()): boolean {
    return (
      this.db
        .prepare(
          "UPDATE harness_waits SET state = 'closed', closed_at = ? WHERE id = ? AND state = 'claimed'",
        )
        .run(now, waitId).changes === 1
    );
  }

  /**
   * A worker was stopped after it ended with an open question (or awaited
   * event): the wait closes and its dispatch settles as `stopped`, in one
   * transaction, with a `stopped` event in the ledger. False when the wait
   * was no longer open (answered, woken, expired or stopped already).
   */
  stopWait(waitId: string, reason: string, now = Date.now()): boolean {
    return transaction(this.db, () => {
      const u = this.db
        .prepare("UPDATE harness_waits SET state = 'closed', closed_at = ? WHERE id = ? AND state = 'open'")
        .run(now, waitId);
      if (u.changes !== 1) return false;
      const w = this.wait(waitId) as WaitRecord;
      this.db
        .prepare(
          `UPDATE dispatches SET status = 'settled', outcome = 'stopped', active_run_id = NULL, updated_at = ?, finished_at = ?
           WHERE id = ? AND finished_at IS NULL`,
        )
        .run(now, now, w.dispatchId);
      this.event(w.dispatchId, "stopped", now, {
        waitId,
        detail: { workerId: w.workerId, reason: reason.slice(0, 300) },
      });
      return true;
    });
  }

  /** Open waits past their expiry: each expires and its dispatch settles as `expired`, once. */
  expireWaits(now = Date.now()): WaitRecord[] {
    return transaction(this.db, () => {
      const rows = this.db
        .prepare(
          "SELECT * FROM harness_waits WHERE state = 'open' AND expires_at IS NOT NULL AND expires_at <= ?",
        )
        .all(now) as unknown as WaitRow[];
      const out: WaitRecord[] = [];
      for (const r of rows) {
        const u = this.db
          .prepare(
            "UPDATE harness_waits SET state = 'expired', closed_at = ? WHERE id = ? AND state = 'open'",
          )
          .run(now, r.id);
        if (u.changes !== 1) continue;
        this.db
          .prepare(
            `UPDATE dispatches SET status = 'settled', outcome = 'expired', updated_at = ?, finished_at = ?
             WHERE id = ? AND finished_at IS NULL`,
          )
          .run(now, now, r.dispatch_id);
        this.event(r.dispatch_id, "expired", now, { waitId: r.id });
        out.push(toWait({ ...r, state: "expired", closed_at: now }));
      }
      return out;
    });
  }

  /** Dispatches an execution may have been cut off in (for restart reconciliation). */
  unfinished(): DispatchRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM dispatches WHERE status IN ('queued','running') ORDER BY created_at, rowid")
        .all() as unknown as Row[]
    ).map((r) => toRecord(this.db, r));
  }

  /** Whether an execution of the dispatch did something outward (send, payment, publish, delete, push). */
  hadOutward(id: string): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM dispatch_events WHERE dispatch_id = ? AND kind = 'outward' LIMIT 1")
      .get(id);
  }

  /** Restart reconciliation: run once more (counted), or park for a person, or fail. */
  requeue(id: string, now = Date.now()): boolean {
    return transaction(this.db, () => {
      const r = this.db
        .prepare(
          `UPDATE dispatches SET status = 'queued', requeues = requeues + 1, active_run_id = NULL, updated_at = ?
           WHERE id = ? AND status IN ('queued','running')`,
        )
        .run(now, id);
      if (r.changes === 1) this.event(id, "requeued", now);
      return r.changes === 1;
    });
  }

  park(
    id: string,
    outcome: DispatchOutcome,
    now = Date.now(),
    status: DispatchStatus = "needs_review",
  ): boolean {
    return transaction(this.db, () => {
      const r = this.db
        .prepare(
          `UPDATE dispatches SET status = ?, outcome = ?, active_run_id = NULL, updated_at = ?, finished_at = ?
           WHERE id = ? AND finished_at IS NULL`,
        )
        .run(status, outcome, now, status === "settled" ? now : null, id);
      if (r.changes === 1) this.event(id, "reconciled", now, { detail: { outcome, status } });
      return r.changes === 1;
    });
  }

  /** Settled dispatches older than the retention, with their events and waits (plan §2.9: 30 days). */
  prune(now = Date.now(), days = DISPATCH_RETENTION_DAYS): number {
    const cutoff = now - days * 86_400_000;
    return transaction(this.db, () => {
      const ids = (
        this.db
          .prepare("SELECT id FROM dispatches WHERE finished_at IS NOT NULL AND finished_at < ?")
          .all(cutoff) as Array<{ id: string }>
      ).map((r) => r.id);
      for (const id of ids) {
        this.db.prepare("DELETE FROM dispatches WHERE id = ?").run(id);
        this.db.prepare("DELETE FROM dispatch_events WHERE dispatch_id = ?").run(id);
        this.db.prepare("DELETE FROM harness_waits WHERE dispatch_id = ?").run(id);
      }
      return ids.length;
    });
  }
}
