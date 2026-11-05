import { execFile } from "node:child_process";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Opt-in, one-time import of cookies from the person's everyday Chrome on
 * macOS into one persistent Space (never the shared profile, never by
 * default). Chrome keeps cookies in an SQLite file and encrypts each value
 * with AES-128-CBC under a key derived (PBKDF2-SHA1, "saltysalt", 1003
 * rounds) from the "Chrome Safe Storage" password in the login Keychain;
 * reading that password makes macOS ask the person. We copy the database to
 * a private temp dir (Chrome holds a lock on it), read only the hosts the
 * person picked, decrypt in memory, hand the cookies to the Space's browser
 * and delete the copy. Nothing is written to Alca's own store. Windows
 * (App-Bound Encryption, Chrome 127+) and Linux are not supported.
 */

export class CookieImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CookieImportError";
  }
}

/** Where the "Chrome Safe Storage" password comes from (the real Keychain, or a test fake). */
export interface SafeStorageKeySource {
  /** Resolves the password; macOS shows its Keychain prompt here. */
  chromeSafeStoragePassword(): Promise<string>;
}

/** The macOS login Keychain via `security` (the password is read from its stdout, never logged). */
export const macKeychain: SafeStorageKeySource = {
  chromeSafeStoragePassword: () =>
    new Promise((resolve, reject) => {
      execFile(
        "/usr/bin/security",
        ["find-generic-password", "-w", "-s", "Chrome Safe Storage"],
        { timeout: 120_000 },
        (err, stdout) => {
          if (err) reject(new CookieImportError("無法從鑰匙圈取得 Chrome Safe Storage（你可能按了拒絕）"));
          else resolve(String(stdout).replace(/\n$/, ""));
        },
      );
    }),
};

/** Chrome profile dirs on macOS (Default, Profile 1, …) that have a cookie DB. */
export function chromeProfiles(home = homedir()): Array<{ name: string; cookies: string }> {
  const root = join(home, "Library", "Application Support", "Google", "Chrome");
  const out: Array<{ name: string; cookies: string }> = [];
  for (const name of ["Default", ...Array.from({ length: 20 }, (_, i) => `Profile ${i + 1}`)]) {
    const db = cookieDbIn(join(root, name));
    if (db) out.push({ name, cookies: db });
  }
  return out;
}

/** Chrome 96+ keeps the DB under Network/; older versions directly in the profile. */
export function cookieDbIn(profileDir: string): string | undefined {
  for (const p of [join(profileDir, "Network", "Cookies"), join(profileDir, "Cookies")])
    if (existsSync(p)) return p;
  return undefined;
}

/** PBKDF2-HMAC-SHA1(password, "saltysalt", 1003) → 16-byte AES key. */
export function deriveChromeKey(password: string): Buffer {
  return pbkdf2Sync(Buffer.from(password, "utf8"), Buffer.from("saltysalt"), 1003, 16, "sha1");
}

const IV = Buffer.alloc(16, 0x20);

/**
 * Decrypt one `encrypted_value`. `v10` + AES-128-CBC (IV = 16 spaces, PKCS#7).
 * From DB meta version 24 (Chrome 130+) the plaintext starts with
 * SHA-256(host_key), which is dropped. Returns undefined for a format we do not read.
 */
export function decryptChromeValue(enc: Uint8Array, key: Buffer, metaVersion: number): string | undefined {
  const buf = Buffer.from(enc);
  if (buf.length < 3 + 16 || buf.toString("latin1", 0, 3) !== "v10") return undefined;
  try {
    const d = createDecipheriv("aes-128-cbc", key, IV);
    const plain = Buffer.concat([d.update(buf.subarray(3)), d.final()]);
    return (metaVersion >= 24 ? plain.subarray(32) : plain).toString("utf8");
  } catch {
    return undefined;
  }
}

/** A cookie in CDP `Network.CookieParam` shape. */
export interface ImportedCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  /** Unix seconds; absent = session cookie. */
  expires?: number;
}

export interface DomainSummary {
  /** Host without the leading dot, e.g. "github.com". */
  domain: string;
  cookies: number;
}

/** Microseconds since 1601-01-01 (Windows epoch) → Unix seconds. */
export function chromeTimeToUnix(us: number | bigint): number {
  const n = typeof us === "bigint" ? Number(us / 1000n) / 1000 : us / 1e6;
  return Math.floor(n - 11644473600);
}

const bareHost = (h: string) => h.replace(/^\./, "").toLowerCase();
/** Does a cookie's host belong to a picked domain (itself or a subdomain)? */
export const hostInDomain = (host: string, domain: string) => {
  const h = bareHost(host);
  const d = bareHost(domain);
  return h === d || h.endsWith(`.${d}`);
};

function withCopy<T>(dbPath: string, fn: (db: DatabaseSync) => T): T {
  if (!existsSync(dbPath)) throw new CookieImportError(`找不到 Chrome 的 cookie 檔：${dbPath}`);
  const dir = mkdtempSync(join(tmpdir(), "alca-cookies-"));
  try {
    const copy = join(dir, "Cookies");
    copyFileSync(dbPath, copy);
    // A WAL beside it holds the newest rows.
    for (const ext of ["-wal", "-shm"]) if (existsSync(dbPath + ext)) copyFileSync(dbPath + ext, copy + ext);
    const db = new DatabaseSync(copy, { readOnly: false });
    try {
      return fn(db);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function metaVersion(db: DatabaseSync): number {
  try {
    const r = db.prepare("SELECT value FROM meta WHERE key = 'version'").get() as
      | { value?: unknown }
      | undefined;
    return Number(r?.value ?? 0) || 0;
  } catch {
    return 0;
  }
}

/** Which sites have cookies (no decryption, no Keychain prompt). */
export function listChromeCookieDomains(dbPath: string): DomainSummary[] {
  return withCopy(dbPath, (db) => {
    const rows = db
      .prepare("SELECT host_key AS host, COUNT(*) AS n FROM cookies GROUP BY host_key")
      .all() as Array<{
      host: string;
      n: number;
    }>;
    const by = new Map<string, number>();
    for (const r of rows) {
      const d = bareHost(String(r.host));
      by.set(d, (by.get(d) ?? 0) + Number(r.n));
    }
    return [...by.entries()]
      .map(([domain, cookies]) => ({ domain, cookies }))
      .sort((a, b) => a.domain.localeCompare(b.domain));
  });
}

const SAMESITE: Record<number, ImportedCookie["sameSite"]> = { 0: "None", 1: "Lax", 2: "Strict" };

export interface ReadCookiesResult {
  cookies: ImportedCookie[];
  /** Rows we could not decrypt (another format, a wrong key). */
  skipped: number;
  expired: number;
}

/** Decrypt the cookies of the picked domains. The password is asked for only when there is something to read. */
export async function readChromeCookies(o: {
  dbPath: string;
  domains: readonly string[];
  keys: SafeStorageKeySource;
  now?: () => Date;
}): Promise<ReadCookiesResult> {
  const picked = [
    ...new Set(
      o.domains
        .map(bareHost)
        .filter((d) => /^[a-z0-9.-]{1,253}$/.test(d) && (d.includes(".") || d === "localhost")),
    ),
  ];
  if (!picked.length) throw new CookieImportError("請至少選一個網站");
  const rows = withCopy(o.dbPath, (db) => {
    const all = db
      .prepare(
        // Microseconds since 1601 overflow a JS number's exact range; SQLite divides first.
        "SELECT host_key, name, value, encrypted_value, path, expires_utc / 1000000 AS expires_s, is_secure, is_httponly, samesite, has_expires FROM cookies",
      )
      .all() as Array<Record<string, unknown>>;
    return {
      rows: all.filter((r) => picked.some((d) => hostInDomain(String(r.host_key), d))),
      meta: metaVersion(db),
    };
  });
  if (!rows.rows.length) return { cookies: [], skipped: 0, expired: 0 };
  const key = deriveChromeKey(await o.keys.chromeSafeStoragePassword());
  const nowSec = Math.floor((o.now?.() ?? new Date()).getTime() / 1000);
  const out: ImportedCookie[] = [];
  let skipped = 0;
  let expired = 0;
  for (const r of rows.rows) {
    const enc = r.encrypted_value as Uint8Array | null;
    const value =
      enc && enc.length > 0
        ? decryptChromeValue(enc, key, rows.meta)
        : typeof r.value === "string"
          ? r.value
          : undefined;
    if (value === undefined) {
      skipped++;
      continue;
    }
    const hasExpires = Number(r.has_expires ?? 1) !== 0;
    const exp = Number(r.expires_s ?? 0);
    const expires = hasExpires && exp > 0 ? exp - 11644473600 : undefined;
    if (expires !== undefined && expires <= nowSec) {
      expired++;
      continue;
    }
    const host = String(r.host_key);
    const secure = Number(r.is_secure) === 1;
    const sameSite = SAMESITE[Number(r.samesite)];
    out.push({
      name: String(r.name),
      value,
      domain: host,
      path: String(r.path || "/"),
      secure,
      httpOnly: Number(r.is_httponly) === 1,
      // SameSite=None is only valid on a secure cookie; leave it unspecified otherwise.
      ...(sameSite && (sameSite !== "None" || secure) ? { sameSite } : {}),
      ...(expires !== undefined ? { expires } : {}),
    });
  }
  // A key that decrypts nothing is a wrong key, not an empty jar.
  if (!out.length && skipped > 0 && expired === 0)
    throw new CookieImportError("Chrome 的 cookie 無法解密（鑰匙圈的密碼不對，或是不支援的格式）");
  return { cookies: out, skipped, expired };
}
