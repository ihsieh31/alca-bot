import type { Learning } from "@alca/core";
import { tSource } from "@alca/design/i18n";
import { candidateFromRemember, confirmClasses } from "@alca/memory";
import type { MemoryKind, MemoryRecord, MemoryScope, SkillRecord, SkillVersion, Store } from "@alca/store";

/**
 * Memory and skill management shared by the loopback HTTP routes (desktop)
 * and the Link RPC ops (phone). Everything is per bot: a bot sees its own
 * items plus the shared user model, and only its own skills.
 */

const KINDS: readonly MemoryKind[] = ["fact", "preference", "person", "project"];
const SCOPES: readonly MemoryScope[] = ["shared", "bot"];

export class MemoryApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const bad = (m: string) => new MemoryApiError(400, m);
const missing = (m: string) => new MemoryApiError(404, m);

export interface MemoryView {
  id: string;
  botId: string;
  botName: string;
  scope: MemoryScope;
  kind: MemoryKind;
  body: string;
  quote: string | null;
  origin: "user" | "inferred";
  confidence: number;
  status: "active" | "superseded";
  source: {
    kind: string;
    threadId: string | null;
    threadTitle: string | null;
    messageId: string | null;
    workerId: string | null;
    workerTitle: string | null;
  };
  /** The person edited it (the source still names where it was first learned). */
  edited: boolean;
  versions: number;
  uses: number;
  lastUsedAt: string | null;
  confirmedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SkillVersionView {
  version: number;
  name: string;
  description: string;
  triggers: string[];
  steps: Array<{ text: string; tool?: string; actionClass?: string }>;
  actionClasses: string[];
  alwaysConfirm: string[];
  state: SkillVersion["state"];
  author: SkillVersion["author"];
  note: string | null;
  createdAt: string;
}

export interface SkillView {
  id: string;
  botId: string;
  botName: string;
  status: SkillRecord["status"];
  version: number;
  current: SkillVersionView | null;
  pending: SkillVersionView | null;
  history: Array<{ version: number; state: string; author: string; createdAt: string; note: string | null }>;
  uses: number;
  lastUsedAt: string | null;
  source: { threadId: string | null; threadTitle: string | null; workerId: string | null };
  createdAt: string;
  updatedAt: string;
}

export class MemoryApi {
  private readonly learning: Learning;
  private readonly store: Store;
  private readonly defaultBot: () => string;

  constructor(learning: Learning, defaultBot: () => string) {
    this.learning = learning;
    this.store = learning.store;
    this.defaultBot = defaultBot;
  }

  /** The learning channel (memory changed / skill proposed or updated), in both modes. */
  subscribe(fn: Parameters<Learning["subscribe"]>[0]): () => void {
    return this.learning.subscribe(fn);
  }

  private bot(id: unknown): string {
    const b = typeof id === "string" && id ? id : this.defaultBot();
    if (!this.store.bots.get(b)) throw missing(`bot ${b}`);
    return b;
  }

  private botName(id: string): string {
    return this.store.bots.get(id)?.name ?? id;
  }

  memoryView(m: MemoryRecord): MemoryView {
    // An edited item keeps pointing at where it was first learned.
    const chain = this.store.memory.chain(m.id);
    const origin = m.source.kind === "ui" ? (chain.find((x) => x.source.kind === "chat") ?? m) : m;
    const t = origin.source.threadId ? this.store.threads.get(origin.source.threadId) : undefined;
    const w = origin.source.workerId ? this.store.workers.get(origin.source.workerId) : undefined;
    return {
      id: m.id,
      botId: m.botId,
      botName: this.botName(m.botId),
      scope: m.scope,
      kind: m.kind,
      body: m.body,
      quote: m.quote,
      origin: m.origin,
      confidence: m.confidence,
      status: m.status,
      source: {
        kind: origin.source.kind ?? "chat",
        threadId: origin.source.threadId,
        threadTitle: t?.title ?? null,
        messageId: origin.source.messageId,
        workerId: origin.source.workerId,
        workerTitle: w?.title ?? null,
      },
      edited: origin !== m || (m.source.kind === "ui" && chain.length > 1),
      versions: chain.length,
      uses: m.uses,
      lastUsedAt: m.lastUsedAt,
      confirmedAt: m.confirmedAt,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    };
  }

  private visible(id: string, botId?: string): MemoryRecord {
    const m = this.store.memory.get(id);
    const b = botId ? this.bot(botId) : undefined;
    if (!m || (b && m.botId !== b && m.scope !== "shared")) throw missing(`memory ${id}`);
    return m;
  }

  async list(q: { bot?: unknown; q?: unknown; kind?: unknown; origin?: unknown; scope?: unknown }) {
    const botId = this.bot(q.bot);
    const kind = KINDS.includes(q.kind as MemoryKind) ? (q.kind as MemoryKind) : undefined;
    const origin = q.origin === "user" || q.origin === "inferred" ? q.origin : undefined;
    const scope = SCOPES.includes(q.scope as MemoryScope) ? (q.scope as MemoryScope) : undefined;
    const text = typeof q.q === "string" ? q.q.trim().slice(0, 200) : "";
    let items = text
      ? await this.learning.memory.search(botId, text, 200, kind ? { kinds: [kind] } : {})
      : this.learning.memory.list(botId, { ...(kind ? { kinds: [kind] } : {}), limit: 500 });
    if (origin) items = items.filter((m) => m.origin === origin);
    if (scope) items = items.filter((m) => m.scope === scope);
    const all = this.learning.memory.list(botId, { limit: 100_000 });
    const counts: Record<string, number> = { all: all.length, user: 0, inferred: 0 };
    for (const k of KINDS) counts[k] = 0;
    for (const m of all) {
      counts[m.kind] = (counts[m.kind] ?? 0) + 1;
      counts[m.origin] = (counts[m.origin] ?? 0) + 1;
    }
    return {
      botId,
      items: items.map((m) => this.memoryView(m)),
      counts,
      forgotten: this.store.memory.tombstones().length,
      learning: true,
    };
  }

  detail(id: string, bot?: unknown) {
    const m = this.visible(id, typeof bot === "string" ? bot : undefined);
    return {
      memory: this.memoryView(m),
      history: this.store.memory.chain(m.id).map((x) => ({
        id: x.id,
        body: x.body,
        origin: x.origin,
        status: x.status,
        createdAt: x.createdAt,
        source: x.source.kind,
      })),
    };
  }

  add(body: Record<string, unknown>) {
    const botId = this.bot(body.botId);
    const text = typeof body.body === "string" ? body.body.trim() : "";
    if (!text || text.length > 2000) throw bad("body is required (≤ 2000 chars)");
    // No kind given (the 新增記憶 box): the same rules as 「記住…」 pick it, so 「我喜歡答案先給結論」
    // is a preference, not a fact (mac test 2026-11-04). The person's words stay the body.
    const picked = candidateFromRemember({ text, quote: "" });
    const kind = KINDS.includes(body.kind as MemoryKind) ? (body.kind as MemoryKind) : picked.kind;
    const subject = kind === picked.kind ? picked.subject : "";
    const scope = SCOPES.includes(body.scope as MemoryScope) ? (body.scope as MemoryScope) : undefined;
    const r = this.learning.memory.remember(
      botId,
      { kind, subject, body: text, quote: "", confidence: 1 },
      {},
      { source: "ui", ...(scope ? { scope } : {}) },
    );
    if (r.status === "secret") throw bad(tSource("core.memory.secret"));
    return { status: r.status, memory: r.memory ? this.memoryView(r.memory) : null };
  }

  update(id: string, body: Record<string, unknown>) {
    const m = this.visible(id, typeof body.botId === "string" ? body.botId : undefined);
    if (m.status !== "active") throw new MemoryApiError(409, tSource("core.memory.oldVersion"));
    let cur = m;
    if (typeof body.scope === "string") {
      if (!SCOPES.includes(body.scope as MemoryScope)) throw bad("scope must be shared or bot");
      cur = this.learning.memory.rescope(m.id, body.scope as MemoryScope) ?? cur;
    }
    const kind = KINDS.includes(body.kind as MemoryKind) ? (body.kind as MemoryKind) : undefined;
    const text = typeof body.body === "string" ? body.body.trim() : undefined;
    if ((text !== undefined && text !== cur.body) || (kind && kind !== cur.kind)) {
      if (text !== undefined && (!text || text.length > 2000)) throw bad("body is required (≤ 2000 chars)");
      const r = this.learning.memory.edit(cur.id, {
        ...(text ? { body: text } : {}),
        ...(kind ? { kind } : {}),
      });
      if (r.status === "secret") throw bad(tSource("core.memory.secret"));
      if (r.memory) cur = r.memory;
    }
    return { memory: this.memoryView(this.store.memory.get(cur.id) as MemoryRecord) };
  }

  confirm(id: string) {
    this.visible(id);
    const m = this.learning.memory.confirm(id) ?? this.store.memory.get(id);
    return { memory: m ? this.memoryView(m) : null };
  }

  forget(id: string) {
    this.visible(id);
    const gone = this.learning.memory.forget(id);
    return { forgotten: gone.length };
  }

  clearForgotten() {
    return { cleared: this.store.memory.clearTombstones() };
  }

  export(bot?: unknown) {
    return this.learning.memory.export(this.bot(bot));
  }

  // ── skills ─────────────────────────────────────────────────

  private versionView(v: SkillVersion | undefined): SkillVersionView | null {
    if (!v) return null;
    return {
      version: v.version,
      name: v.name,
      description: v.description,
      triggers: v.triggers,
      steps: v.steps.map((s) => ({
        text: s.text,
        ...(s.tool ? { tool: s.tool } : {}),
        ...(s.actionClass ? { actionClass: s.actionClass } : {}),
      })),
      actionClasses: v.actionClasses,
      alwaysConfirm: confirmClasses(v.actionClasses),
      state: v.state,
      author: v.author,
      note: v.note,
      createdAt: v.createdAt,
    };
  }

  skillView(s: SkillRecord): SkillView {
    const t = s.sourceThreadId ? this.store.threads.get(s.sourceThreadId) : undefined;
    return {
      id: s.id,
      botId: s.botId,
      botName: this.botName(s.botId),
      status: s.status,
      version: s.version,
      current: this.versionView(s.current),
      pending: this.versionView(s.pending),
      history: this.store.skills.versions(s.id).map((v) => ({
        version: v.version,
        state: v.state,
        author: v.author,
        createdAt: v.createdAt,
        note: v.note,
      })),
      uses: s.uses,
      lastUsedAt: s.lastUsedAt,
      source: { threadId: s.sourceThreadId, threadTitle: t?.title ?? null, workerId: s.sourceWorkerId },
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    };
  }

  private skill(id: string, bot?: unknown): SkillRecord {
    const s = this.store.skills.get(id);
    if (!s || (typeof bot === "string" && bot && s.botId !== bot)) throw missing(`skill ${id}`);
    return s;
  }

  skills(q: { bot?: unknown; status?: unknown }) {
    const botId = this.bot(q.bot);
    const all = this.store.skills.list({ botId }).filter((s) => s.status !== "rejected" || s.pending);
    const items = q.status === "proposed" ? all.filter((s) => s.pending) : all;
    return { botId, items: items.map((s) => this.skillView(s)) };
  }

  /** Proposals waiting for the person in a thread (shown as cards in that chat). */
  proposalsFor(threadId: string): SkillView[] {
    return this.store.skills
      .list({})
      .filter((s) => s.sourceThreadId === threadId && s.pending && s.status !== "rejected")
      .map((s) => this.skillView(s));
  }

  skillDetail(id: string) {
    return { skill: this.skillView(this.skill(id)) };
  }

  private version(body: Record<string, unknown>): number | undefined {
    return typeof body.version === "number" && Number.isInteger(body.version) ? body.version : undefined;
  }

  approve(id: string, body: Record<string, unknown> = {}) {
    this.skill(id);
    if (body.edit && typeof body.edit === "object") this.edit(id, body.edit as Record<string, unknown>);
    else this.learning.approveSkill(id, this.version(body));
    return this.skillDetail(id);
  }

  reject(id: string, body: Record<string, unknown> = {}) {
    this.skill(id);
    this.learning.rejectSkill(id, this.version(body));
    return this.skillDetail(id);
  }

  edit(id: string, body: Record<string, unknown>) {
    this.skill(id);
    const list = (v: unknown, max: number) =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, max) : undefined;
    const name = typeof body.name === "string" ? body.name : undefined;
    const description = typeof body.description === "string" ? body.description : undefined;
    const triggers = list(body.triggers, 8);
    const steps = list(body.steps, 30);
    if (steps?.every((s) => !s.trim())) throw bad("a skill needs at least one step");
    this.learning.editSkill(id, {
      ...(name !== undefined ? { name } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(triggers ? { triggers } : {}),
      ...(steps ? { steps } : {}),
    });
    return this.skillDetail(id);
  }

  setEnabled(id: string, enabled: boolean) {
    const s = this.skill(id);
    if (s.version === 0) throw new MemoryApiError(409, tSource("core.memory.skillNotApproved"));
    this.learning.setSkillEnabled(id, enabled);
    return this.skillDetail(id);
  }

  remove(id: string) {
    this.skill(id);
    return { deleted: this.learning.deleteSkill(id) };
  }
}
