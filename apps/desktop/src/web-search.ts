// 設定 › 網路搜尋 (next round R1): which search provider general workers
// may use for `web_search`, and its key. The key goes into the SecretStore
// (the vault) after one real query proves it works, and never comes back
// out: the view says only whether one is set, with the last four characters.
// Adding a provider, a key or a SearXNG address widens where Alca may
// connect, so it needs the approve key; turning search off or removing a key
// narrows and does not.
import type { Settings } from "@alca/config";
import { preview } from "@alca/connectors";
import {
  SEARCH_SECRET,
  type SearchProviderId,
  searchProviderFor,
  type WebSearchToolOptions,
  webSearchTool,
} from "@alca/core";
import { tSource } from "@alca/design/i18n";
import type { SecretStore } from "@alca/os";
import { HttpError } from "./http.ts";

export type WebSearchSettings = Settings["engineering"]["webSearch"];

export interface WebSearchView {
  provider: SearchProviderId | null;
  searxngUrl: string | null;
  count: number;
  /** A preview of each saved key (never the key). */
  keys: Record<SearchProviderId, string | null>;
  /** General workers get `web_search` now. */
  available: boolean;
}

export interface WebSearchApiOptions {
  secrets: SecretStore;
  settings: () => Settings;
  /** Write `engineering.webSearch` to config.json (validated as a whole). */
  save: (next: WebSearchSettings) => void;
  /** Tests: the fake network for the check query. */
  deps?: WebSearchToolOptions["deps"];
}

const PROVIDERS: readonly SearchProviderId[] = ["brave", "tavily", "searxng"];
const isProvider = (v: unknown): v is SearchProviderId =>
  typeof v === "string" && (PROVIDERS as readonly string[]).includes(v);

export class WebSearchApi {
  private readonly o: WebSearchApiOptions;
  /** Which search keys exist (refreshed at start and after every change), so `available()` stays synchronous. */
  private keys = new Set<string>();

  constructor(o: WebSearchApiOptions) {
    this.o = o;
  }

  async refresh(): Promise<void> {
    const names = new Set(await this.o.secrets.names());
    this.keys = new Set(Object.values(SEARCH_SECRET).filter((n) => names.has(n)));
  }

  private config(): WebSearchSettings {
    return this.o.settings().engineering.webSearch;
  }

  available(): boolean {
    const p = searchProviderFor(this.config());
    if (!p) return false;
    return p.id === "searxng" || this.keys.has(SEARCH_SECRET[p.id]);
  }

  /** What AgentSystem's `webSearch` option needs. */
  toolOptions(): WebSearchToolOptions & { available: () => boolean } {
    return {
      provider: () => searchProviderFor(this.config()),
      secret: (name) => this.o.secrets.get(name),
      count: () => this.config().count,
      ...(this.o.deps ? { deps: this.o.deps } : {}),
      available: () => this.available(),
    };
  }

  async view(): Promise<WebSearchView> {
    const c = this.config();
    const keys = {} as Record<SearchProviderId, string | null>;
    for (const p of PROVIDERS) keys[p] = preview(await this.o.secrets.get(SEARCH_SECRET[p]));
    return {
      provider: c.provider,
      searxngUrl: c.searxngUrl,
      count: c.count,
      keys,
      available: this.available(),
    };
  }

  /**
   * `{provider: brave|tavily|searxng|null, searxngUrl?, count?, key?}`.
   * Turning search off needs nothing more; anything else needs the approve
   * key. A new key is checked with one real query before it is kept.
   */
  async put(body: Record<string, unknown>, keyed: boolean): Promise<WebSearchView> {
    for (const k of Object.keys(body))
      if (!["provider", "searxngUrl", "count", "key"].includes(k))
        throw new HttpError(400, tSource("core.common.notEditableHere", { key: k }));
    const cur = this.config();
    const provider = "provider" in body ? body.provider : cur.provider;
    if (provider !== null && !isProvider(provider)) throw new HttpError(400, tSource("core.search.provider"));
    const searxngUrl =
      "searxngUrl" in body
        ? typeof body.searxngUrl === "string" && body.searxngUrl.trim()
          ? body.searxngUrl.trim()
          : null
        : cur.searxngUrl;
    const count = "count" in body ? body.count : cur.count;
    const key = typeof body.key === "string" ? body.key.trim() : "";
    const next = { provider, searxngUrl, count } as WebSearchSettings;
    const narrows = provider === null && !key && searxngUrl === cur.searxngUrl;
    if (!narrows && !keyed) throw new HttpError(403, tSource("core.search.needsWindow"));
    if (provider === "searxng" && !searxngUrl) throw new HttpError(400, tSource("core.search.searxUrl"));
    if (searxngUrl && !/^https?:\/\/[^/\s]+/i.test(searxngUrl))
      throw new HttpError(400, tSource("core.search.searxScheme"));
    if (key) {
      if (!provider) throw new HttpError(400, tSource("core.search.pickFirst"));
      if (!/^[\x21-\x7e]{8,300}$/.test(key)) throw new HttpError(400, tSource("core.search.keyShape"));
      await this.check(next, key);
      await this.o.secrets.set(SEARCH_SECRET[provider], key);
    } else if (provider && provider !== "searxng" && !(await this.o.secrets.get(SEARCH_SECRET[provider])))
      throw new HttpError(400, tSource("core.search.needsKey"));
    this.o.save(next);
    await this.refresh();
    return this.view();
  }

  /** Remove one provider's key (narrows: no approve key needed). */
  async clearKey(provider: string): Promise<WebSearchView> {
    if (!isProvider(provider)) throw new HttpError(404, tSource("core.search.none"));
    await this.o.secrets.delete(SEARCH_SECRET[provider]);
    await this.refresh();
    return this.view();
  }

  /** One real query (`alca`) with the new key; a refusal never stores the key. */
  private async check(c: WebSearchSettings, key: string): Promise<void> {
    const t = webSearchTool({
      provider: () => searchProviderFor(c),
      secret: async () => key,
      ...(this.o.deps ? { deps: this.o.deps } : {}),
    });
    try {
      await t.run({ query: "alca", count: 1 }, AbortSignal.timeout(20_000));
    } catch (e) {
      throw new HttpError(
        400,
        tSource("core.search.keyFailed", { reason: String((e as Error)?.message ?? e).slice(0, 300) }),
      );
    }
  }
}
