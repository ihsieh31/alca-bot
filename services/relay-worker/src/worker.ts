// Alca Link relay on Cloudflare Workers (P10). Every relay socket goes to one
// Durable Object, which runs the same RelayHub as the Node relay
// (services/rendezvous): pairing nameplates, mailboxes, ciphertext
// forwarding, and the Google-account directory with token checks. The
// account registry is kept in the object's storage as keyed hashes only.
//
//   GET /healthz        counts, configuration warnings (ok:false when misconfigured)
//   GET /v0/link        WebSocket (relay protocol v0)
//   /v0/hooks/<id>…     webhook mailboxes (review M3; same protocol as the Node relay, one
//                       Durable Object per mailbox: src/hooks.ts)
//
// Scale (review M2): one object holds every relay socket, because pairing
// codes and the Google directory must meet in one place; it caps itself at
// MAX_SOCKETS (default 5000) and each address at 32 sockets, with the hub's
// hello deadline, idle timeout and byte budget. Sharding by mailbox needs a
// separate directory for nameplates and accounts; see docs/DEPLOY.md.
//
// Not here (Node relay only): serving the phone site (use Vercel), TLS options.
import { RELAY_PATH } from "@alca/link/relay-protocol";
import { AccountRegistry } from "@alca/rendezvous/accounts";
import { GoogleTokenVerifier } from "@alca/rendezvous/google";
import { RelayHub } from "@alca/rendezvous/relay";
import type { CfWebSocket, DurableState, RelayEnv } from "./cf-types.ts";
import { HOOK_ID_RE, HOOKS_PATH, HookObject } from "./hooks.ts";
import { adaptSocket } from "./socket.ts";
import { DurableAccountStore } from "./storage.ts";

export { HookObject };

/** Sockets one relay object accepts unless MAX_SOCKETS says otherwise. */
export const DEFAULT_MAX_SOCKETS = 5000;

/**
 * What is wrong with this deployment's settings (review L3 / L4), worst first. `fatal` ones make
 * /healthz say ok:false; the rest are warnings.
 */
export function configProblems(env: RelayEnv): Array<{ fatal: boolean; message: string }> {
  const out: Array<{ fatal: boolean; message: string }> = [];
  const production = env.RELAY_MODE === "production";
  if (list(env.GOOGLE_CLIENT_IDS).length && !env.ALCA_RELAY_SECRET)
    out.push({
      fatal: true,
      message:
        "GOOGLE_CLIENT_IDS is set but the ALCA_RELAY_SECRET secret is missing: Google sign-in is off (wrangler secret put ALCA_RELAY_SECRET)",
    });
  else if (env.ALCA_RELAY_SECRET && env.ALCA_RELAY_SECRET.length < 32)
    out.push({ fatal: false, message: "ALCA_RELAY_SECRET is shorter than 32 characters" });
  if (!list(env.ALLOWED_ORIGINS).length)
    out.push({
      fatal: production,
      message: production
        ? "ALLOWED_ORIGINS is empty in production mode: browser sockets are refused until it names the phone site"
        : "ALLOWED_ORIGINS is empty: any website can open relay sockets (set it to the phone site's origin)",
    });
  return out;
}

const list = (s: string | undefined) =>
  (s ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

const HEADERS = { "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };

/** The runtime's WebSocketPair (a global on Workers; tests put a fake there). */
type Pair = new () => { 0: CfWebSocket; 1: CfWebSocket };
const pair = (): Pair => (globalThis as unknown as { WebSocketPair: Pair }).WebSocketPair;

export class RelayObject {
  private hub: RelayHub;
  private registry: AccountRegistry | undefined;
  private readonly env: RelayEnv;

  constructor(state: DurableState, env: RelayEnv) {
    this.env = env;
    const ids = list(env.GOOGLE_CLIENT_IDS);
    const max = Number(env.MAX_SOCKETS);
    const limits = { maxSockets: Number.isInteger(max) && max > 0 ? max : DEFAULT_MAX_SOCKETS };
    if (ids.length && env.ALCA_RELAY_SECRET) {
      this.registry = new AccountRegistry({
        secret: env.ALCA_RELAY_SECRET,
        store: new DurableAccountStore(state.storage),
      });
      const verifier = new GoogleTokenVerifier({
        audiences: ids,
        ...(env.GOOGLE_JWKS_URL ? { jwksUrl: env.GOOGLE_JWKS_URL } : {}),
      });
      this.hub = new RelayHub({ accounts: { registry: this.registry, verifier }, limits });
      const r = this.registry;
      void state.blockConcurrencyWhile(() => r.ready());
    } else {
      this.hub = new RelayHub({
        limits,
        // Review L4: say why, instead of a plain "no Google sign-in".
        ...(ids.length ? { accountsOff: "the relay is missing its ALCA_RELAY_SECRET" } : {}),
      });
    }
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") {
      const problems = configProblems(this.env);
      return Response.json(
        {
          ok: !problems.some((p) => p.fatal),
          google: !!this.registry,
          hooks: !!this.env.HOOKS,
          mode: this.env.RELAY_MODE === "production" ? "production" : "default",
          ...(problems.length ? { warnings: problems.map((p) => p.message) } : {}),
          ...this.hub.stats(),
        },
        { headers: HEADERS },
      );
    }
    if (url.pathname !== RELAY_PATH || req.headers.get("upgrade")?.toLowerCase() !== "websocket")
      return new Response("not found", { status: 404, headers: HEADERS });
    const origins = list(this.env.ALLOWED_ORIGINS);
    const origin = req.headers.get("origin");
    if (origin && origins.length && !origins.includes(origin))
      return new Response("forbidden", { status: 403, headers: HEADERS });
    // Review L3: the official deployment names its phone site; until it does, no browser gets in.
    if (origin && !origins.length && this.env.RELAY_MODE === "production")
      return new Response("forbidden: ALLOWED_ORIGINS is not set", { status: 403, headers: HEADERS });
    const P = pair();
    const p = new P();
    this.accept(p[1], req.headers.get("cf-connecting-ip") ?? "unknown");
    return new Response(null, { status: 101, webSocket: p[0] } as ResponseInit);
  }

  /** Hand the server half of a socket to the hub (the client address keys the rate limits). */
  accept(server: CfWebSocket, ip: string): void {
    server.accept();
    this.hub.accept(adaptSocket(server, ip), ip);
  }

  stats() {
    return this.hub.stats();
  }

  flush(): Promise<void> {
    return this.registry?.flush() ?? Promise.resolve();
  }
}

export default {
  async fetch(req: Request, env: RelayEnv): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith(HOOKS_PATH)) {
      const id = url.pathname.slice(HOOKS_PATH.length).split("/")[0] ?? "";
      if (!env.HOOKS)
        return Response.json(
          { error: "not found: this relay has no HOOKS binding (webhook mailboxes)" },
          { status: 404, headers: HEADERS },
        );
      if (!HOOK_ID_RE.test(id))
        return Response.json({ error: "not found" }, { status: 404, headers: HEADERS });
      // One object per mailbox: mailboxes share no thread and no storage limit.
      return env.HOOKS.get(env.HOOKS.idFromName(id)).fetch(req);
    }
    if (url.pathname !== "/healthz" && url.pathname !== RELAY_PATH)
      return new Response("not found", { status: 404, headers: HEADERS });
    // One object for the whole relay: cores and devices must meet in one place.
    return env.RELAY.get(env.RELAY.idFromName("relay")).fetch(req);
  },
};
