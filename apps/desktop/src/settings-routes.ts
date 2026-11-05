import { tSource } from "@alca/design/i18n";
import type { AppContext } from "./app-context.ts";
import { HttpError, send } from "./http.ts";
import type { Route } from "./routes.ts";
import { carriedApproveKey } from "./ui-session.ts";

/**
 * The 設定 screen (P13 B3), loopback only (paired devices cannot change settings):
 *
 *   GET   /api/settings              the simple and 進階 fields, which saved ones wait for a restart
 *   PATCH /api/settings              {level?, learning?, pushPreview?, defaultScopes?, allowPairing?,
 *                                     rendezvousUrl?, logLevel?, browserAutoDownload?}
 *   GET   /api/settings/backups      the database backups (newest first); restore is CLI only
 *   POST  /api/settings/backups      現在備份
 *   GET   /api/settings/data         資料: retention policy, last hourly data steps, anchor
 *   GET   /api/settings/perf         資料: event-loop delay, slow SQL, worker jobs (read-only, R2.2)
 *   GET   /api/settings/encryption   資料: column encryption, where the vault key is, plaintext backups (R7)
 *   POST  /api/settings/encryption/drop-plaintext-backups
 *                                    once nothing is plaintext: a new backup, then the old ones go (approve key)
 *   POST  /api/export                {scope:"thread", id, options?:{passphrase?, memories?}} → the
 *                                    .alca-export file as a download (R5.6; nothing kept in the core)
 *   POST  /api/import                {data: base64 of the file, passphrase?} → a new conversation;
 *                                    the approve key too (it adds a conversation, ui-session.ts NEEDS_KEY)
 *   POST  /api/settings/verify       驗證稽核紀錄 (read-only; the local token, no approve key)
 *   GET   /api/settings/about        version, data folder, logs
 *   POST  /api/settings/open-logs    open <data>/logs in the file manager
 *   POST  /api/settings/open-data    open the data folder
 *   POST  /api/settings/update-check 檢查更新 (Phase E; one GET to the release list, never installs)
 *   GET   /api/settings/search       網路搜尋: provider, SearXNG URL, key previews, offered now?
 *   PUT   /api/settings/search       {provider, searxngUrl?, count?, key?}  (widening needs the approve key)
 *   DELETE /api/settings/search/key/:provider
 *
 * The other 設定 sections use their own APIs: /api/bots + /api/providers
 * (模型), /api/link (連線, devices), /api/browser/status + install (瀏覽器),
 * /api/telegram.
 */
/** A base64 import body: about 96 MB of export file (gzip; far past a long conversation). */
const IMPORT_BODY_MAX = 128 * 1024 * 1024;

export function settingsRoutes(): Route[] {
  return [
    {
      method: "GET",
      path: "/api/settings",
      handle: ({ ctx }) => {
        if (!ctx.settingsApi) throw new HttpError(404, "not found");
        return ctx.settingsApi.view();
      },
    },
    {
      method: "PATCH",
      path: "/api/settings",
      handle: async ({ ctx, body }) => {
        if (!ctx.settingsApi) throw new HttpError(404, "not found");
        return ctx.settingsApi.patch(await body());
      },
    },
    { method: "GET", path: "/api/settings/backups", handle: ({ ctx }) => system(ctx).backups() },
    { method: "POST", path: "/api/settings/backups", handle: ({ ctx }) => system(ctx).backupNow() },
    { method: "GET", path: "/api/settings/data", handle: ({ ctx }) => system(ctx).data() },
    { method: "GET", path: "/api/settings/perf", handle: ({ ctx }) => system(ctx).perf() },
    { method: "POST", path: "/api/settings/verify", handle: ({ ctx }) => system(ctx).verify() },
    { method: "GET", path: "/api/settings/encryption", handle: ({ ctx }) => seal(ctx).view() },
    {
      method: "POST",
      path: "/api/settings/encryption/drop-plaintext-backups",
      handle: ({ ctx }) => seal(ctx).dropPlaintextBackups(),
    },
    {
      method: "POST",
      path: "/api/export",
      handle: async ({ ctx, body, res }) => {
        const b = await body();
        if ((b.scope ?? "thread") !== "thread") throw new HttpError(400, tSource("core.export.threadOnly"));
        if (typeof b.id !== "string" || !b.id) throw new HttpError(400, "id is required");
        const opt = (typeof b.options === "object" && b.options !== null ? b.options : b) as Record<
          string,
          unknown
        >;
        const passphrase = typeof opt.passphrase === "string" && opt.passphrase ? opt.passphrase : undefined;
        if (passphrase !== undefined && passphrase.length < 8)
          throw new HttpError(400, tSource("core.export.passphraseShort"));
        const out = await system(ctx).exportThread(b.id, {
          ...(passphrase ? { passphrase } : {}),
          ...(opt.memories === true ? { memories: true } : {}),
        });
        send(res, 200, out.bytes, "application/gzip", {
          "content-disposition": `attachment; filename="${out.name}"`,
          "x-alca-export-counts": JSON.stringify(out.summary.counts),
        });
        return undefined;
      },
    },
    {
      method: "POST",
      path: "/api/import",
      handle: async ({ ctx, body }) => {
        const b = await body(IMPORT_BODY_MAX);
        if (typeof b.data !== "string" || !b.data)
          throw new HttpError(400, "data (the file, base64) is required");
        return system(ctx).importThread(Buffer.from(b.data, "base64"), {
          ...(typeof b.passphrase === "string" && b.passphrase ? { passphrase: b.passphrase } : {}),
        });
      },
    },
    { method: "GET", path: "/api/settings/about", handle: ({ ctx }) => system(ctx).about() },
    { method: "POST", path: "/api/settings/open-logs", handle: ({ ctx }) => system(ctx).openLogs() },
    { method: "POST", path: "/api/settings/open-data", handle: ({ ctx }) => system(ctx).openDataDir() },
    { method: "POST", path: "/api/settings/update-check", handle: ({ ctx }) => system(ctx).checkUpdate() },
    { method: "GET", path: "/api/settings/search", handle: ({ ctx }) => search(ctx).view() },
    {
      method: "PUT",
      path: "/api/settings/search",
      handle: async ({ ctx, req, body }) => search(ctx).put(await body(8 * 1024), carriedApproveKey(req)),
    },
    {
      method: "DELETE",
      path: "/api/settings/search/key/:provider",
      handle: ({ ctx, params }) => search(ctx).clearKey(params.provider ?? ""),
    },
  ];
}

function seal(ctx: AppContext) {
  if (!ctx.seal) throw new HttpError(404, "not found");
  return ctx.seal;
}

function search(ctx: AppContext) {
  if (!ctx.webSearch) throw new HttpError(404, "not found");
  return ctx.webSearch;
}

function system(ctx: AppContext) {
  if (!ctx.system) throw new HttpError(404, "not found");
  return ctx.system;
}
