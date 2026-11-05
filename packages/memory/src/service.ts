import type { MemoryKind, MemoryQuery, MemoryRecord, MemoryScope, MemorySource, Store } from "@alca/store";
import { cosine, type Embedder, fuseRanks } from "./embedding.ts";
import type { Candidate } from "./extract.ts";
import { lifeInstant } from "./life.ts";
import { containsSecret, redact } from "./redact.ts";
import { matchesTombstone, normalizeForMatch, tombstoneDigest, tombstoneShingles } from "./tombstone.ts";

export interface Provenance {
  threadId?: string;
  messageId?: string;
  runId?: string;
  workerId?: string;
}

export type LearnStatus =
  | "stored"
  | "superseded"
  | "duplicate"
  | "confirmed"
  | "secret"
  | "forgotten"
  | "kept_confirmed"
  | "off";

export interface LearnOutcome {
  status: LearnStatus;
  memory?: MemoryRecord;
  replaced?: MemoryRecord;
}

export type MemoryChangeOp = "added" | "superseded" | "confirmed" | "rescoped" | "forgotten";

export interface MemoryChange {
  op: MemoryChangeOp;
  memory: MemoryRecord;
  replaces?: string;
}

export interface MemoryServiceOptions {
  store: Store;
  now?: () => Date;
  /** Optional embedding hook (off by default; no network). */
  embedder?: Embedder;
  /** The single learning switch: off = nothing is inferred (explicit 記住 still works). */
  learning?: () => boolean;
  onChange?: (c: MemoryChange) => void;
}

export interface RecallEntry {
  id: string;
  kind: MemoryKind;
  origin: "user" | "inferred";
  confidence: number;
  body: string;
  /** Why it was picked: matched the message, or standing (preferences / people). */
  why: "match" | "standing";
}

export const KIND_LABEL: Record<MemoryKind, string> = {
  fact: "事實",
  preference: "偏好",
  person: "人物",
  project: "專案",
};

/** Rough token count: one per CJK character, one per four other characters. */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(ch)) cjk++;
    else other++;
  }
  return cjk + Math.ceil(other / 4);
}

export function recallTag(e: Pick<RecallEntry, "kind" | "origin" | "confidence">): string {
  const sure = e.origin === "user" ? "已確認" : `推測 ${Math.round(e.confidence * 100)}%`;
  return `${KIND_LABEL[e.kind]}・${sure}`;
}

/** Where an item belongs by default: things about the person are the shared user model. */
export function defaultScope(kind: MemoryKind): MemoryScope {
  return kind === "project" ? "bot" : "shared";
}

const sameText = (a: string, b: string) => normalizeForMatch(a) === normalizeForMatch(b);

/**
 * Memory, per bot: the write path (remember / learn / correct / forget), the
 * read path (budgeted recall, search) and the person's controls (edit,
 * confirm, share, export). Every write goes through the secret filter and the
 * tombstones; content is superseded, never overwritten.
 */
export class MemoryService {
  readonly store: Store;
  private readonly o: MemoryServiceOptions;
  private readonly now: () => Date;

  constructor(o: MemoryServiceOptions) {
    this.o = o;
    this.store = o.store;
    this.now = o.now ?? (() => new Date());
  }

  get embedder(): Embedder | undefined {
    return this.o.embedder;
  }

  private changed(c: MemoryChange): void {
    try {
      this.o.onChange?.(c);
    } catch {
      // a broken listener must not break a write
    }
  }

  private source(kind: MemorySource["kind"], p: Provenance): MemorySource {
    return {
      kind,
      threadId: p.threadId ?? null,
      messageId: p.messageId ?? null,
      runId: p.runId ?? null,
      workerId: p.workerId ?? null,
    };
  }

  private embedLater(m: MemoryRecord): void {
    const e = this.o.embedder;
    if (!e) return;
    void e
      .embed([`${m.subject} ${m.body}`])
      .then(([v]) => {
        if (v && this.store.memory.get(m.id)) this.store.memory.setEmbedding(m.id, v, e.id);
      })
      .catch(() => undefined);
  }

  /** True when the text repeats something the person told Alca to forget. */
  isForgotten(text: string): boolean {
    const key = this.store.memory.tombstoneKey();
    return this.store.memory.tombstones().some((t) => matchesTombstone(key, text, t));
  }

  private write(
    botId: string,
    c: Candidate,
    origin: "user" | "inferred",
    sourceKind: MemorySource["kind"],
    p: Provenance,
    scope?: MemoryScope,
  ): LearnOutcome {
    const body = c.body.trim().slice(0, 2000);
    if (!body || containsSecret(body) || containsSecret(c.subject)) return { status: "secret" };
    const sc = scope ?? defaultScope(c.kind);
    const repo = this.store.memory;
    // The same thing again: confirm it if the person said it, otherwise keep what is there.
    const dup = repo
      .search(body, { visibleTo: botId, limit: 10 })
      .find((m) => sameText(m.body, body) && m.kind === c.kind);
    if (dup) {
      if (origin === "user" && dup.origin === "inferred" && repo.confirm(dup.id, this.now())) {
        const m = repo.get(dup.id) as MemoryRecord;
        this.changed({ op: "confirmed", memory: m });
        return { status: "confirmed", memory: m };
      }
      return { status: "duplicate", memory: dup };
    }
    const old = repo.activeBySubject(botId, sc, c.subject);
    // An inference never replaces what the person confirmed, unless they are correcting it.
    if (old && old.origin === "user" && origin === "inferred" && !c.correction)
      return { status: "kept_confirmed", memory: old };
    const m = repo.add(
      {
        botId,
        scope: sc,
        kind: c.kind,
        subject: c.subject,
        body,
        quote: c.quote ? redact(c.quote).slice(0, 600) : null,
        origin,
        confidence: origin === "user" ? 1 : Math.min(0.95, Math.max(0.05, c.confidence)),
        source: this.source(sourceKind, p),
        ...(old ? { supersedes: old.id } : {}),
        ...(c.appliesTo?.length ? { appliesTo: c.appliesTo } : {}),
        ...(c.dueAt ? { dueAt: c.dueAt } : {}),
      },
      this.now(),
    );
    this.embedLater(m);
    this.changed(old ? { op: "superseded", memory: m, replaces: old.id } : { op: "added", memory: m });
    return old ? { status: "superseded", memory: m, replaced: old } : { status: "stored", memory: m };
  }

  /** The person said "記住…": stored as confirmed. It also lifts a matching tombstone (their call). */
  remember(
    botId: string,
    c: Candidate,
    p: Provenance = {},
    opts: { scope?: MemoryScope; source?: "chat" | "ui" } = {},
  ): LearnOutcome {
    if (containsSecret(c.body) || containsSecret(c.quote)) return { status: "secret" };
    const key = this.store.memory.tombstoneKey();
    for (const t of this.store.memory.tombstones())
      if (matchesTombstone(key, c.body, t)) this.store.memory.deleteTombstone(t.id);
    return this.write(botId, c, "user", opts.source ?? "chat", p, opts.scope);
  }

  /** An inferred candidate from a turn: filtered by the learning switch, secrets and tombstones. */
  learn(botId: string, c: Candidate, p: Provenance = {}): LearnOutcome {
    if (this.o.learning && !this.o.learning()) return { status: "off" };
    if (containsSecret(c.body) || containsSecret(c.quote)) return { status: "secret" };
    if (this.isForgotten(c.body) || this.isForgotten(c.quote)) return { status: "forgotten" };
    return this.write(botId, c, "inferred", "chat", p);
  }

  private tombstone(botId: string, text: string, reason: "forget" | "never_learn" = "forget"): void {
    const key = this.store.memory.tombstoneKey();
    const shingles = tombstoneShingles(key, text);
    if (!normalizeForMatch(text)) return;
    this.store.memory.addTombstone(
      { botId, digest: tombstoneDigest(key, text), shingles, reason },
      this.now(),
    );
  }

  /** Hard delete an item and every version of it, and remember (as hashes) not to learn it again. */
  forget(id: string): MemoryRecord[] {
    const gone = this.store.memory.forgetChain(id);
    for (const m of gone) {
      this.tombstone(m.botId, m.body);
      if (m.quote) this.tombstone(m.botId, m.quote);
    }
    const last = gone.at(-1);
    if (last) this.changed({ op: "forgotten", memory: last });
    return gone;
  }

  /** "忘記…": forget every item the bot can see that matches, and never learn that text again. */
  forgetMatching(botId: string, query: string): MemoryRecord[] {
    const key = this.store.memory.tombstoneKey();
    const probe = { digest: tombstoneDigest(key, query), shingles: tombstoneShingles(key, query) };
    const seen = new Set<string>();
    const hits = [
      ...this.store.memory.search(query, { visibleTo: botId, limit: 50 }),
      ...this.store.memory
        .list({ visibleTo: botId, limit: 500 })
        .filter((m) => matchesTombstone(key, m.body, probe)),
    ].filter((m) => !seen.has(m.id) && seen.add(m.id));
    const gone: MemoryRecord[] = [];
    for (const m of hits) gone.push(...this.forget(m.id));
    this.tombstone(botId, query);
    return gone;
  }

  /** The person edits an item: a new confirmed version that supersedes it. */
  edit(id: string, patch: { body?: string; kind?: MemoryKind }, p: Provenance = {}): LearnOutcome {
    const old = this.store.memory.get(id);
    if (!old) return { status: "duplicate" };
    if (old.status !== "active") return { status: "duplicate", memory: old };
    const body = (patch.body ?? old.body).trim().slice(0, 2000);
    if (!body || containsSecret(body)) return { status: "secret" };
    // A life event's day lives in its body: an edit that changes the day moves `due_at` with it,
    // and an edit that no longer names a day takes it off the timeline.
    const dueAt = old.subject.startsWith("life:") ? lifeInstant(old.subject, body) : old.dueAt;
    const m = this.store.memory.add(
      {
        botId: old.botId,
        scope: old.scope,
        kind: patch.kind ?? old.kind,
        subject: old.subject,
        body,
        quote: old.quote,
        origin: "user",
        confidence: 1,
        source: this.source("ui", p),
        supersedes: old.id,
        ...(old.appliesTo.length ? { appliesTo: old.appliesTo } : {}),
        ...(dueAt ? { dueAt } : {}),
      },
      this.now(),
    );
    this.embedLater(m);
    this.changed({ op: "superseded", memory: m, replaces: old.id });
    return { status: "superseded", memory: m, replaced: old };
  }

  confirm(id: string): MemoryRecord | undefined {
    if (!this.store.memory.confirm(id, this.now())) return undefined;
    const m = this.store.memory.get(id) as MemoryRecord;
    this.changed({ op: "confirmed", memory: m });
    return m;
  }

  rescope(id: string, scope: MemoryScope): MemoryRecord | undefined {
    if (!this.store.memory.rescope(id, scope, this.now())) return undefined;
    const m = this.store.memory.get(id) as MemoryRecord;
    this.changed({ op: "rescoped", memory: m });
    return m;
  }

  list(botId: string, q: Omit<MemoryQuery, "visibleTo"> = {}): MemoryRecord[] {
    return this.store.memory.list({ ...q, visibleTo: botId });
  }

  /** Full-text search, fused with vector similarity when an embedder is plugged in. */
  async search(
    botId: string,
    query: string,
    limit = 10,
    opts: { kinds?: readonly MemoryKind[]; any?: boolean } = {},
  ): Promise<MemoryRecord[]> {
    const kinds = opts.kinds;
    const fts = this.store.memory.search(query, {
      visibleTo: botId,
      limit: limit * 2,
      ...(kinds ? { kinds } : {}),
      ...(opts.any ? { any: true } : {}),
    });
    const e = this.o.embedder;
    if (!e || !query.trim()) return fts.slice(0, limit);
    let ranked: string[] = [];
    try {
      const [q] = await e.embed([query]);
      if (q)
        ranked = this.store.memory
          .embeddings(botId, e.id)
          .map((x) => ({ id: x.id, s: cosine(q, x.vector) }))
          .filter((x) => x.s > 0.2)
          .sort((a, b) => b.s - a.s)
          .slice(0, limit * 2)
          .map((x) => x.id);
    } catch {
      ranked = [];
    }
    const ids = fuseRanks([fts.map((m) => m.id), ranked]).slice(0, limit);
    const byId = new Map(fts.map((m) => [m.id, m as MemoryRecord]));
    return ids
      .map((id) => byId.get(id) ?? this.store.memory.get(id))
      .filter((m): m is MemoryRecord => !!m && m.status === "active" && (!kinds || kinds.includes(m.kind)));
  }

  /**
   * Read path: what the router gets for one message, within a token budget.
   * First what matches the message, then standing preferences and people
   * (confirmed first). Recalled items are counted as used.
   */
  async recall(botId: string, query: string, budgetTokens = 400): Promise<RecallEntry[]> {
    const matched = await this.search(botId, query, 8, { any: true }).catch(() => []);
    // Standing: preferences and people, and any fact the person confirmed (an allergy matters at dinner).
    const standing = this.store.memory
      .list({ visibleTo: botId, kinds: ["preference", "person", "fact"], limit: 60 })
      .filter((m) => (m.kind === "fact" ? m.origin === "user" : m.origin === "user" || m.confidence >= 0.6))
      .sort((a, b) => (a.origin === b.origin ? b.confidence - a.confidence : a.origin === "user" ? -1 : 1));
    const out: RecallEntry[] = [];
    const seen = new Set<string>();
    let used = 0;
    for (const [m, why] of [
      ...matched.map((m) => [m, "match"] as const),
      ...standing.map((m) => [m, "standing"] as const),
    ]) {
      if (seen.has(m.id)) continue;
      const e: RecallEntry = {
        id: m.id,
        kind: m.kind,
        origin: m.origin,
        confidence: m.confidence,
        body: m.body,
        why,
      };
      const cost = estimateTokens(`- ${e.body}（${recallTag(e)}・${e.id}）`) + 2;
      if (used + cost > budgetTokens) continue;
      used += cost;
      seen.add(m.id);
      out.push(e);
    }
    if (out.length)
      this.store.memory.touch(
        out.map((e) => e.id),
        this.now(),
      );
    return out;
  }

  /** Everything a bot can read, with provenance and history, for the person to keep. */
  export(botId: string): Record<string, unknown> {
    const active = this.store.memory.list({ visibleTo: botId, limit: 100_000 });
    const bot = this.store.bots.get(botId);
    return {
      format: "alca.memory.export.v1",
      exportedAt: this.now().toISOString(),
      bot: bot ? { id: bot.id, name: bot.name } : { id: botId },
      memories: active.map((m) => ({
        id: m.id,
        kind: m.kind,
        scope: m.scope,
        body: m.body,
        quote: m.quote,
        origin: m.origin,
        confidence: m.confidence,
        source: m.source,
        ownerBotId: m.botId,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
        confirmedAt: m.confirmedAt,
        history: this.store.memory
          .chain(m.id)
          .filter((x) => x.id !== m.id)
          .map((x) => ({ id: x.id, body: x.body, origin: x.origin, createdAt: x.createdAt })),
      })),
      skills: this.store.skills.list({ botId }).map((s) => ({
        id: s.id,
        status: s.status,
        version: s.version,
        versions: this.store.skills.versions(s.id),
      })),
      forgotten: this.store.memory.tombstones().length,
    };
  }
}
