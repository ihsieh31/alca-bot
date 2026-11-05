import type { SecretStore } from "@alca/os";
import type { ActionClass } from "@alca/policy";
import type { ConnectorAccount, IntegrationServer, Store } from "@alca/store";
import { HttpTransport, McpClient, McpError, type SpawnFn, StdioTransport, stdioEnv } from "./mcp-client.ts";
import { classifyByHostRule, type IntegrationProvider, mcpToolkit, type ProviderTool } from "./provider.ts";

/**
 * Next round R8: the person's own MCP servers as one `IntegrationProvider`.
 *
 * - One server = one row in `integration_servers` + one connector account
 *   (`provider = mcp`, `remote_id` = the server id, toolkit `mcp-<id>`), so
 *   grants, the account choice, quotas and cards work as for any app.
 * - Secrets (a bearer header for HTTP, environment values for stdio) are in
 *   the SecretStore as `integration.mcp.<id>.<name>`; the table keeps names.
 * - Class: the same host rule as Composio (the person chose not to tighten
 *   it): the tool name as a slug (`MCP_SEARCH_NOTES`), the server's
 *   `readOnlyHint` / `destructiveHint` annotations at the weight Composio's
 *   tags have, and a tool the server cannot describe fails closed (B9).
 * - The server's descriptions are untrusted text: the service fences them.
 * - Adding or changing a server needs the approve key (desktop route); a
 *   stdio server runs as the person, like an ACP engine.
 */

export const MCP_SECRET = (id: string, name: string) => `integration.mcp.${id}.${name}`;
export const SERVER_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

/** The slug form of an MCP tool name, for the shared class rule (`searchNotes` → `MCP_SEARCH_NOTES`). */
export function mcpSlug(name: string): string {
  return `MCP_${name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase()}`;
}

/** MCP annotations as the hint words the class rule reads (only what the server set to true). */
export function mcpHints(annotations: Record<string, unknown>): string[] {
  return ["readOnlyHint", "destructiveHint"].filter((k) => annotations[k] === true);
}

export interface ServerInput {
  id: string;
  label: string;
  transport: "stdio" | "http";
  command?: string | null;
  args?: string[];
  cwd?: string | null;
  url?: string | null;
  /** name → value; values go to the SecretStore only. An empty value removes that secret. */
  secrets?: Record<string, string>;
  enabled?: boolean;
}

export interface McpProviderOptions {
  store: Store;
  secrets: SecretStore;
  spawn?: SpawnFn;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export class McpProvider implements IntegrationProvider {
  readonly id = "mcp" as const;
  private readonly clients = new Map<string, McpClient>();
  private readonly o: McpProviderOptions;

  constructor(o: McpProviderOptions) {
    this.o = o;
  }

  async configured(): Promise<boolean> {
    return this.o.store.connectors.servers().some((s) => s.enabled);
  }

  private async secretValues(s: IntegrationServer): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const n of s.secretNames) {
      const v = await this.o.secrets.get(MCP_SECRET(s.id, n));
      if (v) out[n] = v;
    }
    return out;
  }

  /** The client of one server (started on first use). */
  client(serverId: string): McpClient {
    const hit = this.clients.get(serverId);
    if (hit) return hit;
    const s = this.o.store.connectors.server(serverId);
    if (!s) throw new McpError("not_found", `沒有 MCP server「${serverId}」`);
    if (!s.enabled) throw new McpError("disabled", `MCP server「${s.label}」已停用`);
    let c: McpClient | undefined;
    if (s.transport === "stdio")
      c = new McpClient(
        new StdioTransport({
          command: s.command as string,
          args: s.args,
          ...(s.cwd ? { cwd: s.cwd } : {}),
          env: async () => stdioEnv(await this.secretValues(s)),
          ...(this.o.spawn ? { spawn: this.o.spawn } : {}),
          ...(this.o.sleep ? { sleep: this.o.sleep } : {}),
          // A restarted server knows nothing: handshake again before the call that started it.
          onStart: () => c?.initialize() ?? Promise.resolve(),
        }),
      );
    else
      c = new McpClient(
        new HttpTransport({
          url: s.url as string,
          headers: () => this.secretValues(s),
          ...(this.o.fetch ? { fetch: this.o.fetch } : {}),
        }),
      );
    this.clients.set(serverId, c);
    return c;
  }

  private tool(
    serverId: string,
    t: {
      name: string;
      description: string;
      inputSchema: Record<string, unknown>;
      annotations: Record<string, unknown>;
    },
  ): ProviderTool {
    return {
      slug: `${serverId}:${t.name}`,
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      hints: mcpHints(t.annotations),
      toolkit: mcpToolkit(serverId),
    };
  }

  async searchTools(q: {
    accounts: ConnectorAccount[];
    query: string;
    limit: number;
  }): Promise<ProviderTool[]> {
    const words = q.query
      .toLowerCase()
      .split(/[\s,，、]+/)
      .filter((w) => w.length > 1);
    const out: ProviderTool[] = [];
    for (const a of q.accounts) {
      let list: ProviderTool[];
      try {
        list = (await this.client(a.remoteId).listTools()).map((t) => this.tool(a.remoteId, t));
      } catch {
        continue; // one server down does not hide the others
      }
      const hits = words.length
        ? list.filter((t) => words.some((w) => `${t.name} ${t.description}`.toLowerCase().includes(w)))
        : list;
      out.push(...(hits.length ? hits : list).slice(0, Math.max(q.limit, 1)));
    }
    return out;
  }

  async getTool(slug: string): Promise<ProviderTool | undefined> {
    const i = slug.indexOf(":");
    const server = slug.slice(0, i);
    const name = slug.slice(i + 1);
    try {
      const t = (await this.client(server).listTools()).find((x) => x.name === name);
      return t ? this.tool(server, t) : undefined;
    } catch {
      return undefined;
    }
  }

  classify(slug: string, tool: ProviderTool | undefined): ActionClass {
    return classifyByHostRule(mcpSlug(slug.slice(slug.indexOf(":") + 1)), tool);
  }

  async execute(o: { account: ConnectorAccount; slug: string; args: Record<string, unknown> }) {
    const i = o.slug.indexOf(":");
    if (o.slug.slice(0, i) !== o.account.remoteId)
      return { ok: false, data: null, error: "這個工具不屬於這個 MCP server" };
    try {
      const r = await this.client(o.account.remoteId).callTool(o.slug.slice(i + 1), o.args);
      const data = r.structured ?? r.content;
      return r.isError ? { ok: false, data, error: "MCP 工具回報錯誤" } : { ok: true, data };
    } catch (e) {
      return { ok: false, data: null, error: String((e as Error)?.message ?? e).slice(0, 300) };
    }
  }

  async disconnect(account: ConnectorAccount): Promise<void> {
    await this.clients.get(account.remoteId)?.close();
    this.clients.delete(account.remoteId);
  }

  sourceLabel(account: ConnectorAccount | undefined): string {
    return `我的 MCP：${account?.label ?? "server"}`;
  }

  // ── the person's servers (desktop 連接 page; the route asks for the approve key) ──

  /** Add or change a server; its account exists from then on (granted to `botId` when new). */
  async saveServer(input: ServerInput, botId?: string): Promise<IntegrationServer> {
    const id = String(input.id ?? "")
      .trim()
      .toLowerCase();
    if (!SERVER_ID_RE.test(id)) throw new McpError("bad_id", "server id 只能用小寫英數與 -（最多 40 字）");
    const label = String(input.label ?? "")
      .trim()
      .slice(0, 60);
    if (!label) throw new McpError("bad_label", "請幫這個 server 取個名字");
    const transport = input.transport;
    if (transport !== "stdio" && transport !== "http")
      throw new McpError("bad_transport", "transport 只能是 stdio 或 http");
    const args = Array.isArray(input.args) ? input.args.map(String) : [];
    if (args.length > 64 || args.some((a) => a.length > 1000))
      throw new McpError("bad_args", "參數太多或太長");
    const command = transport === "stdio" ? String(input.command ?? "").trim() : "";
    if (transport === "stdio" && !command) throw new McpError("bad_command", "stdio server 需要 command");
    const url = transport === "http" ? String(input.url ?? "").trim() : "";
    if (transport === "http" && !/^https?:\/\/[^/\s]+/i.test(url))
      throw new McpError("bad_url", "http server 需要 http(s):// 網址");
    const secrets = input.secrets ?? {};
    for (const n of Object.keys(secrets))
      if (!SECRET_NAME_RE.test(n)) throw new McpError("bad_secret", `「${n.slice(0, 40)}」不能當祕密名稱`);
    const before = this.o.store.connectors.server(id);
    const names = new Set(before?.secretNames ?? []);
    for (const [n, v] of Object.entries(secrets)) {
      if (v) {
        await this.o.secrets.set(MCP_SECRET(id, n), v);
        names.add(n);
      } else {
        await this.o.secrets.delete(MCP_SECRET(id, n));
        names.delete(n);
      }
    }
    const saved = this.o.store.connectors.saveServer({
      id,
      label,
      transport,
      command: command || null,
      args,
      cwd: input.cwd ? String(input.cwd) : null,
      url: url || null,
      secretNames: [...names],
      enabled: input.enabled !== false,
    });
    // A changed server starts fresh at the next call.
    await this.clients.get(id)?.close();
    this.clients.delete(id);
    const acc = this.o.store.connectors.byRemote(id, "mcp");
    if (!acc || acc.status === "removed") {
      const a = this.o.store.connectors.addAccount({
        provider: "mcp",
        remoteId: id,
        toolkit: mcpToolkit(id),
        label,
        status: "pending",
      });
      if (botId) this.o.store.connectors.grant(botId, a.id, "act");
    } else if (acc.label !== label) this.o.store.connectors.rename(acc.id, label);
    return saved;
  }

  /** Try the handshake and the tool list; the account becomes active or failed. */
  async check(id: string): Promise<{ ok: boolean; tools: number; error?: string }> {
    const acc = this.o.store.connectors.byRemote(id, "mcp");
    try {
      const n = (await this.client(id).listTools()).length;
      if (acc && acc.status !== "removed")
        this.o.store.connectors.setStatus(acc.id, "active", this.clients.get(id)?.serverName || undefined);
      return { ok: true, tools: n };
    } catch (e) {
      if (acc && acc.status !== "removed") this.o.store.connectors.setStatus(acc.id, "failed");
      return { ok: false, tools: 0, error: String((e as Error)?.message ?? e).slice(0, 300) };
    }
  }

  /** Remove a server: its client stops, its secrets go, its account is disconnected. */
  async removeServer(id: string): Promise<void> {
    const s = this.o.store.connectors.server(id);
    if (!s) throw new McpError("not_found", "沒有這個 MCP server");
    await this.clients.get(id)?.close();
    this.clients.delete(id);
    for (const n of s.secretNames) await this.o.secrets.delete(MCP_SECRET(id, n));
    const acc = this.o.store.connectors.byRemote(id, "mcp");
    if (acc && acc.status !== "removed") this.o.store.connectors.remove(acc.id);
    this.o.store.connectors.removeServer(id);
  }

  async close(): Promise<void> {
    for (const c of this.clients.values()) await c.close().catch(() => undefined);
    this.clients.clear();
  }
}
