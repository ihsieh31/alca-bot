import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { writeFileAtomic } from "@alca/os";

/**
 * Webhook mailboxes on the person's own relay (P6). A connected-app provider
 * (Composio) POSTs trigger events to `/v0/hooks/<id>`; the core, which has no
 * inbound port, pulls them with a token only it knows. The relay keeps the
 * raw body and the three signature headers in memory, bounded, for a day; it
 * cannot forge an event because the core checks the provider's signature.
 * With `file` set (`--hooks-file`), mailboxes and their waiting events are
 * also written there (0600, atomic rename) so a relay restart loses nothing.
 * A pull whose `after` is past the mailbox's own counter means the relay
 * started over: nothing is dropped and every waiting item is returned.
 *
 *   PUT  /v0/hooks/<id>                 {pull: sha256(token) hex}  register (same hash = ok, other = 409)
 *   POST /v0/hooks/<id>                 the provider delivers (unknown id = 404)
 *   GET  /v0/hooks/<id>/events?after=N  x-alca-pull: <token>  → {items}; items ≤ N are dropped (ack)
 */

export const HOOKS_PATH = "/v0/hooks/";
const ID_RE = /^[A-Za-z0-9_-]{22,64}$/;
const SIGNED_HEADERS = ["webhook-id", "webhook-timestamp", "webhook-signature"] as const;

export interface HookItem {
  seq: number;
  receivedAt: string;
  headers: Record<string, string>;
  body: string;
}

interface Box {
  pullHash: Buffer;
  seq: number;
  items: HookItem[];
  touched: number;
}

export interface HookLimits {
  maxBoxes: number;
  maxItems: number;
  maxBodyBytes: number;
  ttlMs: number;
  /** Keep the mailboxes in this file across restarts (default: memory only). */
  file?: string;
}

interface Saved {
  v: 1;
  boxes: Array<{ id: string; pull: string; seq: number; touched: number; items: HookItem[] }>;
}

const DEFAULTS: HookLimits = {
  maxBoxes: 1000,
  maxItems: 500,
  maxBodyBytes: 256 * 1024,
  ttlMs: 24 * 3600_000,
};

const sha = (s: string) => createHash("sha256").update(s).digest();

async function readBody(req: IncomingMessage, max: number): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req as AsyncIterable<Buffer>) {
    size += c.length;
    if (size > max) return undefined;
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const reply = (res: ServerResponse, status: number, value: unknown, headers: Record<string, string>) => {
  res.writeHead(status, { ...headers, "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
};

const done = (res: ServerResponse, status: number, value: unknown, headers: Record<string, string>): true => {
  reply(res, status, value, headers);
  return true;
};

export class HookBoxes {
  private readonly boxes = new Map<string, Box>();
  private readonly limits: HookLimits;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  constructor(limits: Partial<HookLimits> = {}) {
    this.limits = { ...DEFAULTS, ...limits };
    this.load();
  }

  private load(): void {
    const f = this.limits.file;
    if (!f || !existsSync(f)) return;
    try {
      const saved = JSON.parse(readFileSync(f, "utf8")) as Saved;
      for (const b of saved.boxes ?? []) {
        if (!ID_RE.test(b.id) || !/^[0-9a-f]{64}$/.test(b.pull)) continue;
        this.boxes.set(b.id, {
          pullHash: Buffer.from(b.pull, "hex"),
          seq: Number(b.seq) || 0,
          touched: Number(b.touched) || Date.now(),
          items: Array.isArray(b.items) ? b.items.slice(-this.limits.maxItems) : [],
        });
      }
    } catch {
      // A damaged file starts empty; the core registers again on its next pull.
    }
  }

  /** Write the mailboxes now (also called on close). */
  flush(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    const f = this.limits.file;
    if (!f) return;
    const saved: Saved = {
      v: 1,
      boxes: [...this.boxes].map(([id, b]) => ({
        id,
        pull: b.pullHash.toString("hex"),
        seq: b.seq,
        touched: b.touched,
        items: b.items,
      })),
    };
    writeFileAtomic(f, JSON.stringify(saved), { mode: 0o600 });
  }

  private changed(): void {
    if (!this.limits.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      try {
        this.flush();
      } catch {
        // Disk trouble: keep serving from memory and try again on the next change.
      }
    }, 200);
    this.saveTimer.unref?.();
  }

  stats(): { hooks: number } {
    return { hooks: this.boxes.size };
  }

  private sweep(now: number): void {
    for (const [id, b] of this.boxes) {
      b.items = b.items.filter((i) => now - Date.parse(i.receivedAt) < this.limits.ttlMs);
      if (now - b.touched > this.limits.ttlMs * 7 && !b.items.length) this.boxes.delete(id);
    }
  }

  /** Handle a request under `/v0/hooks/`; false when the path is not ours. */
  async handle(req: IncomingMessage, res: ServerResponse, headers: Record<string, string>): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://x");
    if (!url.pathname.startsWith(HOOKS_PATH)) return false;
    const [id, sub, extra] = url.pathname.slice(HOOKS_PATH.length).split("/");
    if (!id || !ID_RE.test(id) || extra !== undefined) return done(res, 404, { error: "not found" }, headers);
    const now = Date.now();
    this.sweep(now);
    const box = this.boxes.get(id);
    if (req.method === "PUT" && sub === undefined) {
      const raw = await readBody(req, 4096);
      let pull = "";
      try {
        pull = String((JSON.parse(raw ?? "") as { pull?: unknown }).pull ?? "");
      } catch {
        pull = "";
      }
      if (!/^[0-9a-f]{64}$/.test(pull)) return done(res, 400, { error: "pull hash" }, headers);
      const hash = Buffer.from(pull, "hex");
      if (box) {
        const same = timingSafeEqual(box.pullHash, hash);
        if (!same) return done(res, 409, { error: "taken" }, headers);
        box.touched = now;
        return done(res, 200, { ok: true }, headers);
      }
      if (this.boxes.size >= this.limits.maxBoxes) return done(res, 503, { error: "full" }, headers);
      this.boxes.set(id, { pullHash: hash, seq: 0, items: [], touched: now });
      this.changed();
      return done(res, 201, { ok: true }, headers);
    }
    if (req.method === "POST" && sub === undefined) {
      if (!box) return done(res, 404, { error: "not found" }, headers);
      const body = await readBody(req, this.limits.maxBodyBytes);
      if (body === undefined) return done(res, 413, { error: "too large" }, headers);
      const h: Record<string, string> = {};
      for (const k of SIGNED_HEADERS) {
        const v = req.headers[k];
        if (typeof v === "string") h[k] = v.slice(0, 512);
      }
      box.seq += 1;
      box.items.push({ seq: box.seq, receivedAt: new Date(now).toISOString(), headers: h, body });
      if (box.items.length > this.limits.maxItems)
        box.items.splice(0, box.items.length - this.limits.maxItems);
      this.changed();
      return done(res, 200, { ok: true }, headers);
    }
    if (req.method === "GET" && sub === "events") {
      const token = req.headers["x-alca-pull"];
      if (!box || typeof token !== "string" || !timingSafeEqual(box.pullHash, sha(token)))
        return done(res, 403, { error: "forbidden" }, headers);
      const asked = Number(url.searchParams.get("after") ?? 0) || 0;
      // Past our counter: this mailbox started over (a relay without a file restarted). Drop nothing.
      const after = asked > box.seq ? 0 : asked;
      const before = box.items.length;
      box.items = box.items.filter((i) => i.seq > after);
      box.touched = now;
      if (box.items.length !== before) this.changed();
      return done(res, 200, { items: box.items.slice(0, 100), seq: box.seq }, headers);
    }
    return done(res, 405, { error: "method" }, headers);
  }
}
