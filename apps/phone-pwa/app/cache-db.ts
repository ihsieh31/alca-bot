// P13: IndexedDB under the offline cache — its own database, apart from the
// identity key's (keystore.ts), so wiping the cache can never touch the
// pairing. Values are sealed records and CryptoKey handles (structured clone
// keeps a non-extractable key non-extractable).
import type { RecordStore } from "./cache-crypto.ts";

const DB = "alca-phone-cache";
const STORE = "rec";

let conn: Promise<IDBDatabase> | undefined;

function open(): Promise<IDBDatabase> {
  conn ??= new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => {
      const db = r.result;
      db.onclose = () => (conn = undefined);
      db.onversionchange = () => {
        db.close();
        conn = undefined;
      };
      resolve(db);
    };
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new DOMException("IndexedDB is blocked by another tab", "InvalidStateError"));
  }).catch((e: unknown) => {
    conn = undefined;
    throw e;
  });
  return conn;
}

async function tx<T>(
  mode: IDBTransactionMode,
  f: (s: IDBObjectStore) => IDBRequest<T>,
  retry = true,
): Promise<T> {
  try {
    const db = await open();
    return await new Promise<T>((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = f(t.objectStore(STORE));
      let out: T;
      req.onsuccess = () => {
        out = req.result;
      };
      req.onerror = () => reject(req.error);
      t.oncomplete = () => resolve(out);
      t.onabort = () => reject(t.error ?? new DOMException("transaction aborted", "UnknownError"));
    });
  } catch (e) {
    // iOS can drop the connection under a backgrounded page: reopen once.
    if (!retry || !(e instanceof DOMException)) throw e;
    conn = undefined;
    return tx(mode, f, false);
  }
}

export const idbStore: RecordStore = {
  get: <T>(k: string) => tx<T | undefined>("readonly", (s) => s.get(k) as IDBRequest<T | undefined>),
  put: async (k, v) => void (await tx("readwrite", (s) => s.put(v, k))),
  del: async (k) => void (await tx("readwrite", (s) => s.delete(k))),
  keys: async (prefix) =>
    (
      await tx<IDBValidKey[]>("readonly", (s) => s.getAllKeys(IDBKeyRange.bound(prefix, `${prefix}\uffff`)))
    ).map(String),
  clear: async () => void (await tx("readwrite", (s) => s.clear())),
};

/** True when this page can keep the offline cache at all. */
export const hasIndexedDb = (): boolean => typeof indexedDB !== "undefined";
