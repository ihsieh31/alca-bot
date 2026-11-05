// Next round R1: 設定 › 網路搜尋. The key is checked with one query before
// it is kept, never comes back out, and widening needs the approve key.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSettings, type Settings } from "@alca/config";
import type { SecretStore } from "@alca/os";
import { afterEach, describe, expect, it } from "vitest";
import { startDesktop } from "../src/index.ts";
import { WebSearchApi } from "../src/web-search.ts";

const KEY = "BSA-fict-key-0123456789abcdef";

function memorySecrets(): SecretStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    backend: "memory",
    get: async (n) => values.get(n),
    set: async (n, v) => void values.set(n, v),
    delete: async (n) => void values.delete(n),
    names: async () => [...values.keys()],
  };
}

function fakeNet(status: number, body: string) {
  const urls: string[] = [];
  return {
    urls,
    deps: {
      resolve: async () => ["93.184.216.34"],
      connect: async (r: { url: URL }) => {
        urls.push(r.url.href);
        const buf = Buffer.from(body);
        return {
          status,
          headers: { "content-type": "application/json" },
          destroy: () => undefined,
          body: (async function* () {
            yield buf;
          })(),
        };
      },
    },
  };
}

function api(status = 200, body = '{"web":{"results":[]}}') {
  let settings: Settings = parseSettings({});
  const secrets = memorySecrets();
  const net = fakeNet(status, body);
  const a = new WebSearchApi({
    secrets,
    settings: () => settings,
    save: (next) => {
      settings = parseSettings({ engineering: { webSearch: next } });
    },
    deps: net.deps,
  });
  return { a, secrets, net, settings: () => settings };
}

describe("WebSearchApi (next round R1)", () => {
  it("checks a new key with one real query, keeps it in the SecretStore, and offers web_search", async () => {
    const t = api();
    expect(t.a.available()).toBe(false);
    const v = await t.a.put({ provider: "brave", key: KEY }, true);
    expect(t.net.urls[0]).toMatch(/^https:\/\/api\.search\.brave\.com\/res\/v1\/web\/search\?q=alca&count=1/);
    expect(t.secrets.values.get("search.brave.apiKey")).toBe(KEY);
    expect(v.provider).toBe("brave");
    expect(v.available).toBe(true);
    expect(JSON.stringify(v)).not.toContain(KEY);
    expect(v.keys.brave).toBe(`••••${KEY.slice(-4)}`);
    expect(t.a.available()).toBe(true);
  });

  it("a key the provider refuses is not kept, and the error does not echo it", async () => {
    const t = api(401, `{"error":"bad ${KEY}"}`);
    const err = await t.a.put({ provider: "brave", key: KEY }, true).catch((e: Error) => e.message);
    expect(err).toMatch(/沒有通過檢查/);
    expect(err).not.toContain(KEY);
    expect(t.secrets.values.size).toBe(0);
    expect(t.settings().engineering.webSearch.provider).toBeNull();
  });

  it("widening without the approve key is refused; turning it off is not", async () => {
    const t = api();
    await expect(t.a.put({ provider: "brave", key: KEY }, false)).rejects.toThrow(/核准金鑰/);
    await expect(
      t.a.put({ provider: "searxng", searxngUrl: "http://127.0.0.1:8888" }, false),
    ).rejects.toThrow(/核准金鑰/);
    expect(t.net.urls).toHaveLength(0);
    await t.a.put({ provider: "brave", key: KEY }, true);
    const off = await t.a.put({ provider: null }, false);
    expect(off.available).toBe(false);
    expect(t.a.available()).toBe(false);
  });

  it("a provider without its key, or SearXNG without a URL, is refused", async () => {
    const t = api();
    await expect(t.a.put({ provider: "tavily" }, true)).rejects.toThrow(/需要金鑰/);
    await expect(t.a.put({ provider: "searxng" }, true)).rejects.toThrow(/需要網址/);
    await expect(t.a.put({ provider: "searxng", searxngUrl: "ftp://x" }, true)).rejects.toThrow(/http/);
    await expect(t.a.put({ provider: "google" }, true)).rejects.toThrow(/只能是/);
    await expect(t.a.put({ engineering: {} }, true)).rejects.toThrow(/不能在這裡改/);
  });

  it("removing the key takes web_search away from the next worker", async () => {
    const t = api();
    await t.a.put({ provider: "brave", key: KEY }, true);
    const opts = t.a.toolOptions();
    expect(opts.available()).toBe(true);
    await t.a.clearKey("brave");
    expect(opts.available()).toBe(false);
    expect(t.secrets.values.size).toBe(0);
  });
});

describe("設定 › 網路搜尋 routes", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
  });

  it("GET shows no key; PUT needs the approve key to widen; config.json gets engineering.webSearch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alca-search-"));
    const app = await startDesktop({
      engine: "demo",
      dataDir: dir,
      port: 0,
      agents: "direct",
      browser: "off",
    });
    cleanups.push(
      () => rmSync(dir, { recursive: true, force: true }),
      () => app.close(),
    );
    const call = async (method: string, path: string, body?: unknown, approve = true) => {
      const res = await fetch(`${app.server.url}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${app.token}`,
          ...(approve ? app.uiHeaders : { origin: app.server.url }),
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      // biome-ignore lint/suspicious/noExplicitAny: test helper reads arbitrary JSON
      return { status: res.status, body: (await res.json()) as any };
    };
    const v = await call("GET", "/api/settings/search");
    expect(v.body).toMatchObject({ provider: null, available: false, keys: { brave: null, tavily: null } });
    const sx = { provider: "searxng", searxngUrl: "http://127.0.0.1:8888" };
    expect((await call("PUT", "/api/settings/search", sx, false)).status).toBe(403);
    const ok = await call("PUT", "/api/settings/search", sx);
    expect(ok.status).toBe(200);
    expect(ok.body.available).toBe(true);
    const file = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    expect(file.engineering.webSearch).toEqual({
      provider: "searxng",
      searxngUrl: "http://127.0.0.1:8888",
      count: 5,
    });
    expect((await call("PUT", "/api/settings/search", { provider: null }, false)).status).toBe(200);
    expect((await call("DELETE", "/api/settings/search/key/brave", undefined, false)).status).toBe(200);
  });
});
