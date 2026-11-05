// Site configuration, written at build time into `config.json` from the
// environment (ALCA_RELAY_URL, ALCA_GOOGLE_CLIENT_ID; see vercel.json and
// docs/DEPLOY.md). Nothing in it is secret: a Google Web client ID is public
// by design. A copy served by the relay itself (`--pwa`) may have neither:
// then the relay is this page's own origin and only pairing codes are offered.
export interface SiteConfig {
  /** The relay (https:// or wss://); default: this page's origin. */
  relayUrl: string;
  /** Google Web OAuth client ID for 用 Google 登入; unset = pairing codes only. */
  googleClientId?: string;
}

let cached: SiteConfig | undefined;

export async function siteConfig(): Promise<SiteConfig> {
  if (cached) return cached;
  let raw: Record<string, unknown> = {};
  try {
    const res = await fetch("./config.json", { cache: "no-cache" });
    if (res.ok) raw = (await res.json()) as Record<string, unknown>;
  } catch {
    // offline first start or no config: defaults
  }
  const relay = typeof raw.relayUrl === "string" && raw.relayUrl ? raw.relayUrl : location.origin;
  const gid = typeof raw.googleClientId === "string" && raw.googleClientId ? raw.googleClientId : undefined;
  cached = { relayUrl: relay, ...(gid ? { googleClientId: gid } : {}) };
  return cached;
}
