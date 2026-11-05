// Fails when a deployment-specific or sensitive value is committed: our own
// domain (also reversed, as a bundle id / service label), *.workers.dev /
// *.vercel.app / *.pages.dev hosts, Google OAuth client IDs and secrets, and
// key / token shapes (OpenAI, Anthropic, OpenRouter, Google, GitHub, Slack,
// AWS, Telegram, Vercel, Composio, Cloudflare account ids, PEM private keys).
// Official hosted endpoints come from config / env / build-time variables
// with empty or example.com defaults (docs/DEPLOY.md "Official service vs
// self-host").
//
// Every tracked text file is scanned, Markdown and docs/ included. The only
// values let through are the documented placeholders in NEUTRAL below
// (an `example` label, `<you>` / `…` forms that never match a rule, the two
// test client IDs, and keys whose secret part is one repeated character).
//
// More domains (a new project domain, a custom relay host):
//   ALCA_DEPLOY_DOMAINS="example.org,relay.example.net" node scripts/check-deploy-values.ts
// Usage: node scripts/check-deploy-values.ts [path ...]   (default: git ls-files)
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface Rule {
  name: string;
  re: RegExp;
  /** A match that is one of the documented placeholders. */
  neutral?: (m: string) => boolean;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The project's own domain(s). Built from parts so a grep for the domain finds only this line. */
export const PROJECT_DOMAINS = [["alca", "corp.me"].join("-")];

/** `alca-corp.me` → also `me.alca-corp` (a bundle id / LaunchAgent label made from the domain). */
export function domainRules(domains: string[]): Rule[] {
  const out: Rule[] = [];
  for (const d of domains.map((x) => x.trim().toLowerCase()).filter(Boolean)) {
    out.push({ name: "project domain", re: new RegExp(`(?<![a-z0-9-])${esc(d)}(?![a-z0-9-])`, "gi") });
    const rev = d.split(".").reverse().join(".");
    if (rev !== d)
      out.push({
        name: "bundle id from the project domain",
        re: new RegExp(`(?<![a-z0-9-])${esc(rev)}(?![a-z0-9-])`, "gi"),
      });
  }
  return out;
}

// ── The narrow allowlist ────────────────────────────────────────────────

/** A host is a placeholder only when one of its labels is exactly `example`. */
const exampleHost = (m: string) => m.toLowerCase().split(".").includes("example");

/** The test fixtures' client IDs (and `example.apps…`); nothing else that looks like one. */
const NEUTRAL_CLIENT_IDS = new Set([
  "test-web.apps.googleusercontent.com",
  "test-desktop.apps.googleusercontent.com",
  "x-test.apps.googleusercontent.com",
  "000-test.apps.googleusercontent.com",
  "example.apps.googleusercontent.com",
]);

/**
 * Key-shaped fixtures the tests need as they are (the redaction tests want a realistic shape);
 * AKIAIOSFODNN7EXAMPLE is AWS's own documented example key.
 */
const FIXTURE_KEYS = new Set([
  "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv",
  "sk-never-on-the-phone-123",
  "GOCSPX-not-really-secret",
  "AKIAIOSFODNN7EXAMPLE",
]);

/**
 * A key that says it is a fixture: its secret part is one character repeated (`sk-xxxx…`), it has
 * a whole `test` / `example` / `fake` segment (`sk-test-0001`, `sk-or-example-…`), or it is listed.
 */
const fixtureKey = (m: string) => {
  if (FIXTURE_KEYS.has(m)) return true;
  if (/(^|[-_])(test|example|fake)([-_]|$)/i.test(m)) return true;
  const tail = m.slice(-12).replace(/[-_]/g, "");
  return tail.length > 0 && new Set(tail.toLowerCase()).size === 1;
};

/** Rules a file may break on purpose (a PEM header in the redaction test). Exact paths only. */
export const FILE_ALLOW: Readonly<Record<string, readonly string[]>> = {
  "packages/memory/test/redact.test.ts": ["private key"],
};

export const NEUTRAL = { exampleHost, clientIds: NEUTRAL_CLIENT_IDS, fixtureKeys: FIXTURE_KEYS, fixtureKey };

// ── Rules ───────────────────────────────────────────────────────────────

const HOST = "[a-z0-9-]+(?:\\.[a-z0-9-]+)*";

export const BASE_RULES: Rule[] = [
  { name: "workers.dev host", re: new RegExp(`${HOST}\\.workers\\.dev`, "gi"), neutral: exampleHost },
  { name: "vercel.app host", re: new RegExp(`${HOST}\\.vercel\\.app`, "gi"), neutral: exampleHost },
  { name: "pages.dev host", re: new RegExp(`${HOST}\\.pages\\.dev`, "gi"), neutral: exampleHost },
  {
    name: "Google OAuth client ID",
    re: /[a-z0-9-]+\.apps\.googleusercontent\.com/gi,
    neutral: (m) => NEUTRAL_CLIENT_IDS.has(m.toLowerCase()),
  },
  { name: "Google OAuth client secret", re: /GOCSPX-[A-Za-z0-9_-]{10,}/g, neutral: fixtureKey },
  { name: "Google API key", re: /AIza[0-9A-Za-z_-]{35}/g, neutral: fixtureKey },
  {
    name: "OpenAI / Anthropic / OpenRouter key",
    re: /\bsk-(?:proj-|svcacct-|admin-|ant-(?:api|admin)\d*-|or-v1-|or-)?[A-Za-z0-9_-]{20,}/g,
    neutral: fixtureKey,
  },
  {
    name: "GitHub token",
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{40,})/g,
    neutral: fixtureKey,
  },
  { name: "Slack token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, neutral: fixtureKey },
  { name: "AWS access key id", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, neutral: fixtureKey },
  { name: "Telegram bot token", re: /\b\d{6,12}:[A-Za-z0-9_-]{35}\b/g, neutral: fixtureKey },
  { name: "Vercel project / team id", re: /\b(?:prj|team)_[A-Za-z0-9]{20,}\b/g, neutral: fixtureKey },
  { name: "Composio key", re: /\bak_[A-Za-z0-9_-]{20,}/g, neutral: fixtureKey },
  { name: "Stripe key", re: /\b[rs]k_live_[A-Za-z0-9]{16,}/g, neutral: fixtureKey },
  { name: "private key", re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g },
  {
    name: "Cloudflare account id",
    re: /account[_-]?id\\?["']?\s*[:=]\s*\\?["']?[0-9a-f]{32}\b/gi,
  },
];

const extra = (process.env.ALCA_DEPLOY_DOMAINS ?? "").split(",");
export const RULES: Rule[] = [...domainRules([...PROJECT_DOMAINS, ...extra]), ...BASE_RULES];

/** Files that are not text, and this script (it names the patterns). The test builds its fixtures from parts. */
const SKIP = [
  /^scripts\/check-deploy-values\.ts$/,
  /pnpm-lock\.yaml$/,
  /\.(png|jpe?g|gif|webp|ico|icns|woff2?|pdf|ttf|otf|zip|gz|tgz)$/,
];

export function scan(file: string, text: string, rules: Rule[] = RULES): string[] {
  const out: string[] = [];
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    for (const r of rules)
      for (const m of line.matchAll(r.re)) {
        if (r.neutral?.(m[0]) || FILE_ALLOW[file]?.includes(r.name)) continue;
        out.push(`${file}:${i + 1}: ${r.name}: ${m[0]}`);
      }
  });
  return out;
}

export const skipped = (f: string): boolean => SKIP.some((s) => s.test(f));

function main(): void {
  const args = process.argv.slice(2);
  const files = args.length
    ? args
    : execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);
  const hits: string[] = [];
  for (const f of files) {
    if (skipped(f)) continue;
    let text: string;
    try {
      text = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    hits.push(...scan(f, text));
  }
  if (hits.length) {
    console.error("Deployment-specific or sensitive values found (move them to config / env):");
    for (const h of hits) console.error(`  ${h}`);
    process.exit(1);
  }
  console.log(`deploy values: clean (${files.length} files)`);
}

/**
 * Run as a script (not imported)? Compares real paths, so a checkout whose path
 * has spaces (`import.meta.url` encodes them as %20) or symlinks still runs.
 */
function isMain(url: string): boolean {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return realpathSync(fileURLToPath(url)) === realpathSync(arg);
  } catch {
    return false;
  }
}

if (isMain(import.meta.url)) main();
