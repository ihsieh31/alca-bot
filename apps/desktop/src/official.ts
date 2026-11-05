// The official service's public endpoints (P12), so a person who installs
// Alca fills in nothing. They are NOT in the source: a release / install
// writes them into `apps/desktop/official-config.json` (gitignored) from the
// build's variables (GitHub Actions repo variables ALCA_OFFICIAL_RELAY_URL,
// ALCA_OFFICIAL_SITE_URL, ALCA_OFFICIAL_GOOGLE_CLIENT_ID; see
// scripts/gen-official-config.ts and docs/DEPLOY.md). The same names as
// environment variables override the file at run time. A self-hoster sets
// their own in 連線 (link.json) or config.json, which win over these.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface OfficialConfig {
  /** The relay (https://). */
  relayUrl?: string;
  /** The phone site (https://): phones open it, and the computer signs in with Google through it. */
  siteUrl?: string;
  /** The site's Google Web OAuth client ID (public by design). */
  googleClientId?: string;
}

export const OFFICIAL_CONFIG_PATH = fileURLToPath(new URL("../official-config.json", import.meta.url));

const LOOPBACK = /^(http|ws):\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/;

/** Keep only well-formed values: https (or loopback http for tests), a client-ID shape. */
export function normalizeOfficial(raw: Record<string, unknown>): OfficialConfig {
  const url = (v: unknown) => {
    if (typeof v !== "string" || !v.trim()) return undefined;
    const s = v.trim().replace(/\/$/, "");
    if (!/^(https|wss):\/\//.test(s) && !LOOPBACK.test(s)) return undefined;
    try {
      const u = new URL(s);
      return u.username || u.password ? undefined : s;
    } catch {
      return undefined;
    }
  };
  const relayUrl = url(raw.relayUrl);
  const siteUrl = url(raw.siteUrl);
  const gid =
    typeof raw.googleClientId === "string" &&
    /^[\w.-]+\.apps\.googleusercontent\.com$/.test(raw.googleClientId.trim())
      ? raw.googleClientId.trim()
      : undefined;
  return {
    ...(relayUrl ? { relayUrl } : {}),
    ...(siteUrl ? { siteUrl } : {}),
    ...(gid ? { googleClientId: gid } : {}),
  };
}

/** The values a build variable / environment gives (ALCA_OFFICIAL_*). */
export function officialFromEnv(env: Record<string, string | undefined>): OfficialConfig {
  return normalizeOfficial({
    relayUrl: env.ALCA_OFFICIAL_RELAY_URL,
    siteUrl: env.ALCA_OFFICIAL_SITE_URL,
    googleClientId: env.ALCA_OFFICIAL_GOOGLE_CLIENT_ID,
  });
}

/** The generated file, then the environment on top; empty when neither is there (a plain checkout). */
export function loadOfficialConfig(
  path = OFFICIAL_CONFIG_PATH,
  env: Record<string, string | undefined> = process.env,
): OfficialConfig {
  let file: OfficialConfig = {};
  if (existsSync(path))
    try {
      file = normalizeOfficial(JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>);
    } catch {
      file = {};
    }
  return { ...file, ...officialFromEnv(env) };
}

/**
 * Only the site is known (e.g. `--site` at install): its public `config.json`
 * names the relay and the Web client ID. Best effort, bounded; a value given
 * explicitly always wins.
 */
export async function completeFromSite(
  c: OfficialConfig,
  o: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<OfficialConfig> {
  if (!c.siteUrl || (c.relayUrl && c.googleClientId)) return c;
  try {
    const res = await (o.fetch ?? fetch)(`${c.siteUrl}/config.json`, {
      signal: AbortSignal.timeout(o.timeoutMs ?? 3000),
    });
    if (!res.ok) return c;
    const site = normalizeOfficial((await res.json()) as Record<string, unknown>);
    return {
      ...(site.relayUrl ? { relayUrl: site.relayUrl.replace(/^wss:/, "https:") } : {}),
      ...(site.googleClientId ? { googleClientId: site.googleClientId } : {}),
      ...c,
    };
  } catch {
    return c;
  }
}
