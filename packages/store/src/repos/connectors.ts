import type { DatabaseSync } from "node:sqlite";
import { atomic } from "../db.ts";
import { newStoreId } from "../ids.ts";

export type ConnectorAccountStatus = "pending" | "active" | "failed" | "expired" | "removed";
export type ConnectorAccess = "read" | "act";

/** Next round R8: where an account's tools run. */
/**
 * `google` (Gmail / Calendar straight from Google, next round R8) was removed
 * on 2026-11-05: migration 27 marks any such account removed; reading Gmail /
 * Google Calendar goes through Composio only.
 */
export type IntegrationProviderId = "composio" | "mcp";

export interface ConnectorAccount {
  id: string;
  provider: IntegrationProviderId;
  remoteId: string;
  toolkit: string;
  label: string;
  status: ConnectorAccountStatus;
  /** What the provider says the account is (an address or a login), never a token. */
  identity: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectorGrant {
  botId: string;
  accountId: string;
  access: ConnectorAccess;
}

export interface ConnectorTrigger {
  id: string;
  accountId: string;
  slug: string;
  remoteId: string | null;
  triggerId: string;
  config: Record<string, unknown>;
  status: "active" | "failed" | "removed";
  detail: string;
  createdAt: string;
}

const account = (r: Record<string, unknown>): ConnectorAccount => ({
  id: r.id as string,
  provider: r.provider as IntegrationProviderId,
  remoteId: r.remote_id as string,
  toolkit: r.toolkit as string,
  label: r.label as string,
  status: r.status as ConnectorAccountStatus,
  identity: r.identity as string,
  createdAt: r.created_at as string,
  updatedAt: r.updated_at as string,
});

const ctrigger = (r: Record<string, unknown>): ConnectorTrigger => ({
  id: r.id as string,
  accountId: r.account_id as string,
  slug: r.slug as string,
  remoteId: (r.remote_id as string | null) ?? null,
  triggerId: r.trigger_id as string,
  config: JSON.parse(r.config as string) as Record<string, unknown>,
  status: r.status as ConnectorTrigger["status"],
  detail: r.detail as string,
  createdAt: r.created_at as string,
});

/** The local half of connected apps: which accounts exist, who may use them, how much they were used today. */
export class ConnectorRepo {
  readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  addAccount(a: {
    /** Default composio (every account before next round R8). */
    provider?: IntegrationProviderId;
    remoteId: string;
    toolkit: string;
    label: string;
    status?: ConnectorAccountStatus;
    identity?: string;
  }): ConnectorAccount {
    const id = newStoreId("acc");
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO connector_accounts (id, provider, remote_id, toolkit, label, status, identity, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        a.provider ?? "composio",
        a.remoteId,
        a.toolkit,
        a.label,
        a.status ?? "pending",
        a.identity ?? "",
        now,
        now,
      );
    return this.account(id) as ConnectorAccount;
  }

  account(id: string): ConnectorAccount | undefined {
    const r = this.db.prepare("SELECT * FROM connector_accounts WHERE id = ?").get(id);
    return r ? account(r as Record<string, unknown>) : undefined;
  }

  byRemote(remoteId: string, provider: IntegrationProviderId = "composio"): ConnectorAccount | undefined {
    const r = this.db
      .prepare("SELECT * FROM connector_accounts WHERE provider = ? AND remote_id = ?")
      .get(provider, remoteId);
    return r ? account(r as Record<string, unknown>) : undefined;
  }

  /** Every account that is not removed, grouped by app then label. */
  accounts(opts: { includeRemoved?: boolean } = {}): ConnectorAccount[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM connector_accounts ${opts.includeRemoved ? "" : "WHERE status <> 'removed'"} ORDER BY toolkit, label, created_at`,
      )
      .all() as Record<string, unknown>[];
    return rows.map(account);
  }

  setStatus(id: string, status: ConnectorAccountStatus, identity?: string): void {
    this.db
      .prepare(
        "UPDATE connector_accounts SET status = ?, identity = COALESCE(?, identity), updated_at = ? WHERE id = ?",
      )
      .run(status, identity ?? null, new Date().toISOString(), id);
  }

  rename(id: string, label: string): void {
    this.db
      .prepare("UPDATE connector_accounts SET label = ?, updated_at = ? WHERE id = ?")
      .run(label, new Date().toISOString(), id);
  }

  /** Disconnect: the row stays (audit refers to it) but no bot can use it any more. */
  remove(id: string): void {
    atomic(this.db, () => {
      this.db.prepare("DELETE FROM connector_grants WHERE account_id = ?").run(id);
      this.setStatus(id, "removed");
      this.db.prepare("UPDATE connector_triggers SET status = 'removed' WHERE account_id = ?").run(id);
    });
  }

  grant(botId: string, accountId: string, access: ConnectorAccess | null): void {
    if (access === null) {
      this.db
        .prepare("DELETE FROM connector_grants WHERE bot_id = ? AND account_id = ?")
        .run(botId, accountId);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO connector_grants (bot_id, account_id, access, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (bot_id, account_id) DO UPDATE SET access = excluded.access`,
      )
      .run(botId, accountId, access, new Date().toISOString());
  }

  grants(opts: { botId?: string; accountId?: string } = {}): ConnectorGrant[] {
    const where: string[] = [];
    const args: string[] = [];
    if (opts.botId) {
      where.push("bot_id = ?");
      args.push(opts.botId);
    }
    if (opts.accountId) {
      where.push("account_id = ?");
      args.push(opts.accountId);
    }
    const rows = this.db
      .prepare(
        `SELECT bot_id, account_id, access FROM connector_grants ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY bot_id, account_id`,
      )
      .all(...args) as Array<{ bot_id: string; account_id: string; access: ConnectorAccess }>;
    return rows.map((r) => ({ botId: r.bot_id, accountId: r.account_id, access: r.access }));
  }

  /** Active accounts this bot may use, with its access level. */
  usable(botId: string): Array<ConnectorAccount & { access: ConnectorAccess }> {
    const rows = this.db
      .prepare(
        `SELECT a.*, g.access FROM connector_accounts a JOIN connector_grants g ON g.account_id = a.id
         WHERE g.bot_id = ? AND a.status = 'active' ORDER BY a.toolkit, a.label`,
      )
      .all(botId) as Record<string, unknown>[];
    return rows.map((r) => ({ ...account(r), access: r.access as ConnectorAccess }));
  }

  usage(day: string, botId: string, actionClass: string): number {
    const r = this.db
      .prepare("SELECT count FROM connector_usage WHERE day = ? AND bot_id = ? AND action_class = ?")
      .get(day, botId, actionClass) as { count: number } | undefined;
    return r?.count ?? 0;
  }

  /** Reserve one use under a daily limit; false (and nothing changed) when the limit is reached. */
  reserve(day: string, botId: string, actionClass: string, limit: number): boolean {
    return atomic(this.db, () => {
      if (this.usage(day, botId, actionClass) >= limit) return false;
      this.db
        .prepare(
          `INSERT INTO connector_usage (day, bot_id, action_class, count) VALUES (?, ?, ?, 1)
           ON CONFLICT (day, bot_id, action_class) DO UPDATE SET count = count + 1`,
        )
        .run(day, botId, actionClass);
      return true;
    });
  }

  meta(key: string): string | undefined {
    const r = this.db.prepare("SELECT value FROM connector_meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return r?.value;
  }

  setMeta(key: string, value: string | null): void {
    if (value === null) this.db.prepare("DELETE FROM connector_meta WHERE key = ?").run(key);
    else
      this.db
        .prepare(
          "INSERT INTO connector_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        )
        .run(key, value);
  }

  addTrigger(t: {
    accountId: string;
    slug: string;
    remoteId: string | null;
    triggerId: string;
    config: Record<string, unknown>;
    status: ConnectorTrigger["status"];
    detail?: string;
  }): ConnectorTrigger {
    const id = newStoreId("ctg");
    this.db
      .prepare(
        `INSERT INTO connector_triggers (id, account_id, slug, remote_id, trigger_id, config, status, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        t.accountId,
        t.slug,
        t.remoteId,
        t.triggerId,
        JSON.stringify(t.config),
        t.status,
        t.detail ?? "",
        new Date().toISOString(),
      );
    return this.trigger(id) as ConnectorTrigger;
  }

  trigger(id: string): ConnectorTrigger | undefined {
    const r = this.db.prepare("SELECT * FROM connector_triggers WHERE id = ?").get(id);
    return r ? ctrigger(r as Record<string, unknown>) : undefined;
  }

  triggerByRemote(remoteId: string): ConnectorTrigger | undefined {
    const r = this.db
      .prepare("SELECT * FROM connector_triggers WHERE remote_id = ? AND status = 'active'")
      .get(remoteId);
    return r ? ctrigger(r as Record<string, unknown>) : undefined;
  }

  triggers(accountId?: string): ConnectorTrigger[] {
    const rows = (
      accountId
        ? this.db
            .prepare("SELECT * FROM connector_triggers WHERE account_id = ? ORDER BY created_at")
            .all(accountId)
        : this.db.prepare("SELECT * FROM connector_triggers ORDER BY created_at").all()
    ) as Record<string, unknown>[];
    return rows.map(ctrigger);
  }

  setTriggerStatus(id: string, status: ConnectorTrigger["status"], detail = ""): void {
    this.db
      .prepare("UPDATE connector_triggers SET status = ?, detail = ? WHERE id = ?")
      .run(status, detail, id);
  }

  /** First sighting of a delivered event id → true; a replay or a duplicate → false. */
  markSeen(eventId: string): boolean {
    const r = this.db
      .prepare("INSERT OR IGNORE INTO connector_events_seen (event_id, received_at) VALUES (?, ?)")
      .run(eventId, new Date().toISOString());
    return Number(r.changes) === 1;
  }

  // ── Next round R8: the person's MCP servers (secret values live in the SecretStore) ──

  servers(): IntegrationServer[] {
    return (
      this.db.prepare("SELECT * FROM integration_servers ORDER BY created_at").all() as Record<
        string,
        unknown
      >[]
    ).map(server);
  }

  server(id: string): IntegrationServer | undefined {
    const r = this.db.prepare("SELECT * FROM integration_servers WHERE id = ?").get(id);
    return r ? server(r as Record<string, unknown>) : undefined;
  }

  saveServer(s: Omit<IntegrationServer, "createdAt" | "updatedAt">): IntegrationServer {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO integration_servers (id, label, transport, command, args, cwd, url, secret_names, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET label = excluded.label, transport = excluded.transport,
           command = excluded.command, args = excluded.args, cwd = excluded.cwd, url = excluded.url,
           secret_names = excluded.secret_names, enabled = excluded.enabled, updated_at = excluded.updated_at`,
      )
      .run(
        s.id,
        s.label,
        s.transport,
        s.command,
        JSON.stringify(s.args),
        s.cwd,
        s.url,
        JSON.stringify(s.secretNames),
        s.enabled ? 1 : 0,
        now,
        now,
      );
    return this.server(s.id) as IntegrationServer;
  }

  removeServer(id: string): void {
    this.db.prepare("DELETE FROM integration_servers WHERE id = ?").run(id);
  }
}

export interface IntegrationServer {
  id: string;
  label: string;
  transport: "stdio" | "http";
  command: string | null;
  args: string[];
  cwd: string | null;
  url: string | null;
  /** Header (http) or environment variable (stdio) names whose values are in the SecretStore. */
  secretNames: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

const server = (r: Record<string, unknown>): IntegrationServer => ({
  id: r.id as string,
  label: r.label as string,
  transport: r.transport as IntegrationServer["transport"],
  command: (r.command as string | null) ?? null,
  args: JSON.parse(r.args as string) as string[],
  cwd: (r.cwd as string | null) ?? null,
  url: (r.url as string | null) ?? null,
  secretNames: JSON.parse(r.secret_names as string) as string[],
  enabled: r.enabled === 1,
  createdAt: r.created_at as string,
  updatedAt: r.updated_at as string,
});
