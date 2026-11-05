import { hkdfSync, randomBytes } from "node:crypto";
import { type SecretStore, storeAndVerify } from "./secret-store.ts";

/**
 * The data encryption key (DEK) for Phase F2's column encryption
 * (next-round design 2, R7.4), kept in the same sealed vault as the core's
 * other long-term keys, so its protection is the vault key's: the OS keychain,
 * or — degraded, and shown as such — the 0600 `vault.key`.
 *
 * Stored as one vault entry, `core.dbKey`, holding a small key ring so a
 * rotation adds key 2 without losing key 1 (rows sealed with `k: 1` must still
 * open):
 *
 *     {"v":1,"current":1,"keys":{"1":"<base64 32 bytes>"}}
 *
 * The entry starts with `core.`, so `alca secrets export` carries it and
 * `alca secrets reset` leaves it alone (losing it would make every sealed
 * column unreadable).
 */
export const DATA_KEY_NAME = "core.dbKey";

export interface DataKeyRing {
  /** The key id new rows are sealed with. */
  readonly current: number;
  /** The current key (32 bytes). */
  readonly key: Buffer;
  /** The key for an id found in a stored row; undefined if this ring never had it. */
  keyFor(id: number): Buffer | undefined;
  /** Every id in the ring, ascending. */
  readonly ids: readonly number[];
}

/** The `core.dbKey` entry cannot be used (malformed or missing a key). Nothing was written. */
export class DataKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataKeyError";
  }
}

interface Stored {
  v: 1;
  current: number;
  keys: Record<string, string>;
}

function parse(text: string): DataKeyRing {
  let s: Stored;
  try {
    s = JSON.parse(text) as Stored;
  } catch {
    throw new DataKeyError(`${DATA_KEY_NAME} 不是 JSON`);
  }
  if (s?.v !== 1 || !Number.isInteger(s.current) || !s.keys || typeof s.keys !== "object")
    throw new DataKeyError(`${DATA_KEY_NAME} 格式不對`);
  const map = new Map<number, Buffer>();
  for (const [id, b64] of Object.entries(s.keys)) {
    const n = Number(id);
    const key = typeof b64 === "string" ? Buffer.from(b64, "base64") : Buffer.alloc(0);
    if (!Number.isInteger(n) || n < 1 || key.length !== 32)
      throw new DataKeyError(`${DATA_KEY_NAME} 的金鑰 ${id} 格式不對`);
    map.set(n, key);
  }
  const key = map.get(s.current);
  if (!key) throw new DataKeyError(`${DATA_KEY_NAME} 沒有目前的金鑰 ${s.current}`);
  return {
    current: s.current,
    key,
    keyFor: (id) => map.get(id),
    ids: [...map.keys()].sort((a, b) => a - b),
  };
}

const encode = (current: number, keys: Map<number, Buffer>) =>
  JSON.stringify({
    v: 1,
    current,
    keys: Object.fromEntries([...keys].map(([id, k]) => [String(id), k.toString("base64")])),
  } satisfies Stored);

/**
 * The data key ring, or undefined when none was made yet. Never creates one:
 * a reader (backup restore, `db verify`) must not mint a key a database was
 * not sealed with. Throws DataKeyError when the entry is there but unusable,
 * and whatever the store throws when the vault cannot be opened (VaultError,
 * e.g. the keychain item is gone) — never a new key in that case.
 */
export async function getDataKey(store: SecretStore): Promise<DataKeyRing | undefined> {
  const text = await store.get(DATA_KEY_NAME);
  return text === undefined ? undefined : parse(text);
}

/**
 * The data key ring, making key 1 the first time: 32 random bytes, stored and
 * read back from the vault file before it is returned (next-round §6.4 step
 * 1), so no row is ever sealed with a key that did not reach the disk.
 * F2 calls this once at start, then writes its `meta.seal_check`.
 */
export async function ensureDataKey(store: SecretStore): Promise<{ ring: DataKeyRing; created: boolean }> {
  const have = await getDataKey(store);
  if (have) return { ring: have, created: false };
  const text = encode(1, new Map([[1, randomBytes(32)]]));
  await storeAndVerify(store, { [DATA_KEY_NAME]: text });
  return { ring: parse(text), created: true };
}

/**
 * Add a new key and make it current; the old keys stay so older rows still
 * open. Returns the new ring (stored and read back).
 */
export async function rotateDataKey(store: SecretStore): Promise<DataKeyRing> {
  const have = await getDataKey(store);
  if (!have) throw new DataKeyError(`還沒有 ${DATA_KEY_NAME}，不能輪替`);
  const keys = new Map(have.ids.map((id) => [id, have.keyFor(id) as Buffer]));
  const next = Math.max(...have.ids) + 1;
  keys.set(next, randomBytes(32));
  const text = encode(next, keys);
  await storeAndVerify(store, { [DATA_KEY_NAME]: text });
  return parse(text);
}

/**
 * A purpose-bound sub-key from a data key (HKDF-SHA256, empty salt), e.g.
 * R7.4's `ftsKey = deriveSubkey(ring.key, "alca fts")`. Different labels give
 * unrelated keys; the same label and key always give the same one.
 */
export function deriveSubkey(key: Buffer, label: string, length = 32): Buffer {
  if (!label) throw new DataKeyError("deriveSubkey 需要用途標籤");
  return Buffer.from(hkdfSync("sha256", key, Buffer.alloc(0), Buffer.from(label, "utf8"), length));
}
