import type { HostTool } from "@alca/tools";
import { validateArgs } from "../schema.ts";

/**
 * Plan §5: deferred tool loading for the general harness.
 * A few tools are visible from the start; the rest (connected-app actions,
 * the less common browser tools) sit in a catalog the worker reaches through
 * `tool_search` → `tool_describe` → `tool_call`. `tool_call` runs the catalog
 * tool behind its own class and approval flow (its `inspect` reports the
 * inner tool's class, which the gateway then decides on), and refuses a tool
 * whose schema this turn has not loaded yet.
 */

export type ToolRisk = "read" | "write" | "outward" | "secret";

export interface CatalogEntry {
  name: string;
  summary: string;
  schema: Record<string, unknown>;
  risk: ToolRisk;
  guidanceKeys: string[];
}

export const SEARCH_LIMIT_DEFAULT = 5;
export const SEARCH_LIMIT_MAX = 10;
export const READY_MAX = 3;
export const SUMMARY_MAX = 180;
export const NAME_LIST_MAX = 4000;
export const DIRECT_MAX = 12;
/**
 * Below this many catalog tools there is nothing to defer: every tool is
 * offered directly (same classes and gates either way). Deferring pays off
 * for the long lists connected apps bring.
 */
export const LAZY_MIN_CATALOG = 8;

/**
 * Tools a general worker sees without searching (≤ 12 besides the three
 * lazy-loading tools and the contract). `web_search` is here only when the
 * host offered it (a provider is set in 設定).
 */
export const GENERAL_DIRECT = [
  "browser_open",
  "browser_tabs",
  "browser_script",
  "browser_fill_secret",
  "browser_request_takeover",
  "web_fetch",
  "web_search",
  "file_read",
  "file_write",
  "file_list",
  "draft_save",
  "await_event",
] as const;

/** Always direct, never in the catalog: the contract and the look-back tools. */
const ALWAYS_DIRECT = new Set(["report_result", "handoff", "history_search", "history_read", "list_waits"]);

/**
 * The connected-app gateway (find → use over every app and MCP server the bot
 * may use), offered directly whenever the host offers it and not counted in
 * DIRECT_MAX: three small schemas in front of any number of app tools. In the
 * catalog they were unreachable for a CLI worker (Claude Code) that called
 * `connector_find_tool` by name and got "No such tool available" (mac device
 * test 2026-11-05 BUG-3). The app shortcuts (`app_*`) stay in the catalog.
 */
export const CONNECTOR_DIRECT = ["connector_accounts", "connector_find_tool", "connector_use_tool"] as const;
const CONNECTOR_DIRECT_SET = new Set<string>(CONNECTOR_DIRECT);

/**
 * Names only the host may offer (next round R1): a tool with one of these
 * names that a connector or an MCP server brought in is never offered,
 * directly or through the catalog, so it cannot pose as Alca's own.
 */
const HOST_RESERVED = new Set(["web_search"]);
const offered = (t: HostTool) => !HOST_RESERVED.has(t.spec.name) || t.hostOwned === true;

export const LAZY_TOOL_NAMES = ["tool_search", "tool_describe", "tool_call"] as const;

const GUIDANCE: Record<string, string> = {
  browser:
    "瀏覽器：先 browser_open 看頁面，再用 browser_script 一次跑多個步驟；送出、付款、寄送的步驟會停下等使用者批准。",
  login:
    "登入：密碼只用 browser_fill_secret 帶金庫項目 id 由 Alca 代填（只限 HTTPS、同一個網站）；卡號、驗證碼、CAPTCHA 用 browser_request_takeover。",
  payment:
    "付款：最後一步一律由使用者在手機上確認（browser_request_takeover reason=payment_confirmation），不要自己按。",
  form: "表單：填好後先 snapshot 核對欄位，再送出；送出前主機會出示批准卡。",
};

function riskOf(t: HostTool): ToolRisk {
  const n = t.spec.name;
  if (/secret|password|fill_card|vault/.test(n)) return "secret";
  const c = t.actionClass as string;
  if (c === "read") return "read";
  if (c === "write") return "write";
  return "outward";
}

function guidanceKeysOf(name: string, summary: string): string[] {
  const keys: string[] = [];
  if (name.startsWith("browser_")) keys.push("browser");
  if (/login|sign.?in|登入|密碼/i.test(`${name} ${summary}`)) keys.push("login");
  if (/pay|checkout|付款|結帳|刷卡/i.test(`${name} ${summary}`)) keys.push("payment");
  if (/form|fill|表單|填/i.test(`${name} ${summary}`)) keys.push("form");
  return keys;
}

export function catalogEntry(t: HostTool): CatalogEntry {
  const summary = t.spec.description.replace(/\s+/g, " ").trim().slice(0, SUMMARY_MAX);
  return {
    name: t.spec.name,
    summary,
    schema: t.spec.inputSchema,
    risk: riskOf(t),
    guidanceKeys: guidanceKeysOf(t.spec.name, summary),
  };
}

/** Split a general worker's tools into the visible ones and the catalog. */
export function splitGeneralTools(tools: readonly HostTool[]): { direct: HostTool[]; catalog: HostTool[] } {
  const direct: HostTool[] = [];
  const catalog: HostTool[] = [];
  const wanted = new Set<string>(GENERAL_DIRECT);
  for (const t of tools) {
    const n = t.spec.name;
    if ((LAZY_TOOL_NAMES as readonly string[]).includes(n)) continue;
    if (
      ALWAYS_DIRECT.has(n) ||
      CONNECTOR_DIRECT_SET.has(n) ||
      (wanted.has(n) && direct.filter((d) => wanted.has(d.spec.name)).length < DIRECT_MAX)
    )
      direct.push(t);
    else catalog.push(t);
  }
  return { direct, catalog };
}

const words = (s: string) =>
  s
    .toLowerCase()
    .split(/[\s_.\-/,，、。:：]+/)
    .filter(Boolean);

/** Score: a name word hit +3, a summary word hit +1; an exact name first; stable order. */
export function searchCatalog(entries: readonly CatalogEntry[], queries: readonly string[], limit: number) {
  const scored = entries.map((e, i) => {
    let score = 0;
    let exact = false;
    let strong = false;
    const nameWords = words(e.name.replace(/^[a-z]+_/, ""));
    for (const q of queries) {
      const qw = words(q);
      const ql = q.trim().toLowerCase();
      if (ql === e.name.toLowerCase()) exact = true;
      for (const w of qw) {
        if (words(e.name).includes(w) || e.name.toLowerCase().includes(w)) score += 3;
        if (e.summary.toLowerCase().includes(w)) score += 1;
      }
      if (nameWords.length && nameWords.every((nw) => ql.includes(nw))) strong = true;
    }
    return { e, i, score: exact ? score + 1000 : score, strong: strong || exact };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, limit);
}

function guidanceFor(entries: readonly CatalogEntry[]): string[] {
  const keys = new Set<string>();
  for (const e of entries) for (const k of e.guidanceKeys) keys.add(k);
  return [...keys].map((k) => GUIDANCE[k]).filter((g): g is string => !!g);
}

/** The comma-separated name list in `tool_search`'s description (≤ 4,000 characters). */
export function nameList(entries: readonly CatalogEntry[]): string {
  let out = "";
  for (const e of entries) {
    const next = out ? `${out}, ${e.name}` : e.name;
    if (next.length > NAME_LIST_MAX - 20) return `${out}, …`;
    out = next;
  }
  return out;
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

function queriesOf(a: Record<string, unknown>): string[] {
  const qs = Array.isArray(a.queries) ? a.queries.filter((q): q is string => typeof q === "string") : [];
  const q = str(a.query);
  return [...(q ? [q] : []), ...qs].map((s) => s.slice(0, 200)).slice(0, 10);
}

function namesOf(a: Record<string, unknown>): string[] {
  const ns = Array.isArray(a.names) ? a.names.filter((n): n is string => typeof n === "string") : [];
  const n = str(a.name);
  return [...(n ? [n] : []), ...ns].slice(0, 10);
}

/** What `tool_search` adds from the connected apps when nothing in them matched (or none is usable). */
const NO_APP_HIT = /還沒有可以用的 app|沒有找到相符的工具/;

/**
 * The three lazy-loading tools over a catalog. Built per worker turn (the
 * worker's tools are built per run), so "loaded this turn" is this instance's set.
 * `apps`, when given, is the direct `connector_find_tool`: `tool_search` also
 * searches the connected apps and MCP servers with it, so their tools show up
 * in the same search (BUG-3: a search for files listed only file_* tools).
 */
export function lazyTools(catalog: readonly HostTool[], apps?: HostTool): HostTool[] {
  const byName = new Map(catalog.map((t) => [t.spec.name, t]));
  const entries = catalog.map(catalogEntry);
  const entryOf = new Map(entries.map((e) => [e.name, e]));
  const loaded = new Set<string>();
  const hasBrowserScript = byName.has("browser_script");
  const describe = (e: CatalogEntry) => ({ name: e.name, summary: e.summary, schema: e.schema });
  return [
    {
      spec: {
        name: "tool_search",
        description: `找沒有直接列出的工具（連接的 app、較少用的瀏覽器工具）。用 query 或 queries 搜尋；最相關的會附參數。全部工具：${nameList(entries)}`,
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            queries: { type: "array", items: { type: "string" }, maxItems: 10 },
            limit: { type: "integer", minimum: 1, maximum: SEARCH_LIMIT_MAX },
          },
          additionalProperties: false,
        },
      },
      actionClass: "read",
      run: async (a, signal, ctx) => {
        const qs = queriesOf(a);
        if (!qs.length) throw new Error("需要 query 或 queries");
        const raw = typeof a.limit === "number" ? Math.floor(a.limit) : SEARCH_LIMIT_DEFAULT;
        const limit = Math.min(SEARCH_LIMIT_MAX, Math.max(1, raw));
        const hits = searchCatalog(entries, qs, limit);
        let ready = 0;
        const tools = hits.map((h) => {
          if (h.strong && ready < READY_MAX) {
            ready++;
            loaded.add(h.e.name);
            return describe(h.e);
          }
          return { name: h.e.name, summary: h.e.summary };
        });
        const readyBrowser = tools.some((t) => "schema" in t && t.name.startsWith("browser_"));
        if (readyBrowser && hasBrowserScript && !tools.some((t) => t.name === "browser_script")) {
          const e = entryOf.get("browser_script");
          if (e) {
            loaded.add(e.name);
            tools.push(describe(e));
          }
        }
        const shown = hits.map((h) => h.e);
        const out: Record<string, unknown> = { tools };
        const g = guidanceFor(shown);
        if (g.length) out.guidance = g;
        if (!shown.some((e) => e.name.startsWith("browser_")))
          out.note = "沒有專屬工具的網站用瀏覽器（browser_open、browser_script）。";
        if (apps) {
          // The connected apps' own tools; run them with connector_use_tool.
          const found = await apps.run({ query: qs.join(" ") }, signal, ctx).catch(() => "");
          if (found && !NO_APP_HIT.test(found)) out.apps = found;
        }
        return JSON.stringify(out);
      },
    },
    {
      spec: {
        name: "tool_describe",
        description:
          "看一個或多個工具的完整參數（name 或 names，最多 10 個）；tool_call 之前必須先載入參數。",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string" },
            names: { type: "array", items: { type: "string" }, maxItems: 10 },
          },
          additionalProperties: false,
        },
      },
      actionClass: "read",
      run: async (a) => {
        const ns = namesOf(a);
        if (!ns.length) throw new Error("需要 name 或 names");
        const found = ns.map((n) => entryOf.get(n)).filter((e): e is CatalogEntry => !!e);
        const missing = ns.filter((n) => !entryOf.has(n));
        for (const e of found) loaded.add(e.name);
        return JSON.stringify({
          tools: found.map(describe),
          guidance: guidanceFor(found),
          ...(missing.length ? { unknown: missing } : {}),
        });
      },
    },
    {
      spec: {
        name: "tool_call",
        description:
          "呼叫 tool_search／tool_describe 找到的工具：name 與 arguments（照它的參數）。照該工具自己的權限與批准流程執行。",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string", maxLength: 160 }, arguments: { type: "object" } },
          required: ["name"],
          additionalProperties: false,
        },
      },
      actionClass: "read",
      inspect: async (a, ctx) => {
        const name = str(a.name) ?? "";
        const inner = byName.get(name);
        if (!inner || !loaded.has(name))
          return { actionClass: "read", summary: `tool_call ${name.slice(0, 80)}` };
        const args = (a.arguments ?? {}) as Record<string, unknown>;
        let actionClass: string = inner.actionClass;
        let summary = `透過 tool_call 執行 ${name}`;
        let target: string | undefined;
        if (inner.inspect) {
          try {
            const r = await inner.inspect(args, ctx);
            if (r.actionClass) actionClass = r.actionClass;
            if (r.summary) summary = `${summary}：${r.summary}`;
            if (r.target) target = r.target;
          } catch {
            // keep the declared class
          }
        }
        return { actionClass, summary, ...(target ? { target } : {}) } as Awaited<
          ReturnType<NonNullable<HostTool["inspect"]>>
        >;
      },
      run: async (a, signal, ctx) => {
        const name = str(a.name) ?? "";
        const inner = byName.get(name);
        // 1. unknown → error, without echoing the arguments
        if (!inner) throw new Error(`unknown tool: ${name.slice(0, 160)}`);
        const e = entryOf.get(name) as CatalogEntry;
        // 2. stricter than calling blind: the schema must be loaded this turn first
        if (!loaded.has(name)) {
          loaded.add(name);
          return JSON.stringify({ error: "schema_not_loaded", schema: e.schema, guidance: guidanceFor([e]) });
        }
        // 3. the inner tool's own schema (field paths only, never values)
        const raw = a.arguments;
        const args =
          typeof raw === "object" && raw !== null && !Array.isArray(raw)
            ? (raw as Record<string, unknown>)
            : {};
        const v = validateArgs(name, inner.spec.inputSchema, args);
        if (!v.ok) throw new Error(v.message);
        // 4. the gateway already decided on the inner tool's class (inspect above)
        return inner.run(v.args, signal, ctx);
      },
    },
  ];
}

/** A general worker's tool list: the direct tools, then the lazy-loading trio over the rest. */
export function generalToolset(tools: readonly HostTool[]): HostTool[] {
  // R1: web_search only as the host's own tool (offered when a provider is set; otherwise searching is Alca Browser).
  const { direct, catalog } = splitGeneralTools(tools.filter(offered));
  if (catalog.length < LAZY_MIN_CATALOG) return [...direct, ...catalog];
  const apps = direct.find((t) => t.spec.name === "connector_find_tool");
  return [...direct, ...lazyTools(catalog, apps)];
}
