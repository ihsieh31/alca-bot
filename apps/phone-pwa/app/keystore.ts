// The phone's own storage: one IndexedDB object store. The identity private
// key is a non-extractable CryptoKey (the browser keeps it; script can sign
// with it but never read it). Nothing secret is in localStorage.
import type { Identity, LinkCredentials } from "@alca/link/browser";

const DB = "alca-phone";
const STORE = "kv";

let conn: Promise<IDBDatabase> | undefined;

/**
 * One shared connection, reopened when the browser drops it. iOS Safari can
 * close IndexedDB under a backgrounded page ("Connection to Indexed Database
 * server lost"); another tab upgrading the schema sends `versionchange`.
 */
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

const transient = (e: unknown) =>
  e instanceof DOMException &&
  ["InvalidStateError", "UnknownError", "TransactionInactiveError"].includes(e.name);

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
    // A dropped connection: open a fresh one and try once more.
    if (!retry || !transient(e)) throw e;
    conn = undefined;
    return tx(mode, f, false);
  }
}

/** A quick read/write round trip for the diagnostics page (ms, or the error). */
export async function probeStorage(): Promise<{ ok: boolean; ms: number; error?: string }> {
  const t = performance.now();
  try {
    await kv.set("probe", Date.now());
    await kv.get("probe");
    return { ok: true, ms: Math.round(performance.now() - t) };
  } catch (e) {
    return { ok: false, ms: Math.round(performance.now() - t), error: String((e as Error).message ?? e) };
  }
}

export const kv = {
  get: <T>(k: string) => tx<T | undefined>("readonly", (s) => s.get(k) as IDBRequest<T | undefined>),
  set: (k: string, v: unknown) => tx("readwrite", (s) => s.put(v, k)),
  del: (k: string) => tx("readwrite", (s) => s.delete(k)),
};

export type ThemePref = "dark" | "light" | "system";

export interface Saved {
  identity?: Identity;
  credentials?: LinkCredentials;
  theme?: ThemePref;
  lastThread?: string;
}

export async function loadSaved(): Promise<Saved> {
  const [identity, credentials, theme, lastThread] = await Promise.all([
    kv.get<Identity>("identity"),
    kv.get<LinkCredentials>("credentials"),
    kv.get<ThemePref>("theme"),
    kv.get<string>("lastThread"),
  ]);
  return {
    ...(identity ? { identity } : {}),
    ...(credentials ? { credentials } : {}),
    ...(theme ? { theme } : {}),
    ...(lastThread ? { lastThread } : {}),
  };
}
