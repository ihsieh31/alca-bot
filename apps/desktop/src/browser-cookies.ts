import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import {
  type BrowserHost,
  ControlError,
  CookieImportError,
  chromeProfiles,
  listChromeCookieDomains,
  macKeychain,
  readChromeCookies,
  type SafeStorageKeySource,
  SpaceNotFoundError,
} from "@alca/browser";
import { appendAudit, type Store } from "@alca/store";
import { HttpError, json, readJson } from "./http.ts";

/**
 * P13 opt-in import of the person's Chrome cookies (macOS) into ONE
 * persistent isolated Space. Nothing happens unless the person opens the
 * import sheet, picks sites and presses 匯入; listing reads only host names
 * (no Keychain prompt); the import asks macOS for the "Chrome Safe Storage"
 * password, decrypts in memory, hands the cookies to that Space's own
 * browser and writes an audit row with the sites and counts (never values).
 * Desktop only: no phone RPC carries it.
 */

export interface CookieImportSource {
  keys: SafeStorageKeySource;
  /** Home dir whose Chrome profiles are read (tests point it at a fixture). */
  home: string;
  /** Platform the import is offered on (darwin only, unless a test says otherwise). */
  platform: string;
}

export const defaultCookieSource = (): CookieImportSource => ({
  keys: macKeychain,
  home: homedir(),
  platform: process.platform,
});

const DESKTOP = { kind: "user" as const, id: "desktop" };

export function cookieImportSupported(src: CookieImportSource): boolean {
  return src.platform === "darwin";
}

/**
 * `GET /api/browser/chrome-import` (profiles and their sites) and
 * `POST /api/browser/spaces/:id/import-cookies` `{ profile, domains }`.
 * Returns false when the path is not one of these.
 */
export async function cookieImportRoute(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  host: BrowserHost,
  store: Store,
  src: CookieImportSource,
): Promise<boolean> {
  const [, , kind, id, verb] = parts;
  const method = req.method ?? "GET";
  const isList = method === "GET" && kind === "chrome-import" && !id;
  const isImport = method === "POST" && kind === "spaces" && !!id && verb === "import-cookies";
  if (!isList && !isImport) return false;
  if (!cookieImportSupported(src)) throw new HttpError(501, "目前只支援從 macOS 上的 Chrome 匯入登入");
  const profiles = chromeProfiles(src.home);
  try {
    if (isList) {
      json(res, 200, {
        profiles: profiles.map((p) => {
          try {
            return { name: p.name, domains: listChromeCookieDomains(p.cookies) };
          } catch (err) {
            return { name: p.name, domains: [], error: String((err as Error).message ?? err) };
          }
        }),
      });
      return true;
    }
    const b = await readJson(req, 64 * 1024);
    const profileName = typeof b.profile === "string" ? b.profile : "Default";
    const profile = profiles.find((p) => p.name === profileName);
    if (!profile) throw new HttpError(404, `找不到 Chrome 設定檔「${profileName}」`);
    const domains = Array.isArray(b.domains)
      ? b.domains.filter((d): d is string => typeof d === "string").slice(0, 200)
      : [];
    if (!domains.length) throw new HttpError(400, "請至少選一個網站");
    // Check the target before the Keychain prompt: never ask for a password we would not use.
    const space = host.get(id as string);
    if (space.profile !== "isolated" || !space.persistent)
      throw new ControlError("只能匯入到「隔離並保留登入」的 Space，不會匯入共用的瀏覽器設定檔");
    const r = await readChromeCookies({ dbPath: profile.cookies, domains, keys: src.keys });
    const imported = await host.importCookies(space.spaceId, r.cookies);
    appendAudit(store.db, {
      ts: new Date().toISOString(),
      initiator: { kind: "user", id: DESKTOP.id },
      actor: DESKTOP,
      action: "browser.cookie_import",
      actionClass: "write",
      target: space.spaceId,
      decision: "allow",
      detail: {
        profile: profile.name,
        domains,
        imported,
        skipped: r.skipped,
        expired: r.expired,
        botId: space.botId,
      },
    });
    json(res, 200, { imported, skipped: r.skipped, expired: r.expired });
    return true;
  } catch (err) {
    if (err instanceof SpaceNotFoundError) throw new HttpError(404, err.message);
    if (err instanceof ControlError) throw new HttpError(409, err.message);
    if (err instanceof CookieImportError) throw new HttpError(400, err.message);
    throw err;
  }
}
