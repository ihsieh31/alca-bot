import type { DatabaseSync } from "node:sqlite";
import { newStoreId } from "../ids.ts";
import { openValue, sealValue } from "../seal.ts";

export type WorkerStatus =
  | "queued"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "stopped"
  | "needs_review";

export const WORKER_ACTIVE: readonly WorkerStatus[] = ["queued", "running", "waiting"];
export const WORKER_FINAL: readonly WorkerStatus[] = ["succeeded", "failed", "stopped"];

type Initiator = { kind: "user" | "schedule" | "agent" | "webhook"; id: string };

export interface WorkerBudget {
  /** Engine passes / tool steps. */
  maxSteps?: number;
  /** Running time, not counting time spent waiting for a person. */
  maxRunMs?: number;
  maxTokens?: number;
}

/** What the router handed a worker, by id (workers read memory only through these). */
export interface WorkerGrants {
  memoryIds?: string[];
  skillId?: string;
  /** Plan §0.2: the harness this worker runs under (absent = a plain worker). */
  harness?: "coding" | "general";
  /** The dispatch (ledger row) this worker serves; continuation workers share it. */
  dispatchId?: string;
  doneWhen?: string;
  workdir?: string;
  ownsPaths?: string[];
  /** Plan §2.5: the dispatch's own check commands. */
  checks?: string[];
  handoffFrom?: string;
  /** The open wait (NEEDS_INPUT or event) this worker was started to continue. */
  waitId?: string;
  /**
   * Design §0.2.4: the JSON Schema `report_result.data` must match (the
   * subset `harness/schema.ts` checks). Set by the host (routines), carried
   * to continuation workers.
   */
  resultSchema?: Record<string, unknown>;
}

export interface WorkerResultRecord {
  mode: "inline" | "spill";
  summary: string;
  chars: number;
  spillId?: string;
}

/** Failed tool calls of a worker's runs (C2): how many, and the last call's error when that call failed. */
export interface WorkerToolErrors {
  count: number;
  /** Set only when the worker's last tool call failed (it did not recover). */
  last: string | null;
}

export interface WorkerRecord {
  id: string;
  botId: string;
  threadId: string;
  jobId: string;
  parentRunId: string | null;
  runId: string | null;
  title: string;
  goal: string;
  initiator: Initiator;
  speculative: boolean;
  status: WorkerStatus;
  steps: number;
  /** Tokens counted against the budget (cache reads weigh a tenth: core/harness/usage.ts). */
  tokens: number;
  /** Prompt-cache reads, booked apart (mac test B3). */
  cachedTokens: number;
  budget: WorkerBudget;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  lastActivityAt: string | null;
  waitingSince: string | null;
  waitedMs: number;
  stopReason: string | null;
  result: WorkerResultRecord | null;
  grants: WorkerGrants;
  toolErrors: WorkerToolErrors;
}

interface WorkerRow {
  id: string;
  bot_id: string;
  thread_id: string;
  job_id: string;
  parent_run_id: string | null;
  run_id: string | null;
  title: string;
  goal: string;
  initiator_kind: Initiator["kind"];
  initiator_id: string;
  speculative: number;
  status: WorkerStatus;
  steps: number;
  tokens: number;
  cached_tokens: number | null;
  budget: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  last_activity_at: string | null;
  waiting_since: string | null;
  waited_ms: number;
  stop_reason: string | null;
  result_mode: "inline" | "spill" | null;
  result_summary: string | null;
  result_chars: number | null;
  spill_id: string | null;
  grants: string | null;
  tool_errors: number | null;
  last_tool_error: string | null;
}

const worker = (db: DatabaseSync, r: WorkerRow): WorkerRecord => ({
  id: r.id,
  botId: r.bot_id,
  threadId: r.thread_id,
  jobId: r.job_id,
  parentRunId: r.parent_run_id,
  runId: r.run_id,
  title: r.title,
  goal: openValue(db, "workers", "goal", r.id, r.goal),
  initiator: { kind: r.initiator_kind, id: r.initiator_id },
  speculative: r.speculative === 1,
  status: r.status,
  steps: r.steps,
  tokens: r.tokens,
  cachedTokens: r.cached_tokens ?? 0,
  budget: JSON.parse(r.budget) as WorkerBudget,
  createdAt: r.created_at,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  lastActivityAt: r.last_activity_at,
  waitingSince: r.waiting_since,
  waitedMs: r.waited_ms,
  stopReason: r.stop_reason,
  result: r.result_mode
    ? {
        mode: r.result_mode,
        summary: openValue(db, "workers", "result_summary", r.id, r.result_summary) ?? "",
        chars: r.result_chars ?? 0,
        ...(r.spill_id ? { spillId: r.spill_id } : {}),
      }
    : null,
  grants: r.grants ? (JSON.parse(r.grants) as WorkerGrants) : {},
  toolErrors: { count: r.tool_errors ?? 0, last: r.last_tool_error ?? null },
});

export interface SpillRecord {
  id: string;
  botId: string;
  ownerKind: "worker" | "trigger_event";
  ownerId: string;
  title: string;
  body: string;
  chars: number;
  createdAt: string;
}

export interface InboxItem {
  id: string;
  botId: string;
  threadId: string;
  kind: "worker_report" | "trigger" | "peer_request" | "peer_report";
  refId: string;
  body: string;
  initiator: Initiator;
  status: "pending" | "delivered";
  runId: string | null;
  createdAt: string;
}

export interface WorkerInboxItem {
  id: string;
  workerId: string;
  streamId: string | null;
  eventId: string | null;
  body: string;
  createdAt: string;
}

/**
 * Workers (one per task), their spilled results, and the two inboxes that
 * carry results to a bot's router and stream events to workers. Pending
 * inbox rows survive a restart and are delivered after it.
 */
export class WorkerRepo {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  // ── workers ────────────────────────────────────────────────
  create(
    w: {
      id?: string;
      botId: string;
      threadId: string;
      jobId: string;
      parentRunId?: string | null;
      title: string;
      goal: string;
      initiator: Initiator;
      speculative?: boolean;
      budget?: WorkerBudget;
      grants?: WorkerGrants;
    },
    now = new Date(),
  ): WorkerRecord {
    const id = w.id ?? newStoreId("wkr", now.getTime());
    this.db
      .prepare(
        `INSERT INTO workers (id, bot_id, thread_id, job_id, parent_run_id, title, goal, initiator_kind,
           initiator_id, speculative, budget, grants, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        w.botId,
        w.threadId,
        w.jobId,
        w.parentRunId ?? null,
        w.title.trim().slice(0, 80) || "工作",
        sealValue(this.db, "workers", "goal", id, w.goal),
        w.initiator.kind,
        w.initiator.id,
        w.speculative ? 1 : 0,
        JSON.stringify(w.budget ?? {}),
        JSON.stringify(w.grants ?? {}),
        now.toISOString(),
      );
    return this.get(id) as WorkerRecord;
  }

  get(id: string): WorkerRecord | undefined {
    const r = this.db.prepare("SELECT * FROM workers WHERE id = ?").get(id) as WorkerRow | undefined;
    return r ? worker(this.db, r) : undefined;
  }

  byThread(threadId: string): WorkerRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM workers WHERE thread_id = ? ORDER BY created_at, rowid")
      .all(threadId) as unknown as WorkerRow[];
    return rows.map((r) => worker(this.db, r));
  }

  /** Workers that have not finished (queued / running / waiting), optionally of one bot. */
  active(botId?: string): WorkerRecord[] {
    const rows = (botId
      ? this.db
          .prepare(
            "SELECT * FROM workers WHERE status IN ('queued','running','waiting') AND bot_id = ? ORDER BY created_at, rowid",
          )
          .all(botId)
      : this.db
          .prepare(
            "SELECT * FROM workers WHERE status IN ('queued','running','waiting') ORDER BY created_at, rowid",
          )
          .all()) as unknown as WorkerRow[];
    return rows.map((r) => worker(this.db, r));
  }

  byRun(runId: string): WorkerRecord | undefined {
    const r = this.db
      .prepare("SELECT w.* FROM workers w JOIN runs r ON r.worker_id = w.id WHERE r.id = ?")
      .get(runId) as WorkerRow | undefined;
    return r ? worker(this.db, r) : undefined;
  }

  /** The worker is running a new run (first start, follow-up event, or after a restart). */
  started(id: string, runId: string, now = new Date()): void {
    const ts = now.toISOString();
    this.db
      .prepare(
        `UPDATE workers SET status = 'running', run_id = ?, started_at = COALESCE(started_at, ?),
           last_activity_at = ?, waiting_since = NULL WHERE id = ?`,
      )
      .run(runId, ts, ts, id);
  }

  /** Some progress (a tool call finished, text arrived, tokens were spent). */
  activity(
    id: string,
    now = new Date(),
    d: { steps?: number; tokens?: number; cachedTokens?: number } = {},
  ): void {
    this.db
      .prepare(
        "UPDATE workers SET last_activity_at = ?, steps = steps + ?, tokens = tokens + ?, cached_tokens = cached_tokens + ? WHERE id = ?",
      )
      .run(now.toISOString(), d.steps ?? 0, d.tokens ?? 0, d.cachedTokens ?? 0, id);
  }

  /** Waiting for a person (an approval card): not stuck, and the time does not count against the budget. */
  setWaiting(id: string, waiting: boolean, now = new Date()): void {
    const ts = now.toISOString();
    if (waiting) {
      this.db
        .prepare(
          "UPDATE workers SET status = 'waiting', waiting_since = COALESCE(waiting_since, ?) WHERE id = ? AND status IN ('running','waiting')",
        )
        .run(ts, id);
      return;
    }
    const w = this.get(id);
    if (w?.status !== "waiting") return;
    const waited = w.waitingSince ? Math.max(0, now.getTime() - Date.parse(w.waitingSince)) : 0;
    this.db
      .prepare(
        `UPDATE workers SET status = 'running', waiting_since = NULL, waited_ms = waited_ms + ?,
           last_activity_at = ? WHERE id = ? AND status = 'waiting'`,
      )
      .run(waited, ts, id);
  }

  setStatus(id: string, status: WorkerStatus, extra: { stopReason?: string } = {}): void {
    this.db
      .prepare("UPDATE workers SET status = ?, stop_reason = COALESCE(?, stop_reason) WHERE id = ?")
      .run(status, extra.stopReason ?? null, id);
  }

  /** Close the worker once. A second finish (a race between stop and completion) changes nothing. */
  finish(
    id: string,
    status: "succeeded" | "failed" | "stopped",
    now = new Date(),
    extra: { stopReason?: string; result?: WorkerResultRecord; toolErrors?: WorkerToolErrors } = {},
  ): boolean {
    const r = extra.result;
    const te = extra.toolErrors;
    const res = this.db
      .prepare(
        `UPDATE workers SET status = ?, finished_at = ?, waiting_since = NULL,
           stop_reason = COALESCE(?, stop_reason), result_mode = ?, result_summary = ?, result_chars = ?,
           spill_id = ?, tool_errors = ?, last_tool_error = ?
         WHERE id = ? AND status NOT IN ('succeeded','failed','stopped')`,
      )
      .run(
        status,
        now.toISOString(),
        extra.stopReason ?? null,
        r?.mode ?? null,
        sealValue(this.db, "workers", "result_summary", id, r?.summary ?? null),
        r?.chars ?? null,
        r?.spillId ?? null,
        te?.count ?? 0,
        te?.last ?? null,
        id,
      );
    return Number(res.changes) === 1;
  }

  // ── engine conversations and router sessions ───────────────
  conversation(key: string, engineId: string): string | undefined {
    const r = this.db
      .prepare("SELECT session_id FROM engine_conversations WHERE key = ? AND engine_id = ?")
      .get(key, engineId) as { session_id: string } | undefined;
    return r?.session_id;
  }

  setConversation(key: string, engineId: string, sessionId: string, now = new Date()): void {
    this.db
      .prepare(
        `INSERT INTO engine_conversations (key, engine_id, session_id, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (key, engine_id) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at`,
      )
      .run(key, engineId, sessionId, now.toISOString());
  }

  /** Review 2026-11-05 #4: forget a conversation the engine could not resume. */
  clearConversation(key: string, engineId: string): void {
    this.db.prepare("DELETE FROM engine_conversations WHERE key = ? AND engine_id = ?").run(key, engineId);
  }

  /** The bot's one resident router conversation (created on first use, kept forever). */
  routerSession(botId: string, now = new Date()): string {
    const key = `router.${botId}`;
    this.db
      .prepare(
        "INSERT INTO router_sessions (bot_id, session_key, created_at) VALUES (?, ?, ?) ON CONFLICT (bot_id) DO NOTHING",
      )
      .run(botId, key, now.toISOString());
    const r = this.db.prepare("SELECT session_key FROM router_sessions WHERE bot_id = ?").get(botId) as {
      session_key: string;
    };
    return r.session_key;
  }

  routerTurn(botId: string, now = new Date()): void {
    this.db
      .prepare("UPDATE router_sessions SET last_turn_at = ? WHERE bot_id = ?")
      .run(now.toISOString(), botId);
  }

  // ── spills ─────────────────────────────────────────────────
  addSpill(s: Omit<SpillRecord, "id" | "chars" | "createdAt">, now = new Date()): SpillRecord {
    const id = newStoreId("spl", now.getTime());
    this.db
      .prepare(
        `INSERT INTO spills (id, bot_id, owner_kind, owner_id, title, body, chars, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        s.botId,
        s.ownerKind,
        s.ownerId,
        s.title,
        sealValue(this.db, "spills", "body", id, s.body),
        [...s.body].length,
        now.toISOString(),
      );
    return this.spill(id) as SpillRecord;
  }

  spill(id: string): SpillRecord | undefined {
    const r = this.db.prepare("SELECT * FROM spills WHERE id = ?").get(id) as
      | {
          id: string;
          bot_id: string;
          owner_kind: SpillRecord["ownerKind"];
          owner_id: string;
          title: string;
          body: string;
          chars: number;
          created_at: string;
        }
      | undefined;
    return r
      ? {
          id: r.id,
          botId: r.bot_id,
          ownerKind: r.owner_kind,
          ownerId: r.owner_id,
          title: r.title,
          body: openValue(this.db, "spills", "body", r.id, r.body),
          chars: r.chars,
          createdAt: r.created_at,
        }
      : undefined;
  }

  spillsOf(ownerId: string): string[] {
    const rows = this.db
      .prepare("SELECT id FROM spills WHERE owner_id = ? ORDER BY created_at, rowid")
      .all(ownerId) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  // ── router inbox ───────────────────────────────────────────
  addInbox(i: Omit<InboxItem, "id" | "status" | "runId" | "createdAt">, now = new Date()): InboxItem {
    const id = newStoreId("ibx", now.getTime());
    this.db
      .prepare(
        `INSERT INTO router_inbox (id, bot_id, thread_id, kind, ref_id, body, initiator_kind, initiator_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        i.botId,
        i.threadId,
        i.kind,
        i.refId,
        sealValue(this.db, "router_inbox", "body", id, i.body),
        i.initiator.kind,
        i.initiator.id,
        now.toISOString(),
      );
    return this.inboxItem(id) as InboxItem;
  }

  private inboxRow(r: Record<string, unknown>): InboxItem {
    return {
      id: r.id as string,
      botId: r.bot_id as string,
      threadId: r.thread_id as string,
      kind: r.kind as InboxItem["kind"],
      refId: r.ref_id as string,
      body: openValue(this.db, "router_inbox", "body", r.id as string, r.body as string),
      initiator: { kind: r.initiator_kind as Initiator["kind"], id: r.initiator_id as string },
      status: r.status as InboxItem["status"],
      runId: (r.run_id as string | null) ?? null,
      createdAt: r.created_at as string,
    };
  }

  inboxItem(id: string): InboxItem | undefined {
    const r = this.db.prepare("SELECT * FROM router_inbox WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? this.inboxRow(r) : undefined;
  }

  pendingInbox(botId?: string): InboxItem[] {
    const rows = (
      botId
        ? this.db
            .prepare(
              "SELECT * FROM router_inbox WHERE status = 'pending' AND bot_id = ? ORDER BY created_at, rowid",
            )
            .all(botId)
        : this.db
            .prepare("SELECT * FROM router_inbox WHERE status = 'pending' ORDER BY created_at, rowid")
            .all()
    ) as Array<Record<string, unknown>>;
    return rows.map((r) => this.inboxRow(r));
  }

  delivered(id: string, runId: string, now = new Date()): boolean {
    const r = this.db
      .prepare(
        "UPDATE router_inbox SET status = 'delivered', run_id = ?, delivered_at = ? WHERE id = ? AND status = 'pending'",
      )
      .run(runId, now.toISOString(), id);
    return Number(r.changes) === 1;
  }

  /**
   * After a restart: items whose router run was cut off (interrupted) go back
   * to pending so the router still hears about them. The router has no
   * outbound tools, so hearing a report twice is harmless; missing it is not.
   */
  redeliverInterrupted(): number {
    const r = this.db
      .prepare(
        `UPDATE router_inbox SET status = 'pending', run_id = NULL, delivered_at = NULL
         WHERE status = 'delivered' AND run_id IN (SELECT id FROM runs WHERE finish_reason = 'interrupted')`,
      )
      .run();
    return Number(r.changes);
  }

  // ── worker inbox (stream pass-through) ─────────────────────
  addWorkerInbox(i: Omit<WorkerInboxItem, "id" | "createdAt">, now = new Date()): WorkerInboxItem {
    const id = newStoreId("wib", now.getTime());
    this.db
      .prepare(
        "INSERT INTO worker_inbox (id, worker_id, stream_id, event_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        i.workerId,
        i.streamId,
        i.eventId,
        sealValue(this.db, "worker_inbox", "body", id, i.body),
        now.toISOString(),
      );
    return { ...i, id, createdAt: now.toISOString() };
  }

  pendingWorkerInbox(workerId: string): WorkerInboxItem[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM worker_inbox WHERE worker_id = ? AND status = 'pending' ORDER BY created_at, rowid",
      )
      .all(workerId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as string,
      workerId: r.worker_id as string,
      streamId: (r.stream_id as string | null) ?? null,
      eventId: (r.event_id as string | null) ?? null,
      body: openValue(this.db, "worker_inbox", "body", r.id as string, r.body as string),
      createdAt: r.created_at as string,
    }));
  }

  workerInboxDelivered(ids: readonly string[], now = new Date()): void {
    const stmt = this.db.prepare(
      "UPDATE worker_inbox SET status = 'delivered', delivered_at = ? WHERE id = ? AND status = 'pending'",
    );
    for (const id of ids) stmt.run(now.toISOString(), id);
  }
}
