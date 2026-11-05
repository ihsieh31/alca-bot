import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import { writeFileAtomic } from "./atomic-file.ts";

/**
 * Where the vault's file key lives: the OS keychain when one is reachable
 * (macOS Keychain via `security`, the freedesktop Secret Service via
 * `secret-tool`), else a 0600 key file next to the vault. Moved here from the
 * connectors package unchanged, except that the key file is now written
 * atomically (a torn `vault.key` would lock the whole vault).
 */

export interface KeySource {
  /** "keychain-macos" | "secret-service" | "file" */
  readonly kind: string;
  load(): Promise<Buffer | undefined>;
  save(key: Buffer): Promise<void>;
  /** Where the key is and, when it is NOT in an OS keychain, why (LazyKeySource; others omit it). */
  status?(): KeyStatus;
  /**
   * The vault opened with the key `load()` returned. LazyKeySource uses it to
   * move a key read from the old shared item into this folder's own item, only
   * once it is known to open this folder's vault.
   */
  confirmed?(): Promise<void>;
}

/**
 * Where the vault key lives, said plainly (next-round §6.4 "明確標示"):
 * `degraded` is true whenever the key sits in the 0600 `vault.key` next to
 * the vault, which protects about as much as a plaintext 0600 file.
 */
export interface KeyStatus {
  /** "keychain-macos" | "secret-service" | "file" | "undecided" (nothing stored or read yet). */
  where: string;
  degraded: boolean;
  /** Why the key is (or will be) in the file; absent when it is in a keychain. */
  reason?: string;
  /** The file was asked for (`ALCA_VAULT_BACKEND=file`), not fallen back to. */
  forced?: boolean;
}

/**
 * The keychain did not answer at all (no `security` / `secret-tool`, no
 * D-Bus session, keychain locked or refused), as opposed to "answered: no
 * such item". Carries a short human reason for `alca secrets status`.
 */
export class KeychainUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeychainUnavailableError";
  }
}

const SERVICE = "alca-agent";
const ACCOUNT = "vault-key";

/** What a keychain command returned. `missing`: the program itself is not installed. */
export interface CommandResult {
  code: number;
  out: string;
  err?: string;
  missing?: boolean;
}

function run(cmd: string, args: string[], input?: string): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { timeout: 10_000 }, (err, stdout, stderr) => {
      const raw = (err as { code?: number | string } | null)?.code;
      const code = err ? Number(raw ?? 1) || 1 : 0;
      resolve({ code, out: String(stdout ?? ""), err: String(stderr ?? ""), missing: raw === "ENOENT" });
    });
    child.stdin?.on("error", () => undefined); // the program is missing: execFile reports it
    if (input !== undefined) child.stdin?.end(input);
  });
}

const firstLine = (s: string | undefined) => (s ?? "").trim().split("\n")[0]?.slice(0, 200) ?? "";

/** A 0600 key file. The fallback when no keychain answers. */
export class FileKeySource implements KeySource {
  readonly kind = "file";
  private readonly path: string;
  constructor(path: string) {
    this.path = path;
  }
  async load(): Promise<Buffer | undefined> {
    if (!existsSync(this.path)) return undefined;
    const b = Buffer.from(readFileSync(this.path, "utf8").trim(), "base64");
    return b.length === 32 ? b : undefined;
  }
  async save(key: Buffer): Promise<void> {
    writeFileAtomic(this.path, `${key.toString("base64")}\n`, { mode: 0o600 });
  }
}

export type CommandRunner = (cmd: string, args: string[], input?: string) => Promise<CommandResult>;

/** macOS `security`: exit 44 is errSecItemNotFound ("could not be found in the keychain"). */
const MAC_NOT_FOUND = 44;

/** macOS Keychain through the system `security` tool. */
export class MacKeychainKeySource implements KeySource {
  readonly kind = "keychain-macos";
  private readonly exec: CommandRunner;
  readonly account: string;
  constructor(exec: CommandRunner = run, account = ACCOUNT) {
    this.exec = exec;
    this.account = account;
  }
  async load(): Promise<Buffer | undefined> {
    const r = await this.exec("security", ["find-generic-password", "-a", this.account, "-s", SERVICE, "-w"]);
    if (r.missing) throw new KeychainUnavailableError("找不到 /usr/bin/security");
    if (r.code === MAC_NOT_FOUND) return undefined;
    // Any other failure (keychain locked, access refused, no login keychain) is
    // "did not answer", never "no key": the caller must not make a new one.
    if (r.code !== 0)
      throw new KeychainUnavailableError(
        `macOS 鑰匙圈沒有回應（security 結束碼 ${r.code}${firstLine(r.err) ? `：${firstLine(r.err)}` : ""}）`,
      );
    const b = Buffer.from(r.out.trim(), "base64");
    return b.length === 32 ? b : undefined;
  }
  async save(key: Buffer): Promise<void> {
    // `security -i` reads its command from stdin, so the key never appears in a
    // process listing (as `-w <key>` on the command line would). Base64 has no
    // spaces or quotes, so it is one word to security's own line parser.
    // Interactive mode can exit 0 after a refused command: read it back to be sure.
    const value = key.toString("base64");
    const r = await this.exec(
      "security",
      ["-i"],
      `add-generic-password -U -a ${this.account} -s ${SERVICE} -w ${value}\n`,
    );
    if (r.missing) throw new KeychainUnavailableError("找不到 /usr/bin/security");
    const back = r.code === 0 ? await this.load() : undefined;
    if (!back?.equals(key))
      throw new KeychainUnavailableError(
        `macOS 鑰匙圈拒絕存入保管庫金鑰${firstLine(r.err) ? `（${firstLine(r.err)}）` : ""}`,
      );
  }
}

/** freedesktop Secret Service (GNOME Keyring, KWallet) through `secret-tool`; the value goes over stdin. */
export class SecretServiceKeySource implements KeySource {
  readonly kind = "secret-service";
  private readonly exec: CommandRunner;
  readonly account: string;
  constructor(exec: CommandRunner = run, account = ACCOUNT) {
    this.exec = exec;
    this.account = account;
  }
  async load(): Promise<Buffer | undefined> {
    const r = await this.exec("secret-tool", ["lookup", "service", SERVICE, "account", this.account]);
    if (r.missing) throw new KeychainUnavailableError("沒有安裝 secret-tool（libsecret-tools）");
    // `secret-tool lookup` exits 1 both for "no such item" (nothing on stderr)
    // and for "no Secret Service / no D-Bus session" (a message on stderr).
    if (r.code !== 0 && firstLine(r.err))
      throw new KeychainUnavailableError(`Secret Service 沒有回應（${firstLine(r.err)}）`);
    if (r.code !== 0) return undefined;
    const b = Buffer.from(r.out.trim(), "base64");
    return b.length === 32 ? b : undefined;
  }
  async save(key: Buffer): Promise<void> {
    const r = await this.exec(
      "secret-tool",
      ["store", "--label=Alca vault key", "service", SERVICE, "account", this.account],
      key.toString("base64"),
    );
    if (r.missing) throw new KeychainUnavailableError("沒有安裝 secret-tool（libsecret-tools）");
    if (r.code !== 0)
      throw new KeychainUnavailableError(
        `Secret Service 拒絕存入保管庫金鑰${firstLine(r.err) ? `（${firstLine(r.err)}）` : ""}`,
      );
    // Read it back, as on macOS: a locked collection can accept and still not keep it.
    const back = await this.load();
    if (!back?.equals(key)) throw new KeychainUnavailableError("Secret Service 存入後讀不回保管庫金鑰");
  }
}

const realish = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/**
 * The keychain item's account for a data folder: `vault-key` for the default
 * one (`~/.alca`, as before), `vault-key-<12 hex of sha256(path)>` for any
 * other, so a test run or a second data folder never reads or overwrites the
 * person's main item (mac test 2026-11-04b E7).
 */
export function keychainAccount(dir: string, home = homedir()): string {
  const d = realish(dir);
  if (d === realish(join(home, ".alca"))) return ACCOUNT;
  return `${ACCOUNT}-${createHash("sha256").update(d).digest("hex").slice(0, 12)}`;
}

export type VaultBackend = "auto" | "file";

/** `ALCA_VAULT_BACKEND=file` (or the older `ALCA_VAULT_KEY=file`) keeps the key in a file only. */
export function vaultBackendFromEnv(env: Record<string, string | undefined> = process.env): VaultBackend {
  return env.ALCA_VAULT_BACKEND === "file" || env.ALCA_VAULT_KEY === "file" ? "file" : "auto";
}

/**
 * Mac test 2026-11-04b E7: the core went to the login keychain on every start
 * (and wrote a probe key there) even with nothing to keep. Now nothing is
 * decided until the vault needs its key, which is only when a secret is stored
 * or one already stored is read:
 *
 * - a `vault.key` in the data folder (or backend "file") → that file;
 * - reading with no key file → the keychain item for this folder; for a
 *   folder that is not the default AND already has a vault (vault.json or its
 *   .bak), the old shared item as a last try, read only, so a vault made
 *   before E7 still opens. Once the vault opens with it (`confirmed()`), the
 *   same key is saved to this folder's item, read back, and used from then on:
 *   the shared item is never written. A brand-new folder never reads it
 *   (mac device test 2026-11-05 BUG-1: a new folder ended up on the person's
 *   main key);
 * - storing the first key → the keychain once, read back to be sure; if it
 *   refuses or there is none, the 0600 key file. No probe item is ever written.
 *
 * Phase D1: the fall back to the file is no longer silent. `status()` says
 * where the key is and, when it is the file, why (forced, no keychain on this
 * OS, the keychain's own error, an older `vault.key`); the core logs it at
 * start and `alca secrets status` prints it.
 */
export class LazyKeySource implements KeySource {
  private readonly file: FileKeySource;
  private readonly keychains: KeySource[];
  private readonly legacy: KeySource[];
  private readonly vaultExists: () => boolean;
  private chosen: KeySource | undefined;
  /** The key read from a legacy item, waiting for the vault to confirm it before it is copied. */
  private migrate: Buffer | undefined;
  private readonly keyFile: string;
  private readonly forcedFile: boolean;
  /** Why the key is not (or cannot be) in a keychain; set as soon as that is known. */
  private why: string | undefined;
  constructor(o: {
    dir: string;
    backend?: VaultBackend;
    keychains?: KeySource[];
    legacy?: KeySource[];
    /** Whether this folder already has a vault; default: `<dir>/vault.json` or its `.bak` exists. */
    vaultExists?: () => boolean;
  }) {
    this.keyFile = join(o.dir, "vault.key");
    const vault = join(o.dir, "vault.json");
    this.vaultExists = o.vaultExists ?? (() => existsSync(vault) || existsSync(`${vault}.bak`));
    this.file = new FileKeySource(this.keyFile);
    this.forcedFile = o.backend === "file";
    this.keychains = this.forcedFile ? [] : (o.keychains ?? []);
    this.legacy = this.forcedFile ? [] : (o.legacy ?? []);
  }
  /** Where the key is, once known ("file", "keychain-macos", "secret-service"); "auto" before. */
  get kind(): string {
    return this.chosen?.kind ?? (this.keychains.length ? "auto" : "file");
  }
  /** Why the file is (or would be) used instead of a keychain. */
  private fileReason(): string {
    if (this.forcedFile) return "設定為只用檔案（ALCA_VAULT_BACKEND=file）";
    if (!this.keychains.length) return "這個作業系統沒有 Alca 支援的鑰匙圈";
    if (this.why) return this.why;
    return "資料夾裡已有 vault.key（建立保管庫時鑰匙圈不可用），沿用它";
  }
  status(): KeyStatus {
    if (this.chosen && this.chosen !== this.file) return { where: this.chosen.kind, degraded: false };
    if (this.chosen === this.file || this.forcedFile || !this.keychains.length)
      return {
        where: "file",
        degraded: true,
        reason: this.fileReason(),
        ...(this.forcedFile ? { forced: true } : {}),
      };
    return this.why
      ? { where: "undecided", degraded: true, reason: this.why }
      : { where: "undecided", degraded: false };
  }
  /** The last reason a keychain did not answer (for the vault's "cannot open" message). */
  get unavailable(): string | undefined {
    return this.why;
  }
  async load(): Promise<Buffer | undefined> {
    if (this.chosen) return this.chosen.load();
    if (existsSync(this.keyFile) || !this.keychains.length) {
      this.chosen = this.file;
      return this.file.load();
    }
    // The old shared item only for a vault that already exists: a new folder
    // must get its own item on the first save, never the person's main key.
    const legacy = this.vaultExists() ? this.legacy : [];
    for (const c of [...this.keychains, ...legacy]) {
      try {
        const k = await c.load();
        if (k) {
          this.chosen = c;
          this.why = undefined;
          if (legacy.includes(c)) this.migrate = k;
          return k;
        }
      } catch (err) {
        // not reachable here; remember why (a later save falls back to the file)
        this.why ??= err instanceof Error ? err.message : String(err);
      }
    }
    return undefined;
  }
  /**
   * The vault opened with the key read from the old shared item: save the same
   * key to this folder's own item, read it back, and use that item from now
   * on. If the keychain refuses, keep reading the shared item (read only).
   */
  async confirmed(): Promise<void> {
    const key = this.migrate;
    if (!key) return;
    this.migrate = undefined;
    for (const c of this.keychains) {
      try {
        await c.save(key);
        if ((await c.load())?.equals(key)) {
          this.chosen = c;
          return;
        }
      } catch (err) {
        this.why = err instanceof Error ? err.message : String(err);
      }
    }
  }
  /** The chosen source is the old shared item, which is only ever read. */
  private get onLegacy(): boolean {
    return !!this.chosen && this.legacy.includes(this.chosen);
  }
  async save(key: Buffer): Promise<void> {
    if (this.chosen && this.chosen !== this.file && !this.onLegacy) {
      try {
        await this.chosen.save(key);
        return;
      } catch (err) {
        this.why = err instanceof Error ? err.message : String(err);
        // fall through to the file
      }
    }
    if (!existsSync(this.keyFile))
      for (const c of this.keychains) {
        try {
          await c.save(key);
          this.chosen = c;
          this.why = undefined;
          return;
        } catch (err) {
          // refused or none: the file below, and say why
          this.why = err instanceof Error ? err.message : String(err);
        }
      }
    await this.file.save(key);
    this.chosen = this.file;
  }
}

/**
 * The vault's key source for a data folder: nothing is read or written until
 * the vault needs its key (LazyKeySource); the keychain item is named per
 * data folder (keychainAccount).
 */
export function defaultKeySource(dir: string, prefer: VaultBackend = "auto"): KeySource {
  const os = platform();
  const account = keychainAccount(dir);
  const make = (a: string): KeySource[] =>
    os === "darwin"
      ? [new MacKeychainKeySource(run, a)]
      : os === "linux"
        ? [new SecretServiceKeySource(run, a)]
        : [];
  return new LazyKeySource({
    dir,
    backend: prefer,
    keychains: make(account),
    legacy: account === ACCOUNT ? [] : make(ACCOUNT),
  });
}
