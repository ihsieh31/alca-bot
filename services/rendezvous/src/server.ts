// HTTP(S) front of the rendezvous: `GET /healthz`, the WebSocket endpoint
// `/v0/link`, and (optionally) the phone PWA as static files. No request is
// logged with its content and nothing is written to disk.
import { readFileSync, statSync } from "node:fs";
import {
  createServer as createHttp,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createServer as createHttps } from "node:https";
import type { AddressInfo } from "node:net";
import { extname, join, normalize, resolve } from "node:path";
import type { Duplex } from "node:stream";
import { RELAY_PATH } from "@alca/link/relay-protocol";
import { acceptWebSocket } from "@alca/link/ws";
import { AccountRegistry, MemoryAccountStore } from "./accounts.ts";
import { FileAccountStore, relaySecret } from "./accounts-file.ts";
import { GoogleTokenVerifier, type GoogleVerifierOptions } from "./google.ts";
import { HookBoxes, type HookLimits } from "./hooks.ts";
import { RelayHub, type RelayHubOptions, type RelayLimits } from "./relay.ts";

export interface RendezvousOptions {
  host?: string;
  port?: number;
  /** PEM files: serve HTTPS / WSS directly (otherwise put a TLS proxy in front). */
  tlsCert?: string;
  tlsKey?: string;
  /** Directory of the built phone PWA (`apps/phone-pwa/dist`); unset = relay only. */
  pwaDir?: string;
  /**
   * Take the client address from X-Forwarded-For (only behind your own proxy). The number is how
   * many proxies of yours append to it (`true` = 1): the address is that many entries from the
   * right, the rightmost one your outermost proxy did not write. The leftmost entries are whatever
   * the client sent and are never used.
   */
  trustProxy?: boolean | number;
  /** Allowed Origin headers for browser WebSockets; empty = any (the payload is end-to-end encrypted). */
  origins?: string[];
  maxMessageBytes?: number;
  limits?: Partial<RelayLimits>;
  /** Webhook mailboxes for connected-app triggers (P6); `false` turns them off. */
  hooks?: Partial<HookLimits> | false;
  tap?: RelayHubOptions["tap"];
  log?: (msg: string) => void;
  /**
   * P10: Google sign-in. `clientIds` = the OAuth client IDs whose ID tokens
   * are accepted (the phone site's Web client and the computer's Desktop
   * client). `jwksUrl` / `issuers` exist for tests with a fake issuer.
   */
  google?: { clientIds: string[]; jwksUrl?: string; issuers?: string[]; fetch?: typeof fetch };
  /** P10: where the account registry is kept (JSON, 0600); unset = in memory. */
  accountsFile?: string;
  /** P10: the key of the account hash; default $ALCA_RELAY_SECRET, else `<accountsFile>.key` (created). */
  relaySecret?: string;
}

export interface Rendezvous {
  server: Server;
  hub: RelayHub;
  hooks: HookBoxes | undefined;
  accounts: AccountRegistry | undefined;
  url: string;
  port: number;
  close(): Promise<void>;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

/**
 * The PWA talks only to its own origin (the relay socket) and, for the P10
 * Google sign-in button, Google Identity Services (its script, style, iframe
 * and endpoints under accounts.google.com/gsi/); no inline script.
 */
export const PWA_CSP =
  "default-src 'self'; script-src 'self' https://accounts.google.com/gsi/client; style-src 'self' https://accounts.google.com/gsi/style; frame-src https://accounts.google.com/gsi/; img-src 'self' data: blob:; connect-src 'self' ws: wss: https://accounts.google.com/gsi/; font-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  // The Google sign-in pop-up (P10) must be able to report back to this page.
  "cross-origin-opener-policy": "same-origin-allow-popups",
  "permissions-policy": "camera=(self), microphone=(), geolocation=()",
};

/**
 * The client address behind `hops` trusted proxies (review M1): each proxy appends the address it
 * saw, so the client is the `hops`-th entry from the right. With fewer entries than hops, the
 * leftmost one (every entry came from a proxy of ours); none → the socket's own address.
 */
export function clientAddress(xff: string | string[] | undefined, hops: number, remote: string): string {
  if (hops < 1) return remote;
  const list = (Array.isArray(xff) ? xff.join(",") : (xff ?? ""))
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  if (!list.length) return remote;
  return list[Math.max(0, list.length - hops)] ?? remote;
}

/** `/diag` → `/#diag`: the 診斷 sheet opens from the fragment. */
export const SHORT_LINKS: Readonly<Record<string, string>> = { "/diag": "/#diag" };

function serveStatic(dir: string, req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", "http://x");
  let rel = normalize(decodeURIComponent(url.pathname)).replace(/^\/+/, "");
  if (rel === "" || rel.endsWith("/")) rel += "index.html";
  if (rel.startsWith("..") || rel.includes("\0")) return void res.writeHead(404).end();
  let file = join(dir, rel);
  let type = TYPES[extname(file)];
  try {
    if (!type || !statSync(file).isFile()) throw new Error();
  } catch {
    // App routes fall back to the shell.
    if (extname(rel)) return void res.writeHead(404, HEADERS).end();
    file = join(dir, "index.html");
    type = TYPES[".html"];
  }
  const sw = rel === "sw.js";
  res.writeHead(200, {
    ...HEADERS,
    "content-type": type as string,
    "content-security-policy": PWA_CSP,
    "cache-control": sw || rel === "index.html" ? "no-cache" : "public, max-age=300",
    ...(sw ? { "service-worker-allowed": "/" } : {}),
  });
  res.end(readFileSync(file));
}

function accountsFrom(o: RendezvousOptions) {
  if (!o.google?.clientIds.length) return undefined;
  const secret =
    o.relaySecret ??
    (o.accountsFile
      ? relaySecret(`${o.accountsFile}.key`)
      : (process.env.ALCA_RELAY_SECRET ?? crypto.randomUUID() + crypto.randomUUID()));
  const registry = new AccountRegistry({
    secret,
    store: o.accountsFile ? new FileAccountStore(o.accountsFile) : new MemoryAccountStore(),
  });
  const v: GoogleVerifierOptions = { audiences: o.google.clientIds };
  if (o.google.jwksUrl) v.jwksUrl = o.google.jwksUrl;
  if (o.google.issuers) v.issuers = o.google.issuers;
  if (o.google.fetch) v.fetch = o.google.fetch;
  return { registry, verifier: new GoogleTokenVerifier(v) };
}

export async function startRendezvous(o: RendezvousOptions = {}): Promise<Rendezvous> {
  const accounts = accountsFrom(o);
  await accounts?.registry.ready();
  const hub = new RelayHub({
    ...(accounts ? { accounts } : {}),
    ...(o.limits ? { limits: o.limits } : {}),
    ...(o.tap ? { tap: o.tap } : {}),
    ...(o.log ? { log: o.log } : {}),
  });
  const pwaDir = o.pwaDir ? resolve(o.pwaDir) : undefined;
  const hooks = o.hooks === false ? undefined : new HookBoxes(o.hooks ?? {});
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "/").split("?")[0];
    if (req.method === "GET" && path === "/healthz") {
      res.writeHead(200, { ...HEADERS, "content-type": "application/json" });
      return void res.end(JSON.stringify({ ok: true, ...hub.stats(), ...(hooks?.stats() ?? {}) }));
    }
    if (hooks && path?.startsWith("/v0/hooks/")) {
      hooks.handle(req, res, HEADERS).catch(() => {
        if (!res.headersSent) res.writeHead(500, HEADERS);
        res.end();
      });
      return;
    }
    if (pwaDir && (req.method === "GET" || req.method === "HEAD")) {
      // Short links into the app (DEVICE-TEST.md, typed by hand): the app reads its hash, not its path.
      const to = path && SHORT_LINKS[path.replace(/\/+$/, "")];
      if (to) return void res.writeHead(302, { ...HEADERS, location: to, "cache-control": "no-store" }).end();
      return serveStatic(pwaDir, req, res);
    }
    res.writeHead(404, HEADERS).end();
  };
  const tls = o.tlsCert && o.tlsKey;
  const server = tls
    ? createHttps({ cert: readFileSync(o.tlsCert as string), key: readFileSync(o.tlsKey as string) }, handler)
    : createHttp(handler);
  // Upgraded sockets leave the server's bookkeeping: track them so close() ends them.
  const sockets = new Set<Duplex>();
  server.on("upgrade", (req, socket, head) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    const path = (req.url ?? "/").split("?")[0];
    const origin = req.headers.origin;
    if (path !== RELAY_PATH || (origin && o.origins?.length && !o.origins.includes(origin))) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const ws = acceptWebSocket(req, socket, head, { maxMessageBytes: o.maxMessageBytes ?? 4 * 1024 * 1024 });
    if (!ws) return;
    const hops = o.trustProxy === true ? 1 : typeof o.trustProxy === "number" ? Math.floor(o.trustProxy) : 0;
    hub.accept(ws, clientAddress(req.headers["x-forwarded-for"], hops, ws.remoteAddress));
  });
  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(o.port ?? 8787, o.host ?? "127.0.0.1", () => res());
  });
  const port = (server.address() as AddressInfo).port;
  const host = o.host && o.host !== "0.0.0.0" && o.host !== "::" ? o.host : "127.0.0.1";
  return {
    server,
    hub,
    hooks,
    accounts: accounts?.registry,
    port,
    url: `${tls ? "https" : "http"}://${host.includes(":") ? `[${host}]` : host}:${port}`,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        for (const s of sockets) s.destroy();
        hooks?.flush();
        void Promise.resolve(accounts?.registry.flush()).finally(() => server.close(() => r()));
      }),
  };
}
