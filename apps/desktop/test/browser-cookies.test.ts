// P13 opt-in Chrome cookie import over the desktop API: fixture Chrome home,
// fake Keychain, fake browser (no Chromium needed).
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserHost, type SafeStorageKeySource } from "@alca/browser";
import type { AlcaCore } from "@alca/core";
import { openStore, type Store } from "@alca/store";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeChromeCookieDb } from "../../../packages/browser/testing/chrome-cookies-fixture.ts";
import { fakeBrowser } from "../../../packages/browser/testing/fake-cdp.ts";
import { type BrowserSetup, browserRoute } from "../src/browser.ts";
import { HttpError } from "../src/http.ts";

const BOT = "bot_00000000000000000000000001";
const PW = "fixture-pw";

describe("desktop × Chrome cookie import (fixture DB, fake Keychain)", () => {
  let dir: string;
  let store: Store;
  let server: Server;
  let base = "";
  let host: BrowserHost;
  let asked = 0;
  let platform = "darwin";
  const setCookies: unknown[] = [];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "alca-cookie-desk-"));
    store = openStore(join(dir, "db.sqlite"));
    const home = join(dir, "home");
    const prof = join(home, "Library", "Application Support", "Google", "Chrome", "Default", "Network");
    mkdirSync(prof, { recursive: true });
    writeChromeCookieDb(join(prof, "Cookies"), PW, [
      { host: ".github.com", name: "logged_in", value: "yes", secure: true },
      { host: "mail.example.com", name: "sid", value: "keep-out" },
    ]);
    const shared = fakeBrowser({});
    const own = fakeBrowser({});
    const realSend = own.cdp.send.bind(own.cdp);
    own.cdp.send = async (method: string, params?: Record<string, unknown>, sessionId?: string) => {
      if (method === "Storage.setCookies") setCookies.push(params?.cookies);
      return realSend(method, params, sessionId);
    };
    host = new BrowserHost({ launchShared: async () => shared.proc, launchIsolated: async () => own.proc });
    const keys: SafeStorageKeySource = {
      chromeSafeStoragePassword: async () => {
        asked++;
        return PW;
      },
    };
    const setup = {
      host,
      dir,
      cookies: {
        keys,
        home,
        get platform() {
          return platform;
        },
      },
      available: () => true,
      autoInstall: () => false,
      installer: { state: () => ({ phase: "ready" }) },
    } as unknown as BrowserSetup;
    const core = { store, defaultBotId: BOT } as unknown as AlcaCore;
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      browserRoute(req, res, url.pathname.split("/").filter(Boolean), url, setup, core)
        .then((hit) => {
          if (!hit) res.writeHead(404).end();
        })
        .catch((err) => {
          res
            .writeHead(err instanceof HttpError ? err.status : 500)
            .end(JSON.stringify({ error: String(err.message) }));
        });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.close();
    await host.shutdown();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(base + path, {
      method,
      ...(body ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}),
    });
    // biome-ignore lint/suspicious/noExplicitAny: test JSON
    return { status: r.status, body: (await r.json().catch(() => null)) as any };
  };

  it("lists Chrome's sites without asking the Keychain", async () => {
    const st = await call("GET", "/api/browser/status");
    expect(st.body.cookieImport).toBe(true);
    const r = await call("GET", "/api/browser/chrome-import");
    expect(r.status).toBe(200);
    expect(r.body.profiles).toEqual([
      {
        name: "Default",
        domains: [
          { domain: "github.com", cookies: 1 },
          { domain: "mail.example.com", cookies: 1 },
        ],
      },
    ]);
    expect(asked).toBe(0);
  });

  it("refuses the shared profile before any Keychain prompt; imports only the picked site into a persistent Space, audited", async () => {
    const shared = await host.open({ botId: BOT, title: "共用" });
    const no = await call("POST", `/api/browser/spaces/${shared.spaceId}/import-cookies`, {
      domains: ["github.com"],
    });
    expect(no.status).toBe(409);
    expect(asked).toBe(0);

    const keep = await host.open({ botId: BOT, title: "工作", profile: "isolated", persistent: true });
    const ok = await call("POST", `/api/browser/spaces/${keep.spaceId}/import-cookies`, {
      profile: "Default",
      domains: ["github.com"],
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ imported: 1, skipped: 0, expired: 0 });
    expect(asked).toBe(1);
    expect(setCookies).toHaveLength(1);
    expect(JSON.stringify(setCookies)).toContain("logged_in");
    expect(JSON.stringify(setCookies)).not.toContain("keep-out");
    const audit = store.db
      .prepare("SELECT action, target, detail FROM audit_log WHERE action = 'browser.cookie_import'")
      .all() as Array<{ action: string; target: string; detail: string }>;
    expect(audit).toHaveLength(1);
    expect(audit[0]?.target).toBe(keep.spaceId);
    expect(audit[0]?.detail).toContain("github.com");
    expect(audit[0]?.detail).not.toContain("yes");

    expect(
      (await call("POST", `/api/browser/spaces/${keep.spaceId}/import-cookies`, { domains: [] })).status,
    ).toBe(400);
    expect(
      (
        await call("POST", `/api/browser/spaces/${keep.spaceId}/import-cookies`, {
          profile: "Nope",
          domains: ["a.com"],
        })
      ).status,
    ).toBe(404);
  });

  it("is not offered off macOS", async () => {
    platform = "win32";
    expect((await call("GET", "/api/browser/status")).body.cookieImport).toBe(false);
    expect((await call("GET", "/api/browser/chrome-import")).status).toBe(501);
    platform = "darwin";
  });
});
