import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import type { AddressInfo } from "node:net";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { Settings } from "@alca/config";
import {
  assertSafeStartup,
  NotFoundError,
  secretsFromMap,
  ThreadBusyError,
  ThreadInUseError,
} from "@alca/core";
import { I18N_DIR, TOKENS_CSS_PATH } from "@alca/design";
import { tSource } from "@alca/design/i18n";
import type { AppContext } from "./app-context.ts";
import { desktopRoutes } from "./core-routes.ts";
import { CSP, checkHostAndOrigin, checkToken, errorBody, HttpError, json, readJson, send } from "./http.ts";
import { openInBrowser } from "./open-url.ts";
import { TeamApiError } from "./team-api.ts";
import { markApproveKey, needsApproveKey } from "./ui-session.ts";

export { threadSummary } from "./core-routes.ts";

const UI_DIR = fileURLToPath(new URL("../ui/", import.meta.url));

export interface DesktopServer {
  server: Server;
  url: string;
  port: number;
  close(): Promise<void>;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".ts": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

const tsCache = new Map<string, string>();

function serveUi(res: ServerResponse, path: string): void {
  if (path === "/ui/tokens.css") {
    send(res, 200, readFileSync(TOKENS_CSS_PATH), TYPES[".css"] as string);
    return;
  }
  const rel = normalize(path.slice("/ui/".length));
  if (rel.startsWith("..") || rel.includes("\0")) throw new HttpError(404, "not found");
  // R9.3: the shared string table lives in @alca/design; the UI imports it as ./i18n/….
  const i18n = /^i18n[\\/]/.test(rel);
  const file = i18n ? join(I18N_DIR, rel.slice("i18n/".length)) : join(UI_DIR, rel);
  const ext = extname(rel);
  const type = TYPES[ext];
  if (!type) throw new HttpError(404, "not found");
  let body: string | Buffer;
  try {
    body = readFileSync(file);
  } catch {
    throw new HttpError(404, "not found");
  }
  if (ext === ".ts") {
    const key = `${rel}:${body.length}`;
    let js = tsCache.get(key);
    if (!js) {
      js = stripTypeScriptTypes(body.toString("utf8"), { mode: "strip" });
      tsCache.set(key, js);
    }
    body = js;
  }
  send(res, 200, body, type, { "content-security-policy": CSP });
}

const ROUTES = desktopRoutes();

/** The URL a window opens with: the token and a fresh one-time launch code in the fragment. */
export function launchUrl(ctx: AppContext, base: string, extra = ""): string {
  return `${base}/#token=${ctx.token}&ui=${ctx.ui.mint()}${extra ? `&${extra}` : ""}`;
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AppContext,
  port: number,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const path = url.pathname;
  const method = req.method ?? "GET";
  if (method === "GET" && (path === "/" || path === "/index.html")) {
    send(res, 200, readFileSync(join(UI_DIR, "index.html")), TYPES[".html"] as string, {
      "content-security-policy": CSP,
    });
    return;
  }
  if (method === "GET" && path.startsWith("/ui/")) return serveUi(res, path);
  if (method === "GET" && path === "/api/health") return json(res, 200, { ok: true });
  if (!path.startsWith("/api/")) throw new HttpError(404, "not found");
  checkToken(req, ctx.token);
  // S2.2: the launch code from a window the core opened → the in-memory approve key.
  if (method === "POST" && path === "/api/ui/session") {
    const b = await readJson(req, 4096);
    return json(res, 200, { approveKey: await ctx.ui.exchangeSoon(b.code) });
  }
  // A window without the key (the shell's own, a reload) asks the core to open one that has it.
  if (method === "POST" && path === "/api/ui/open") {
    const b = await readJson(req, 4096);
    const at = typeof b.open === "string" && /^[a-z]{1,20}$/.test(b.open) ? `open=${b.open}` : "";
    if (!ctx.ui.mayOpen()) throw new HttpError(429, tSource("core.ui.openedRecently"));
    const base = `http://127.0.0.1:${port}`;
    return json(res, 200, { opened: (ctx.openWindow ?? openInBrowser)(launchUrl(ctx, base, at)) });
  }
  if (needsApproveKey(method, path)) ctx.ui.check(req, port);
  // Routes whose need for the key depends on the body (turning 完全授權 on) read this mark.
  if (ctx.ui.passes(req, port)) markApproveKey(req);
  await ROUTES.dispatch(req, res, url, ctx);
}

/**
 * Start the local server. Refuses to start unless the bind address is
 * loopback and the local token is present and strong (core startup safety
 * check); every API call needs the token, and Host / Origin are checked.
 */
export async function startDesktopServer(o: AppContext): Promise<DesktopServer> {
  const settings = o.settings();
  const host = o.host ?? settings.engineering.bindHost;
  const checked: Settings = { ...settings, engineering: { ...settings.engineering, bindHost: host } };
  assertSafeStartup(
    checked,
    secretsFromMap({ "link.identityKey": o.token, ...o.secrets, "core.localToken": o.token }),
  );

  let port = 0;
  const server = createServer((req, res) => {
    void (async () => {
      try {
        checkHostAndOrigin(req, port);
        await route(req, res, o, port);
      } catch (err) {
        if (res.headersSent) return void res.end();
        if (err instanceof HttpError) return json(res, err.status, errorBody(err.message));
        if (err instanceof TeamApiError) return json(res, err.status, errorBody(err.message));
        if (err instanceof NotFoundError) return json(res, 404, errorBody(err.message));
        if (err instanceof ThreadBusyError) return json(res, 409, errorBody(tSource("core.thread.busy")));
        if (err instanceof ThreadInUseError) return json(res, 409, errorBody(err.message));
        json(res, 500, { error: "internal error" });
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port ?? settings.engineering.port, host, () => resolve());
  });
  port = (server.address() as AddressInfo).port;
  const shownHost = host.includes(":") ? `[${host}]` : host;
  return {
    server,
    port,
    url: `http://${shownHost === "localhost" ? "127.0.0.1" : shownHost}:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
