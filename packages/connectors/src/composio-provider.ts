import type { ActionClass } from "@alca/policy";
import type { ConnectorAccount } from "@alca/store";
import { appInfo } from "./catalog.ts";
import { type ComposioClient, ComposioError, type ComposioTool } from "./composio.ts";
import { classifyByHostRule, type IntegrationProvider, type ProviderTool } from "./provider.ts";

/**
 * Next round R8: Composio as one `IntegrationProvider`. Behaviour is the
 * same as before the split: the same REST calls, the same tool cache, the
 * same class rule (slug verbs; Composio's own `readOnlyHint` still counts,
 * the person chose not to tighten that), the same fail-closed B9 rule for a
 * tool Composio cannot describe. Keys, sessions, Connect Links and triggers
 * stay with ConnectorService / hooks.ts (they are Composio's alone).
 */
export class ComposioProvider implements IntegrationProvider {
  readonly id = "composio" as const;
  private readonly tools = new Map<string, ComposioTool>();
  private readonly o: {
    client: ComposioClient;
    hasKey: () => Promise<boolean>;
    userId: () => string;
  };

  constructor(o: { client: ComposioClient; hasKey: () => Promise<boolean>; userId: () => string }) {
    this.o = o;
  }

  configured(): Promise<boolean> {
    return this.o.hasKey();
  }

  private view(t: ComposioTool): ProviderTool {
    return {
      slug: t.slug,
      name: t.name,
      description: t.description,
      inputSchema: t.inputParameters,
      hints: t.tags,
      toolkit: t.toolkit,
    };
  }

  /** Composio's own tool record (cached), or undefined when it cannot be looked up. */
  async raw(slug: string): Promise<ComposioTool | undefined> {
    const hit = this.tools.get(slug);
    if (hit) return hit;
    try {
      const t = await this.o.client.getTool(slug);
      if (t.slug) this.tools.set(slug, t);
      return t.slug ? t : undefined;
    } catch {
      return undefined;
    }
  }

  async getTool(slug: string): Promise<ProviderTool | undefined> {
    const t = await this.raw(slug);
    return t ? this.view(t) : undefined;
  }

  async searchTools(q: {
    accounts: ConnectorAccount[];
    query: string;
    limit: number;
  }): Promise<ProviderTool[]> {
    const toolkits = [...new Set(q.accounts.map((a) => a.toolkit))];
    const found = await this.o.client.searchTools({ toolkits, query: q.query, limit: q.limit });
    for (const t of found) this.tools.set(t.slug, t);
    return found.map((t) => this.view(t));
  }

  classify(slug: string, tool: ProviderTool | undefined): ActionClass {
    return classifyByHostRule(slug, tool);
  }

  async execute(o: { account: ConnectorAccount; slug: string; args: Record<string, unknown> }) {
    const r = await this.o.client.execute(o.slug, {
      userId: this.o.userId(),
      accountId: o.account.remoteId,
      arguments: o.args,
    });
    return { ok: r.successful, data: r.data, ...(r.error ? { error: r.error } : {}) };
  }

  async disconnect(account: ConnectorAccount): Promise<void> {
    try {
      await this.o.client.deleteAccount(account.remoteId);
    } catch (err) {
      if (!(err instanceof ComposioError && err.status === 404)) throw err;
    }
  }

  sourceLabel(_account: ConnectorAccount | undefined, toolkit: string): string {
    return `${appInfo(toolkit).name}（Composio）`;
  }
}
