// Telegram reply channel on the desktop (P13): the service over the local
// vault and `<data-dir>/telegram.json`, and its loopback API. The token goes
// in once and is never returned (status says only whether it is set).
//
//   GET    /api/telegram         status: on / off, bot, allow-list, last error, chats that tried
//   PUT    /api/telegram         {enabled?, botId?, allowChatIds?}
//   PUT    /api/telegram/token   {token} (checked with Telegram first)
//   DELETE /api/telegram/token
import { join } from "node:path";
import { coreHost, type SecretStore, TelegramError, TelegramService } from "@alca/channel-telegram";
import type { AlcaCore } from "@alca/core";
import { HttpError, json, readJson } from "./http.ts";
import type { RouteReq } from "./routes.ts";

export function createTelegram(o: {
  core: AlcaCore;
  dataDir: string;
  vault: SecretStore;
  /** Tests point this at a fake Bot API. */
  apiBase?: string;
}): TelegramService {
  return new TelegramService({
    statePath: join(o.dataDir, "telegram.json"),
    secrets: o.vault,
    host: coreHost(o.core),
    ...(o.apiBase ? { apiBase: o.apiBase } : {}),
  });
}

const fail = (e: unknown): never => {
  if (e instanceof TelegramError) throw new HttpError(400, e.message);
  throw e;
};

export async function telegramRoute(r: RouteReq, svc: TelegramService | undefined): Promise<boolean> {
  const [, area, sub, extra] = r.parts;
  if (area !== "telegram" || extra !== undefined) return false;
  if (!svc) throw new HttpError(404, "這個版本沒有 Telegram");
  const method = r.req.method ?? "GET";
  if (sub === undefined && method === "GET") {
    json(r.res, 200, await svc.status());
    return true;
  }
  if (sub === undefined && method === "PUT") {
    const body = await readJson(r.req);
    const change: Record<string, unknown> = {};
    for (const k of ["enabled", "botId", "allowChatIds"]) if (k in body) change[k] = body[k];
    await svc.update(change).catch(fail);
    json(r.res, 200, await svc.status());
    return true;
  }
  if (sub === "token" && method === "PUT") {
    const body = await readJson(r.req, 4096);
    if (typeof body.token !== "string" || !body.token.trim()) throw new HttpError(400, "請貼上 bot 權杖");
    await svc.setToken(body.token).catch(fail);
    json(r.res, 200, await svc.status());
    return true;
  }
  if (sub === "token" && method === "DELETE") {
    await svc.clearToken();
    json(r.res, 200, await svc.status());
    return true;
  }
  if (sub === undefined || sub === "token") throw new HttpError(405, "method not allowed");
  return false;
}
