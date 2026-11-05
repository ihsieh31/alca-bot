// The service worker's decisions, run as the real sw.ts in a sandbox:
// navigation fallback on a host error (re-pair after revoke → Cloudflare 1033)
// and the notification tap that leaves its target for the page (BUG-7).
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { PENDING_CACHE, PENDING_KEY } from "../app/reach.ts";

const SRC = readFileSync(new URL("../app/sw.ts", import.meta.url), "utf8");
const SCOPE = "https://phone.example.com/";

type Handler = (e: Record<string, unknown>) => void;

function loadSw(
  net: (req: unknown) => Promise<Response>,
  assets: string[] = [],
  o: { words?: Record<string, Record<string, string>>; language?: string } = {},
) {
  const handlers = new Map<string, Handler>();
  const stores = new Map<string, Map<string, Response>>();
  const shell = new Response("<!doctype html><title>shell</title>", { status: 200 });
  const store = (name: string) => {
    const m = stores.get(name) ?? new Map<string, Response>();
    stores.set(name, m);
    return {
      put: async (k: string, r: Response) => void m.set(k, r),
      match: async (k: string) => m.get(k)?.clone(),
      delete: async (k: string) => m.delete(k),
      addAll: async (reqs: unknown[]) => void added.push(...reqs),
    };
  };
  const calls: string[] = [];
  const added: unknown[] = [];
  const shown: Array<{ title: string; body: string }> = [];
  const windows: Array<Record<string, unknown>> = [];
  const self = {
    addEventListener: (t: string, h: Handler) => handlers.set(t, h),
    skipWaiting: async () => undefined,
    registration: {
      scope: SCOPE,
      showNotification: async (title: string, opt: Record<string, unknown>) =>
        void shown.push({ title, body: String(opt.body) }),
    },
    clients: {
      claim: async () => undefined,
      matchAll: async () => windows,
      openWindow: async (u: string) => {
        calls.push(`open:${u}`);
        return null;
      },
    },
    navigator: { language: o.language ?? "zh-TW" },
  };
  const code = stripTypeScriptTypes(SRC, { mode: "strip" })
    .replace('JSON.parse("__WORDS__")', JSON.stringify(o.words ?? {}))
    .replace('JSON.parse("__ASSETS__")', JSON.stringify(assets));
  runInNewContext(code, {
    self,
    location: new URL(SCOPE),
    fetch: net,
    Response,
    // A worker resolves relative URLs against its own location; Node needs the base.
    Request: class extends Request {
      constructor(u: string, o?: RequestInit) {
        super(new URL(u, SCOPE), o);
      }
    },
    URL,
    JSON,
    Date,
    Promise,
    caches: {
      open: async (n: string) => store(n),
      match: async (k: string) => (k === "./index.html" ? shell.clone() : undefined),
      keys: async () => [...stores.keys()],
      delete: async (n: string) => stores.delete(n),
    },
  });
  const fire = async (type: string, e: Record<string, unknown>) => {
    let done: Promise<unknown> = Promise.resolve();
    let response: Promise<Response> | Response | undefined;
    (handlers.get(type) as Handler)({
      ...e,
      waitUntil: (p: Promise<unknown>) => {
        done = p;
      },
      respondWith: (r: Promise<Response> | Response) => {
        response = r;
      },
    });
    await done;
    return response ? await response : undefined;
  };
  return { fire, stores, calls, windows, added, shown };
}

const nav = { method: "GET", url: `${SCOPE}#pair=abc`, mode: "navigate" };

describe("phone service worker", () => {
  it("a host error page (Cloudflare 530 / 1033) on a navigation → the cached app shell", async () => {
    const sw = loadSw(async () => new Response("error code: 1033", { status: 530 }));
    const r = (await sw.fire("fetch", { request: nav })) as Response;
    expect(await r.text()).toContain("<title>shell</title>");
  });

  it("network down → the cached shell; a good answer or a 404 stays the network's", async () => {
    const down = loadSw(async () => {
      throw new TypeError("offline");
    });
    expect(await ((await down.fire("fetch", { request: nav })) as Response).text()).toContain("shell");
    const ok = loadSw(async () => new Response("fresh", { status: 200 }));
    expect(await ((await ok.fire("fetch", { request: nav })) as Response).text()).toBe("fresh");
    const missing = loadSw(async () => new Response("nope", { status: 404 }));
    expect(((await missing.fire("fetch", { request: nav })) as Response).status).toBe(404);
  });

  it("a notification tap with the app open: focus + message, and the target is left for the page", async () => {
    const sw = loadSw(async () => new Response(""));
    const got: unknown[] = [];
    sw.windows.push({
      url: SCOPE,
      focused: false,
      focus: async () => undefined,
      postMessage: (m: unknown) => got.push(m),
    });
    await sw.fire("notificationclick", {
      notification: { data: { t: "approval", id: "apv_9" }, close: () => undefined, tag: "apv_9" },
      action: "",
    });
    expect(got).toEqual([{ type: "alca-open", t: "approval", id: "apv_9" }]);
    const note = sw.stores.get(PENDING_CACHE)?.get(PENDING_KEY);
    expect(note).toBeDefined();
    const p = (await note?.json()) as { t: string; id: string; at: number };
    expect([p.t, p.id]).toEqual(["approval", "apv_9"]);
    expect(Math.abs(Date.now() - p.at)).toBeLessThan(5000);
  });

  it("no app open: opens it at #open=…, also leaving the target", async () => {
    const sw = loadSw(async () => new Response(""));
    await sw.fire("notificationclick", {
      notification: { data: { t: "question", id: "q_1" }, close: () => undefined, tag: "q_1" },
      action: "",
    });
    expect(sw.calls).toEqual([`open:${SCOPE}#open=question:q_1`]);
    expect(sw.stores.get(PENDING_CACHE)?.has(PENDING_KEY)).toBe(true);
  });

  it("install precaches past the HTTP cache (cache: 'reload'), so a new version never stores old bytes", async () => {
    const sw = loadSw(async () => new Response(""), ["./index.html", "./styles/chat.css"]);
    await sw.fire("install", {});
    expect(sw.added).toHaveLength(2);
    for (const r of sw.added as Request[]) {
      expect(r).toBeInstanceOf(Request);
      expect(r.cache).toBe("reload");
    }
    expect((sw.added as Request[]).map((r) => new URL(r.url).pathname)).toEqual([
      "/index.html",
      "/styles/chat.css",
    ]);
  });

  it("notifications follow the app's 介面語言 (posted by the page), else the system language", async () => {
    const words = {
      "zh-Hant-TW": { "phone.sw.alcaHasAQuestion": "Alca 有個問題" },
      en: { "phone.sw.alcaHasAQuestion": "Alca has a question" },
    };
    const push = { data: { json: () => ({ v: 1, t: "question", id: "q_1" }) } };
    const sw = loadSw(async () => new Response(""), [], { words, language: "zh-TW" });
    await sw.fire("push", push);
    expect(sw.shown.at(-1)?.title).toBe("Alca 有個問題");
    await sw.fire("message", { data: { type: "alca-locale", locale: "en" }, ports: [] });
    await sw.fire("push", push);
    expect(sw.shown.at(-1)?.title).toBe("Alca has a question");
    // Junk is ignored; the stored choice stands.
    await sw.fire("message", { data: { type: "alca-locale", locale: "<script>" }, ports: [] });
    await sw.fire("push", push);
    expect(sw.shown.at(-1)?.title).toBe("Alca has a question");
    // A fresh worker (no stored choice) with an English system.
    const en = loadSw(async () => new Response(""), [], { words, language: "en-US" });
    await en.fire("push", push);
    expect(en.shown.at(-1)?.title).toBe("Alca has a question");
  });

  it("keeps the pending-tap names in step with app/reach.ts", () => {
    expect(SRC).toContain(`const PENDING_CACHE = "${PENDING_CACHE}"`);
    expect(SRC).toContain(`const PENDING_KEY = "${PENDING_KEY}"`);
  });
});
