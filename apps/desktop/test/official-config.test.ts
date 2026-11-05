// P12: the official service's public endpoints are injected at build time
// into a gitignored file (never in the source) and fill the empty defaults,
// so an installed Alca needs no relay URL, client ID or secret.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { writeOfficialConfig } from "../../../scripts/gen-official-config.ts";
import {
  completeFromSite,
  loadOfficialConfig,
  normalizeOfficial,
  OFFICIAL_CONFIG_PATH,
} from "../src/official.ts";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "alca-official-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const ENV = {
  ALCA_OFFICIAL_RELAY_URL: "https://relay.example.com/",
  ALCA_OFFICIAL_SITE_URL: "https://alca.example.com",
  ALCA_OFFICIAL_GOOGLE_CLIENT_ID: "test-web.apps.googleusercontent.com",
};

describe("official config (P12)", () => {
  it("is generated from the build variables into a gitignored file, never tracked", () => {
    const out = join(tmp, "official-config.json");
    expect(writeOfficialConfig(out, ENV)).toEqual({
      relayUrl: "https://relay.example.com",
      siteUrl: "https://alca.example.com",
      googleClientId: "test-web.apps.googleusercontent.com",
    });
    expect(loadOfficialConfig(out, {})).toEqual({
      relayUrl: "https://relay.example.com",
      siteUrl: "https://alca.example.com",
      googleClientId: "test-web.apps.googleusercontent.com",
    });
    // The real path is ignored by git and not in the source tree.
    expect(
      execFileSync("git", ["check-ignore", OFFICIAL_CONFIG_PATH], { cwd: ROOT, encoding: "utf8" }).trim(),
    ).toBe(OFFICIAL_CONFIG_PATH);
    const tracked = execFileSync("git", ["ls-files", "apps/desktop"], { cwd: ROOT, encoding: "utf8" });
    expect(tracked).not.toContain("official-config.json");
  });

  it("no variables → no file and empty defaults; a malformed value fails the build", () => {
    const out = join(tmp, "none.json");
    expect(writeOfficialConfig(out, {})).toBeUndefined();
    expect(existsSync(out)).toBe(false);
    expect(loadOfficialConfig(out, {})).toEqual({});
    expect(() => writeOfficialConfig(out, { ALCA_OFFICIAL_SITE_URL: "http://alca.example.com" })).toThrow(
      /malformed/,
    );
    expect(() => writeOfficialConfig(out, { ALCA_OFFICIAL_GOOGLE_CLIENT_ID: "GOCSPX-secret" })).toThrow(
      /malformed/,
    );
  });

  it("the environment overrides the file at run time; bad values are dropped", () => {
    const out = join(tmp, "file.json");
    writeFileSync(out, JSON.stringify({ relayUrl: "https://a.example.com", siteUrl: "javascript:alert(1)" }));
    expect(loadOfficialConfig(out, { ALCA_OFFICIAL_RELAY_URL: "https://b.example.com" })).toEqual({
      relayUrl: "https://b.example.com",
    });
    expect(normalizeOfficial({ relayUrl: "https://u:p@relay.example.com" })).toEqual({});
    expect(normalizeOfficial({ siteUrl: "http://127.0.0.1:5173" })).toEqual({
      siteUrl: "http://127.0.0.1:5173",
    });
  });

  it("with only the site known, its public config.json fills in the relay and the client ID", async () => {
    const seen: string[] = [];
    const fake = (async (u: string) => {
      seen.push(String(u));
      return new Response(
        JSON.stringify({
          relayUrl: "wss://relay.example.com",
          googleClientId: "test-web.apps.googleusercontent.com",
        }),
      );
    }) as unknown as typeof fetch;
    expect(await completeFromSite({ siteUrl: "https://alca.example.com" }, { fetch: fake })).toEqual({
      siteUrl: "https://alca.example.com",
      relayUrl: "https://relay.example.com",
      googleClientId: "test-web.apps.googleusercontent.com",
    });
    expect(seen).toEqual(["https://alca.example.com/config.json"]);
    // Given values win; nothing to fetch when everything is there; a dead site changes nothing.
    const full = {
      siteUrl: "https://a.example.com",
      relayUrl: "https://r.example.com",
      googleClientId: "x-test.apps.googleusercontent.com",
    };
    expect(await completeFromSite(full, { fetch: fake })).toEqual(full);
    const dead = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await completeFromSite({ siteUrl: "https://a.example.com" }, { fetch: dead })).toEqual({
      siteUrl: "https://a.example.com",
    });
  });
});
