import { randomBytes } from "node:crypto";
import { isAlwaysConfirm, type Settings } from "@alca/config";
import type { ActionClass } from "@alca/policy";
import type { ConnectorAccess, ConnectorAccount, ConnectorAccountStatus, Store } from "@alca/store";
import { budgetJson, fenceApp } from "./budget.ts";
import { APPS, type AppInfo, appInfo, TOOLKIT_RE } from "./catalog.ts";
import { CLASS_WORD, stricter } from "./classify.ts";
import { ComposioClient, ComposioError } from "./composio.ts";
import { ComposioProvider } from "./composio-provider.ts";
import {
  type IntegrationProvider,
  mcpToolkit,
  type ParsedTool,
  type ProviderTool,
  parseToolName,
} from "./provider.ts";
import type { Vault } from "./vault.ts";
import { preview } from "./vault.ts";

export const COMPOSIO_KEY = "composio.apiKey";

export class ConnectorError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ConnectorError";
    this.code = code;
  }
}

export interface ConnectorServiceOptions {
  store: Store;
  vault: Vault;
  settings: () => Settings;
  /** Override the client (tests); default: Composio at `engineering.connectors.composioBaseUrl`. */
  client?: ComposioClient;
  /** Next round R8: providers besides Composio (the person's MCP servers). */
  providers?: IntegrationProvider[];
  fetch?: typeof fetch;
  now?: () => Date;
}

export interface AccountView {
  id: string;
  /** Next round R8: composio or mcp (a server of the person's). */
  provider: ConnectorAccount["provider"];
  toolkit: string;
  app: string;
  mark: string;
  label: string;
  status: ConnectorAccountStatus;
  identity: string;
  bots: Array<{ botId: string; name: string; access: ConnectorAccess | null }>;
  triggers: Array<{ id: string; slug: string; name: string; status: string }>;
  createdAt: string;
}

export interface ConnectorsStatus {
  provider: "composio";
  keySet: boolean;
  keyPreview: string | null;
  keyStore: string;
  apps: ReadonlyArray<
    Pick<AppInfo, "toolkit" | "name" | "mark" | "blurb"> & { triggers: AppInfo["triggers"] }
  >;
  groups: Array<{ toolkit: string; app: string; mark: string; accounts: AccountView[] }>;
  bots: Array<{ id: string; name: string }>;
  usageToday: Record<string, number>;
  quota: Settings["engineering"]["connectors"]["dailyQuota"];
}

const STATUS: Record<string, ConnectorAccountStatus> = {
  ACTIVE: "active",
  INITIATED: "pending",
  INITIALIZING: "pending",
  FAILED: "failed",
  EXPIRED: "expired",
  INACTIVE: "failed",
};

const localDay = (d: Date) => d.toLocaleDateString("sv-SE");

/**
 * Connected apps, Composio first. Accounts and who may use them live in our
 * store; tokens live at Composio (the person accepted that). The API key is
 * read from the vault for each call and never leaves the host process.
 */
export class ConnectorService {
  readonly client: ComposioClient;
  readonly composio: ComposioProvider;
  private readonly o: ConnectorServiceOptions;
  private readonly providers = new Map<ConnectorAccount["provider"], IntegrationProvider>();

  constructor(o: ConnectorServiceOptions) {
    this.o = o;
    this.client =
      o.client ??
      new ComposioClient({
        baseUrl: o.settings().engineering.connectors.composioBaseUrl,
        apiKey: () => o.vault.get(COMPOSIO_KEY),
        ...(o.fetch ? { fetch: o.fetch } : {}),
      });
    this.composio = new ComposioProvider({
      client: this.client,
      hasKey: () => this.hasKey(),
      userId: () => this.userId(),
    });
    this.providers.set("composio", this.composio);
    for (const p of o.providers ?? []) if (p.id !== "composio") this.providers.set(p.id, p);
  }

  /** The provider an account or a tool runs on (Composio when none other is registered). */
  provider(id: ConnectorAccount["provider"]): IntegrationProvider {
    const p = this.providers.get(id);
    if (!p) throw new ConnectorError("no_provider", `「${id}」整合沒有啟用`);
    return p;
  }

  /** Add or replace a provider after start (the desktop registers MCP once its config is read). */
  register(p: IntegrationProvider): void {
    if (p.id !== "composio") this.providers.set(p.id, p);
  }

  private parse(raw: string): ParsedTool {
    const p = parseToolName(raw);
    if (!p) throw new ConnectorError("bad_tool", "工具名稱不對");
    return p;
  }

  private get store() {
    return this.o.store;
  }
  private now(): Date {
    return this.o.now?.() ?? new Date();
  }

  async hasKey(): Promise<boolean> {
    return this.o.vault.has(COMPOSIO_KEY);
  }

  /** Check the key against Composio, then keep it in the vault (only ever there). */
  async setKey(key: string): Promise<void> {
    const k = key.trim();
    if (!/^[\w.-]{8,200}$/.test(k)) throw new ConnectorError("bad_key", "這不像 Composio API key");
    try {
      await this.client.checkKey(k);
    } catch (err) {
      if (err instanceof ComposioError && (err.status === 401 || err.status === 403))
        throw new ConnectorError("bad_key", "Composio 不接受這把 key");
      throw err;
    }
    const before = await this.o.vault.get(COMPOSIO_KEY);
    await this.o.vault.set(COMPOSIO_KEY, k);
    // Another key can be another project: start a fresh session there.
    if (before !== k) this.store.connectors.setMeta("composio.sessionId", null);
  }

  async clearKey(): Promise<void> {
    await this.o.vault.delete(COMPOSIO_KEY);
    this.store.connectors.setMeta("composio.sessionId", null);
  }

  /** Our own user id at Composio: random, stable, says nothing about the person. */
  userId(): string {
    let id = this.store.connectors.meta("composio.userId");
    if (!id) {
      id = `alca-${randomBytes(9).toString("hex")}`;
      this.store.connectors.setMeta("composio.userId", id);
    }
    return id;
  }

  private async session(): Promise<string> {
    const existing = this.store.connectors.meta("composio.sessionId");
    if (existing) return existing;
    const id = await this.client.createSession(this.userId());
    this.store.connectors.setMeta("composio.sessionId", id);
    return id;
  }

  async status(botId?: string): Promise<ConnectorsStatus> {
    const key = await this.o.vault.get(COMPOSIO_KEY);
    const bots = this.store.bots.list().map((b) => ({ id: b.id, name: b.name }));
    const groups = new Map<string, AccountView[]>();
    for (const a of this.store.connectors.accounts()) {
      const list = groups.get(a.toolkit) ?? [];
      list.push(this.view(a, bots));
      groups.set(a.toolkit, list);
    }
    const day = localDay(this.now());
    const bot = botId ?? this.store.bots.default()?.id ?? "";
    const quota = this.o.settings().engineering.connectors.dailyQuota;
    return {
      provider: "composio",
      keySet: !!key,
      keyPreview: preview(key),
      keyStore: this.o.vault.keyKind,
      apps: APPS.map((a) => ({
        toolkit: a.toolkit,
        name: a.name,
        mark: a.mark,
        blurb: a.blurb,
        triggers: a.triggers,
      })),
      groups: [...groups.entries()].map(([toolkit, accounts]) => {
        const info = appInfo(toolkit);
        return { toolkit, app: info.name, mark: info.mark, accounts };
      }),
      bots,
      usageToday: Object.fromEntries(
        Object.keys(quota).map((c) => [c, this.store.connectors.usage(day, bot, c)]),
      ),
      quota,
    };
  }

  private view(a: ConnectorAccount, bots: Array<{ id: string; name: string }>): AccountView {
    const grants = this.store.connectors.grants({ accountId: a.id });
    const info = appInfo(a.toolkit);
    return {
      id: a.id,
      provider: a.provider,
      toolkit: a.toolkit,
      app: info.name,
      mark: info.mark,
      label: a.label,
      status: a.status,
      identity: a.identity,
      bots: bots.map((b) => ({
        botId: b.id,
        name: b.name,
        access: grants.find((g) => g.botId === b.id)?.access ?? null,
      })),
      triggers: this.store.connectors
        .triggers(a.id)
        .filter((t) => t.status !== "removed")
        .map((t) => ({
          id: t.id,
          slug: t.slug,
          name: info.triggers.find((x) => x.slug === t.slug)?.name ?? t.slug,
          status: t.status,
        })),
      createdAt: a.createdAt,
    };
  }

  /**
   * Start connecting an account: a Composio Connect Link the person opens in
   * their own browser (desktop or phone). The account shows as 等待授權 until
   * `refresh` sees it active. The connecting bot may use it (`act`).
   */
  async connect(o: { toolkit: string; label: string; botId?: string; callbackUrl?: string }): Promise<{
    account: AccountView;
    redirectUrl: string;
  }> {
    const toolkit = o.toolkit.trim().toLowerCase();
    const label = o.label.trim().slice(0, 60);
    if (!TOOLKIT_RE.test(toolkit)) throw new ConnectorError("bad_app", "沒有這個 app");
    // Next round R8: MCP servers are not Composio apps (desktop 連接 page only).
    if (toolkit.startsWith("mcp-"))
      throw new ConnectorError("bad_app", "這個 app 不經過 Composio：請在電腦的「連接」頁設定");
    if (!label) throw new ConnectorError("bad_label", "請幫這個帳號取個名字（例如「工作」）");
    if (!(await this.hasKey())) throw new ConnectorError("no_key", "請先輸入你的 Composio API key");
    const taken = this.store.connectors
      .accounts()
      .some((a) => a.toolkit === toolkit && a.label === label && a.status !== "failed");
    if (taken) throw new ConnectorError("label_taken", `「${label}」已經用過了，換一個名字`);
    const sid = await this.session();
    const r = await this.client.link(sid, {
      toolkit,
      alias: label,
      ...(o.callbackUrl ? { callbackUrl: o.callbackUrl } : {}),
    });
    const acc =
      this.store.connectors.byRemote(r.accountId) ??
      this.store.connectors.addAccount({ remoteId: r.accountId, toolkit, label, status: "pending" });
    const bot = o.botId ?? this.store.bots.default()?.id;
    if (bot) this.store.connectors.grant(bot, acc.id, "act");
    return { account: this.view(acc, this.store.bots.list()), redirectUrl: r.redirectUrl };
  }

  /** Pull account states from Composio (after a Connect Link, on page open, on a timer). */
  async refresh(): Promise<{ changed: number }> {
    if (!(await this.hasKey())) return { changed: 0 };
    const remote = await this.client.accounts(this.userId());
    let changed = 0;
    for (const r of remote) {
      const status = STATUS[r.status.toUpperCase()] ?? "failed";
      const local = this.store.connectors.byRemote(r.id);
      if (!local) {
        if (status !== "active") continue;
        // Connected outside Alca for the same user: list it, used by no bot until the person allows it.
        const label = (r.alias ?? r.wordId ?? r.toolkit).slice(0, 60) || r.toolkit;
        this.store.connectors.addAccount({ remoteId: r.id, toolkit: r.toolkit, label, status });
        changed++;
      } else if (local.status !== "removed" && local.status !== status) {
        this.store.connectors.setStatus(local.id, status);
        changed++;
      }
    }
    return { changed };
  }

  async disconnect(accountId: string): Promise<void> {
    const a = this.store.connectors.account(accountId);
    if (!a || a.status === "removed") throw new ConnectorError("not_found", "沒有這個帳號");
    if (a.provider === "composio")
      for (const t of this.store.connectors.triggers(a.id))
        if (t.remoteId && t.status === "active")
          await this.client.deleteTrigger(t.remoteId).catch(() => undefined);
    await this.provider(a.provider).disconnect(a);
    this.store.connectors.remove(a.id);
  }

  rename(accountId: string, label: string): void {
    const l = label.trim().slice(0, 60);
    const a = this.store.connectors.account(accountId);
    if (!a || a.status === "removed") throw new ConnectorError("not_found", "沒有這個帳號");
    if (!l) throw new ConnectorError("bad_label", "名字不能是空的");
    this.store.connectors.rename(a.id, l);
  }

  setGrant(botId: string, accountId: string, access: ConnectorAccess | null): void {
    if (!this.store.bots.get(botId)) throw new ConnectorError("not_found", "沒有這個 bot");
    const a = this.store.connectors.account(accountId);
    if (!a || a.status === "removed") throw new ConnectorError("not_found", "沒有這個帳號");
    this.store.connectors.grant(botId, accountId, access);
  }

  /**
   * The accounts a bot may use in this conversation. In a peer conversation (a
   * teammate asked this bot) it is the intersection over the whole chain: an
   * account every bot of the chain may use, at the lowest access any of them
   * has. A delegation never widens what the asking bot may do with an app.
   */
  usable(botId: string, threadId?: string): Array<ConnectorAccount & { access: ConnectorAccess }> {
    const own = this.store.connectors.usable(botId);
    let chain: readonly string[] = [];
    if (threadId) {
      try {
        chain = this.store.team.byPeerThread(threadId)?.chain ?? [];
      } catch {
        chain = []; // stores without the team tables: the bot's own grants
      }
    }
    const others = [...new Set(chain)].filter((b) => b !== botId);
    if (!others.length) return own;
    const grants = others.map((b) => new Map(this.store.connectors.usable(b).map((a) => [a.id, a.access])));
    return own.flatMap((a) => {
      let access: ConnectorAccess = a.access;
      for (const g of grants) {
        const theirs = g.get(a.id);
        if (!theirs) return [];
        if (theirs === "read") access = "read";
      }
      return [{ ...a, access }];
    });
  }

  /**
   * The toolkit a model meant by `app`. The model sees app names and account
   * labels, not toolkits, so it may pass the toolkit (`gmail`, `mcp-fs`), an
   * MCP server's id (`fs`, `mcp:fs`), the shown name (`MCP：fs`, `Gmail`) or
   * the account's label (`檔案`). Matched against the apps this bot may use;
   * anything else comes back lowercased, unchanged (mac device test
   * 2026-11-05 BUG-3: `app=fs` found no `mcp-fs` account).
   */
  appOf(botId: string, app: string, threadId?: string): string {
    const raw = app.trim().toLowerCase();
    if (!raw) return raw;
    const bare = raw.replace(/^(?:我的\s*)?mcp\s*[:：-]\s*/, "");
    const mine = this.usable(botId, threadId);
    const toolkits = [...new Set(mine.map((a) => a.toolkit))];
    const exact = toolkits.find((t) => t === raw);
    if (exact) return exact;
    const server = toolkits.find((t) => t === mcpToolkit(bare));
    if (server) return server;
    const named = toolkits.find((t) => {
      const n = appInfo(t).name.toLowerCase();
      return n === raw || n.replace(/^mcp：/, "") === bare;
    });
    if (named) return named;
    const labelled = mine.filter(
      (a) => a.label.trim().toLowerCase() === raw || a.label.trim().toLowerCase() === bare,
    );
    const byLabel = [...new Set(labelled.map((a) => a.toolkit))];
    if (byLabel.length === 1) return byLabel[0] as string;
    return raw;
  }

  /**
   * The account a call runs as. With more than one for the app, the caller must say which.
   * Review 2026-11-05 #6: `toolkit` is taken as is (a tool's own toolkit, `toolkitOf`);
   * only an app name the model wrote (`fuzzy`) goes through `appOf`'s name / label matching,
   * so a Composio slug never lands on an MCP server that happens to share its name.
   */
  resolveAccount(
    botId: string,
    toolkit: string,
    account?: unknown,
    threadId?: string,
    o: { fuzzy?: boolean } = {},
  ): ConnectorAccount & { access: ConnectorAccess } {
    const app = o.fuzzy ? this.appOf(botId, toolkit, threadId) : toolkit;
    const mine = this.usable(botId, threadId).filter((a) => a.toolkit === app);
    const name = appInfo(app).name;
    if (!mine.length) throw new ConnectorError("no_account", `這個 bot 沒有可以用的 ${name} 帳號`);
    const want = typeof account === "string" ? account.trim() : "";
    if (want) {
      const hit = mine.find((a) => a.id === want || a.label === want);
      if (!hit)
        throw new ConnectorError(
          "no_account",
          `沒有叫「${want}」的 ${name} 帳號；可以用：${mine.map((a) => `「${a.label}」`).join("、")}`,
        );
      return hit;
    }
    if (mine.length > 1)
      throw new ConnectorError(
        "choose_account",
        `${name} 有 ${mine.length} 個帳號：${mine.map((a) => `「${a.label}」`).join("、")}。請用 account 指定要用哪一個（不要自己猜）。`,
      );
    return mine[0] as ConnectorAccount & { access: ConnectorAccess };
  }

  /** Review 2026-11-05 #6: a call runs only as an account of the tool's own toolkit (never a look-alike). */
  private sameToolkit<A extends ConnectorAccount>(acc: A, toolkit: string): A {
    if (acc.toolkit !== toolkit)
      throw new ConnectorError("no_account", `這個 bot 沒有可以用的 ${appInfo(toolkit).name} 帳號`);
    return acc;
  }

  /** The app a tool belongs to (the toolkit its account has). */
  toolkitOf(slug: string): string {
    const p = parseToolName(slug);
    if (p?.provider === "mcp") return mcpToolkit(p.slug.split(":")[0] as string);
    const head = slug.split("_")[0]?.toLowerCase() ?? "";
    const toolkits = new Set(this.store.connectors.accounts().map((a) => a.toolkit));
    for (const t of toolkits) if (t.replaceAll(/[-_]/g, "") === head) return t;
    return head;
  }

  /**
   * The live class of one call, decided by the host: Composio and MCP by the
   * same slug / hint rule (fails closed without a description, B9).
   */
  async classOf(slug: string, args: Record<string, unknown> = {}): Promise<ActionClass> {
    const p = parseToolName(slug);
    if (!p) return "send";
    const prov = this.providers.get(p.provider);
    if (!prov) return "send";
    return prov.classify(p.slug, await prov.getTool(p.slug).catch(() => undefined), args);
  }

  private line(p: IntegrationProvider, t: ProviderTool, labelled: boolean, acc?: ConnectorAccount): string {
    const full = p.id === "composio" ? t.slug : `${p.id}:${t.slug}`;
    const cls = p.classify(t.slug, t, {});
    const req = Array.isArray((t.inputSchema as { required?: unknown }).required)
      ? ((t.inputSchema as { required: unknown[] }).required as string[]).join(", ")
      : "";
    const desc = t.description.replace(/\s+/g, " ").slice(0, p.id === "mcp" ? 500 : 160);
    return `- ${full}（${CLASS_WORD[cls] ?? cls}${isAlwaysConfirm(cls) ? "，一律先問使用者" : ""}）${desc}${req ? `｜必填：${req}` : ""}${labelled ? `｜${p.sourceLabel(acc, t.toolkit)}` : ""}`;
  }

  /** Search tools across the apps this bot may use (step one of find → use), every provider at once. */
  async findTools(botId: string, query: string, app?: string, threadId?: string): Promise<string> {
    const toolkit = app ? this.appOf(botId, app, threadId) : undefined;
    const mine = this.usable(botId, threadId).filter((a) => !toolkit || a.toolkit === toolkit);
    if (!mine.length)
      return toolkit
        ? `這個 bot 沒有可以用的 ${appInfo(toolkit).name} 帳號（connector_accounts 列出可以用的 app 值）。`
        : "這個 bot 還沒有可以用的 app。";
    const byProvider = new Map<ConnectorAccount["provider"], ConnectorAccount[]>();
    for (const a of mine) byProvider.set(a.provider, [...(byProvider.get(a.provider) ?? []), a]);
    const labelled = byProvider.size > 1 || !byProvider.has("composio");
    const plain: string[] = [];
    const outside: string[] = [];
    for (const [id, accounts] of byProvider) {
      const p = this.providers.get(id);
      if (!p) continue;
      const found = await p.searchTools({ accounts, query, limit: 8 });
      for (const t of found) {
        const line = this.line(
          p,
          t,
          labelled,
          accounts.find((a) => a.toolkit === t.toolkit),
        );
        // A server's own words (MCP tool descriptions) are untrusted: fenced, defused.
        (id === "mcp" ? outside : plain).push(line);
      }
    }
    if (!plain.length && !outside.length) return "沒有找到相符的工具；換個說法再找一次。";
    const fenced = outside.length
      ? [
          fenceApp({
            toolkit: "mcp",
            tool: "tools/list",
            account: "",
            body: outside.join("\n"),
            truncated: false,
          }),
        ]
      : [];
    return [
      ...plain,
      ...fenced,
      "用 connector_find_tool {slug} 看完整參數，再用 connector_use_tool 執行。",
    ].join("\n");
  }

  async describeTool(slug: string): Promise<string> {
    const p = parseToolName(slug);
    const prov = p ? this.providers.get(p.provider) : undefined;
    const t = p && prov ? await prov.getTool(p.slug).catch(() => undefined) : undefined;
    if (!p || !prov || !t) return `找不到工具 ${slug.slice(0, 160)}`;
    const cls = prov.classify(p.slug, t, {});
    const max = this.o.settings().engineering.connectors.resultChars;
    const text = [
      `${p.full}（${CLASS_WORD[cls] ?? cls}）${t.description.slice(0, p.provider === "mcp" ? 500 : 600)}`,
      `參數：${budgetJson(t.inputSchema, Math.min(max, 4000)).text}`,
    ].join("\n");
    return p.provider === "mcp"
      ? fenceApp({ toolkit: this.toolkitOf(p.full), tool: p.slug, account: "", body: text, truncated: false })
      : text;
  }

  /**
   * Run one tool as one account. The host already showed the card (when one
   * was needed); here we re-check what the gateway authorized against the
   * tool's live class, the bot's grant and the daily quota, then call it.
   */
  async execute(o: {
    botId: string;
    /** The conversation the call is made in (a peer conversation narrows grants to the chain). */
    threadId?: string;
    slug: string;
    account?: unknown;
    arguments: Record<string, unknown>;
    authorized: ActionClass;
  }): Promise<string> {
    const parsed = this.parse(o.slug);
    const slug = parsed.full;
    const toolkit = this.toolkitOf(slug);
    const acc = this.sameToolkit(this.resolveAccount(o.botId, toolkit, o.account, o.threadId), toolkit);
    const live = await this.classOf(slug, o.arguments);
    if (live !== "read" && acc.access === "read")
      throw new ConnectorError("read_only", `這個 bot 對「${acc.label}」只有讀取權限`);
    if (stricter(o.authorized, live) !== o.authorized || (isAlwaysConfirm(live) && o.authorized !== live))
      throw new ConnectorError(
        "not_authorized",
        `這個動作是「${CLASS_WORD[live] ?? live}」，還沒有經過使用者確認；不會執行`,
      );
    if (live !== "read") {
      const quota = this.o.settings().engineering.connectors.dailyQuota;
      const limit = (quota as Record<string, number>)[live] ?? 0;
      if (!this.store.connectors.reserve(localDay(this.now()), o.botId, live, limit))
        throw new ConnectorError(
          "quota",
          limit === 0
            ? `「${CLASS_WORD[live] ?? live}」不能透過連接的 app 做`
            : `今天「${CLASS_WORD[live] ?? live}」的額度（${limit} 次）用完了，明天再試或到設定調整`,
        );
    }
    const r = await this.provider(acc.provider).execute({
      account: acc,
      slug: parsed.slug,
      args: o.arguments,
    });
    const max = this.o.settings().engineering.connectors.resultChars;
    const shaped = budgetJson(r.ok ? r.data : { error: r.error ?? "失敗" }, max);
    const body = fenceApp({
      toolkit,
      tool: slug,
      account: acc.label,
      body: shaped.text,
      truncated: shaped.truncated,
    });
    if (!r.ok)
      throw new ConnectorError("tool_failed", `${slug} 沒有成功：${(r.error ?? "").slice(0, 300)}\n${body}`);
    return body;
  }

  /** Read-only execution for routine checks (pure code, no model): the raw data, never a write. */
  async readRaw(o: {
    botId: string;
    slug: string;
    account?: unknown;
    arguments: Record<string, unknown>;
  }): Promise<unknown> {
    const parsed = this.parse(o.slug);
    const slug = parsed.full;
    if ((await this.classOf(slug, o.arguments)) !== "read")
      throw new ConnectorError("not_read", `${slug} 不是讀取工具，不能當作檢查`);
    const toolkit = this.toolkitOf(slug);
    const acc = this.sameToolkit(this.resolveAccount(o.botId, toolkit, o.account), toolkit);
    const r = await this.provider(acc.provider).execute({
      account: acc,
      slug: parsed.slug,
      args: o.arguments,
    });
    if (!r.ok) throw new ConnectorError("tool_failed", `${slug} 讀取失敗：${(r.error ?? "").slice(0, 300)}`);
    return r.data;
  }
}
