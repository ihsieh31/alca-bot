import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { type DataKeyRing, deriveSubkey } from "@alca/os";

/**
 * Next round R7.4 (Phase F2): column encryption.
 *
 * One `Sealer` per database connection, made from the data key ring of D1
 * (`ensureDataKey` / `getDataKey`, vault entry `core.dbKey`). Every content
 * column listed in `SEALED` is written through `seal` and read through
 * `open`; nothing else in the repo touches those columns with SQL (a test
 * scans for it).
 *
 * Stored form, for every sealed column alike (valid JSON, so the
 * `CHECK (json_valid(payload))` columns still pass):
 *
 *     {"$enc":1,"k":<key id>,"d":"<base64(nonce12 ‖ ciphertext ‖ tag16)>"}
 *
 * AES-256-GCM; the associated data is `table|column|primary key`, so a value
 * moved to another row or column does not open. Reads accept plaintext too
 * (rows written before the key existed, until the background pass seals
 * them).
 *
 * The connection-to-sealer map (`bindSealer` / `sealerOf`) is how the repos,
 * the jobs runtime and the database worker find it without each repo taking
 * a new constructor argument.
 */

/** A key ring as D1 returns it (`DataKeyRing`), or the same shape rebuilt in the worker. */
export type SealRing = Pick<DataKeyRing, "current" | "key" | "keyFor" | "ids">;

/** The ring as plain data (crosses `postMessage` to the database worker; never written anywhere). */
export interface SealWire {
  current: number;
  keys: Record<string, string>;
}

export class SealError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SealError";
  }
}

/** The database was sealed with another data key (or the key is gone): nothing is written. */
export class SealKeyMismatchError extends SealError {
  constructor(message: string) {
    super(message);
    this.name = "SealKeyMismatchError";
  }
}

/**
 * Every sealed column, by table, with the columns that make up the row's
 * identity for the associated data. One list: the repos, the background
 * pass, export / import, and the static scan test all read it.
 * `memories.search_terms` is not here: it holds keyed tokens (`ftsTerms`).
 */
export const SEALED: Readonly<Record<string, { cols: readonly string[]; pk: readonly string[] }>> = {
  messages: { cols: ["content"], pk: ["id"] },
  run_events: { cols: ["payload"], pk: ["run_id", "seq"] },
  job_events: { cols: ["payload"], pk: ["job_id", "seq"] },
  jobs: { cols: ["title", "input", "result"], pk: ["id"] },
  spills: { cols: ["body"], pk: ["id"] },
  trigger_events: { cols: ["payload"], pk: ["id"] },
  router_inbox: { cols: ["body"], pk: ["id"] },
  worker_inbox: { cols: ["body"], pk: ["id"] },
  workers: { cols: ["goal", "result_summary"], pk: ["id"] },
  approvals: { cols: ["summary"], pk: ["id"] },
  dispatches: { cols: ["report"], pk: ["id"] },
  memories: { cols: ["body", "quote"], pk: ["id"] },
  drafts: { cols: ["body"], pk: ["id"] },
  routine_items: { cols: ["payload"], pk: ["routine_id", "item_key"] },
  // Item 4 (migration 30): an add-on offer is written from mail / calendar facts.
  // Review 2026-11-05 #2 (migration 31): `topic` was a plaintext prefix of `action`.
  offers: { cols: ["text", "action", "topic"], pk: ["id"] },
  // Review 2026-11-05 #3 (migration 31): an add-on's state (主動留意's queue holds candidate facts).
  bot_addons: { cols: ["state_json"], pk: ["bot_id", "addon_id"] },
};

export type SealedTable = keyof typeof SEALED;

const MARK = '{"$enc":';
const HEAD = '{"$enc":1,"k":';
const DATA = ',"d":"';

/** `{k, d}` of the exact form `seal` writes (no JSON.parse, no regex over a long value), else undefined. */
function parseCanonical(s: string): { k: number; d: string } | undefined {
  if (!s.startsWith(HEAD) || !s.endsWith('"}')) return undefined;
  const at = s.indexOf(DATA, HEAD.length);
  if (at < 0 || at > HEAD.length + 9) return undefined;
  const ks = s.slice(HEAD.length, at);
  if (!/^\d{1,9}$/.test(ks)) return undefined;
  const from = at + DATA.length;
  const end = s.length - 2;
  // The data is base64: no quote or backslash before the closing quote.
  if (s.indexOf('"', from) !== end || s.indexOf("\\", from) >= 0) return undefined;
  return { k: Number(ks), d: s.slice(from, end) };
}

/** `{k, d}` of a sealed value, or undefined (one parse; R7.7: a read used to parse it three times). */
function parseSealed(stored: unknown): { k: number; d: string } | undefined {
  if (typeof stored !== "string" || !stored.startsWith(MARK)) return undefined;
  const c = parseCanonical(stored);
  if (c) return c;
  try {
    const v = JSON.parse(stored) as { $enc?: unknown; k?: unknown; d?: unknown };
    return v.$enc === 1 && Number.isInteger(v.k) && typeof v.d === "string"
      ? { k: v.k as number, d: v.d }
      : undefined;
  } catch {
    return undefined;
  }
}

/** True for a value in the sealed form (cheap check, then the shape). */
export function isSealedText(stored: unknown): stored is string {
  return parseSealed(stored) !== undefined;
}

/**
 * Nonces come from a pool filled by one `randomBytes` call (R7.7: one call
 * per value cost about a third of a seal). Still 96 random bits each, and a
 * slice is handed out once.
 */
const NONCE = 12;
const POOL = NONCE * 1024;
let pool = Buffer.alloc(0);
let poolAt = POOL;
function nonce(): Buffer {
  if (poolAt + NONCE > pool.length) {
    pool = randomBytes(POOL);
    poolAt = 0;
  }
  const n = pool.subarray(poolAt, poolAt + NONCE);
  poolAt += NONCE;
  return n;
}

/** The SQL twin of `isSealedText` (the triggers of migration 25 use the same test). */
export const SQL_IS_SEALED = (x: string) =>
  `(CASE WHEN json_valid(${x}) THEN json_extract(${x}, '$."$enc"') END) IS 1`;

export const pkOf = (tbl: string, row: Record<string, unknown>): string => {
  const spec = SEALED[tbl];
  if (!spec) throw new SealError(`${tbl} has no sealed columns`);
  return spec.pk.map((c) => String(row[c] ?? "")).join(":");
};

function ringFromWire(w: SealWire): SealRing {
  const map = new Map<number, Buffer>();
  for (const [id, b64] of Object.entries(w.keys)) map.set(Number(id), Buffer.from(b64, "base64"));
  const key = map.get(w.current);
  if (key?.length !== 32) throw new SealError("資料金鑰格式不對");
  return { current: w.current, key, keyFor: (id) => map.get(id), ids: [...map.keys()].sort((a, b) => a - b) };
}

export class Sealer {
  private readonly ring: SealRing;
  /** R7.4: `ftsKey = HKDF(DEK, "alca fts")` (D1's `deriveSubkey`). */
  readonly ftsKey: Buffer;

  constructor(ring: SealRing | SealWire) {
    this.ring = "keyFor" in ring ? ring : ringFromWire(ring);
    this.ftsKey = deriveSubkey(this.ring.key, "alca fts");
  }

  get currentKeyId(): number {
    return this.ring.current;
  }

  get keyIds(): readonly number[] {
    return this.ring.ids;
  }

  /**
   * A fingerprint of the key ring (HMAC of its first key; a rotation keeps
   * it). Stored in plain as `meta.seal_ring` so a restore can tell a backup
   * of another ring without opening the vault. Says nothing about the key.
   */
  get ringId(): string {
    const first = this.ring.keyFor(this.ring.ids[0] as number) as Buffer;
    return createHmac("sha256", first).update("alca seal ring", "utf8").digest("hex").slice(0, 16);
  }

  /** Plain data for the database worker (stays in memory). */
  toWire(): SealWire {
    const keys: Record<string, string> = {};
    for (const id of this.ring.ids) keys[String(id)] = (this.ring.keyFor(id) as Buffer).toString("base64");
    return { current: this.ring.current, keys };
  }

  isSealed(stored: unknown): boolean {
    return isSealedText(stored);
  }

  seal(tbl: string, col: string, pk: string, text: string): string {
    const n = nonce();
    const c = createCipheriv("aes-256-gcm", this.ring.key, n);
    c.setAAD(Buffer.from(`${tbl}|${col}|${pk}`, "utf8"));
    const ct = c.update(text, "utf8");
    c.final(); // GCM: no trailing block
    const d = Buffer.concat([n, ct, c.getAuthTag()]).toString("base64");
    return `{"$enc":1,"k":${this.ring.current},"d":"${d}"}`;
  }

  /** Plaintext as is; a sealed value opened (wrong key, row or column → SealError). */
  open(tbl: string, col: string, pk: string, stored: string): string {
    const v = parseSealed(stored);
    if (!v) return stored;
    const key = this.ring.keyFor(v.k);
    if (!key) throw new SealError(`${tbl}.${col} 用的是資料金鑰 ${v.k}，目前的金鑰環沒有它`);
    const raw = Buffer.from(v.d, "base64");
    if (raw.length < 28) throw new SealError(`${tbl}.${col} 的密文毀損`);
    const d = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
    d.setAAD(Buffer.from(`${tbl}|${col}|${pk}`, "utf8"));
    d.setAuthTag(raw.subarray(raw.length - 16));
    try {
      const out = d.update(raw.subarray(12, raw.length - 16));
      d.final(); // checks the tag
      return out.toString("utf8");
    } catch {
      throw new SealError(`${tbl}.${col}（${pk}）解不開：金鑰不對，或密文被搬到別列、被改過`);
    }
  }

  /** One keyed FTS token (R7.4: first 10 hex chars of HMAC-SHA256). */
  ftsToken(token: string): string {
    return createHmac("sha256", this.ftsKey).update(token, "utf8").digest("hex").slice(0, 10);
  }
}

// ── connection → sealer ────────────────────────────────────────────────────

const BOUND = new WeakMap<DatabaseSync, Sealer>();

/** Make `sealer` the one used for every write and read on `db`. */
export function bindSealer(db: DatabaseSync, sealer: Sealer | undefined): void {
  if (sealer) BOUND.set(db, sealer);
  else BOUND.delete(db);
}

export function sealerOf(db: DatabaseSync): Sealer | undefined {
  return BOUND.get(db);
}

/** Seal one value for writing (null stays null; no sealer → as is). */
export function sealValue<T extends string | null | undefined>(
  db: DatabaseSync,
  tbl: SealedTable,
  col: string,
  pk: string,
  text: T,
): T | string {
  const s = BOUND.get(db);
  if (!s || typeof text !== "string") return text;
  return s.seal(tbl, col, pk, text);
}

/** Open one stored value (plaintext passes; sealed without a sealer → SealError). */
export function openValue<T extends string | null | undefined>(
  db: DatabaseSync,
  tbl: SealedTable,
  col: string,
  pk: string,
  stored: T,
): T | string {
  if (typeof stored !== "string" || !stored.startsWith(MARK)) return stored;
  const s = BOUND.get(db);
  if (!s) {
    if (!isSealedText(stored)) return stored;
    throw new SealError(`${tbl}.${col} 是加密的，但這次啟動沒有資料金鑰`);
  }
  return s.open(tbl, col, pk, stored);
}

/** Open every sealed column of one row in place (export, scans). */
export function openRow<R extends Record<string, unknown>>(db: DatabaseSync, tbl: string, row: R): R {
  const spec = SEALED[tbl];
  if (!spec) return row;
  const pk = pkOf(tbl, row);
  const out: Record<string, unknown> = { ...row };
  for (const c of spec.cols)
    if (typeof out[c] === "string") out[c] = openValue(db, tbl as SealedTable, c, pk, out[c] as string);
  return out as R;
}

/** Seal every sealed column of one row (import: after the row got its new id). */
export function sealRow<R extends Record<string, unknown>>(db: DatabaseSync, tbl: string, row: R): R {
  const spec = SEALED[tbl];
  if (!spec || !BOUND.get(db)) return row;
  const pk = pkOf(tbl, row);
  const out: Record<string, unknown> = { ...row };
  for (const c of spec.cols)
    if (typeof out[c] === "string") out[c] = sealValue(db, tbl as SealedTable, c, pk, out[c] as string);
  return out as R;
}

// ── meta: the key check and the background pass's progress ─────────────────

const CHECK_TEXT = "alca";

const meta = (db: DatabaseSync, k: string): string | undefined =>
  (db.prepare("SELECT v FROM meta WHERE k = ?").get(k) as { v: string } | undefined)?.v;

const hasMeta = (db: DatabaseSync) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();

/**
 * R7.5 step 2: the first start with a key writes `meta.seal_check`; every
 * later start opens it. A database sealed with another key (or a key ring
 * that lost the key it used) throws SealKeyMismatchError before anything is
 * written. A database that has sealed rows but no key at all is refused the
 * same way (`sealer` undefined).
 */
export function checkSealKey(db: DatabaseSync, sealer: Sealer | undefined): "new" | "ok" | "none" {
  if (!hasMeta(db)) return "none";
  const stored = meta(db, "seal_check");
  if (!sealer) {
    if (stored) throw new SealKeyMismatchError("資料庫已加密，但讀不到資料金鑰（core.dbKey）");
    return "none";
  }
  if (!stored) {
    db.prepare("INSERT INTO meta (k, v) VALUES ('seal_check', ?)").run(
      sealer.seal("meta", "check", "v1", CHECK_TEXT),
    );
    db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('seal_ring', ?)").run(sealer.ringId);
    return "new";
  }
  let text: string;
  try {
    text = sealer.open("meta", "check", "v1", stored);
  } catch {
    throw new SealKeyMismatchError(
      "資料庫是用另一把資料金鑰加密的（core.dbKey 不對），已停止，沒有寫入任何資料",
    );
  }
  if (text !== CHECK_TEXT) throw new SealKeyMismatchError("資料金鑰檢查值不對");
  return "ok";
}

/** `meta.seal_ring` of a database (undefined: never sealed, or before migration 25). */
export function sealRingOf(db: DatabaseSync): string | undefined {
  return hasMeta(db) ? meta(db, "seal_ring") : undefined;
}

/** True when `db`'s seal check opens with `sealer` (backup restore); "none" when the file was never sealed. */
export function sealCheckOpens(db: DatabaseSync, sealer: Sealer | undefined): boolean | "none" {
  if (!hasMeta(db)) return "none";
  const stored = meta(db, "seal_check");
  if (!stored) return "none";
  if (!sealer) return false;
  try {
    return sealer.open("meta", "check", "v1", stored) === CHECK_TEXT;
  } catch {
    return false;
  }
}

export function readSealProgress(db: DatabaseSync): Record<string, string> {
  if (!hasMeta(db)) return {};
  try {
    return JSON.parse(meta(db, "seal_progress") ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

export function writeSealProgress(db: DatabaseSync, p: Record<string, string>): void {
  db.prepare(
    "INSERT INTO meta (k, v) VALUES ('seal_progress', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
  ).run(JSON.stringify(p));
}
