import type { DatabaseSync } from "node:sqlite";
import { newStoreId } from "../ids.ts";
import { openValue, sealValue } from "../seal.ts";

export type TriggerSource = "timer" | "manual" | "im" | "email" | "github" | "webhook";

export interface TriggerRecord {
  id: string;
  botId: string;
  threadId: string;
  name: string;
  source: TriggerSource;
  config: Record<string, unknown>;
  /** Stage 1 (code) rule, see `@alca/core` `TriggerRule`. */
  rule: Record<string, unknown>;
  /** Stage 2 (model) rule in plain words; null = no semantic stage. */
  semantic: string | null;
  enabled: boolean;
  scheduleId: string | null;
  createdAt: string;
}

export interface StreamRecord {
  id: string;
  botId: string;
  key: string;
  title: string;
  createdAt: string;
  lastEventAt: string | null;
}

export interface TriggerEventRecord {
  id: string;
  triggerId: string;
  streamId: string | null;
  payload: Record<string, unknown>;
  ruleVerdict: "drop" | "candidate" | "explicit";
  judged: "wake" | "skip" | null;
  judgeReason: string | null;
  outcome: "dropped" | "router" | "workers";
  createdAt: string;
}

export interface WatchdogEventRecord {
  id: number;
  workerId: string;
  botId: string;
  kind: "stuck" | "looping" | "over_budget";
  detail: string;
  createdAt: string;
}

const trigger = (r: Record<string, unknown>): TriggerRecord => ({
  id: r.id as string,
  botId: r.bot_id as string,
  threadId: r.thread_id as string,
  name: r.name as string,
  source: r.source as TriggerSource,
  config: JSON.parse(r.config as string) as Record<string, unknown>,
  rule: JSON.parse(r.rule as string) as Record<string, unknown>,
  semantic: (r.semantic as string | null) ?? null,
  enabled: r.enabled === 1,
  scheduleId: (r.schedule_id as string | null) ?? null,
  createdAt: r.created_at as string,
});

const stream = (r: Record<string, unknown>): StreamRecord => ({
  id: r.id as string,
  botId: r.bot_id as string,
  key: r.key as string,
  title: r.title as string,
  createdAt: r.created_at as string,
  lastEventAt: (r.last_event_at as string | null) ?? null,
});

const tevent = (db: DatabaseSync, r: Record<string, unknown>): TriggerEventRecord => ({
  id: r.id as string,
  triggerId: r.trigger_id as string,
  streamId: (r.stream_id as string | null) ?? null,
  payload: JSON.parse(
    openValue(db, "trigger_events", "payload", r.id as string, r.payload as string),
  ) as Record<string, unknown>,
  ruleVerdict: r.rule_verdict as TriggerEventRecord["ruleVerdict"],
  judged: (r.judged as TriggerEventRecord["judged"]) ?? null,
  judgeReason: (r.judge_reason as string | null) ?? null,
  outcome: r.outcome as TriggerEventRecord["outcome"],
  createdAt: r.created_at as string,
});

/** Triggers and their verdict log, streams and who subscribes to them, and the watchdog log. */
export class TriggerRepo {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  create(
    t: Omit<TriggerRecord, "id" | "createdAt" | "enabled" | "scheduleId" | "semantic"> & {
      semantic?: string | null;
      enabled?: boolean;
    },
    now = new Date(),
  ): TriggerRecord {
    const id = newStoreId("trg", now.getTime());
    this.db
      .prepare(
        `INSERT INTO triggers (id, bot_id, thread_id, name, source, config, rule, semantic, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        t.botId,
        t.threadId,
        t.name.trim().slice(0, 80) || "觸發器",
        t.source,
        JSON.stringify(t.config),
        JSON.stringify(t.rule),
        t.semantic?.trim() || null,
        t.enabled === false ? 0 : 1,
        now.toISOString(),
      );
    return this.get(id) as TriggerRecord;
  }

  get(id: string): TriggerRecord | undefined {
    const r = this.db.prepare("SELECT * FROM triggers WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? trigger(r) : undefined;
  }

  list(botId?: string): TriggerRecord[] {
    const rows = (
      botId
        ? this.db.prepare("SELECT * FROM triggers WHERE bot_id = ? ORDER BY created_at, rowid").all(botId)
        : this.db.prepare("SELECT * FROM triggers ORDER BY created_at, rowid").all()
    ) as Array<Record<string, unknown>>;
    return rows.map(trigger);
  }

  bySchedule(scheduleId: string): TriggerRecord | undefined {
    const r = this.db.prepare("SELECT * FROM triggers WHERE schedule_id = ?").get(scheduleId) as
      | Record<string, unknown>
      | undefined;
    return r ? trigger(r) : undefined;
  }

  setEnabled(id: string, enabled: boolean): void {
    this.db.prepare("UPDATE triggers SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
  }

  /** Turn the semantic stage on (a rule in plain words) or off (null). */
  setSemantic(id: string, semantic: string | null): void {
    this.db.prepare("UPDATE triggers SET semantic = ? WHERE id = ?").run(semantic?.trim() || null, id);
  }

  setConfig(id: string, config: Record<string, unknown>): void {
    this.db.prepare("UPDATE triggers SET config = ? WHERE id = ?").run(JSON.stringify(config), id);
  }

  setSchedule(id: string, scheduleId: string): void {
    this.db.prepare("UPDATE triggers SET schedule_id = ? WHERE id = ?").run(scheduleId, id);
  }

  // ── streams ────────────────────────────────────────────────
  /** One stream per (bot, key): the same mail thread, PR or chat topic is always the same stream. */
  ensureStream(botId: string, key: string, title: string, now = new Date()): StreamRecord {
    this.db
      .prepare(
        `INSERT INTO streams (id, bot_id, key, title, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (bot_id, key) DO NOTHING`,
      )
      .run(newStoreId("str", now.getTime()), botId, key, title.slice(0, 80) || key, now.toISOString());
    const r = this.db.prepare("SELECT * FROM streams WHERE bot_id = ? AND key = ?").get(botId, key) as Record<
      string,
      unknown
    >;
    return stream(r);
  }

  stream(id: string): StreamRecord | undefined {
    const r = this.db.prepare("SELECT * FROM streams WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? stream(r) : undefined;
  }

  touchStream(id: string, now = new Date()): void {
    this.db.prepare("UPDATE streams SET last_event_at = ? WHERE id = ?").run(now.toISOString(), id);
  }

  subscribe(streamId: string, workerId: string, now = new Date()): void {
    this.db
      .prepare(
        "INSERT INTO stream_subscriptions (stream_id, worker_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
      )
      .run(streamId, workerId, now.toISOString());
  }

  subscribers(streamId: string): string[] {
    const rows = this.db
      .prepare("SELECT worker_id FROM stream_subscriptions WHERE stream_id = ? ORDER BY created_at")
      .all(streamId) as Array<{ worker_id: string }>;
    return rows.map((r) => r.worker_id);
  }

  subscriptionsOf(workerId: string): string[] {
    const rows = this.db
      .prepare("SELECT stream_id FROM stream_subscriptions WHERE worker_id = ? ORDER BY created_at")
      .all(workerId) as Array<{ stream_id: string }>;
    return rows.map((r) => r.stream_id);
  }

  // ── trigger events (append-only) ───────────────────────────
  addEvent(e: Omit<TriggerEventRecord, "id" | "createdAt">, now = new Date()): TriggerEventRecord {
    const id = newStoreId("tev", now.getTime());
    this.db
      .prepare(
        `INSERT INTO trigger_events (id, trigger_id, stream_id, payload, rule_verdict, judged, judge_reason, outcome, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        e.triggerId,
        e.streamId,
        sealValue(this.db, "trigger_events", "payload", id, JSON.stringify(e.payload)),
        e.ruleVerdict,
        e.judged,
        e.judgeReason,
        e.outcome,
        now.toISOString(),
      );
    return this.event(id) as TriggerEventRecord;
  }

  event(id: string): TriggerEventRecord | undefined {
    const r = this.db.prepare("SELECT * FROM trigger_events WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? tevent(this.db, r) : undefined;
  }

  events(filter: { triggerId?: string; streamId?: string }, limit = 20): TriggerEventRecord[] {
    const col = filter.triggerId ? "trigger_id" : "stream_id";
    const val = filter.triggerId ?? filter.streamId ?? "";
    const rows = this.db
      .prepare(`SELECT * FROM trigger_events WHERE ${col} = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(val, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => tevent(this.db, r));
  }

  // ── watchdog log (append-only) ─────────────────────────────
  addWatchdog(e: Omit<WatchdogEventRecord, "id" | "createdAt">, now = new Date()): WatchdogEventRecord {
    const r = this.db
      .prepare(
        "INSERT INTO watchdog_events (worker_id, bot_id, kind, detail, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(e.workerId, e.botId, e.kind, e.detail, now.toISOString());
    return { ...e, id: Number(r.lastInsertRowid), createdAt: now.toISOString() };
  }

  watchdogEvents(workerId?: string): WatchdogEventRecord[] {
    const rows = (
      workerId
        ? this.db.prepare("SELECT * FROM watchdog_events WHERE worker_id = ? ORDER BY id").all(workerId)
        : this.db.prepare("SELECT * FROM watchdog_events ORDER BY id").all()
    ) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as number,
      workerId: r.worker_id as string,
      botId: r.bot_id as string,
      kind: r.kind as WatchdogEventRecord["kind"],
      detail: r.detail as string,
      createdAt: r.created_at as string,
    }));
  }
}
