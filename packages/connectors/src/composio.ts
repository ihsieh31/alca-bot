/**
 * A small client for Composio's public REST API (v3.1). Only the calls Alca
 * needs, written from the public reference at docs.composio.dev:
 *
 *   POST   /tool_router/session                     one session per local user (multi-account, explicit choice)
 *   POST   /tool_router/session/{id}/link           Connect Link for one app (alias = our label)
 *   GET    /connected_accounts?user_ids=…           accounts of our user
 *   DELETE /connected_accounts/{id}                 disconnect
 *   GET    /tools?toolkit_slug=…&query=…            tool search
 *   GET    /tools/{slug}                            one tool's schema
 *   POST   /tools/execute/{slug}                    run a tool as one connected account
 *   POST   /trigger_instances/{slug}/upsert         start a trigger (egress_url → the person's relay)
 *   DELETE /trigger_instances/manage/{id}
 *   GET|POST /webhook_subscriptions (+ GET /{id})   the project's signing secret
 *
 * The API key comes from a getter on every call (the vault), goes only into
 * the `x-api-key` header, and is scrubbed from any error text.
 */

export class ComposioError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ComposioError";
    this.status = status;
    this.code = code;
  }
}

export interface ComposioAccount {
  id: string;
  toolkit: string;
  alias: string | null;
  wordId: string | null;
  status: string;
  createdAt: string;
}

export interface ComposioTool {
  slug: string;
  name: string;
  description: string;
  toolkit: string;
  inputParameters: Record<string, unknown>;
  tags: string[];
}

export interface ComposioExecution {
  successful: boolean;
  data: unknown;
  error: string | null;
  logId?: string;
}

export interface ComposioClientOptions {
  baseUrl: string;
  apiKey: () => Promise<string | undefined>;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

export class ComposioClient {
  private readonly o: ComposioClientOptions;
  constructor(o: ComposioClientOptions) {
    this.o = o;
  }

  private async call<T>(
    method: string,
    path: string,
    o: { query?: Record<string, string | number | undefined>; body?: unknown; key?: string } = {},
  ): Promise<T> {
    const key = o.key ?? (await this.o.apiKey());
    if (!key) throw new ComposioError(0, "no_key", "還沒有設定 Composio API key");
    const url = new URL(this.o.baseUrl.replace(/\/+$/, "") + path);
    for (const [k, v] of Object.entries(o.query ?? {}))
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    const scrub = (s: string) => s.split(key).join("[key]");
    let res: Response;
    try {
      res = await (this.o.fetch ?? fetch)(url, {
        method,
        headers: {
          "x-api-key": key,
          accept: "application/json",
          ...(o.body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 60_000),
      });
    } catch (err) {
      throw new ComposioError(
        0,
        "network",
        scrub(`連不上 Composio：${String((err as Error)?.message ?? err)}`),
      );
    }
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? (JSON.parse(text) as unknown) : undefined;
    } catch {
      body = undefined;
    }
    if (!res.ok) {
      const e = (body as { error?: { message?: unknown; slug?: unknown } } | undefined)?.error;
      const msg = str(e?.message) || text.slice(0, 200) || res.statusText;
      throw new ComposioError(res.status, str(e?.slug) || `http_${res.status}`, scrub(msg).slice(0, 300));
    }
    return body as T;
  }

  /** Validate a key before it is saved (one cheap read). */
  async checkKey(key: string): Promise<void> {
    await this.call("GET", "/toolkits", { query: { limit: 1 }, key });
  }

  async createSession(userId: string): Promise<string> {
    const r = await this.call<{ session_id?: string }>("POST", "/tool_router/session", {
      body: {
        user_id: userId,
        manage_connections: { enable: false },
        workbench: { enable: false },
        multi_account: { enable: true, require_explicit_selection: true },
      },
    });
    if (!r?.session_id) throw new ComposioError(502, "bad_response", "Composio 沒有回傳 session id");
    return r.session_id;
  }

  async link(
    sessionId: string,
    o: { toolkit: string; alias?: string; callbackUrl?: string },
  ): Promise<{ redirectUrl: string; accountId: string }> {
    const r = await this.call<{ redirect_url?: string; connected_account_id?: string }>(
      "POST",
      `/tool_router/session/${encodeURIComponent(sessionId)}/link`,
      {
        body: {
          toolkit: o.toolkit,
          ...(o.alias ? { alias: o.alias } : {}),
          ...(o.callbackUrl ? { callback_url: o.callbackUrl } : {}),
        },
      },
    );
    if (!r?.redirect_url || !r.connected_account_id || !safeRedirect(r.redirect_url))
      throw new ComposioError(502, "bad_response", "Composio 沒有回傳連接網址");
    return { redirectUrl: r.redirect_url, accountId: r.connected_account_id };
  }

  async accounts(userId: string): Promise<ComposioAccount[]> {
    const out: ComposioAccount[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const r = await this.call<{ items?: Array<Record<string, unknown>>; next_cursor?: string | null }>(
        "GET",
        "/connected_accounts",
        { query: { user_ids: userId, limit: 100, cursor } },
      );
      for (const i of r?.items ?? [])
        out.push({
          id: str(i.id),
          toolkit: str((i.toolkit as { slug?: unknown } | undefined)?.slug),
          alias: str(i.alias) || null,
          wordId: str(i.word_id) || null,
          status: str(i.status) || "UNKNOWN",
          createdAt: str(i.created_at),
        });
      cursor = r?.next_cursor ?? undefined;
      if (!cursor) break;
    }
    return out;
  }

  async deleteAccount(id: string): Promise<void> {
    await this.call("DELETE", `/connected_accounts/${encodeURIComponent(id)}`);
  }

  private tool(i: Record<string, unknown>): ComposioTool {
    return {
      slug: str(i.slug),
      name: str(i.name),
      description: str(i.description),
      toolkit: str((i.toolkit as { slug?: unknown } | undefined)?.slug),
      inputParameters: (i.input_parameters as Record<string, unknown> | undefined) ?? {},
      tags: Array.isArray(i.tags) ? i.tags.filter((t): t is string => typeof t === "string") : [],
    };
  }

  async searchTools(o: {
    toolkits: readonly string[];
    query?: string;
    limit?: number;
  }): Promise<ComposioTool[]> {
    if (!o.toolkits.length) return [];
    const r = await this.call<{ items?: Array<Record<string, unknown>> }>("GET", "/tools", {
      query: { toolkit_slug: o.toolkits.join(","), query: o.query, limit: o.limit ?? 8 },
    });
    return (r?.items ?? []).map((i) => this.tool(i));
  }

  async getTool(slug: string): Promise<ComposioTool> {
    const r = await this.call<Record<string, unknown>>("GET", `/tools/${encodeURIComponent(slug)}`);
    return this.tool(r ?? {});
  }

  async execute(
    slug: string,
    o: { userId: string; accountId: string; arguments: Record<string, unknown> },
  ): Promise<ComposioExecution> {
    const r = await this.call<Record<string, unknown>>("POST", `/tools/execute/${encodeURIComponent(slug)}`, {
      body: { user_id: o.userId, connected_account_id: o.accountId, arguments: o.arguments },
    });
    return {
      successful: r?.successful === true,
      data: r?.data ?? null,
      error: str(r?.error) || null,
      ...(str(r?.log_id) ? { logId: str(r?.log_id) } : {}),
    };
  }

  async upsertTrigger(
    slug: string,
    o: { userId: string; accountId: string; config: Record<string, unknown>; egressUrl?: string },
  ): Promise<string> {
    const r = await this.call<{ trigger_id?: string }>(
      "POST",
      `/trigger_instances/${encodeURIComponent(slug)}/upsert`,
      {
        body: {
          user_id: o.userId,
          connected_account_id: o.accountId,
          trigger_config: o.config,
          ...(o.egressUrl ? { egress_url: o.egressUrl } : {}),
        },
      },
    );
    if (!r?.trigger_id) throw new ComposioError(502, "bad_response", "Composio 沒有回傳觸發器 id");
    return r.trigger_id;
  }

  async deleteTrigger(id: string): Promise<void> {
    await this.call("DELETE", `/trigger_instances/manage/${encodeURIComponent(id)}`);
  }

  /**
   * The project's webhook signing secret. An existing subscription is kept as
   * it is (only its secret is read); a project without one gets one pointing
   * at `fallbackUrl` (our relay hook). Per-trigger `egress_url` routes ours.
   */
  async webhookSecret(fallbackUrl: string): Promise<{ id: string; secret: string; created: boolean }> {
    const list = await this.call<{ items?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>>(
      "GET",
      "/webhook_subscriptions",
    );
    const items = Array.isArray(list) ? list : (list?.items ?? []);
    const first = items[0];
    if (first && str(first.id)) {
      const one = await this.call<Record<string, unknown>>(
        "GET",
        `/webhook_subscriptions/${encodeURIComponent(str(first.id))}`,
      );
      const secret = str(one?.secret) || str(first.secret);
      if (!secret) throw new ComposioError(502, "bad_response", "Composio 沒有回傳 webhook 簽章密鑰");
      return { id: str(first.id), secret, created: false };
    }
    const r = await this.call<Record<string, unknown>>("POST", "/webhook_subscriptions", {
      body: { webhook_url: fallbackUrl, enabled_events: ["composio.trigger.message"], version: "V3" },
    });
    if (!str(r?.secret)) throw new ComposioError(502, "bad_response", "Composio 沒有回傳 webhook 簽章密鑰");
    return { id: str(r?.id), secret: str(r?.secret), created: true };
  }
}

/**
 * The Connect Link is opened in a tab of the app's own origin (desktop UI,
 * phone site), so only an https page (or a loopback stand-in) may come back:
 * a `javascript:` or `data:` URL from a bad response would run as the app.
 */
export function safeRedirect(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && /^(127\.0\.0\.1|localhost|\[::1\])$/.test(u.hostname);
}
