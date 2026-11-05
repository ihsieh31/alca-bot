import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { signWebhook } from "../src/hooks.ts";

/**
 * A local stand-in for Composio's REST API (the subset Alca calls), for tests,
 * the offline demo and screenshots. No real key, no network. It checks the
 * `x-api-key` header, keeps accounts / tools / trigger instances in memory,
 * simulates the OAuth hop (`GET /connect/<id>` marks the account active), and
 * can deliver signed trigger events to the instance's egress URL.
 */

export interface MockMessage {
  messageId: string;
  threadId: string;
  subject: string;
  sender: string;
  preview: string;
  messageTimestamp: string;
}

interface Account {
  id: string;
  userId: string;
  toolkit: string;
  alias: string | null;
  status: string;
  createdAt: string;
}

interface ToolDef {
  slug: string;
  name: string;
  description: string;
  toolkit: string;
  tags: string[];
  required: string[];
  properties: Record<string, unknown>;
}

const TOOLS: ToolDef[] = [
  {
    slug: "GMAIL_FETCH_EMAILS",
    name: "Fetch emails",
    description:
      "Fetches a list of email messages from a Gmail account, supporting filtering and pagination.",
    toolkit: "gmail",
    tags: ["readOnlyHint"],
    required: [],
    properties: { query: { type: "string" }, max_results: { type: "integer" } },
  },
  {
    slug: "GMAIL_SEND_EMAIL",
    name: "Send Email",
    description: "Sends an email via Gmail API using the authenticated user's Google profile.",
    toolkit: "gmail",
    tags: ["createHint"],
    required: [],
    properties: {
      recipient_email: { type: "string" },
      subject: { type: "string" },
      body: { type: "string" },
    },
  },
  {
    slug: "GMAIL_CREATE_EMAIL_DRAFT",
    name: "Create email draft",
    description: "Creates a Gmail email draft.",
    toolkit: "gmail",
    tags: ["createHint"],
    required: [],
    properties: {
      recipient_email: { type: "string" },
      subject: { type: "string" },
      body: { type: "string" },
    },
  },
  {
    slug: "GMAIL_DELETE_MESSAGE",
    name: "Delete message",
    description: "Permanently deletes a specific email message.",
    toolkit: "gmail",
    tags: ["destructiveHint"],
    required: ["message_id"],
    properties: { message_id: { type: "string" } },
  },
  {
    slug: "GOOGLECALENDAR_EVENTS_LIST",
    name: "List events",
    description: "Returns events on the specified calendar.",
    toolkit: "googlecalendar",
    tags: ["readOnlyHint"],
    required: [],
    properties: { calendarId: { type: "string" }, timeMin: { type: "string" }, timeMax: { type: "string" } },
  },
  {
    slug: "GITHUB_CREATE_AN_ISSUE",
    name: "Create an issue",
    description: "Creates a new issue in a GitHub repository.",
    toolkit: "github",
    tags: ["createHint"],
    required: ["owner", "repo", "title"],
    properties: { owner: { type: "string" }, repo: { type: "string" }, title: { type: "string" } },
  },
  {
    slug: "SLACK_CHAT_POST_MESSAGE",
    name: "Post message",
    description: "Posts a message to a Slack channel.",
    toolkit: "slack",
    tags: ["createHint"],
    required: ["channel", "text"],
    properties: { channel: { type: "string" }, text: { type: "string" } },
  },
];

export interface MockComposio {
  url: string;
  baseUrl: string;
  key: string;
  accounts: Account[];
  /** Every execute call, in order (slug, account, arguments). */
  executed: Array<{ slug: string; accountId: string; arguments: Record<string, unknown> }>;
  /** Mail the mock inbox returns (newest first). */
  inbox: MockMessage[];
  /** When set, read tools fail with this message (a provider outage). */
  failReads: string | null;
  triggers: Array<{ id: string; slug: string; accountId: string; egressUrl: string | null; config: unknown }>;
  webhookSecret: string;
  /** Requests seen (method + path), for asserting what was called. */
  calls: string[];
  /** Simulate the person finishing the OAuth page. */
  complete(accountId: string): void;
  /** Add an account as if it were connected (status ACTIVE). */
  addAccount(toolkit: string, alias: string, userId?: string): Account;
  /** Deliver a signed trigger event to the instance's egress URL. */
  emit(
    triggerId: string,
    data: Record<string, unknown>,
    o?: { badSignature?: boolean; id?: string },
  ): Promise<number>;
  close(): Promise<void>;
}

const id = (p: string) => `${p}_${randomBytes(6).toString("hex")}`;

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req as AsyncIterable<Buffer>) chunks.push(c);
  const t = Buffer.concat(chunks).toString("utf8");
  if (!t) return {};
  try {
    return JSON.parse(t) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function startMockComposio(o: { key?: string; port?: number } = {}): Promise<MockComposio> {
  const key = o.key ?? "mock-composio-key-0001";
  const sessions = new Map<string, string>();
  let subscription: { id: string; url: string } | null = null;
  const state: Omit<MockComposio, "url" | "baseUrl" | "complete" | "addAccount" | "emit" | "close"> = {
    key,
    accounts: [],
    executed: [],
    inbox: [],
    failReads: null,
    triggers: [],
    webhookSecret: `whsec_${randomBytes(12).toString("hex")}`,
    calls: [],
  };
  let base = "";

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const send = (status: number, v: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(v));
    };
    const fail = (status: number, message: string, slug = "Error") =>
      send(status, { error: { message, code: status, slug, status } });
    // The OAuth hop (opened in the person's browser).
    if (req.method === "GET" && url.pathname.startsWith("/connect/")) {
      const acc = state.accounts.find((a) => a.id === url.pathname.slice("/connect/".length));
      if (acc) acc.status = "ACTIVE";
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><title>已連接</title><p>已連接，可以關掉這頁回到 Alca。</p>");
      return;
    }
    const path = url.pathname.replace(/^\/api\/v3\.1/, "");
    state.calls.push(`${req.method} ${path}`);
    if (req.headers["x-api-key"] !== key) return fail(401, "Invalid API key", "Unauthorized");
    const b = req.method === "POST" || req.method === "PATCH" ? await body(req) : {};
    const m = (re: RegExp) => re.exec(path);
    if (req.method === "GET" && path === "/toolkits") return send(200, { items: [], next_cursor: null });
    if (req.method === "POST" && path === "/tool_router/session") {
      const sid = id("trs");
      sessions.set(sid, String(b.user_id));
      return send(201, { session_id: sid, mcp: {}, tool_router_tools: [], config: {}, config_version: 1 });
    }
    let r = m(/^\/tool_router\/session\/([^/]+)\/link$/);
    if (req.method === "POST" && r) {
      const userId = sessions.get(r[1] as string);
      if (!userId) return fail(404, "session not found");
      const toolkit = String(b.toolkit ?? "");
      if (!TOOLS.some((t) => t.toolkit === toolkit) && !["line", "telegram"].includes(toolkit))
        return fail(400, `unknown toolkit ${toolkit}`);
      const alias = typeof b.alias === "string" ? b.alias : null;
      if (
        alias &&
        state.accounts.some((a) => a.toolkit === toolkit && a.alias === alias && a.userId === userId)
      )
        return fail(400, "alias must be unique");
      const acc: Account = {
        id: id("ca"),
        userId,
        toolkit,
        alias,
        status: "INITIATED",
        createdAt: new Date().toISOString(),
      };
      state.accounts.push(acc);
      return send(201, {
        link_token: id("lt"),
        redirect_url: `${base}/connect/${acc.id}`,
        connected_account_id: acc.id,
      });
    }
    if (req.method === "GET" && path === "/connected_accounts") {
      const users = (url.searchParams.get("user_ids") ?? "").split(",").filter(Boolean);
      const items = state.accounts
        .filter((a) => !users.length || users.includes(a.userId))
        .map((a) => ({
          id: a.id,
          toolkit: { slug: a.toolkit },
          alias: a.alias,
          word_id: `${a.toolkit}_${a.id.slice(-4)}`,
          status: a.status,
          created_at: a.createdAt,
          updated_at: a.createdAt,
          auth_config: {
            id: "ac_mock",
            auth_scheme: "OAUTH2",
            is_composio_managed: true,
            is_disabled: false,
          },
          state: { authScheme: "OAUTH2", val: { status: a.status } },
          user_id: a.userId,
        }));
      return send(200, { items, next_cursor: null, total_pages: 1, current_page: 1 });
    }
    r = m(/^\/connected_accounts\/([^/]+)$/);
    if (req.method === "DELETE" && r) {
      const i = state.accounts.findIndex((a) => a.id === r?.[1]);
      if (i < 0) return fail(404, "not found");
      state.accounts.splice(i, 1);
      return send(200, { success: true });
    }
    const toolJson = (t: ToolDef) => ({
      slug: t.slug,
      name: t.name,
      description: t.description,
      toolkit: { slug: t.toolkit, name: t.toolkit, logo: "" },
      input_parameters: { type: "object", properties: t.properties, required: t.required },
      output_parameters: {},
      tags: t.tags,
      no_auth: false,
      version: "20261101_00",
      available_versions: ["20261101_00"],
    });
    if (req.method === "GET" && path === "/tools") {
      const kits = (url.searchParams.get("toolkit_slug") ?? "").split(",").filter(Boolean);
      const q = (url.searchParams.get("query") ?? "").toLowerCase();
      const words = q.split(/\s+/).filter(Boolean);
      const items = TOOLS.filter((t) => !kits.length || kits.includes(t.toolkit))
        .filter(
          (t) => !words.length || words.some((w) => `${t.slug} ${t.description}`.toLowerCase().includes(w)),
        )
        .slice(0, Number(url.searchParams.get("limit") ?? 20))
        .map(toolJson);
      return send(200, {
        items,
        next_cursor: null,
        total_pages: 1,
        current_page: 1,
        total_items: items.length,
      });
    }
    r = m(/^\/tools\/([A-Z0-9_]+)$/);
    if (req.method === "GET" && r) {
      const t = TOOLS.find((x) => x.slug === r?.[1]);
      return t ? send(200, toolJson(t)) : fail(404, "tool not found");
    }
    r = m(/^\/tools\/execute\/([A-Z0-9_]+)$/);
    if (req.method === "POST" && r) {
      const slug = r[1] as string;
      const acc = state.accounts.find((a) => a.id === b.connected_account_id);
      if (acc?.status !== "ACTIVE") return fail(404, "connected account not found");
      const args = (b.arguments as Record<string, unknown> | undefined) ?? {};
      state.executed.push({ slug, accountId: acc.id, arguments: args });
      const t = TOOLS.find((x) => x.slug === slug);
      if (t?.tags.includes("readOnlyHint") && state.failReads)
        return send(200, { data: {}, error: state.failReads, successful: false, log_id: id("log") });
      if (slug === "GMAIL_FETCH_EMAILS")
        return send(200, {
          data: {
            messages: state.inbox.slice(0, Number(args.max_results ?? 10)),
            resultSizeEstimate: state.inbox.length,
          },
          error: null,
          successful: true,
          log_id: id("log"),
        });
      if (slug === "GOOGLECALENDAR_EVENTS_LIST")
        return send(200, {
          data: {
            items: [
              { id: "ev1", summary: "產品週會", start: { dateTime: "2026-11-04T10:00:00+08:00" } },
              { id: "ev2", summary: "和小林午餐", start: { dateTime: "2026-11-04T12:30:00+08:00" } },
            ],
          },
          error: null,
          successful: true,
        });
      return send(200, {
        data: { ok: true, id: id("res") },
        error: null,
        successful: true,
        log_id: id("log"),
      });
    }
    r = m(/^\/trigger_instances\/([A-Z0-9_]+)\/upsert$/);
    if (req.method === "POST" && r) {
      const tid = id("ti");
      state.triggers.push({
        id: tid,
        slug: r[1] as string,
        accountId: String(b.connected_account_id ?? ""),
        egressUrl: typeof b.egress_url === "string" ? b.egress_url : null,
        config: b.trigger_config ?? {},
      });
      return send(201, { trigger_id: tid });
    }
    r = m(/^\/trigger_instances\/manage\/([^/]+)$/);
    if (req.method === "DELETE" && r) {
      state.triggers = state.triggers.filter((t) => t.id !== r?.[1]);
      return send(200, { success: true });
    }
    if (req.method === "GET" && path === "/webhook_subscriptions")
      return send(200, {
        items: subscription ? [{ id: subscription.id, webhook_url: subscription.url }] : [],
      });
    if (req.method === "POST" && path === "/webhook_subscriptions") {
      subscription = { id: id("ws"), url: String(b.webhook_url ?? "") };
      return send(201, {
        id: subscription.id,
        webhook_url: subscription.url,
        version: "V3",
        enabled_events: b.enabled_events,
        secret: state.webhookSecret,
      });
    }
    r = m(/^\/webhook_subscriptions\/([^/]+)$/);
    const sub = subscription;
    if (req.method === "GET" && r && sub && sub.id === r[1])
      return send(200, { id: sub.id, webhook_url: sub.url, secret: state.webhookSecret });
    fail(404, `no route ${req.method} ${path}`);
  });
  await new Promise<void>((resolve) => server.listen(o.port ?? 0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
  const mock: MockComposio = Object.assign(state, {
    url: base,
    baseUrl: `${base}/api/v3.1`,
    complete(accountId: string) {
      const a = state.accounts.find((x) => x.id === accountId);
      if (a) a.status = "ACTIVE";
    },
    addAccount(toolkit: string, alias: string, userId = "") {
      const a: Account = {
        id: id("ca"),
        userId,
        toolkit,
        alias,
        status: "ACTIVE",
        createdAt: new Date().toISOString(),
      };
      state.accounts.push(a);
      return a;
    },
    async emit(
      triggerId: string,
      data: Record<string, unknown>,
      e: { badSignature?: boolean; id?: string } = {},
    ) {
      const t = state.triggers.find((x) => x.id === triggerId);
      if (!t?.egressUrl) throw new Error("no egress url for that trigger");
      const msgId = e.id ?? id("msg");
      const payload = JSON.stringify({
        id: msgId,
        type: "composio.trigger.message",
        metadata: { trigger_id: t.id, trigger_slug: t.slug, connected_account_id: t.accountId, user_id: "" },
        data,
        timestamp: new Date().toISOString(),
      });
      const ts = String(Math.floor(Date.now() / 1000));
      const sig = signWebhook(e.badSignature ? "wrong-secret" : state.webhookSecret, msgId, ts, payload);
      const r = await fetch(t.egressUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "webhook-id": msgId,
          "webhook-timestamp": ts,
          "webhook-signature": sig,
        },
        body: payload,
      });
      return r.status;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  });
  return mock;
}
