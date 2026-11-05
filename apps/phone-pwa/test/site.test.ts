// P10: the phone site as a static deploy (Vercel): config.json from the build
// environment, vercel.json headers that keep the relay's CSP and allow only
// Google Identity Services, and the ID-token helpers the sign-in uses.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PWA_CSP } from "@alca/rendezvous";
import { describe, expect, it } from "vitest";
import { tokenFresh, userFromToken } from "../app/idtoken.ts";
import { buildPwa, siteConfigFromEnv } from "../scripts/build.ts";

const HERE = join(import.meta.dirname, "..");

describe("static site build (Vercel)", () => {
  it("writes config.json from ALCA_RELAY_URL / ALCA_GOOGLE_CLIENT_ID and precaches it", () => {
    const out = buildPwa(mkdtempSync(join(tmpdir(), "alca-site-")), {
      ALCA_RELAY_URL: "wss://relay.example.com",
      ALCA_GOOGLE_CLIENT_ID: "test-web.apps.googleusercontent.com",
    });
    try {
      expect(JSON.parse(readFileSync(join(out, "config.json"), "utf8"))).toEqual({
        relayUrl: "wss://relay.example.com",
        googleClientId: "test-web.apps.googleusercontent.com",
      });
      expect(readFileSync(join(out, "sw.js"), "utf8")).toContain('"./config.json"');
      expect(readFileSync(join(out, "index.html"), "utf8")).toContain("./styles/account.css");
      expect(readFileSync(join(out, "app", "account.js"), "utf8")).toContain("enrollDevice");
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
    expect(siteConfigFromEnv({})).toEqual({});
    expect(() => siteConfigFromEnv({ ALCA_RELAY_URL: "http://relay.example" })).toThrow(/https/);
    expect(() => siteConfigFromEnv({ ALCA_GOOGLE_CLIENT_ID: "GOCSPX-secret" })).toThrow(/googleusercontent/);
    expect(siteConfigFromEnv({ ALCA_RELAY_URL: "http://127.0.0.1:8787" })).toEqual({
      relayUrl: "http://127.0.0.1:8787",
    });
  });

  it("vercel.json: same CSP as the relay (wss only), GIS allowed, pop-ups can report back, assets not rewritten", () => {
    const v = JSON.parse(readFileSync(join(HERE, "vercel.json"), "utf8")) as {
      outputDirectory: string;
      headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
      rewrites: Array<{ source: string; destination: string }>;
    };
    expect(v.outputDirectory).toBe("dist");
    const all = v.headers.find((x) => x.source === "/(.*)")?.headers ?? [];
    const csp = all.find((x) => x.key === "Content-Security-Policy")?.value ?? "";
    expect(csp).toBe(PWA_CSP.replace("connect-src 'self' ws: wss:", "connect-src 'self' wss:"));
    expect(csp).toContain("script-src 'self' https://accounts.google.com/gsi/client");
    expect(csp).not.toContain("unsafe-inline");
    expect(all.find((x) => x.key === "Cross-Origin-Opener-Policy")?.value).toBe("same-origin-allow-popups");
    const sw = v.headers.find((x) => x.source === "/sw.js")?.headers ?? [];
    expect(sw.find((x) => x.key === "Service-Worker-Allowed")?.value).toBe("/");
    const re = new RegExp(`^${(v.rewrites[0]?.source ?? "").replace("/(", "/(")}$`);
    expect(re.test("/")).toBe(true);
    expect(re.test("/some/route")).toBe(true);
    for (const asset of [
      "/app/main.js",
      "/sw.js",
      "/config.json",
      "/styles/base.css",
      "/manifest.webmanifest",
    ])
      expect(re.test(asset), asset).toBe(false);
  });
});

describe("Google ID token helpers (display only; the relay verifies)", () => {
  const tok = (claims: Record<string, unknown>) =>
    `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
  it("reads email / name, including non-ASCII names", () => {
    const u = userFromToken(tok({ email: "xiaoming@example.com", name: "王小明", exp: 2_000_000_000 }));
    expect(u).toMatchObject({ email: "xiaoming@example.com", name: "王小明" });
    expect(tokenFresh(u)).toBe(true);
    expect(tokenFresh(userFromToken(tok({ exp: 1000 })))).toBe(false);
    expect(userFromToken("not a token")).toBeUndefined();
  });
});
