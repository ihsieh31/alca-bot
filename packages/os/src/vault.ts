import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readWithRecovery, SecretFileCorruptError, writeFileAtomic } from "./atomic-file.ts";
import type { KeySource, KeyStatus } from "./keychain.ts";
import type { SecretStore } from "./secret-store.ts";

/**
 * Local secret vault (connector and provider API keys, the Telegram token,
 * site logins). Values are sealed with AES-256-GCM in one file
 * (`vault.json`, 0600); the file key comes from a `KeySource`. Only host code
 * reads values; no tool result, prompt or log ever carries one.
 *
 * Writes go through `writeFileAtomic` with a `.bak` of the last copy that
 * still decrypts; a file that no longer decrypts is restored from that
 * backup on the next read (the broken copy is kept as `vault.json.corrupt-*`).
 * `set` / `delete` run one at a time, so two concurrent calls in one process
 * can no longer overwrite each other's entry.
 */

interface Sealed {
  v: 1;
  iv: string;
  tag: string;
  data: string;
}

const AAD = Buffer.from("alca-vault-v1");

export class VaultError extends Error {
  /** "key_missing": the vault exists but its key is not where it should be; "unreadable": the file. */
  readonly code: "key_missing" | "unreadable";
  constructor(message: string, code: "key_missing" | "unreadable" = "unreadable") {
    super(message);
    this.name = "VaultError";
    this.code = code;
  }
}

function unseal(raw: Buffer, key: Buffer): Record<string, string> {
  const sealed = JSON.parse(raw.toString("utf8")) as Sealed;
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"));
  d.setAAD(AAD);
  d.setAuthTag(Buffer.from(sealed.tag, "base64"));
  const plain = Buffer.concat([d.update(Buffer.from(sealed.data, "base64")), d.final()]);
  const v = JSON.parse(plain.toString("utf8")) as unknown;
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
  return v as Record<string, string>;
}

function seal(values: Record<string, string>, key: Buffer): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(AAD);
  const data = Buffer.concat([c.update(Buffer.from(JSON.stringify(values), "utf8")), c.final()]);
  const sealed: Sealed = {
    v: 1,
    iv: iv.toString("base64"),
    tag: c.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
  return JSON.stringify(sealed);
}

export class Vault implements SecretStore {
  readonly path: string;
  private readonly source: KeySource;
  private readonly onRecover: ((note: string) => void) | undefined;
  private key: Buffer | undefined;
  private cache: Record<string, string> | undefined;
  /** The tail of the write queue: every set / delete waits for the one before. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(path: string, source: KeySource, o: { onRecover?: (note: string) => void } = {}) {
    this.path = path;
    this.source = source;
    this.onRecover = o.onRecover;
  }

  get keyKind(): string {
    return this.source.kind;
  }

  get backend(): string {
    return `vault:${this.source.kind}`;
  }

  /** Where the key lives and whether that is the degraded 0600 file (see KeyStatus). */
  keyStatus(): KeyStatus {
    if (this.source.status) return this.source.status();
    return this.source.kind === "file"
      ? { where: "file", degraded: true, reason: "保管庫金鑰在檔案 vault.key" }
      : { where: this.source.kind, degraded: false };
  }

  private async fileKey(): Promise<Buffer> {
    if (this.key) return this.key;
    let k = await this.source.load();
    if (!k) {
      if (existsSync(this.path) || existsSync(`${this.path}.bak`)) {
        const why = (this.source as { unavailable?: string }).unavailable;
        throw new VaultError(`找不到保管庫的金鑰；保管庫無法打開${why ? `（${why}）` : ""}`, "key_missing");
      }
      k = randomBytes(32);
      await this.source.save(k);
    }
    this.key = k;
    return k;
  }

  private async read(fresh = false): Promise<Record<string, string>> {
    if (this.cache && !fresh) return this.cache;
    if (!existsSync(this.path) && !existsSync(`${this.path}.bak`)) {
      this.cache = {};
      return this.cache;
    }
    const key = await this.fileKey();
    let r: ReturnType<typeof readWithRecovery<Record<string, string>>>;
    try {
      r = readWithRecovery(this.path, (b) => unseal(b, key));
    } catch (err) {
      if (err instanceof SecretFileCorruptError)
        throw new VaultError(
          "保管庫打不開（檔案壞了、被改過，或金鑰不對），備份 vault.json.bak 也無法使用；檔案沒有被改動",
        );
      throw err;
    }
    if (r.state === "absent") this.cache = {};
    else {
      if (r.state === "recovered") this.onRecover?.(r.note);
      this.cache = r.value;
      // The key really opens this vault: a key source may now settle where it keeps it.
      await this.source.confirmed?.();
    }
    return this.cache;
  }

  private async write(values: Record<string, string>): Promise<void> {
    const key = await this.fileKey();
    writeFileAtomic(this.path, seal(values, key), {
      mode: 0o600,
      backup: true,
      validate: (current) => !!unseal(current, key),
    });
    this.cache = values;
  }

  /** Run `fn` after every earlier set / delete has finished (or failed). */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async get(name: string): Promise<string | undefined> {
    return (await this.read())[name];
  }

  /** The names of the vault's entries (never their values). */
  async names(): Promise<string[]> {
    return Object.keys(await this.read());
  }

  /**
   * Read one entry back from the file on disk, decrypting it again (not from
   * the in-memory copy): the check after a migration or a new data key that
   * the value really is stored (next-round §6.4 step 1).
   */
  readBack(name: string): Promise<string | undefined> {
    return this.serial(async () => (await this.read(true))[name]);
  }

  /** Set several entries in ONE write: either all of them are in the new file or none. */
  setMany(entries: Record<string, string>): Promise<void> {
    return this.serial(async () => {
      await this.write({ ...(await this.read()), ...entries });
    });
  }

  /** Delete several entries in one write. */
  deleteMany(names: readonly string[]): Promise<void> {
    return this.serial(async () => {
      const all = { ...(await this.read()) };
      if (!names.some((n) => n in all)) return;
      for (const n of names) delete all[n];
      await this.write(all);
    });
  }

  async has(name: string): Promise<boolean> {
    return (await this.get(name)) !== undefined;
  }

  set(name: string, value: string): Promise<void> {
    return this.serial(async () => {
      await this.write({ ...(await this.read()), [name]: value });
    });
  }

  delete(name: string): Promise<void> {
    return this.serial(async () => {
      const all = { ...(await this.read()) };
      if (!(name in all)) return;
      delete all[name];
      await this.write(all);
    });
  }
}
