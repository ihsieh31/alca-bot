import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { newStoreId } from "../ids.ts";
import { openValue, sealValue } from "../seal.ts";

export const OFFER_CATEGORIES = ["project", "errand", "money_account", "social", "study", "other"] as const;
export type OfferCategory = (typeof OFFER_CATEGORIES)[number];
export const OFFER_STATUSES = ["pending", "accepted", "declined", "ignored", "expired"] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];

/** `chat_end` = the last line of a reply; `addon:<id>` = an add-on made it. */
export type OfferSource = "chat_end" | `addon:${string}`;

export interface OfferRecord {
  id: string;
  botId: string;
  threadId: string | null;
  source: OfferSource;
  category: OfferCategory;
  /** A short topic key (what a 別再提這類 is about); sealed (migration 31), compared only once opened. */
  topic: string;
  text: string;
  /** The work to do on a yes (a task for a worker). */
  action: string;
  status: OfferStatus;
  evidence: string[];
  score: number | null;
  dueAt: string | null;
  /** Waiting to be shown (an add-on offer outside its time window). */
  queued: boolean;
  shownAt: string | null;
  workerId: string | null;
  createdAt: string;
  updatedAt: string;
  decidedAt: string | null;
}

export interface OfferInput {
  botId: string;
  threadId?: string | null;
  source: OfferSource;
  category: OfferCategory;
  topic?: string;
  text: string;
  action?: string;
  evidence?: readonly string[];
  score?: number | null;
  dueAt?: string | null;
  queued?: boolean;
}

interface Row {
  id: string;
  bot_id: string;
  thread_id: string | null;
  source: string;
  category: OfferCategory;
  topic: string;
  text: string;
  action: string;
  status: OfferStatus;
  evidence_json: string;
  score: number | null;
  due_at: string | null;
  queued: number;
  shown_at: string | null;
  worker_id: string | null;
  created_at: string;
  updated_at: string;
  decided_at: string | null;
}

const list = (s: string): string[] => {
  try {
    const v = JSON.parse(s) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};

/** `text`, `action` (migration 30) and `topic` (31) are sealed columns; a row written before the key exists reads as is. */
const fromRow = (db: DatabaseSync, r: Row): OfferRecord => ({
  id: r.id,
  botId: r.bot_id,
  threadId: r.thread_id,
  source: r.source as OfferSource,
  category: r.category,
  topic: openValue(db, "offers", "topic", r.id, r.topic),
  text: openValue(db, "offers", "text", r.id, r.text),
  action: openValue(db, "offers", "action", r.id, r.action),
  status: r.status,
  evidence: list(r.evidence_json),
  score: r.score,
  dueAt: r.due_at,
  queued: r.queued === 1,
  shownAt: r.shown_at,
  workerId: r.worker_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  decidedAt: r.decided_at,
});

export interface OfferQuery {
  botId?: string;
  threadId?: string;
  status?: readonly OfferStatus[];
  source?: string;
  /** Only offers made at or after this time. */
  since?: string;
  queued?: boolean;
  limit?: number;
}

export interface OfferStats {
  accepted: number;
  declined: number;
  ignored: number;
  total: number;
}

/**
 * The offer ledger (P14, migration 17): what a bot offered and what the
 * person did with it. Status moves once, from pending; a decided offer stays
 * as it was decided (trigger).
 */
export class OfferRepo {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  add(i: OfferInput, now = new Date()): OfferRecord {
    const id = newStoreId("ofr", now.getTime());
    const ts = now.toISOString();
    this.db
      .prepare(
        `INSERT INTO offers (id, bot_id, thread_id, source, category, topic, text, action, evidence_json, score,
           due_at, queued, shown_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        i.botId,
        i.threadId ?? null,
        i.source,
        i.category,
        sealValue(this.db, "offers", "topic", id, (i.topic ?? "").slice(0, 80)),
        sealValue(this.db, "offers", "text", id, i.text.slice(0, 1000)),
        sealValue(this.db, "offers", "action", id, (i.action ?? "").slice(0, 2000)),
        JSON.stringify((i.evidence ?? []).slice(0, 20)),
        i.score ?? null,
        i.dueAt ?? null,
        i.queued ? 1 : 0,
        i.queued ? null : ts,
        ts,
        ts,
      );
    return this.get(id) as OfferRecord;
  }

  get(id: string): OfferRecord | undefined {
    const r = this.db.prepare("SELECT * FROM offers WHERE id = ?").get(id) as Row | undefined;
    return r ? fromRow(this.db, r) : undefined;
  }

  list(q: OfferQuery = {}): OfferRecord[] {
    const sql: string[] = [];
    const params: SQLInputValue[] = [];
    if (q.botId) {
      sql.push("bot_id = ?");
      params.push(q.botId);
    }
    if (q.threadId) {
      sql.push("thread_id = ?");
      params.push(q.threadId);
    }
    if (q.status?.length) {
      sql.push(`status IN (${q.status.map(() => "?").join(",")})`);
      params.push(...q.status);
    }
    if (q.source) {
      sql.push("source = ?");
      params.push(q.source);
    }
    if (q.since) {
      sql.push("created_at >= ?");
      params.push(q.since);
    }
    if (q.queued !== undefined) {
      sql.push("queued = ?");
      params.push(q.queued ? 1 : 0);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM offers ${sql.length ? `WHERE ${sql.join(" AND ")}` : ""} ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(...params, q.limit ?? 200) as unknown as Row[];
    return rows.map((r) => fromRow(this.db, r));
  }

  /** The newest pending offer of a conversation (what a short yes / no answers). */
  latestPending(threadId: string, source?: string): OfferRecord | undefined {
    return this.list({ threadId, status: ["pending"], ...(source ? { source } : {}), limit: 1 })[0];
  }

  /** Decide a pending offer once. False when it was already decided. */
  decide(
    id: string,
    status: Exclude<OfferStatus, "pending">,
    now = new Date(),
    extra: { workerId?: string } = {},
  ): boolean {
    const ts = now.toISOString();
    const r = this.db
      .prepare(
        `UPDATE offers SET status = ?, decided_at = ?, updated_at = ?, queued = 0,
           worker_id = COALESCE(?, worker_id) WHERE id = ? AND status = 'pending'`,
      )
      .run(status, ts, ts, extra.workerId ?? null, id);
    return Number(r.changes) > 0;
  }

  /** A queued offer is shown now. */
  markShown(id: string, now = new Date()): boolean {
    const ts = now.toISOString();
    const r = this.db
      .prepare(
        "UPDATE offers SET queued = 0, shown_at = ?, updated_at = ? WHERE id = ? AND status = 'pending' AND queued = 1",
      )
      .run(ts, ts, id);
    return Number(r.changes) > 0;
  }

  /** Pending offers shown before `before` that nobody answered → ignored. Returns them. */
  ignoreStale(before: Date, source?: string, now = new Date()): OfferRecord[] {
    const stale = this.list({
      status: ["pending"],
      queued: false,
      ...(source ? { source } : {}),
      limit: 500,
    }).filter((o) => (o.shownAt ?? o.createdAt) < before.toISOString());
    return stale.filter((o) => this.decide(o.id, "ignored", now));
  }

  /** Pending offers whose deadline passed → expired. Returns them. */
  expireOverdue(now = new Date()): OfferRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM offers WHERE status = 'pending' AND due_at IS NOT NULL AND due_at < ?")
      .all(now.toISOString()) as unknown as Row[];
    return rows.map((r) => fromRow(this.db, r)).filter((o) => this.decide(o.id, "expired", now));
  }

  /** Accept rate inputs for a bot (and category) over a window. Pending offers are not counted. */
  stats(botId: string, category: OfferCategory | undefined, since: Date): OfferStats {
    const rows = this.db
      .prepare(
        `SELECT status, COUNT(*) AS n FROM offers WHERE bot_id = ? AND created_at >= ?
           ${category ? "AND category = ?" : ""} AND status IN ('accepted','declined','ignored') GROUP BY status`,
      )
      .all(...([botId, since.toISOString(), ...(category ? [category] : [])] as SQLInputValue[])) as Array<{
      status: OfferStatus;
      n: number;
    }>;
    const by = (s: OfferStatus) => rows.find((r) => r.status === s)?.n ?? 0;
    const accepted = by("accepted");
    const declined = by("declined");
    const ignored = by("ignored");
    return { accepted, declined, ignored, total: accepted + declined + ignored };
  }

  /**
   * Gap analysis 2026-11: one source's offers made since a time, per status,
   * and how many of them were shown (precision metrics).
   */
  outcomes(botId: string, source: string, since: Date): Record<OfferStatus, number> & { shown: number } {
    const rows = this.db
      .prepare(
        `SELECT status, COUNT(*) AS n, SUM(CASE WHEN shown_at IS NOT NULL THEN 1 ELSE 0 END) AS shown
           FROM offers WHERE bot_id = ? AND source = ? AND created_at >= ? GROUP BY status`,
      )
      .all(botId, source, since.toISOString()) as Array<{ status: OfferStatus; n: number; shown: number }>;
    const out = { pending: 0, accepted: 0, declined: 0, ignored: 0, expired: 0, shown: 0 };
    for (const r of rows) {
      out[r.status] = r.n;
      out.shown += r.shown;
    }
    return out;
  }

  /** How many add-on offers were shown to a bot's person since a time (the daily count). */
  shownSince(botId: string, source: string, since: Date): number {
    const r = this.db
      .prepare("SELECT COUNT(*) AS n FROM offers WHERE bot_id = ? AND source = ? AND shown_at >= ?")
      .get(botId, source, since.toISOString()) as { n: number };
    return r.n;
  }

  /** When an add-on last showed an offer to a bot's person. */
  lastShown(botId: string, source: string): string | null {
    const r = this.db
      .prepare("SELECT MAX(shown_at) AS t FROM offers WHERE bot_id = ? AND source = ?")
      .get(botId, source) as { t: string | null };
    return r.t;
  }

  /** True when any offer of this bot already cited this piece of evidence. */
  evidenceUsed(botId: string, evidenceId: string): boolean {
    const r = this.db
      .prepare(
        "SELECT 1 AS x FROM offers WHERE bot_id = ? AND EXISTS (SELECT 1 FROM json_each(offers.evidence_json) WHERE value = ?) LIMIT 1",
      )
      .get(botId, evidenceId) as { x: number } | undefined;
    return !!r;
  }
}
