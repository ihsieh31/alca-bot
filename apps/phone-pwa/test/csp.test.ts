// Review L5: a build that knows its relay narrows connect-src to it (a <meta>
// CSP next to vercel.json's header, which allows any wss: host).
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPwa } from "../scripts/build.ts";
import { connectSrc, withConnectCsp } from "../scripts/csp.ts";

describe("connect-src from the configured relay", () => {
  it("is this site, the relay (https + wss), Tailscale serve and Google Identity Services", () => {
    expect(connectSrc({ ALCA_RELAY_URL: "https://relay.example.com" })).toBe(
      "'self' https://relay.example.com wss://relay.example.com wss://*.ts.net https://accounts.google.com/gsi/",
    );
    expect(connectSrc({ ALCA_OFFICIAL_RELAY_URL: "wss://relay.example.com:8443/v0/link" })).toContain(
      "wss://relay.example.com:8443",
    );
    expect(
      connectSrc({
        ALCA_RELAY_URL: "https://relay.example.com",
        ALCA_CSP_CONNECT_EXTRA: "wss://mac.example.net",
      }),
    ).toContain("wss://mac.example.net");
    expect(() =>
      connectSrc({ ALCA_RELAY_URL: "https://relay.example.com", ALCA_CSP_CONNECT_EXTRA: "wss:" }),
    ).toThrow(/origin/);
  });

  it("nothing is narrowed without a relay, or with ALCA_CSP_CONNECT=open", () => {
    expect(connectSrc({})).toBeUndefined();
    expect(
      connectSrc({ ALCA_RELAY_URL: "https://relay.example.com", ALCA_CSP_CONNECT: "open" }),
    ).toBeUndefined();
    expect(withConnectCsp('<head><meta charset="utf-8" /></head>', {})).toBe(
      '<head><meta charset="utf-8" /></head>',
    );
  });

  it("the built index.html carries the meta CSP before any script or style", () => {
    const out = buildPwa(mkdtempSync(join(tmpdir(), "alca-csp-")), {
      ALCA_RELAY_URL: "wss://relay.example.com",
    });
    try {
      const html = readFileSync(join(out, "index.html"), "utf8");
      const meta = html.indexOf('http-equiv="Content-Security-Policy"');
      expect(meta).toBeGreaterThan(0);
      expect(html).toContain("connect-src 'self' https://relay.example.com wss://relay.example.com");
      expect(meta).toBeLessThan(html.indexOf('<link rel="stylesheet"'));
      expect(meta).toBeLessThan(html.indexOf("<script"));
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
