import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { domainRules, RULES, scan, skipped } from "../../../scripts/check-deploy-values.ts";

// The fixtures are built from parts so this file itself stays clean (it is scanned like any other).
const j = (...p: string[]) => p.join("");
const dom = ["alca", "corp.me"].join("-");
const rev = ["me", "alca-corp"].join(".");
const ROOT = join(import.meta.dirname, "../../..");

/** The 13 values of review 2026-11-04b H3 (only one of them was caught then) + a client ID. */
const SAMPLES: Array<[string, string]> = [
  [j(`"identifier": "`, rev, `.desktop"`), "bundle id from the project domain"],
  [j("GOCSPX-", "AbCdEf1234567890_ghIJkl"), "Google OAuth client secret"],
  [j("123456789", ":AA", "Fq3bLdw7x9Kp2Zr5Tn8Vm4Yc1Hs6Jg0Qe"), "Telegram bot token"],
  [j(`{"account`, `_id": "`, "0123456789abcdef0123456789abcdef", `"}`), "Cloudflare account id"],
  [j("prj", "_", "Ab12Cd34Ef56Gh78Ij90Kl12Mn34"), "Vercel project / team id"],
  [j("team", "_", "Zy98Xw76Vu54Ts32Rq10Po98"), "Vercel project / team id"],
  [j("-----BEGIN ", "PRIVATE KEY-----"), "private key"],
  [j("xox", "b-", "123456789012-1234567890123-AbCdEfGhIjKlMnOp"), "Slack token"],
  [j("AKIA", "Z7Q2P4R6T8V0X1Y3"), "AWS access key id"],
  [j("sk-", "or-v1-", "0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b"), "OpenAI / Anthropic / OpenRouter key"],
  [j("ak", "_", "Qw3rTy7uIo9pAs1dFg5hJk2l"), "Composio key"],
  [j("https://alca-relay.my-team.", "workers", ".dev"), "workers.dev host"],
  [j("https://alca-test.", "vercel", ".app"), "vercel.app host"],
  [
    j("123456789012-", "abcdefghijklmnopqrstuvwxyz012345", ".apps.googleusercontent.com"),
    "Google OAuth client ID",
  ],
];

describe("deploy-values check", () => {
  it.each(SAMPLES)("flags %s", (value, rule) => {
    const hits = scan("x.ts", `const v = ${JSON.stringify(value)};`);
    expect(hits.map((h) => h.split(": ")[1])).toContain(rule);
  });

  it("also flags OpenAI / Anthropic keys, GitHub tokens, Google API keys and our own domain", () => {
    const hits = scan(
      "x.md",
      [
        j("see https://relay.", dom, " for details"),
        j("sk-", "proj-", "Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56"),
        j("sk-", "ant-api03-", "Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1Qq0"),
        j("gh", "p_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"),
        j("AI", "za", "Sy0123456789abcdefghijABCDEFGHIJ_-x"),
      ].join("\n"),
    );
    expect(hits.map((h) => h.split(": ")[1])).toEqual([
      "project domain",
      "OpenAI / Anthropic / OpenRouter key",
      "OpenAI / Anthropic / OpenRouter key",
      "GitHub token",
      "Google API key",
    ]);
  });

  it("lets only the documented placeholders through", () => {
    expect(
      scan(
        "y.md",
        [
          "const a = 'https://relay.example.com';",
          j("https://alca-relay.example.", "workers", ".dev"),
          j("https://<you>.", "workers", ".dev and https://<project>.", "vercel", ".app"),
          j("test-web", ".apps.googleusercontent.com"),
          "…apps.googleusercontent.com",
          j("sk-", "test-0000000000000000"),
          j("sk-", "x".repeat(40)),
        ].join("\n"),
      ),
    ).toEqual([]);
    // `my-`, `test` or `you` inside a real-looking host no longer passes.
    for (const host of ["alca.my-relay", "test-alca", "you-relay"])
      expect(scan("z.ts", j(host, ".workers", ".dev"))).toHaveLength(1);
  });

  it("Markdown and docs/ are scanned; a new domain can be added", () => {
    expect(skipped("docs/DEPLOY.md")).toBe(false);
    expect(skipped("README.md")).toBe(false);
    expect(skipped("docs/screenshots/a.png")).toBe(true);
    const rules = domainRules(["example.org"]);
    expect(
      scan("a.json", '"identifier": "org.example.desktop", "url": "https://example.org"', rules),
    ).toHaveLength(2);
    expect(RULES.length).toBeGreaterThan(rules.length);
  });

  it("the desktop shell and the service carry a neutral id", () => {
    const conf = JSON.parse(readFileSync(join(ROOT, "apps/desktop-shell/src-tauri/tauri.conf.json"), "utf8"));
    expect(conf.identifier).toBe("local.alca.desktop");
    expect(readFileSync(join(ROOT, "apps/desktop/src/service.ts"), "utf8")).toContain('"local.alca.core"');
  });
});
