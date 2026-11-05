import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { toAnyMatchQuery, toMatchQuery, toSearchTerms } from "../cjk.ts";
import { atomic } from "../db.ts";
import { newStoreId } from "../ids.ts";
import { openValue, sealerOf, sealValue } from "../seal.ts";

export type MemoryScope = "shared" | "bot";
export type MemoryKind = "fact" | "preference" | "person" | "project";
export type MemoryOrigin = "user" | "inferred";
export type MemorySourceKind = "chat" | "ui" | "migrated";
/**
 * P14: the kinds of action a memory must be followed for. `proactive` is the
 * 主動留意 add-on (a 「別再提…」 rule); `any` = every action.
 */
export const MEMORY_APPLIES = [
  "send_message",
  "publish",
  "purchase",
  "booking",
  "code",
  "schedule",
  "proactive",
  "any",
] as const;
export type MemoryApplies = (typeof MEMORY_APPLIES)[number];

export interface MemorySource {
  kind: MemorySourceKind;
  threadId?: string | null;
  messageId?: string | null;
  runId?: string | null;
  workerId?: string | null;
}

export interface MemoryInput {
  botId: string;
  scope: MemoryScope;
  kind: MemoryKind;
  subject?: string;
  body: string;
  quote?: string | null;
  origin: MemoryOrigin;
  confidence: number;
  source: MemorySource;
  /** The active item this one replaces (it becomes `superseded`). */
  supersedes?: string;
  /** P14: action kinds this memory must be followed for (empty = found by search only). */
  appliesTo?: readonly MemoryApplies[];
  /** P14: a deadline the person mentioned (ISO). */
  dueAt?: string | null;
}

export interface MemoryRecord {
  id: string;
  botId: string;
  scope: MemoryScope;
  kind: MemoryKind;
  subject: string;
  body: string;
  quote: string | null;
  origin: MemoryOrigin;
  confidence: number;
  status: "active" | "superseded";
  supersedes: string | null;
  supersededBy: string | null;
  source: Required<{ [K in keyof MemorySource]: NonNullable<MemorySource[K]> | null }>;
  uses: number;
  lastUsedAt: string | null;
  confirmedAt: string | null;
  createdAt: string;
  updatedAt: string;
  embedded: boolean;
  appliesTo: MemoryApplies[];
  dueAt: string | null;
}

export interface MemoryHit extends MemoryRecord {
  /** bm25 score; lower is better. */
  score: number;
}

export interface MemoryQuery {
  /** Items this bot can read: its own plus the shared user model. */
  visibleTo?: string;
  /** Exactly this bot's items (its own notes and what it added to the shared model). */
  botId?: string;
  scope?: MemoryScope;
  kinds?: readonly MemoryKind[];
  origin?: MemoryOrigin;
  includeSuperseded?: boolean;
  limit?: number;
  offset?: number;
}

export interface TombstoneRecord {
  id: string;
  botId: string;
  digest: string;
  shingles: string[];
  reason: "forget" | "never_learn";
  createdAt: string;
}

interface Row {
  id: string;
  bot_id: string;
  scope: MemoryScope;
  kind: MemoryKind;
  subject: string;
  body: string;
  quote: string | null;
  origin: MemoryOrigin;
  confidence: number;
  status: "active" | "superseded";
  supersedes: string | null;
  superseded_by: string | null;
  source_kind: MemorySourceKind;
  source_thread_id: string | null;
  source_message_id: string | null;
  source_run_id: string | null;
  source_worker_id: string | null;
  uses: number;
  last_used_at: string | null;
  confirmed_at: string | null;
  created_at: string;
  updated_at: string;
  embedded: number;
  applies_to: string;
  due_at: string | null;
  score?: number;
}

const COLS = `m.id, m.bot_id, m.scope, m.kind, m.subject, m.body, m.quote, m.origin, m.confidence, m.status,
  m.supersedes, m.superseded_by, m.source_kind, m.source_thread_id, m.source_message_id, m.source_run_id,
  m.source_worker_id, m.uses, m.last_used_at, m.confirmed_at, m.created_at, m.updated_at,
  (m.embedding IS NOT NULL) AS embedded, m.applies_to, m.due_at`;

function appliesOf(s: string | null | undefined): MemoryApplies[] {
  try {
    const v = JSON.parse(s ?? "[]") as unknown;
    return Array.isArray(v)
      ? v.filter((x): x is MemoryApplies => (MEMORY_APPLIES as readonly unknown[]).includes(x))
      : [];
  } catch {
    return [];
  }
}

function fromRow(db: DatabaseSync, r: Row): MemoryRecord {
  return {
    id: r.id,
    botId: r.bot_id,
    scope: r.scope,
    kind: r.kind,
    subject: r.subject,
    body: openValue(db, "memories", "body", r.id, r.body),
    quote: openValue(db, "memories", "quote", r.id, r.quote),
    origin: r.origin,
    confidence: r.confidence,
    status: r.status,
    supersedes: r.supersedes,
    supersededBy: r.superseded_by,
    source: {
      kind: r.source_kind,
      threadId: r.source_thread_id,
      messageId: r.source_message_id,
      runId: r.source_run_id,
      workerId: r.source_worker_id,
    },
    uses: r.uses,
    lastUsedAt: r.last_used_at,
    confirmedAt: r.confirmed_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    embedded: r.embedded === 1,
    appliesTo: appliesOf(r.applies_to),
    dueAt: r.due_at ?? null,
  };
}

export function newMemoryId(now = Date.now()): string {
  return newStoreId("mem", now);
}

function where(q: MemoryQuery): { sql: string[]; params: SQLInputValue[] } {
  const sql: string[] = [];
  const params: SQLInputValue[] = [];
  if (!q.includeSuperseded) sql.push("m.status = 'active'");
  if (q.visibleTo) {
    sql.push("(m.bot_id = ? OR m.scope = 'shared')");
    params.push(q.visibleTo);
  }
  if (q.botId) {
    sql.push("m.bot_id = ?");
    params.push(q.botId);
  }
  if (q.scope) {
    sql.push("m.scope = ?");
    params.push(q.scope);
  }
  if (q.kinds?.length) {
    sql.push(`m.kind IN (${q.kinds.map(() => "?").join(",")})`);
    params.push(...q.kinds);
  }
  if (q.origin) {
    sql.push("m.origin = ?");
    params.push(q.origin);
  }
  return { sql, params };
}

/**
 * Durable memory (migration 6). Content is never updated in place: `add`
 * with `supersedes` inserts the new row and marks the old one superseded in
 * one transaction. `forgetChain` hard-deletes an item and every version of
 * it; the caller writes the tombstone.
 */
export class MemoryRepo {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  add(input: MemoryInput, now = new Date()): MemoryRecord {
    const id = newMemoryId(now.getTime());
    const ts = now.toISOString();
    const s = input.source;
    const confidence = Math.max(0, Math.min(1, input.confidence));
    // The plaintext limit (the column's CHECK now allows the sealed form's size, migration 25).
    const chars = [...input.body].length;
    if (chars < 1 || chars > 2000)
      throw new Error("CHECK constraint failed: a memory body is 1–2000 characters");
    const sealer = sealerOf(this.db);
    return atomic(this.db, () => {
      if (input.supersedes) {
        const old = this.get(input.supersedes);
        if (!old) throw new Error(`memory ${input.supersedes} not found`);
        if (old.status !== "active") throw new Error(`memory ${input.supersedes} was already superseded`);
      }
      this.db
        .prepare(
          `INSERT INTO memories (id, bot_id, scope, kind, subject, body, quote, origin, confidence, supersedes,
             source_kind, source_thread_id, source_message_id, source_run_id, source_worker_id, search_terms,
             confirmed_at, created_at, updated_at, applies_to, due_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.botId,
          input.scope,
          input.kind,
          input.subject ?? "",
          sealValue(this.db, "memories", "body", id, input.body),
          sealValue(this.db, "memories", "quote", id, input.quote ?? null),
          input.origin,
          confidence,
          input.supersedes ?? null,
          s.kind,
          s.threadId ?? null,
          s.messageId ?? null,
          s.runId ?? null,
          s.workerId ?? null,
          toSearchTerms(`${input.subject ?? ""} ${input.body}`, sealer),
          input.origin === "user" ? ts : null,
          ts,
          ts,
          JSON.stringify([...new Set(input.appliesTo ?? [])].filter((x) => MEMORY_APPLIES.includes(x))),
          input.dueAt ?? null,
        );
      if (input.supersedes)
        this.db
          .prepare(
            "UPDATE memories SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ? AND status = 'active'",
          )
          .run(id, ts, input.supersedes);
      return this.get(id) as MemoryRecord;
    });
  }

  get(id: string): MemoryRecord | undefined {
    const r = this.db.prepare(`SELECT ${COLS} FROM memories m WHERE m.id = ?`).get(id) as Row | undefined;
    return r ? fromRow(this.db, r) : undefined;
  }

  list(q: MemoryQuery = {}): MemoryRecord[] {
    const w = where(q);
    const rows = this.db
      .prepare(
        `SELECT ${COLS} FROM memories m ${w.sql.length ? `WHERE ${w.sql.join(" AND ")}` : ""}
         ORDER BY m.updated_at DESC, m.n DESC LIMIT ? OFFSET ?`,
      )
      .all(...w.params, q.limit ?? 200, q.offset ?? 0) as unknown as Row[];
    return rows.map((r) => fromRow(this.db, r));
  }

  count(q: MemoryQuery = {}): number {
    const w = where(q);
    const r = this.db
      .prepare(`SELECT count(*) AS c FROM memories m ${w.sql.length ? `WHERE ${w.sql.join(" AND ")}` : ""}`)
      .get(...w.params) as { c: number };
    return r.c;
  }

  /** CJK-aware full-text search (bm25, lower is better). `any`: any token may match (recall). */
  search(query: string, q: MemoryQuery & { any?: boolean } = {}): MemoryHit[] {
    // R7.4: with a data key the index holds keyed tokens; the query is keyed the same way.
    const keyer = sealerOf(this.db);
    const match = q.any ? toAnyMatchQuery(query, keyer) : toMatchQuery(query, keyer);
    if (!match) return [];
    const w = where(q);
    const rows = this.db
      .prepare(
        `SELECT ${COLS}, bm25(memories_fts) AS score
         FROM memories_fts JOIN memories m ON m.n = memories_fts.rowid
         WHERE memories_fts MATCH ? ${w.sql.length ? `AND ${w.sql.join(" AND ")}` : ""}
         ORDER BY score LIMIT ?`,
      )
      .all(match, ...w.params, q.limit ?? 20) as unknown as Row[];
    return rows.map((r) => ({ ...fromRow(this.db, r), score: r.score ?? 0 }));
  }

  /** The active item about the same subject that a new one should supersede (same bot view, same scope). */
  activeBySubject(visibleTo: string, scope: MemoryScope, subject: string): MemoryRecord | undefined {
    if (!subject) return undefined;
    const r = this.db
      .prepare(
        `SELECT ${COLS} FROM memories m WHERE m.status = 'active' AND m.subject = ? AND m.scope = ?
         AND (m.bot_id = ? OR m.scope = 'shared') ORDER BY m.n DESC LIMIT 1`,
      )
      .get(subject, scope, visibleTo) as Row | undefined;
    return r ? fromRow(this.db, r) : undefined;
  }

  /** Every version of an item: what it replaced, and what replaced it, oldest first. */
  chain(id: string): MemoryRecord[] {
    const start = this.get(id);
    if (!start) return [];
    const out = new Map<string, MemoryRecord>([[start.id, start]]);
    let back = start.supersedes;
    while (back && !out.has(back)) {
      const m = this.get(back);
      if (!m) break;
      out.set(m.id, m);
      back = m.supersedes;
    }
    let fwd = start.supersededBy;
    while (fwd && !out.has(fwd)) {
      const m = this.get(fwd);
      if (!m) break;
      out.set(m.id, m);
      fwd = m.supersededBy;
    }
    return [...out.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * P14: active items a bot can read whose `applies_to` names one of these
   * action kinds (or `any`), the person's own first, newest first.
   */
  applying(visibleTo: string, kinds: readonly MemoryApplies[], limit = 5): MemoryRecord[] {
    if (!kinds.length) return [];
    const want = [...new Set([...kinds, "any"])];
    const rows = this.db
      .prepare(
        `SELECT ${COLS} FROM memories m WHERE m.status = 'active' AND (m.bot_id = ? OR m.scope = 'shared')
           AND EXISTS (SELECT 1 FROM json_each(m.applies_to) WHERE value IN (${want.map(() => "?").join(",")}))
         ORDER BY (m.origin = 'user') DESC, m.n DESC LIMIT ?`,
      )
      .all(visibleTo, ...want, limit) as unknown as Row[];
    return rows.map((r) => fromRow(this.db, r));
  }

  /** P14: active items a bot can read that carry a deadline in [from, to). */
  dueBetween(visibleTo: string, from: Date, to: Date, limit = 20): MemoryRecord[] {
    const rows = this.db
      .prepare(
        `SELECT ${COLS} FROM memories m WHERE m.status = 'active' AND (m.bot_id = ? OR m.scope = 'shared')
           AND m.due_at IS NOT NULL AND m.due_at >= ? AND m.due_at < ? ORDER BY m.due_at LIMIT ?`,
      )
      .all(visibleTo, from.toISOString(), to.toISOString(), limit) as unknown as Row[];
    return rows.map((r) => fromRow(this.db, r));
  }

  confirm(id: string, now = new Date()): boolean {
    const ts = now.toISOString();
    const r = this.db
      .prepare(
        "UPDATE memories SET origin = 'user', confidence = 1, confirmed_at = ?, updated_at = ? WHERE id = ? AND status = 'active'",
      )
      .run(ts, ts, id);
    return Number(r.changes) > 0;
  }

  rescope(id: string, scope: MemoryScope, now = new Date()): boolean {
    const r = this.db
      .prepare(
        "UPDATE memories SET scope = ?, updated_at = ? WHERE id = ? AND status = 'active' AND scope <> ?",
      )
      .run(scope, now.toISOString(), id, scope);
    return Number(r.changes) > 0;
  }

  /** Recalled into a prompt: counted, and `last_used_at` moves. */
  touch(ids: readonly string[], now = new Date()): void {
    const stmt = this.db.prepare("UPDATE memories SET uses = uses + 1, last_used_at = ? WHERE id = ?");
    for (const id of ids) stmt.run(now.toISOString(), id);
  }

  setEmbedding(id: string, vector: Float32Array, model: string): void {
    this.db
      .prepare("UPDATE memories SET embedding = ?, embedding_model = ? WHERE id = ?")
      .run(new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength), model, id);
  }

  /** Stored vectors of the active items a bot can read, for one embedding model. */
  embeddings(visibleTo: string, model: string): Array<{ id: string; vector: Float32Array }> {
    const rows = this.db
      .prepare(
        `SELECT id, embedding FROM memories WHERE status = 'active' AND embedding IS NOT NULL
         AND embedding_model = ? AND (bot_id = ? OR scope = 'shared')`,
      )
      .all(model, visibleTo) as Array<{ id: string; embedding: Uint8Array }>;
    return rows.map((r) => {
      const copy = new Uint8Array(r.embedding);
      return { id: r.id, vector: new Float32Array(copy.buffer, 0, Math.floor(copy.byteLength / 4)) };
    });
  }

  /** Hard delete: the item and every version of it. Returns what was deleted. */
  forgetChain(id: string): MemoryRecord[] {
    const chain = this.chain(id);
    if (!chain.length) return [];
    atomic(this.db, () => {
      const del = this.db.prepare("DELETE FROM memories WHERE id = ?");
      for (const m of chain) del.run(m.id);
    });
    return chain;
  }

  // ── tombstones ───────────────────────────────────────────────

  /** The per-store key for tombstone hashes (created by migration 6). */
  tombstoneKey(): string {
    const r = this.db.prepare("SELECT value FROM memory_meta WHERE key = 'tombstone_key'").get() as
      | { value: string }
      | undefined;
    if (!r) throw new Error("memory_meta.tombstone_key missing");
    return r.value;
  }

  addTombstone(
    t: { botId: string; digest: string; shingles: readonly string[]; reason: TombstoneRecord["reason"] },
    now = new Date(),
  ): TombstoneRecord {
    const existing = this.db.prepare("SELECT id FROM memory_tombstones WHERE digest = ?").get(t.digest) as
      | { id: string }
      | undefined;
    if (existing) return this.tombstones().find((x) => x.id === existing.id) as TombstoneRecord;
    const id = newStoreId("tmb", now.getTime());
    this.db
      .prepare(
        "INSERT INTO memory_tombstones (id, bot_id, digest, shingles, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(id, t.botId, t.digest, JSON.stringify(t.shingles), t.reason, now.toISOString());
    return {
      id,
      botId: t.botId,
      digest: t.digest,
      shingles: [...t.shingles],
      reason: t.reason,
      createdAt: now.toISOString(),
    };
  }

  /** Every tombstone of the team: a forgotten item is not re-learned by any bot. */
  tombstones(): TombstoneRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM memory_tombstones ORDER BY created_at")
      .all() as unknown as Array<{
      id: string;
      bot_id: string;
      digest: string;
      shingles: string;
      reason: TombstoneRecord["reason"];
      created_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      botId: r.bot_id,
      digest: r.digest,
      shingles: JSON.parse(r.shingles) as string[],
      reason: r.reason,
      createdAt: r.created_at,
    }));
  }

  deleteTombstone(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM memory_tombstones WHERE id = ?").run(id).changes) > 0;
  }

  /** Let Alca learn again what was forgotten (the person asked for it). */
  clearTombstones(botId?: string): number {
    const r = botId
      ? this.db.prepare("DELETE FROM memory_tombstones WHERE bot_id = ?").run(botId)
      : this.db.prepare("DELETE FROM memory_tombstones").run();
    return Number(r.changes);
  }
}
