// P13: the phone's encrypted offline cache, below the app: every record is
// AES-256-GCM sealed with a data key that never exists outside WebCrypto in a
// usable form.
//
//   KEK  AES-GCM 256, generated non-extractable, kept as a Key handle
//        (IndexedDB stores the handle; script cannot read its bytes, but the
//        browser persists them in the same profile as the records, so a reader
//        of the whole profile gets both — docs/SECURITY.md, offline cache).
//   DK   AES-GCM 256, made once, immediately wrapped with the KEK (AAD binds it
//        to this pairing's device id) and dropped; it is only ever unwrapped
//        as a non-extractable key for encrypt / decrypt.
//   rec  {iv, ct}: AES-GCM under DK, AAD = label ‖ device id ‖ record name, so
//        a record cannot be moved to another name or another pairing.
//
// A new pairing (another device id), a KEK that no longer opens the DK, or a
// record that does not open → the cache is wiped and starts empty: it is a
// cache, never the only copy. Forgetting the computer destroys the KEK and DK
// first (crypto-shredding), then the records. Pure WebCrypto: runs in Node.

export interface RecordStore {
  get<T>(k: string): Promise<T | undefined>;
  put(k: string, v: unknown): Promise<void>;
  del(k: string): Promise<void>;
  keys(prefix: string): Promise<string[]>;
  clear(): Promise<void>;
}

/** A RecordStore in memory (tests; a page where IndexedDB is unavailable keeps nothing across launches). */
export function memoryStore(): RecordStore & { map: Map<string, unknown> } {
  const map = new Map<string, unknown>();
  return {
    map,
    get: async <T>(k: string) => map.get(k) as T | undefined,
    put: async (k, v) => void map.set(k, v),
    del: async (k) => void map.delete(k),
    keys: async (p) => [...map.keys()].filter((k) => k.startsWith(p)),
    clear: async () => map.clear(),
  };
}

/** A WebCrypto key handle (named this way so the file also type-checks without the DOM lib). */
type Key = Parameters<typeof crypto.subtle.encrypt>[1];

const LABEL = "alca-cache/v1";
const enc = new TextEncoder();
const bytes = (t: string): Uint8Array<ArrayBuffer> => new Uint8Array(enc.encode(t));
const dec = new TextDecoder();

interface WrappedKey {
  v: 1;
  deviceId: string;
  iv: Uint8Array<ArrayBuffer>;
  data: ArrayBuffer;
}
interface Sealed {
  v: 1;
  iv: Uint8Array<ArrayBuffer>;
  ct: ArrayBuffer;
}

const iv = (): Uint8Array<ArrayBuffer> => crypto.getRandomValues(new Uint8Array(12));
const isKey = (k: unknown): k is Key =>
  !!k && typeof k === "object" && (k as Key).type === "secret" && "algorithm" in (k as object);

export class SealedStore {
  readonly deviceId: string;
  private readonly raw: RecordStore;
  private readonly dk: Key;

  private constructor(raw: RecordStore, deviceId: string, dk: Key) {
    this.raw = raw;
    this.deviceId = deviceId;
    this.dk = dk;
  }

  /** Open (or create) the cache for this pairing. */
  static async open(raw: RecordStore, deviceId: string): Promise<SealedStore> {
    const subtle = crypto.subtle;
    let kek = await raw.get<Key>("k:kek");
    const wrapped = await raw.get<WrappedKey>("k:dk");
    const aad = bytes(`${LABEL} dk|${deviceId}`);
    if (isKey(kek) && wrapped?.v === 1 && wrapped.deviceId === deviceId) {
      try {
        const dk = await subtle.unwrapKey(
          "raw",
          wrapped.data,
          kek,
          { name: "AES-GCM", iv: wrapped.iv, additionalData: aad },
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt", "decrypt"],
        );
        return new SealedStore(raw, deviceId, dk);
      } catch {
        // The KEK no longer opens it: start over below.
      }
    }
    // First launch, a new pairing, or keys that do not fit together: an empty cache with fresh keys.
    await raw.clear();
    kek = await subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["wrapKey", "unwrapKey"]);
    const fresh = await subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    const wiv = iv();
    const data = await subtle.wrapKey("raw", fresh, kek, { name: "AES-GCM", iv: wiv, additionalData: aad });
    await raw.put("k:kek", kek);
    await raw.put("k:dk", { v: 1, deviceId, iv: wiv, data } satisfies WrappedKey);
    // Use the key the way every later launch will: unwrapped, not extractable.
    const dk = await subtle.unwrapKey(
      "raw",
      data,
      kek,
      { name: "AES-GCM", iv: wiv, additionalData: aad },
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    return new SealedStore(raw, deviceId, dk);
  }

  private aad(name: string) {
    return bytes(`${LABEL}|${this.deviceId}|${name}`);
  }

  async put(name: string, value: unknown): Promise<void> {
    const i = iv();
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: i, additionalData: this.aad(name) },
      this.dk,
      bytes(JSON.stringify(value)),
    );
    await this.raw.put(`r:${name}`, { v: 1, iv: i, ct } satisfies Sealed);
  }

  async get<T>(name: string): Promise<T | undefined> {
    const rec = await this.raw.get<Sealed>(`r:${name}`);
    if (rec?.v !== 1) return undefined;
    try {
      const pt = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: rec.iv, additionalData: this.aad(name) },
        this.dk,
        rec.ct,
      );
      return JSON.parse(dec.decode(pt)) as T;
    } catch {
      // Tampered, moved or from another key: drop it.
      await this.raw.del(`r:${name}`);
      return undefined;
    }
  }

  del(name: string): Promise<void> {
    return this.raw.del(`r:${name}`);
  }

  async names(prefix = ""): Promise<string[]> {
    return (await this.raw.keys(`r:${prefix}`)).map((k) => k.slice(2));
  }

  /** Forget everything: the keys first (nothing left can be opened), then the records. */
  async destroy(): Promise<void> {
    await this.raw.del("k:kek");
    await this.raw.del("k:dk");
    await this.raw.clear();
  }
}
