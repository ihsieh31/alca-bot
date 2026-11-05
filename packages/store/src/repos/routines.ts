import type { DatabaseSync } from "node:sqlite";
import { atomic } from "../db.ts";
import { newStoreId } from "../ids.ts";
import { openValue, sealValue } from "../seal.ts";

export type RoutineKind = "interval" | "cron" | "once" | "trigger";
export type RoutineOutcome =
  | "quiet"
  | "new"
  | "read_failed"
  | "capped"
  | "ai_done"
  | "ai_invalid"
  | "ai_failed";

export interface RoutineRecord {
  id: string;
  botId: string;
  threadId: string;
  name: string;
  kind: RoutineKind;
  intervalSec: number | null;
  cron: string | null;
  tz: string | null;
  runAt: string | null;
  triggerId: string | null;
  check: Record<string, unknown>;
  instructions: string;
  speculative: boolean;
  cursor: Record<string, unknown>;
  nextDueAt: string | null;
  enabled: boolean;
  failCount: number;
  backoffUntil: string | null;
  lastError: string | null;
  lastCheckedAt: string | null;
  lastAiAt: string | null;
  pendingWorker: string | null;
  pendingCursor: Record<string, unknown> | null;
  removedAt: string | null;
  createdAt: string;
}

export interface RoutineRunRecord {
  id: string;
  routineId: string;
  botId: string;
  outcome: RoutineOutcome;
  items: number;
  workerId: string | null;
  detail: string;
  output: unknown;
  createdAt: string;
}

export interface DraftRecord {
  id: string;
  botId: string;
  threadId: string;
  workerId: string | null;
  routineId: string | null;
  accountId: string | null;
  kind: "reply" | "message" | "note";
  title: string;
  body: string;
  target: Record<string, unknown>;
  status: "ready" | "used" | "discarded";
  createdAt: string;
  updatedAt: string;
}

const json = (s: unknown) => JSON.parse(s as string) as Record<string, unknown>;

const routine = (r: Record<string, unknown>): RoutineRecord => ({
  id: r.id as string,
  botId: r.bot_id as string,
  threadId: r.thread_id as string,
  name: r.name as string,
  kind: r.kind as RoutineKind,
  intervalSec: (r.interval_sec as number | null) ?? null,
  cron: (r.cron as string | null) ?? null,
  tz: (r.tz as string | null) ?? null,
  runAt: (r.run_at as string | null) ?? null,
  triggerId: (r.trigger_id as string | null) ?? null,
  check: json(r.check_spec),
  instructions: r.instructions as string,
  speculative: r.speculative === 1,
  cursor: json(r.cursor),
  nextDueAt: (r.next_due_at as string | null) ?? null,
  enabled: r.enabled === 1,
  failCount: r.fail_count as number,
  backoffUntil: (r.backoff_until as string | null) ?? null,
  lastError: (r.last_error as string | null) ?? null,
  lastCheckedAt: (r.last_checked_at as string | null) ?? null,
  lastAiAt: (r.last_ai_at as string | null) ?? null,
  pendingWorker: (r.pending_worker as string | null) ?? null,
  pendingCursor: r.pending_cursor ? json(r.pending_cursor) : null,
  removedAt: (r.removed_at as string | null) ?? null,
  createdAt: r.created_at as string,
});

const run = (r: Record<string, unknown>): RoutineRunRecord => ({
  id: r.id as string,
  routineId: r.routine_id as string,
  botId: r.bot_id as string,
  outcome: r.outcome as RoutineOutcome,
  items: r.items as number,
  workerId: (r.worker_id as string | null) ?? null,
  detail: r.detail as string,
  output: r.output ? (JSON.parse(r.output as string) as unknown) : null,
  createdAt: r.created_at as string,
});

const draft = (db: DatabaseSync, r: Record<string, unknown>): DraftRecord => ({
  id: r.id as string,
  botId: r.bot_id as string,
  threadId: r.thread_id as string,
  workerId: (r.worker_id as string | null) ?? null,
  routineId: (r.routine_id as string | null) ?? null,
  accountId: (r.account_id as string | null) ?? null,
  kind: r.kind as DraftRecord["kind"],
  title: r.title as string,
  body: openValue(db, "drafts", "body", r.id as string, r.body as string),
  target: json(r.target),
  status: r.status as DraftRecord["status"],
  createdAt: r.created_at as string,
  updatedAt: r.updated_at as string,
});

/** Routines, their append-only run log, the queue of trigger-based routines, and prepared drafts. */
export class RoutineRepo {
  readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  create(r: {
    botId: string;
    threadId: string;
    name: string;
    kind: RoutineKind;
    intervalSec?: number | null;
    cron?: string | null;
    tz?: string | null;
    runAt?: string | null;
    triggerId?: string | null;
    check: Record<string, unknown>;
    instructions?: string;
    speculative?: boolean;
    nextDueAt: string | null;
  }): RoutineRecord {
    const id = newStoreId("rtn");
    this.db
      .prepare(
        `INSERT INTO routines (id, bot_id, thread_id, name, kind, interval_sec, cron, tz, run_at, trigger_id,
           check_spec, instructions, speculative, next_due_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        r.botId,
        r.threadId,
        r.name,
        r.kind,
        r.intervalSec ?? null,
        r.cron ?? null,
        r.tz ?? null,
        r.runAt ?? null,
        r.triggerId ?? null,
        JSON.stringify(r.check),
        r.instructions ?? "",
        r.speculative ? 1 : 0,
        r.nextDueAt,
        new Date().toISOString(),
      );
    return this.get(id) as RoutineRecord;
  }

  get(id: string): RoutineRecord | undefined {
    const r = this.db.prepare("SELECT * FROM routines WHERE id = ?").get(id);
    return r ? routine(r as Record<string, unknown>) : undefined;
  }

  list(botId?: string): RoutineRecord[] {
    const rows = (
      botId
        ? this.db
            .prepare("SELECT * FROM routines WHERE bot_id = ? AND removed_at IS NULL ORDER BY created_at")
            .all(botId)
        : this.db.prepare("SELECT * FROM routines WHERE removed_at IS NULL ORDER BY created_at").all()
    ) as Record<string, unknown>[];
    return rows.map(routine);
  }

  byTrigger(triggerId: string): RoutineRecord | undefined {
    const r = this.db.prepare("SELECT * FROM routines WHERE trigger_id = ? AND enabled = 1").get(triggerId);
    return r ? routine(r as Record<string, unknown>) : undefined;
  }

  byPendingWorker(workerId: string): RoutineRecord | undefined {
    const r = this.db.prepare("SELECT * FROM routines WHERE pending_worker = ?").get(workerId);
    return r ? routine(r as Record<string, unknown>) : undefined;
  }

  /** Routines to look at now: schedule due (or a trigger queue with items), not backing off, no AI run in flight. */
  due(now: string): RoutineRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM routines r WHERE enabled = 1 AND pending_worker IS NULL
           AND (backoff_until IS NULL OR backoff_until <= ?)
           AND ((kind <> 'trigger' AND next_due_at IS NOT NULL AND next_due_at <= ?)
             OR (kind = 'trigger' AND EXISTS (SELECT 1 FROM routine_items i WHERE i.routine_id = r.id
                   AND i.seq > COALESCE(json_extract(r.cursor, '$.seq'), 0))))
         ORDER BY COALESCE(next_due_at, created_at), id`,
      )
      .all(now, now) as Record<string, unknown>[];
    return rows.map(routine);
  }

  /** Compare-and-set on the schedule slot: only one tick claims a due slot. */
  claimSlot(id: string, dueAt: string | null, next: string | null): boolean {
    const r =
      dueAt === null
        ? { changes: 1 }
        : this.db
            .prepare("UPDATE routines SET next_due_at = ? WHERE id = ? AND next_due_at = ?")
            .run(next, id, dueAt);
    return Number(r.changes) === 1;
  }

  setEnabled(id: string, enabled: boolean, nextDueAt?: string | null): void {
    if (this.get(id)?.removedAt) return;
    this.db
      .prepare(
        `UPDATE routines SET enabled = ?, next_due_at = CASE WHEN ? THEN ? ELSE next_due_at END,
           backoff_until = CASE WHEN ? = 1 THEN NULL ELSE backoff_until END WHERE id = ?`,
      )
      .run(enabled ? 1 : 0, nextDueAt !== undefined ? 1 : 0, nextDueAt ?? null, enabled ? 1 : 0, id);
  }

  setNextDue(id: string, nextDueAt: string | null): void {
    this.db.prepare("UPDATE routines SET next_due_at = ? WHERE id = ?").run(nextDueAt, id);
  }

  /** A read failed: the data cursor is untouched; count it and back off. */
  readFailed(id: string, error: string, backoffUntil: string): void {
    this.db
      .prepare(
        "UPDATE routines SET fail_count = fail_count + 1, last_error = ?, backoff_until = ?, last_checked_at = ? WHERE id = ?",
      )
      .run(error.slice(0, 500), backoffUntil, new Date().toISOString(), id);
  }

  checked(id: string): void {
    this.db
      .prepare(
        "UPDATE routines SET fail_count = 0, last_error = NULL, backoff_until = NULL, last_checked_at = ? WHERE id = ?",
      )
      .run(new Date().toISOString(), id);
  }

  /** An AI run started for new items; the cursor it would move to waits beside it. */
  aiStarted(id: string, workerId: string, pendingCursor: Record<string, unknown>): void {
    this.db
      .prepare("UPDATE routines SET pending_worker = ?, pending_cursor = ?, last_ai_at = ? WHERE id = ?")
      .run(workerId, JSON.stringify(pendingCursor), new Date().toISOString(), id);
  }

  /**
   * The AI run ended. With `save`, its result row and the cursor move happen in
   * one transaction (the cursor never moves past items whose result is not saved).
   */
  aiEnded(
    id: string,
    o: { save?: { output: unknown; items: number; workerId: string; detail?: string }; fail?: string },
  ): RoutineRunRecord | undefined {
    return atomic(this.db, () => {
      const r = this.get(id);
      if (!r) return undefined;
      let row: RoutineRunRecord | undefined;
      if (o.save) {
        row = this.addRun({
          routineId: id,
          botId: r.botId,
          outcome: "ai_done",
          items: o.save.items,
          workerId: o.save.workerId,
          detail: o.save.detail ?? "",
          output: o.save.output,
        });
        this.db
          .prepare(
            "UPDATE routines SET cursor = COALESCE(pending_cursor, cursor), pending_worker = NULL, pending_cursor = NULL WHERE id = ?",
          )
          .run(id);
      } else {
        this.db
          .prepare(
            "UPDATE routines SET pending_worker = NULL, pending_cursor = NULL, last_error = ?, fail_count = fail_count + 1 WHERE id = ?",
          )
          .run((o.fail ?? "").slice(0, 500), id);
      }
      return row;
    });
  }

  setBackoff(id: string, until: string | null): void {
    this.db.prepare("UPDATE routines SET backoff_until = ? WHERE id = ?").run(until, id);
  }

  remove(id: string): void {
    // Routines are disabled, not deleted: their run log refers to them.
    this.db
      .prepare("UPDATE routines SET enabled = 0, next_due_at = NULL, removed_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
  }

  addRun(r: {
    routineId: string;
    botId: string;
    outcome: RoutineOutcome;
    items?: number;
    workerId?: string | null;
    detail?: string;
    output?: unknown;
  }): RoutineRunRecord {
    const id = newStoreId("rrn");
    this.db
      .prepare(
        `INSERT INTO routine_runs (id, routine_id, bot_id, outcome, items, worker_id, detail, output, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        r.routineId,
        r.botId,
        r.outcome,
        r.items ?? 0,
        r.workerId ?? null,
        (r.detail ?? "").slice(0, 2000),
        r.output === undefined ? null : JSON.stringify(r.output),
        new Date().toISOString(),
      );
    return run(this.db.prepare("SELECT * FROM routine_runs WHERE id = ?").get(id) as Record<string, unknown>);
  }

  runs(routineId: string, limit = 20): RoutineRunRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM routine_runs WHERE routine_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?")
      .all(routineId, limit) as Record<string, unknown>[];
    return rows.map(run);
  }

  /** AI runs (outcome `new`) a bot's routines started since `since`. */
  aiRunsSince(botId: string, since: string): number {
    const r = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM routine_runs WHERE bot_id = ? AND outcome = 'new' AND created_at >= ?",
      )
      .get(botId, since) as { n: number };
    return r.n;
  }

  /** Queue an item for a trigger-based routine (a duplicate key is ignored). */
  enqueueItem(routineId: string, key: string, payload: Record<string, unknown>): boolean {
    const r = this.db
      .prepare(
        "INSERT OR IGNORE INTO routine_items (routine_id, item_key, payload, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(
        routineId,
        key,
        sealValue(this.db, "routine_items", "payload", `${routineId}:${key}`, JSON.stringify(payload)),
        new Date().toISOString(),
      );
    return Number(r.changes) === 1;
  }

  itemsAfter(
    routineId: string,
    seq: number,
    limit = 50,
  ): Array<{ seq: number; key: string; payload: Record<string, unknown> }> {
    const rows = this.db
      .prepare(
        "SELECT seq, item_key, payload FROM routine_items WHERE routine_id = ? AND seq > ? ORDER BY seq LIMIT ?",
      )
      .all(routineId, seq, limit) as Array<{ seq: number; item_key: string; payload: string }>;
    return rows.map((r) => ({
      seq: r.seq,
      key: r.item_key,
      payload: json(openValue(this.db, "routine_items", "payload", `${routineId}:${r.item_key}`, r.payload)),
    }));
  }

  addDraft(d: {
    botId: string;
    threadId: string;
    workerId?: string | null;
    routineId?: string | null;
    accountId?: string | null;
    kind: DraftRecord["kind"];
    title: string;
    body: string;
    target?: Record<string, unknown>;
  }): DraftRecord {
    const id = newStoreId("drf");
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO drafts (id, bot_id, thread_id, worker_id, routine_id, account_id, kind, title, body, target, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        d.botId,
        d.threadId,
        d.workerId ?? null,
        d.routineId ?? null,
        d.accountId ?? null,
        d.kind,
        d.title.slice(0, 120),
        sealValue(this.db, "drafts", "body", id, d.body.slice(0, 20000)),
        JSON.stringify(d.target ?? {}),
        now,
        now,
      );
    return this.draft(id) as DraftRecord;
  }

  draft(id: string): DraftRecord | undefined {
    const r = this.db.prepare("SELECT * FROM drafts WHERE id = ?").get(id);
    return r ? draft(this.db, r as Record<string, unknown>) : undefined;
  }

  drafts(
    o: { threadId?: string; botId?: string; workerId?: string; status?: DraftRecord["status"] } = {},
  ): DraftRecord[] {
    const where: string[] = [];
    const args: string[] = [];
    if (o.workerId) {
      where.push("worker_id = ?");
      args.push(o.workerId);
    }
    if (o.threadId) {
      where.push("thread_id = ?");
      args.push(o.threadId);
    }
    if (o.botId) {
      where.push("bot_id = ?");
      args.push(o.botId);
    }
    if (o.status) {
      where.push("status = ?");
      args.push(o.status);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM drafts ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT 100`,
      )
      .all(...args) as Record<string, unknown>[];
    return rows.map((r) => draft(this.db, r));
  }

  setDraftStatus(id: string, status: DraftRecord["status"]): void {
    this.db
      .prepare("UPDATE drafts SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, new Date().toISOString(), id);
  }
}
