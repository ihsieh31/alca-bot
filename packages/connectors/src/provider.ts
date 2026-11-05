import type { ActionClass } from "@alca/policy";
import type { ConnectorAccount, IntegrationProviderId } from "@alca/store";
import { classifyAppTool, plainlyRead, stricter } from "./classify.ts";

/**
 * Next round R8: where a connected app's tools come from. `ConnectorService`
 * stays the one coordinator that does the host's part — grants, the account
 * choice, the live class, the card text, the daily quota, the fence — and
 * asks a provider only to list, describe and run tools:
 *
 * - `composio`: Composio's hosted tools (tokens at Composio; unchanged).
 * - `mcp`: the person's own MCP servers (stdio or Streamable HTTP).
 *
 * The model still sees only connector_find_tool / connector_use_tool. A tool's
 * full name is `<provider>:<slug>` (`mcp:notes:search_notes`); Composio's keep their bare slug so existing
 * routines and shortcuts keep working.
 */

export interface ProviderTool {
  /** Unique inside the provider (an MCP tool's slug is `<server>:<name>`). */
  slug: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /**
   * What the provider says about itself (Composio tags, MCP annotations as
   * `readOnlyHint` / `destructiveHint` / …). The person chose not to tighten
   * integration policy: hints count exactly as they do for Composio today.
   */
  hints: string[];
  /** The app the tool belongs to (the account's toolkit). */
  toolkit: string;
}

export interface ProviderExecution {
  ok: boolean;
  data: unknown;
  error?: string;
}

export interface IntegrationProvider {
  readonly id: IntegrationProviderId;
  /** Whether this provider can be used at all now (a key, a client id, a server). */
  configured(): Promise<boolean>;
  /** Tools of these accounts matching the query (at most `limit`). */
  searchTools(q: { accounts: ConnectorAccount[]; query: string; limit: number }): Promise<ProviderTool[]>;
  /** One tool's description and schema; undefined when the provider cannot describe it. */
  getTool(slug: string): Promise<ProviderTool | undefined>;
  /** The host's class for one call (args matter for some: a calendar event with attendees is a send). */
  classify(slug: string, tool: ProviderTool | undefined, args: Record<string, unknown>): ActionClass;
  execute(o: {
    account: ConnectorAccount;
    slug: string;
    args: Record<string, unknown>;
  }): Promise<ProviderExecution>;
  /** Forget the account at the provider (revoke a token, nothing for a server). */
  disconnect(account: ConnectorAccount): Promise<void>;
  /** How a found tool is labelled for the model and the person. */
  sourceLabel(account: ConnectorAccount | undefined, toolkit: string): string;
}

/**
 * The class rule Composio and the person's own MCP servers share (the
 * current host rule, not tightened): the slug's verbs, the provider's hints
 * at their current weight, and — for a tool the provider could not describe
 * — B9: only a plainly-read name (LIST / GET / SEARCH / FIND / FETCH and no
 * word that changes anything) is a read; everything else fails closed to send.
 */
export function classifyByHostRule(
  slug: string,
  tool: { hints: readonly string[] } | undefined,
): ActionClass {
  if (!tool) return plainlyRead(slug) ? "read" : stricter("send", classifyAppTool(slug, []));
  return classifyAppTool(slug, tool.hints);
}

export interface ParsedTool {
  provider: IntegrationProviderId;
  /** The slug inside the provider. */
  slug: string;
  /** The name the model uses. */
  full: string;
}

const MCP_TOOL = /^[A-Za-z0-9][\w.-]{0,127}$/;
const SERVER_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Split a full tool name; Composio slugs are upper-cased, MCP names keep their case. */
export function parseToolName(raw: string): ParsedTool | undefined {
  const s = raw.trim();
  const m = /^(mcp):(.+)$/i.exec(s);
  if (!m) {
    const slug = s.toUpperCase();
    return /^[A-Z0-9][A-Z0-9_]{2,120}$/.test(slug) ? { provider: "composio", slug, full: slug } : undefined;
  }
  const provider = "mcp" as const;
  const rest = m[2] as string;
  const i = rest.indexOf(":");
  if (i < 1) return undefined;
  const server = rest.slice(0, i).toLowerCase();
  const name = rest.slice(i + 1);
  if (!SERVER_ID.test(server) || !MCP_TOOL.test(name)) return undefined;
  return { provider, slug: `${server}:${name}`, full: `mcp:${server}:${name}` };
}

/** The account toolkit of an MCP server. */
export const mcpToolkit = (serverId: string) => `mcp-${serverId}`;
