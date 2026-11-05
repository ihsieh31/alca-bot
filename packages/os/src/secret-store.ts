/**
 * The one interface every secret goes through: connector and provider keys,
 * the Telegram token, site logins, and (Phase D1) the core's own long-term
 * keys — the Link identity, the VAPID key and, for Phase F2, the data key.
 * The implementation is the sealed `Vault`, whose file key lives in the OS
 * keychain (macOS Keychain, the freedesktop Secret Service) or, degraded, in
 * a 0600 `vault.key`; `backend` names which (`vault:keychain-macos`,
 * `vault:secret-service`, `vault:file`, `vault:auto` before it is decided).
 */
export interface SecretStore {
  readonly backend: string;
  get(name: string): Promise<string | undefined>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
  /** Entry names only, never values. */
  names(): Promise<string[]>;
  /** Optional: read one entry again from durable storage, not from a cache (Vault has it). */
  readBack?(name: string): Promise<string | undefined>;
  /** Optional: set several entries in one write, all or none (Vault has it). */
  setMany?(entries: Record<string, string>): Promise<void>;
}

/** Set every entry, in one write when the store can. */
export async function storeAll(store: SecretStore, entries: Record<string, string>): Promise<void> {
  if (store.setMany) return store.setMany(entries);
  for (const [k, v] of Object.entries(entries)) await store.set(k, v);
}

/**
 * Store `entries` and prove they are durable: every value read back from
 * storage (not a cache) must equal what was written. Throws, naming the first
 * entry that did not come back; the caller keeps its old copy in that case.
 */
export async function storeAndVerify(store: SecretStore, entries: Record<string, string>): Promise<void> {
  await storeAll(store, entries);
  for (const [k, v] of Object.entries(entries)) {
    const back = store.readBack ? await store.readBack(k) : await store.get(k);
    if (back !== v) throw new Error(`寫進保管庫後讀回不一致：${k}`);
  }
}
