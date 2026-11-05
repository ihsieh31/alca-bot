import type { DatabaseSync, StatementSync } from "node:sqlite";
import { openValue, sealValue } from "../seal.ts";
import {
  batchText,
  chunkItem,
  chunkOf,
  type EventBatching,
  eventItem,
  expandBatch,
  RUN_EVENT_BATCH,
} from "./run-batch.ts";

export { type EventBatching, RUN_EVENT_BATCH } from "./run-batch.ts";

interface PendingBatch {
  first: number;
  next: number;
  chars: number;
  at: string;
  template: string | null;
  items: string[];
  timer: ReturnType<typeof setTimeout> | undefined;
}

export type RunStatus = "running" | "waiting" | "finished";
export type RunFinishReason =
  | "completed"
  | "cancelled"
  | "failed"
  | "interrupted"
  | "max_turns"
  | "awaiting_input"
  | "handed_off";

export interface RunRecord {
  id: string;
  threadId: string;
  parentRunId: string | null;
  status: RunStatus;
  finishReason: RunFinishReason | null;
  initiator: { kind: "user" | "schedule" | "agent" | "webhook"; id: string };
  engine: string | null;
  startedAt: string;
  finishedAt: string | null;
  workerId: string | null;
  /** Bot that spoke in this run (P7; null before migration 8). */
  botId: string | null;
}

interface RunRow {
  id: string;
  thread_id: string;
  parent_run_id: string | null;
  status: RunStatus;
  finish_reason: RunFinishReason | null;
  initiator_kind: RunRecord["initiator"]["kind"];
  initiator_id: string;
  engine: string | null;
  started_at: string;
  finished_at: string | null;
  worker_id?: string | null;
  bot_id?: string | null;
}

const run = (r: RunRow): RunRecord => ({
  id: r.id,
  threadId: r.thread_id,
  parentRunId: r.parent_run_id,
  status: r.status,
  finishReason: r.finish_reason,
  initiator: { kind: r.initiator_kind, id: r.initiator_id },
  engine: r.engine,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  workerId: r.worker_id ?? null,
  botId: r.bot_id ?? null,
});

/** A protocol event as stored (payload is the full event JSON). */
export interface StoredRunEvent {
  runId: string;
  seq: number;
  type: string;
  payload: unknown;
}

/** Runs and their append-only protocol event log. */
export class RunRepo {
  private readonly db: DatabaseSync;
  private readonly batch: EventBatching;
  /** R7.7: streamed chunks held per run until their batch is written (`run-batch.ts`). */
  private readonly pending = new Map<string, PendingBatch>();
  /** A batch the timer could not write (the run was erased meanwhile): reported, never thrown at nobody. */
  private readonly onFlushError: (err: unknown) => void;
  private insertSt: StatementSync | undefined;
  /** Highest seq written or held per run in this process: a batch row is filed under its first seq only, so the primary key alone no longer catches a repeat. */
  private readonly lastSeq = new Map<string, number>();

  constructor(
    db: DatabaseSync,
    o: { batch?: Partial<EventBatching>; onFlushError?: (err: unknown) => void } = {},
  ) {
    this.db = db;
    this.batch = { ...RUN_EVENT_BATCH, ...o.batch };
    this.onFlushError = o.onFlushError ?? (() => {});
  }

  start(
    r: Pick<RunRecord, "id" | "threadId" | "initiator"> & {
      engine?: string;
      parentRunId?: string;
      /** Set for a worker's run (P3); the thread's chat shows only router runs. */
      workerId?: string;
      /** The bot speaking in this run (P7). */
      botId?: string;
    },
    now = new Date(),
  ): RunRecord {
    this.db
      .prepare(
        `INSERT INTO runs (id, thread_id, parent_run_id, initiator_kind, initiator_id, engine, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.id,
        r.threadId,
        r.parentRunId ?? null,
        r.initiator.kind,
        r.initiator.id,
        r.engine ?? null,
        now.toISOString(),
      );
    if (r.workerId) this.db.prepare("UPDATE runs SET worker_id = ? WHERE id = ?").run(r.workerId, r.id);
    if (r.botId) this.db.prepare("UPDATE runs SET bot_id = ? WHERE id = ?").run(r.botId, r.id);
    return this.get(r.id) as RunRecord;
  }

  get(id: string): RunRecord | undefined {
    const r = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined;
    return r ? run(r) : undefined;
  }

  setStatus(id: string, status: "running" | "waiting"): void {
    this.db.prepare("UPDATE runs SET status = ? WHERE id = ? AND status <> 'finished'").run(status, id);
  }

  finish(id: string, reason: RunFinishReason, now = new Date()): void {
    this.db
      .prepare(
        "UPDATE runs SET status = 'finished', finish_reason = ?, finished_at = ? WHERE id = ? AND status <> 'finished'",
      )
      .run(reason, now.toISOString(), id);
  }

  byThread(threadId: string, limit = 50): RunRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM runs WHERE thread_id = ? ORDER BY started_at DESC, id DESC LIMIT ?")
      .all(threadId, limit) as unknown as RunRow[];
    return rows.map(run);
  }

  /** Runs not finished yet (running or waiting for a human). */
  open(threadId?: string): RunRecord[] {
    const rows = (threadId
      ? this.db
          .prepare("SELECT * FROM runs WHERE status <> 'finished' AND thread_id = ? ORDER BY started_at")
          .all(threadId)
      : this.db
          .prepare("SELECT * FROM runs WHERE status <> 'finished' ORDER BY started_at")
          .all()) as unknown as RunRow[];
    return rows.map(run);
  }

  appendEvent(e: { runId: string; seq: number; type: string; payload: unknown }, now = new Date()): void {
    const last = this.lastSeq.get(e.runId) ?? this.maxSeq(e.runId);
    if (e.seq <= last) throw new Error(`run_events: seq ${e.seq} of ${e.runId} is already written`);
    if (e.type === "run.finished") this.lastSeq.delete(e.runId);
    else this.lastSeq.set(e.runId, e.seq);
    let p = this.pending.get(e.runId);
    // Not a streamed chunk, not the next seq, or batching off:
    // whatever is held goes first, then this one alone, at once.
    if (e.type !== "message.delta" || (p && p.next !== e.seq) || this.batch.maxEvents <= 1) {
      if (p) this.flush(e.runId);
      this.insert(e.runId, e.seq, e.type, JSON.stringify(e.payload), now);
      return;
    }
    if (!p) {
      p = {
        first: e.seq,
        next: e.seq,
        chars: 0,
        at: now.toISOString(),
        template: null,
        items: [],
        timer: undefined,
      };
      this.pending.set(e.runId, p);
      const runId = e.runId;
      p.timer = setTimeout(() => {
        try {
          this.flush(runId);
        } catch (err) {
          this.onFlushError(err);
        }
      }, this.batch.windowMs);
      p.timer.unref?.();
    }
    const c = chunkOf(e.type, e.seq, e.payload);
    if (c && p.template === null) p.template = c.template;
    if (c && c.template === p.template) {
      p.items.push(chunkItem(e.seq, c));
      p.chars += c.delta.length;
    } else {
      const json = JSON.stringify(e.payload);
      p.items.push(eventItem(e.seq, e.type, json));
      p.chars += json.length;
    }
    p.next = e.seq + 1;
    if (p.items.length >= this.batch.maxEvents || p.chars >= this.batch.maxChars) this.flush(e.runId);
  }

  /** Write the held chunks of one run (or of every run) now. */
  flush(runId?: string): void {
    if (runId === undefined) {
      for (const id of [...this.pending.keys()]) this.flush(id);
      return;
    }
    const p = this.pending.get(runId);
    if (!p) return;
    this.pending.delete(runId);
    if (p.timer) clearTimeout(p.timer);
    this.insert(runId, p.first, "message.delta", batchText(p.template, p.items), new Date(p.at));
  }

  private maxSeq(runId: string): number {
    const r = this.db.prepare("SELECT MAX(seq) AS s FROM run_events WHERE run_id = ?").get(runId) as
      | { s: number | null }
      | undefined;
    return r?.s ?? -1;
  }

  /** Drop held chunks without writing them (a flush at close failed). */
  discardPending(): void {
    for (const p of this.pending.values()) if (p.timer) clearTimeout(p.timer);
    this.pending.clear();
  }

  private insert(runId: string, seq: number, type: string, json: string, now: Date): void {
    this.insertSt ??= this.db.prepare(
      "INSERT INTO run_events (run_id, seq, type, payload, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    this.insertSt.run(
      runId,
      seq,
      type,
      sealValue(this.db, "run_events", "payload", `${runId}:${seq}`, json),
      now.toISOString(),
    );
  }

  /**
   * Design §0.2.3: a resume cursor that no longer exists — the client saw
   * `afterSeq`, but that row and everything before the oldest kept row were
   * removed (retention, or the conversation was deleted). Returns the oldest
   * seq still kept (null when none is), or undefined when the cursor is fine.
   */
  cursorGone(runId: string, afterSeq: number): { minSeq: number | null } | undefined {
    if (!(afterSeq >= 0)) return undefined;
    this.flush(runId);
    const r = this.db
      .prepare("SELECT MIN(seq) AS min, SUM(seq = ?) AS hit FROM run_events WHERE run_id = ?")
      .get(afterSeq, runId) as { min: number | null; hit: number | null };
    if (r.hit) return undefined;
    if (r.min !== null && afterSeq >= r.min) return undefined;
    if (r.min === null && this.get(runId)?.status !== "finished") return undefined;
    return { minSeq: r.min };
  }

  /**
   * Stored events of a run after `afterSeq`, one by one. `types` keeps only
   * those types and is applied in SQL first (R7.7): a reader that does not
   * want stream chunks (history_search, the learning loop) never opens their
   * batch rows.
   */
  events(runId: string, afterSeq = -1, o: { types?: readonly string[] } = {}): StoredRunEvent[] {
    this.flush(runId);
    const types = o.types;
    const only = types ? new Set(types) : undefined;
    let rows: Array<{ run_id: string; seq: number; type: string; payload: string }>;
    if (types && !only?.has("message.delta")) {
      // Only stream chunks are batched, so no wanted event sits inside a batch row.
      rows = this.db
        .prepare(
          `SELECT run_id, seq, type, payload FROM run_events WHERE run_id = ? AND seq > ?
           AND type IN (${types.map(() => "?").join(",") || "NULL"}) ORDER BY seq`,
        )
        .all(runId, afterSeq, ...types) as typeof rows;
    } else {
      // A batch row is filed under its first seq: start at the row that holds afterSeq + 1.
      const from = (
        this.db
          .prepare("SELECT MAX(seq) AS s FROM run_events WHERE run_id = ? AND seq <= ?")
          .get(runId, afterSeq + 1) as { s: number | null } | undefined
      )?.s;
      rows = this.db
        .prepare(
          "SELECT run_id, seq, type, payload FROM run_events WHERE run_id = ? AND seq >= ? ORDER BY seq",
        )
        .all(runId, from ?? afterSeq + 1) as typeof rows;
    }
    const out: StoredRunEvent[] = [];
    for (const r of rows) {
      const payload = JSON.parse(
        openValue(this.db, "run_events", "payload", `${r.run_id}:${r.seq}`, r.payload),
      );
      const batch = expandBatch(payload);
      if (!batch) {
        if (r.seq > afterSeq && (!only || only.has(r.type)))
          out.push({ runId: r.run_id, seq: r.seq, type: r.type, payload });
        continue;
      }
      for (const [seq, type, ev] of batch)
        if (seq > afterSeq && (!only || only.has(type)))
          out.push({ runId: r.run_id, seq, type, payload: ev });
    }
    return out;
  }
}
