import type { IncomingMessage, ServerResponse } from "node:http";
import { fromB64u, safetyNumber } from "@alca/link";
import { HttpError, json, readJson } from "./http.ts";
import { ALL_SCOPES, type LinkSetup } from "./link.ts";

/**
 * `/api/link/*` (desktop only, loopback + local token like every API route):
 *
 *   GET    /api/link                       status, this core's key, devices, hands
 *   POST   /api/link/pairings              {scopes?} → code, QR, deep link (single use, short TTL)
 *   DELETE /api/link/pairings/:nameplate   cancel an open code
 *   POST   /api/link/devices/:id/revoke    permanent; live sessions end at once
 *   POST   /api/link/devices/:id/scopes    {scopes} (control_computer is granted here, per device)
 *   GET    /api/link/connection            relay in use, stable relay, direct addresses, last self-check
 *   PUT    /api/link/connection            {relayUrl?, directUrls?} → saved in link.json, phones told at once
 *   POST   /api/link/connection/check      run the reachability self-check now
 *   GET    /api/link/remote                用 Google 帳號啟用遠端: state, email, the page to open while signing in
 *   POST   /api/link/remote                start the Google sign-in (→ authUrl; the core waits on its loopback port)
 *   DELETE /api/link/remote                停用: off the account's list on the relay (allowed devices stay until revoked)
 *   GET    /api/link/enrollments           new-device sheets waiting for the phone's code: {id, left, wrong, state, expiresAt}
 *   POST   /api/link/enrollments/:id       {code} → {ok:true, label} | {ok:false, error, left|message}; {cancel:true} refuses
 */

const scopesFrom = (v: unknown): string[] | undefined =>
  Array.isArray(v)
    ? v.filter((s): s is string => typeof s === "string" && (ALL_SCOPES as readonly string[]).includes(s))
    : undefined;

export async function linkRoute(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  link: LinkSetup | undefined,
): Promise<boolean> {
  const [, a, b, c, d] = parts;
  if (a !== "link") return false;
  const method = req.method ?? "GET";
  if (method === "GET" && !b) {
    if (!link) {
      json(res, 200, { enabled: false });
      return true;
    }
    const devices = await Promise.all(
      link
        .devices()
        .map(async ({ pubkey, ...dev }) => ({ ...dev, safetyNumber: await safetyNumber(fromB64u(pubkey)) })),
    );
    json(res, 200, {
      enabled: true,
      status: link.host.status,
      relayUrl: link.host.relayUrl,
      mailbox: link.host.mailbox,
      fingerprint: link.host.coreFingerprint,
      safetyNumber: link.safetyNumber,
      lan: link.lan?.urls ?? [],
      connection: link.connection(),
      devices,
      hands: link.hands.list(),
      pake: link.pake(),
    });
    return true;
  }
  if (!link) throw new HttpError(503, "Alca Link 未啟用（用 --rendezvous 指定會合伺服器）");
  if (b === "connection") {
    if (method === "GET" && !c) {
      json(res, 200, link.connection());
      return true;
    }
    if (method === "PUT" && !c) {
      try {
        json(res, 200, await link.setConnection(await readJson(req)));
      } catch (e) {
        if (e instanceof HttpError) throw e;
        throw new HttpError(400, e instanceof Error ? e.message : "設定有誤");
      }
      return true;
    }
    if (method === "POST" && c === "check") {
      json(res, 200, await link.checkNow());
      return true;
    }
  }
  if (b === "remote" && !c) {
    try {
      if (method === "GET") json(res, 200, link.remote());
      else if (method === "POST") json(res, 200, await link.remoteStart());
      else if (method === "DELETE") json(res, 200, await link.remoteDisable());
      else throw new HttpError(405, "method not allowed");
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(400, e instanceof Error ? e.message : "無法啟用");
    }
    return true;
  }
  if (b === "enrollments") {
    if (method === "GET" && !c) {
      json(res, 200, { enrollments: link.enrollments() });
      return true;
    }
    if (method === "POST" && c && !d) {
      const body = await readJson(req);
      if (body.cancel === true || body.allow === false) {
        if (!link.cancelEnrollment(c)) throw new HttpError(404, "這個請求已經結束了");
        json(res, 200, { cancelled: true });
        return true;
      }
      const out = link.submitEnrollmentCode(c, typeof body.code === "string" ? body.code : "");
      if (!out) throw new HttpError(404, "這個請求已經結束了");
      json(res, 200, await out);
      return true;
    }
  }
  if (b === "pairings" && method === "POST" && !c) {
    const scopes = scopesFrom((await readJson(req)).scopes);
    json(res, 201, await link.pair(scopes ? { scopes } : {}));
    return true;
  }
  if (b === "pairings" && method === "DELETE" && c) {
    link.host.cancelPairing(c);
    json(res, 200, { cancelled: true });
    return true;
  }
  if (b === "devices" && c && method === "POST") {
    if (!link.devices().some((x) => x.id === c)) throw new HttpError(404, "沒有這台裝置");
    if (d === "revoke") {
      json(res, 200, { revoked: link.revoke(c) });
      return true;
    }
    if (d === "scopes") {
      const scopes = scopesFrom((await readJson(req)).scopes);
      if (!scopes) throw new HttpError(400, "scopes must be an array");
      link.setScopes(c, scopes);
      json(res, 200, { scopes });
      return true;
    }
  }
  throw new HttpError(404, "not found");
}
