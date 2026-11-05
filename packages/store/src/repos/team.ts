import type { DatabaseSync } from "node:sqlite";
import { transaction } from "../db.ts";
import { newStoreId } from "../ids.ts";

/**
 * P7 team state: the team rules, bot-to-bot requests with their append-only
 * trail, and the model services bots can run on.
 */

/** Whether a teammate's request needs the person's yes first. */
export type PeerApprovalRule = "auto" | "ask_delegate" | "ask_all";

export interface TeamRules {
  /** auto: teammates ask and delegate freely; ask_delegate: delegations ask the person; ask_all: both ask. */
  peerApproval: PeerApprovalRule;
  /** How deep a chain of delegations may go (A → B is 1, A → B → C is 2). */
  maxDepth: number;
  /** Open requests one conversation may have at once. */
  maxOpen: number;
}

export const DEFAULT_TEAM_RULES: TeamRules = Object.freeze({
  peerApproval: "ask_delegate",
  maxDepth: 2,
  maxOpen: 4,
});

export type PeerKind = "ask" | "delegate";
export type PeerStatus = "running" | "done" | "failed" | "denied" | "refused" | "stopped";
export const PEER_FINAL: readonly PeerStatus[] = ["done", "failed", "denied", "refused", "stopped"];

export interface PeerRequest {
  id: string;
  kind: PeerKind;
  fromBotId: string;
  toBotId: string;
  fromThreadId: string;
  fromRunId: string | null;
  /** The person's conversation the chain started from (cards are shown there). */
  rootThreadId: string;
  /** The asked bot's conversation for this request. */
  peerThreadId: string | null;
  parentId: string | null;
  depth: number;
  /** Bots already in the chain, root first (loop check). */
  chain: string[];
  text: string;
  status: PeerStatus;
  reason: string | null;
  result: string | null;
  approvalId: string | null;
  initiator: { kind: "user" | "schedule" | "agent" | "webhook"; id: string };
  createdAt: string;
  finishedAt: string | null;
}

export type PeerEventKind =
  | "requested"
  | "approval"
  | "approved"
  | "denied"
  | "refused"
  | "started"
  | "card"
  | "answered"
  | "failed"
  | "stopped";

export interface PeerEvent {
  id: string;
  requestId: string;
  kind: PeerEventKind;
  botId: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
}

export type ProviderKind = "openai" | "gemini" | "anthropic" | "acp";

/** A custom provider's own fields (P11): an ACP agent's command, the key's env var, the model list. */
export interface CustomProviderConfig {
  command?: string[];
  /** Env var names → non-secret values for an ACP agent. */
  env?: Record<string, string>;
  /** The vault key goes to the agent as this env var. */
  keyEnv?: string;
  models?: string[];
}

export interface EngineProvider {
  id: string;
  kind: ProviderKind;
  label: string;
  baseUrl: string;
  model: string;
  hasKey: boolean;
  config: CustomProviderConfig;
  createdAt: string;
}

/** The person's choices for a built-in provider (P11); the key itself is in the vault. */
export interface ProviderSettings {
  baseUrl?: string;
  command?: string[];
  /** OpenAI only: "openai-responses" (default) or "openai-chat". */
  family?: string;
  defaultModel?: string;
  reasoningEffort?: string;
}

interface PeerRow {
  id: string;
  kind: PeerKind;
  from_bot_id: string;
  to_bot_id: string;
  from_thread_id: string;
  from_run_id: string | null;
  root_thread_id: string;
  peer_thread_id: string | null;
  parent_id: string | null;
  depth: number;
  chain: string;
  text: string;
  status: PeerStatus;
  reason: string | null;
  result: string | null;
  approval_id: string | null;
  initiator_kind: PeerRequest["initiator"]["kind"];
  initiator_id: string;
  created_at: string;
  finished_at: string | null;
}

const peer = (r: PeerRow): PeerRequest => ({
  id: r.id,
  kind: r.kind,
  fromBotId: r.from_bot_id,
  toBotId: r.to_bot_id,
  fromThreadId: r.from_thread_id,
  fromRunId: r.from_run_id,
  rootThreadId: r.root_thread_id,
  peerThreadId: r.peer_thread_id,
  parentId: r.parent_id,
  depth: r.depth,
  chain: JSON.parse(r.chain) as string[],
  text: r.text,
  status: r.status,
  reason: r.reason,
  result: r.result,
  approvalId: r.approval_id,
  initiator: { kind: r.initiator_kind, id: r.initiator_id },
  createdAt: r.created_at,
  finishedAt: r.finished_at,
});

interface ProviderRow {
  id: string;
  kind: ProviderKind;
  label: string;
  base_url: string;
  model: string;
  has_key: number;
  config: string;
  created_at: string;
}

const provider = (r: ProviderRow): EngineProvider => ({
  id: r.id,
  kind: r.kind,
  label: r.label,
  baseUrl: r.base_url,
  model: r.model,
  hasKey: r.has_key === 1,
  config: JSON.parse(r.config || "{}") as CustomProviderConfig,
  createdAt: r.created_at,
});

export class TeamRepo {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  // ── team rules ──
  rules(): TeamRules {
    const rows = this.db.prepare("SELECT key, value FROM team_meta").all() as Array<{
      key: string;
      value: string;
    }>;
    const m = new Map(rows.map((r) => [r.key, r.value]));
    const approval = m.get("peerApproval");
    const n = (k: string, d: number, lo: number, hi: number) => {
      const v = Number(m.get(k));
      return Number.isInteger(v) && v >= lo && v <= hi ? v : d;
    };
    return {
      peerApproval:
        approval === "auto" || approval === "ask_delegate" || approval === "ask_all"
          ? approval
          : DEFAULT_TEAM_RULES.peerApproval,
      maxDepth: n("maxDepth", DEFAULT_TEAM_RULES.maxDepth, 1, 5),
      maxOpen: n("maxOpen", DEFAULT_TEAM_RULES.maxOpen, 1, 16),
    };
  }

  setRules(patch: Partial<TeamRules>): TeamRules {
    const put = this.db.prepare(
      "INSERT INTO team_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
    transaction(this.db, () => {
      if (patch.peerApproval !== undefined) {
        if (!["auto", "ask_delegate", "ask_all"].includes(patch.peerApproval))
          throw new Error("peerApproval must be auto / ask_delegate / ask_all");
        put.run("peerApproval", patch.peerApproval);
      }
      if (patch.maxDepth !== undefined) {
        if (!Number.isInteger(patch.maxDepth) || patch.maxDepth < 1 || patch.maxDepth > 5)
          throw new Error("maxDepth must be 1–5");
        put.run("maxDepth", String(patch.maxDepth));
      }
      if (patch.maxOpen !== undefined) {
        if (!Number.isInteger(patch.maxOpen) || patch.maxOpen < 1 || patch.maxOpen > 16)
          throw new Error("maxOpen must be 1–16");
        put.run("maxOpen", String(patch.maxOpen));
      }
    });
    return this.rules();
  }

  // ── peer requests ──
  createRequest(
    r: Omit<
      PeerRequest,
      "id" | "createdAt" | "finishedAt" | "result" | "reason" | "peerThreadId" | "approvalId"
    > & { reason?: string; approvalId?: string | null },
    now = new Date(),
  ): PeerRequest {
    const id = newStoreId("peer", now.getTime());
    const final = PEER_FINAL.includes(r.status);
    this.db
      .prepare(
        `INSERT INTO peer_requests (id, kind, from_bot_id, to_bot_id, from_thread_id, from_run_id, root_thread_id,
           parent_id, depth, chain, text, status, reason, approval_id, initiator_kind, initiator_id, created_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        r.kind,
        r.fromBotId,
        r.toBotId,
        r.fromThreadId,
        r.fromRunId,
        r.rootThreadId,
        r.parentId,
        r.depth,
        JSON.stringify(r.chain),
        r.text.slice(0, 8000),
        r.status,
        r.reason ?? null,
        r.approvalId ?? null,
        r.initiator.kind,
        r.initiator.id,
        now.toISOString(),
        final ? now.toISOString() : null,
      );
    return this.request(id) as PeerRequest;
  }

  request(id: string): PeerRequest | undefined {
    const r = this.db.prepare("SELECT * FROM peer_requests WHERE id = ?").get(id) as PeerRow | undefined;
    return r ? peer(r) : undefined;
  }

  /** The request a peer thread serves. */
  byPeerThread(threadId: string): PeerRequest | undefined {
    const r = this.db.prepare("SELECT * FROM peer_requests WHERE peer_thread_id = ?").get(threadId) as
      | PeerRow
      | undefined;
    return r ? peer(r) : undefined;
  }

  attachThread(id: string, threadId: string): void {
    this.db
      .prepare("UPDATE peer_requests SET peer_thread_id = ? WHERE id = ? AND peer_thread_id IS NULL")
      .run(threadId, id);
  }

  /** Close a running request once. Returns false when it was already final. */
  finish(
    id: string,
    status: Exclude<PeerStatus, "running">,
    o: { result?: string; reason?: string },
    now = new Date(),
  ): boolean {
    const r = this.db
      .prepare(
        `UPDATE peer_requests SET status = ?, result = ?, reason = ?, finished_at = ?
         WHERE id = ? AND status = 'running'`,
      )
      .run(status, o.result?.slice(0, 20_000) ?? null, o.reason ?? null, now.toISOString(), id);
    return Number(r.changes) > 0;
  }

  /** Open requests sent from one conversation. */
  openFrom(threadId: string): PeerRequest[] {
    const rows = this.db
      .prepare("SELECT * FROM peer_requests WHERE from_thread_id = ? AND status = 'running'")
      .all(threadId) as unknown as PeerRow[];
    return rows.map(peer);
  }

  running(): PeerRequest[] {
    const rows = this.db
      .prepare("SELECT * FROM peer_requests WHERE status = 'running' ORDER BY created_at")
      .all() as unknown as PeerRow[];
    return rows.map(peer);
  }

  /** Requests whose chain started in this conversation, oldest first. */
  byRoot(threadId: string): PeerRequest[] {
    const rows = this.db
      .prepare("SELECT * FROM peer_requests WHERE root_thread_id = ? ORDER BY created_at, rowid")
      .all(threadId) as unknown as PeerRow[];
    return rows.map(peer);
  }

  /** Newest first, optionally one bot's (asked or asking). */
  recent(o: { botId?: string; limit?: number } = {}): PeerRequest[] {
    const limit = Math.max(1, Math.min(o.limit ?? 50, 500));
    const rows = (o.botId
      ? this.db
          .prepare(
            "SELECT * FROM peer_requests WHERE from_bot_id = ? OR to_bot_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
          )
          .all(o.botId, o.botId, limit)
      : this.db
          .prepare("SELECT * FROM peer_requests ORDER BY created_at DESC, rowid DESC LIMIT ?")
          .all(limit)) as unknown as PeerRow[];
    return rows.map(peer);
  }

  addEvent(
    e: { requestId: string; kind: PeerEventKind; botId?: string | null; detail?: Record<string, unknown> },
    now = new Date(),
  ): PeerEvent {
    const id = newStoreId("pev", now.getTime());
    this.db
      .prepare(
        "INSERT INTO peer_events (id, request_id, kind, bot_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(id, e.requestId, e.kind, e.botId ?? null, JSON.stringify(e.detail ?? {}), now.toISOString());
    return {
      id,
      requestId: e.requestId,
      kind: e.kind,
      botId: e.botId ?? null,
      detail: e.detail ?? {},
      createdAt: now.toISOString(),
    };
  }

  events(requestId: string): PeerEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM peer_events WHERE request_id = ? ORDER BY created_at, rowid")
      .all(requestId) as Array<{
      id: string;
      request_id: string;
      kind: PeerEventKind;
      bot_id: string | null;
      detail: string;
      created_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      requestId: r.request_id,
      kind: r.kind,
      botId: r.bot_id,
      detail: JSON.parse(r.detail) as Record<string, unknown>,
      createdAt: r.created_at,
    }));
  }

  // ── engine providers ──
  addProvider(
    p: {
      kind: ProviderKind;
      label: string;
      baseUrl: string;
      model: string;
      hasKey: boolean;
      config?: CustomProviderConfig;
    },
    now = new Date(),
  ): EngineProvider {
    const id = newStoreId("eng", now.getTime());
    this.db
      .prepare(
        "INSERT INTO engine_providers (id, kind, label, base_url, model, has_key, config, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        p.kind,
        p.label,
        p.baseUrl,
        p.model,
        p.hasKey ? 1 : 0,
        JSON.stringify(p.config ?? {}),
        now.toISOString(),
      );
    return this.provider(id) as EngineProvider;
  }

  setProviderHasKey(id: string, hasKey: boolean): void {
    this.db
      .prepare("UPDATE engine_providers SET has_key = ? WHERE id = ? AND removed_at IS NULL")
      .run(hasKey ? 1 : 0, id);
  }

  // ── built-in provider settings (P11) ──
  providerSettings(id: string): { settings: ProviderSettings; hasKey: boolean } {
    const r = this.db.prepare("SELECT settings, has_key FROM provider_settings WHERE id = ?").get(id) as
      | { settings: string; has_key: number }
      | undefined;
    return r
      ? { settings: JSON.parse(r.settings) as ProviderSettings, hasKey: r.has_key === 1 }
      : { settings: {}, hasKey: false };
  }

  setProviderSettings(
    id: string,
    patch: { settings?: ProviderSettings; hasKey?: boolean },
    now = new Date(),
  ): void {
    const cur = this.providerSettings(id);
    const settings = patch.settings ?? cur.settings;
    const hasKey = patch.hasKey ?? cur.hasKey;
    this.db
      .prepare(
        "INSERT INTO provider_settings (id, settings, has_key, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET settings = excluded.settings, has_key = excluded.has_key, updated_at = excluded.updated_at",
      )
      .run(id, JSON.stringify(settings), hasKey ? 1 : 0, now.toISOString());
  }

  provider(id: string): EngineProvider | undefined {
    const r = this.db.prepare("SELECT * FROM engine_providers WHERE id = ? AND removed_at IS NULL").get(id) as
      | ProviderRow
      | undefined;
    return r ? provider(r) : undefined;
  }

  providers(): EngineProvider[] {
    const rows = this.db
      .prepare("SELECT * FROM engine_providers WHERE removed_at IS NULL ORDER BY created_at")
      .all() as unknown as ProviderRow[];
    return rows.map(provider);
  }

  removeProvider(id: string, now = new Date()): boolean {
    const r = this.db
      .prepare("UPDATE engine_providers SET removed_at = ? WHERE id = ? AND removed_at IS NULL")
      .run(now.toISOString(), id);
    return Number(r.changes) > 0;
  }
}
