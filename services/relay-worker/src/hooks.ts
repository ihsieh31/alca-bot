// Webhook mailboxes on the Workers relay (review M3): the same protocol as the
// Node relay's `/v0/hooks` (services/rendezvous/src/hooks.ts), so a core on the
// official (Workers) relay gets connected-app trigger events too. One Durable
// Object per mailbox id (`HOOKS.idFromName(id)`), so mailboxes never share a
// thread or a storage limit; the object keeps only the SHA-256 of the pull
// token, the counter, and the waiting events (raw body + the three signature
// headers, at most a day). It cannot forge an event: the core checks the
// provider's signature.
//
//   PUT  /v0/hooks/<id>                 {pull: sha256(token) hex}  register (same hash = 200, new = 201, other = 409)
//   POST /v0/hooks/<id>                 the provider delivers (unknown id = 404)
//   GET  /v0/hooks/<id>/events?after=N  x-alca-pull: <token>  → {items, seq}; items ≤ N are dropped (ack)
import type { DurableState } from "./cf-types.ts";

export const HOOKS_PATH = "/v0/hooks/";
export const HOOK_ID_RE = /^[A-Za-z0-9_-]{22,64}$/;
const SIGNED_HEADERS = ["webhook-id", "webhook-timestamp", "webhook-signature"] as const;

export interface HookItem {
  seq: number;
  receivedAt: string;
  headers: Record<string, string>;
  body: string;
}

export interface HookObjectLimits {
  maxItems: number;
  maxBodyBytes: number;
  ttlMs: number;
}

/** The Node relay's defaults (services/rendezvous/src/hooks.ts). */
export const HOOK_DEFAULTS: HookObjectLimits = {
  maxItems: 500,
  maxBodyBytes: 256 * 1024,
  ttlMs: 24 * 3600_000,
};

interface BoxMeta {
  pull: string;
  seq: number;
  touched: number;
}

const HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-type": "application/json",
  "cache-control": "no-store",
};
const reply = (status: number, value: unknown) =>
  new Response(JSON.stringify(value), { status, headers: HEADERS });

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
async function sha256Hex(s: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}
/** Constant-time compare of two hex digests of the same length. */
function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

const itemKey = (seq: number) => `item:${String(seq).padStart(12, "0")}`;

/** Read at most `max` bytes of the body; undefined when it is larger. */
async function readBody(req: Request, max: number): Promise<string | undefined> {
  const declared = Number(req.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > max) return undefined;
  const buf = await req.arrayBuffer();
  if (buf.byteLength > max) return undefined;
  return new TextDecoder().decode(buf);
}

export class HookObject {
  private readonly state: DurableState;
  private readonly limits: HookObjectLimits;
  private readonly now: () => number;
  private meta: BoxMeta | undefined;
  private items: HookItem[] = [];
  private loaded: Promise<void>;

  constructor(
    state: DurableState,
    _env?: unknown,
    o: { limits?: Partial<HookObjectLimits>; now?: () => number } = {},
  ) {
    this.state = state;
    this.limits = { ...HOOK_DEFAULTS, ...o.limits };
    this.now = o.now ?? Date.now;
    this.loaded = state.blockConcurrencyWhile(() => this.load());
  }

  private async load(): Promise<void> {
    this.meta = await this.state.storage.get<BoxMeta>("box");
    const rows = await this.state.storage.list<HookItem>({ prefix: "item:" });
    this.items = [...rows.values()].sort((a, b) => a.seq - b.seq);
  }

  /** Drop events older than the TTL (and their storage rows). */
  private async sweep(now: number): Promise<void> {
    const old = this.items.filter((i) => now - Date.parse(i.receivedAt) >= this.limits.ttlMs);
    if (!old.length) return;
    this.items = this.items.filter((i) => !old.includes(i));
    await this.state.storage.delete(old.map((i) => itemKey(i.seq)));
  }

  private async schedule(now: number): Promise<void> {
    await this.state.storage.setAlarm?.(now + this.limits.ttlMs);
  }

  /** The alarm: expire events; a mailbox idle for a week with nothing waiting is removed (as on the Node relay). */
  async alarm(): Promise<void> {
    await this.loaded;
    const now = this.now();
    await this.sweep(now);
    if (!this.meta) return;
    if (now - this.meta.touched > this.limits.ttlMs * 7 && !this.items.length) {
      await this.state.storage.deleteAll?.();
      this.meta = undefined;
      this.items = [];
      return;
    }
    await this.schedule(now);
  }

  async fetch(req: Request): Promise<Response> {
    await this.loaded;
    const url = new URL(req.url);
    if (!url.pathname.startsWith(HOOKS_PATH)) return reply(404, { error: "not found" });
    const [id, sub, extra] = url.pathname.slice(HOOKS_PATH.length).split("/");
    if (!id || !HOOK_ID_RE.test(id) || extra !== undefined) return reply(404, { error: "not found" });
    const now = this.now();
    await this.sweep(now);
    const box = this.meta;
    if (req.method === "PUT" && sub === undefined) {
      const raw = await readBody(req, 4096);
      let pull = "";
      try {
        pull = String((JSON.parse(raw ?? "") as { pull?: unknown }).pull ?? "");
      } catch {
        pull = "";
      }
      if (!/^[0-9a-f]{64}$/.test(pull)) return reply(400, { error: "pull hash" });
      if (box) {
        if (!sameHex(box.pull, pull)) return reply(409, { error: "taken" });
        box.touched = now;
        await this.state.storage.put({ box });
        return reply(200, { ok: true });
      }
      this.meta = { pull, seq: 0, touched: now };
      this.items = [];
      await this.state.storage.put({ box: this.meta });
      await this.schedule(now);
      return reply(201, { ok: true });
    }
    if (req.method === "POST" && sub === undefined) {
      if (!box) return reply(404, { error: "not found" });
      const body = await readBody(req, this.limits.maxBodyBytes);
      if (body === undefined) return reply(413, { error: "too large" });
      const headers: Record<string, string> = {};
      for (const k of SIGNED_HEADERS) {
        const v = req.headers.get(k);
        if (v !== null) headers[k] = v.slice(0, 512);
      }
      box.seq += 1;
      const item: HookItem = { seq: box.seq, receivedAt: new Date(now).toISOString(), headers, body };
      this.items.push(item);
      const over =
        this.items.length > this.limits.maxItems
          ? this.items.splice(0, this.items.length - this.limits.maxItems)
          : [];
      await this.state.storage.put({ box, [itemKey(item.seq)]: item });
      if (over.length) await this.state.storage.delete(over.map((i) => itemKey(i.seq)));
      return reply(200, { ok: true });
    }
    if (req.method === "GET" && sub === "events") {
      const token = req.headers.get("x-alca-pull");
      if (!box || token === null || !sameHex(box.pull, await sha256Hex(token)))
        return reply(403, { error: "forbidden" });
      const asked = Number(url.searchParams.get("after") ?? 0) || 0;
      // Past our counter: this mailbox started over. Drop nothing.
      const after = asked > box.seq ? 0 : asked;
      const gone = this.items.filter((i) => i.seq <= after);
      this.items = this.items.filter((i) => i.seq > after);
      box.touched = now;
      await this.state.storage.put({ box });
      if (gone.length) await this.state.storage.delete(gone.map((i) => itemKey(i.seq)));
      return reply(200, { items: this.items.slice(0, 100), seq: box.seq });
    }
    return reply(405, { error: "method" });
  }
}
