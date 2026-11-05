import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tSource } from "@alca/design/i18n";
import { writeFileAtomic } from "@alca/os";
import { log } from "./log.ts";

/**
 * How phones reach this core, as set in 連線 (P9), kept in
 * `<data-dir>/link.json` (0600). Nothing here is secret: the relay only ever
 * sees ciphertext and the mailbox is derived from the core's public key.
 *
 * - `relayUrl`: the person's own stable relay (self-hosted or on their own
 *   domain). When set it wins over `--rendezvous` / `advanced.rendezvousUrl`,
 *   which then stays on the list phones know as a fallback.
 * - `directUrls`: direct addresses of this computer's LAN listener, e.g. a
 *   Tailscale `serve` URL (`wss://mac.tailnet.ts.net/v0/link`). Phones on https
 *   use only wss://.
 */
export interface LinkPrefs {
  relayUrl?: string;
  directUrls: string[];
  /**
   * P12, self-host: your own phone site (phones open it; the computer signs in
   * with Google through it) and its Google Web client ID. Unset = the
   * official ones this build carries (official.ts).
   */
  siteUrl?: string;
  googleClientId?: string;
  /**
   * 用 Google 帳號啟用遠端 (P10): this computer is listed under a Google
   * account on `relayUrl`. Display only: the email shown in 手機與裝置.
   */
  google?: { email?: string; relayUrl: string; registeredAt: string };
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** https / wss anywhere; plain http / ws only to this computer (local try-outs). */
export function checkRelayUrl(v: string): string {
  let u: URL;
  try {
    u = new URL(v.trim());
  } catch {
    throw new Error(tSource("core.link.badUrl"));
  }
  const secure = u.protocol === "https:" || u.protocol === "wss:";
  const local = (u.protocol === "http:" || u.protocol === "ws:") && LOOPBACK.has(u.hostname);
  if (!secure && !local) throw new Error(tSource("core.link.relayHttps"));
  if (u.username || u.password) throw new Error(tSource("core.link.noCredentials"));
  u.hash = "";
  u.search = "";
  return u.toString().replace(/\/$/, "");
}

/** The phone site: https (http only on this computer, for local try-outs), no path tricks. */
export function checkSiteUrl(v: string): string {
  const s = checkRelayUrl(v);
  if (/^wss?:/.test(s)) throw new Error(tSource("core.link.siteHttps"));
  return s;
}

export function checkDirectUrl(v: string): string {
  let u: URL;
  try {
    u = new URL(v.trim());
  } catch {
    throw new Error(tSource("core.link.badUrl"));
  }
  if (u.protocol !== "wss:" && u.protocol !== "ws:") throw new Error(tSource("core.link.directWss"));
  if (u.username || u.password) throw new Error(tSource("core.link.noCredentials"));
  if (u.pathname === "/" || u.pathname === "") u.pathname = "/v0/link";
  u.hash = "";
  return u.toString();
}

export function normalizePrefs(v: unknown): LinkPrefs {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const relay = typeof o.relayUrl === "string" && o.relayUrl.trim() ? checkRelayUrl(o.relayUrl) : undefined;
  const direct = Array.isArray(o.directUrls)
    ? o.directUrls.filter((x): x is string => typeof x === "string" && x.trim() !== "").map(checkDirectUrl)
    : [];
  if (direct.length > 4) throw new Error(tSource("core.link.directMax"));
  const site = typeof o.siteUrl === "string" && o.siteUrl.trim() ? checkSiteUrl(o.siteUrl) : undefined;
  const gid = typeof o.googleClientId === "string" ? o.googleClientId.trim() : "";
  if (gid && !/^[\w.-]+\.apps\.googleusercontent\.com$/.test(gid))
    throw new Error(tSource("core.link.googleClientId"));
  const g = o.google && typeof o.google === "object" ? (o.google as Record<string, unknown>) : undefined;
  const google =
    g && typeof g.relayUrl === "string" && typeof g.registeredAt === "string"
      ? {
          relayUrl: g.relayUrl,
          registeredAt: g.registeredAt,
          ...(typeof g.email === "string" ? { email: g.email.slice(0, 200) } : {}),
        }
      : undefined;
  return {
    ...(relay ? { relayUrl: relay } : {}),
    directUrls: [...new Set(direct)],
    ...(site ? { siteUrl: site } : {}),
    ...(gid ? { googleClientId: gid } : {}),
    ...(google ? { google } : {}),
  };
}

export function loadLinkPrefs(dataDir: string): LinkPrefs {
  const p = join(dataDir, "link.json");
  if (!existsSync(p)) return { directUrls: [] };
  try {
    return normalizePrefs(JSON.parse(readFileSync(p, "utf8")));
  } catch {
    // A broken file must not take Link down: fall back to the defaults (and say so in the log).
    log.warn("link.json is unreadable; using the default rendezvous server");
    return { directUrls: [] };
  }
}

export function saveLinkPrefs(dataDir: string, prefs: LinkPrefs): void {
  const p = join(dataDir, "link.json");
  writeFileAtomic(p, `${JSON.stringify(prefs, null, 2)}\n`, { mode: 0o600 });
}
