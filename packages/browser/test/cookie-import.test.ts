// Opt-in Chrome cookie import: a fixture Cookies DB in Chrome's macOS layout,
// a fake Keychain, and (when a Chromium is installed) a real persistent Space.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BrowserAgent,
  BrowserHost,
  type ChromiumProcess,
  ControlError,
  CookieImportError,
  chromeProfiles,
  chromeTimeToUnix,
  decryptChromeValue,
  deriveChromeKey,
  findChromium,
  hostInDomain,
  launchChromium,
  listChromeCookieDomains,
  readChromeCookies,
  type SafeStorageKeySource,
} from "../src/index.ts";
import { encryptChromeValue, writeChromeCookieDb } from "../testing/chrome-cookies-fixture.ts";
import { fakeBrowser } from "../testing/fake-cdp.ts";

const PASSWORD = "fake-safe-storage-pw";
const BOT = "bot_00000000000000000000000001";
const NOW = new Date("2026-11-04T00:00:00Z");
const FUTURE = Math.floor(NOW.getTime() / 1000) + 86_400 * 30;

function fakeKeychain(pw = PASSWORD) {
  const k = { asked: 0, source: {} as SafeStorageKeySource };
  k.source = {
    chromeSafeStoragePassword: async () => {
      k.asked++;
      return pw;
    },
  };
  return k;
}

function fixture(metaVersion = 24) {
  const dir = mkdtempSync(join(tmpdir(), "alca-cookie-fx-"));
  const db = join(dir, "Cookies");
  writeChromeCookieDb(
    db,
    PASSWORD,
    [
      {
        host: ".github.com",
        name: "logged_in",
        value: "yes",
        expires: FUTURE,
        secure: true,
        httpOnly: true,
        samesite: 1,
      },
      {
        host: "github.com",
        name: "user_session",
        value: "s3cret",
        expires: FUTURE,
        secure: true,
        samesite: 2,
      },
      { host: "gist.github.com", name: "g", value: "1" },
      { host: ".example.com", name: "old", value: "x", expires: 1_000_000 },
      { host: ".example.com", name: "plain", value: "p", plain: true, samesite: 0 },
      { host: "bank.example.org", name: "acct", value: "never" },
      { host: ".notgithub.com", name: "evil", value: "nope" },
    ],
    metaVersion,
  );
  return { dir, db };
}

describe("Chrome cookie crypto", () => {
  it("derives the Safe Storage key and decrypts v10 values, with and without the host hash", () => {
    const key = deriveChromeKey(PASSWORD);
    expect(key.length).toBe(16);
    expect(decryptChromeValue(encryptChromeValue("hello", PASSWORD, "a.com", 24), key, 24)).toBe("hello");
    expect(decryptChromeValue(encryptChromeValue("hello", PASSWORD, "a.com", 23), key, 23)).toBe("hello");
    expect(decryptChromeValue(encryptChromeValue("hello", "other", "a.com", 23), key, 23)).not.toBe("hello");
    expect(decryptChromeValue(Buffer.from("v11xxxxxxxxxxxxxxxxxxxxxx"), key, 24)).toBeUndefined();
    expect(chromeTimeToUnix(13_000_000_000_000_000n)).toBe(13_000_000_000 - 11_644_473_600);
    expect(hostInDomain(".github.com", "github.com")).toBe(true);
    expect(hostInDomain("gist.github.com", "github.com")).toBe(true);
    expect(hostInDomain(".notgithub.com", "github.com")).toBe(false);
  });
});

describe("reading a Chrome Cookies DB", () => {
  it("lists sites without touching the Keychain", () => {
    const { dir, db } = fixture();
    expect(listChromeCookieDomains(db)).toEqual([
      { domain: "bank.example.org", cookies: 1 },
      { domain: "example.com", cookies: 2 },
      { domain: "gist.github.com", cookies: 1 },
      { domain: "github.com", cookies: 2 },
      { domain: "notgithub.com", cookies: 1 },
    ]);
    rmSync(dir, { recursive: true });
  });

  it("decrypts only the picked domains, drops expired ones, maps flags", async () => {
    for (const v of [23, 24]) {
      const { dir, db } = fixture(v);
      const k = fakeKeychain();
      const r = await readChromeCookies({
        dbPath: db,
        domains: ["github.com", "example.com"],
        keys: k.source,
        now: () => NOW,
      });
      expect(k.asked).toBe(1);
      expect(r.expired).toBe(1);
      expect(r.skipped).toBe(0);
      const byName = Object.fromEntries(r.cookies.map((c) => [c.name, c]));
      expect(Object.keys(byName).sort()).toEqual(["g", "logged_in", "plain", "user_session"]);
      expect(byName.user_session).toMatchObject({
        value: "s3cret",
        domain: "github.com",
        secure: true,
        sameSite: "Strict",
      });
      expect(byName.logged_in).toMatchObject({ httpOnly: true, sameSite: "Lax", expires: FUTURE });
      expect(byName.g?.expires).toBeUndefined();
      // SameSite=None without Secure is left unspecified.
      expect(byName.plain?.sameSite).toBeUndefined();
      expect(JSON.stringify(r)).not.toContain("never");
      expect(JSON.stringify(r)).not.toContain("nope");
      rmSync(dir, { recursive: true });
    }
  });

  it("does not ask for the password when nothing matches; a wrong password is an error, not an empty jar", async () => {
    const { dir, db } = fixture();
    const k = fakeKeychain();
    expect(
      (await readChromeCookies({ dbPath: db, domains: ["nothing.dev"], keys: k.source })).cookies,
    ).toEqual([]);
    expect(k.asked).toBe(0);
    await expect(readChromeCookies({ dbPath: db, domains: [], keys: k.source })).rejects.toBeInstanceOf(
      CookieImportError,
    );
    await expect(
      readChromeCookies({ dbPath: db, domains: ["bank.example.org"], keys: fakeKeychain("wrong").source }),
    ).rejects.toThrow(/無法解密/);
    const denied: SafeStorageKeySource = {
      chromeSafeStoragePassword: () => Promise.reject(new CookieImportError("拒絕")),
    };
    await expect(readChromeCookies({ dbPath: db, domains: ["github.com"], keys: denied })).rejects.toThrow(
      /拒絕/,
    );
    await expect(
      readChromeCookies({ dbPath: join(dir, "missing"), domains: ["a.com"], keys: k.source }),
    ).rejects.toThrow(/找不到/);
    rmSync(dir, { recursive: true });
  });

  it("finds macOS profiles (Network/Cookies first)", () => {
    const home = mkdtempSync(join(tmpdir(), "alca-home-"));
    const root = join(home, "Library", "Application Support", "Google", "Chrome");
    mkdirSync(join(root, "Default", "Network"), { recursive: true });
    mkdirSync(join(root, "Profile 2"), { recursive: true });
    writeChromeCookieDb(join(root, "Default", "Network", "Cookies"), PASSWORD, []);
    writeChromeCookieDb(join(root, "Profile 2", "Cookies"), PASSWORD, []);
    expect(chromeProfiles(home).map((p) => p.name)).toEqual(["Default", "Profile 2"]);
    rmSync(home, { recursive: true });
  });
});

describe("host.importCookies", () => {
  it("refuses the shared profile and a throwaway isolated context", async () => {
    const { proc } = fakeBrowser({});
    const host = new BrowserHost({ launchShared: async () => proc });
    const shared = await host.open({ botId: BOT, title: "共用" });
    const cookie = { name: "a", value: "b", domain: "x.com", path: "/", secure: false, httpOnly: false };
    await expect(host.importCookies(shared.spaceId, [cookie])).rejects.toBeInstanceOf(ControlError);
    const iso = await host.open({ botId: BOT, title: "隔離", profile: "isolated" });
    await expect(host.importCookies(iso.spaceId, [cookie])).rejects.toBeInstanceOf(ControlError);
    await host.shutdown();
  });
});

const bin = process.env.ALCA_TEST_CHROMIUM || findChromium();

describe.skipIf(!bin)("cookie import × real Chromium (persistent Space)", () => {
  let server: Server;
  let base = "";
  let dir: string;
  const procs: ChromiumProcess[] = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><title>who</title><p id="c">cookie=${String(req.headers.cookie ?? "")}</p>`);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
    dir = mkdtempSync(join(tmpdir(), "alca-cookie-real-"));
  });
  afterAll(async () => {
    for (const p of procs) await p.close().catch(() => undefined);
    server.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it("the imported login is sent by the persistent Space, and not by the shared profile", async () => {
    const db = join(dir, "Cookies");
    writeChromeCookieDb(db, PASSWORD, [
      { host: "localhost", name: "sid", value: "imported-1", expires: FUTURE },
      { host: "other.test", name: "x", value: "no" },
    ]);
    const launch = (d: string) => async () => {
      const p = await launchChromium({
        executablePath: bin as string,
        userDataDir: join(dir, d),
        headless: true,
      });
      procs.push(p);
      return p;
    };
    const host = new BrowserHost({ launchShared: launch("shared"), launchIsolated: (id) => launch(id)() });
    const agent = new BrowserAgent(host);
    const read = async (spaceId: string) =>
      (
        await agent.step(
          spaceId,
          BOT,
          { do: "read" },
          { signal: AbortSignal.timeout(20_000), granted: "read" },
        )
      ).output;
    const keep = await host.open({ botId: BOT, title: "匯入", profile: "isolated", persistent: true });
    const { cookies } = await readChromeCookies({
      dbPath: db,
      domains: ["localhost"],
      keys: fakeKeychain().source,
    });
    expect(await host.importCookies(keep.spaceId, cookies)).toBe(1);
    await agent.step(
      keep.spaceId,
      BOT,
      { do: "navigate", url: `${base}/` },
      { signal: AbortSignal.timeout(20_000), granted: "network" },
    );
    expect(await read(keep.spaceId)).toContain("cookie=sid=imported-1");
    const shared = await host.open({ botId: BOT, title: "共用", url: `${base}/` });
    expect(await read(shared.spaceId)).not.toContain("imported-1");
    await host.shutdown();
  }, 60_000);
});
