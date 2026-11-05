import { createCipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

/**
 * Test-only: write a Cookies database in Chrome's macOS layout, values
 * encrypted the way Chrome does (v10 + AES-128-CBC, key from PBKDF2-SHA1 of
 * the Safe Storage password). `metaVersion` ≥ 24 prefixes SHA-256(host_key).
 */

export interface FixtureCookie {
  host: string;
  name: string;
  value: string;
  path?: string;
  /** Unix seconds; 0 = session cookie. */
  expires?: number;
  secure?: boolean;
  httpOnly?: boolean;
  /** -1 unspecified, 0 None, 1 Lax, 2 Strict */
  samesite?: number;
  /** Store in the plain `value` column instead (old rows). */
  plain?: boolean;
  /** Write garbage instead of a valid ciphertext. */
  corrupt?: boolean;
}

export function encryptChromeValue(
  value: string,
  password: string,
  host: string,
  metaVersion: number,
): Buffer {
  const key = pbkdf2Sync(Buffer.from(password), Buffer.from("saltysalt"), 1003, 16, "sha1");
  const c = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  const prefix = metaVersion >= 24 ? createHash("sha256").update(host).digest() : Buffer.alloc(0);
  return Buffer.concat([
    Buffer.from("v10"),
    c.update(Buffer.concat([prefix, Buffer.from(value)])),
    c.final(),
  ]);
}

const toChromeTime = (unix: number) => BigInt(Math.floor(unix + 11644473600)) * 1_000_000n;

export function writeChromeCookieDb(
  path: string,
  password: string,
  cookies: FixtureCookie[],
  metaVersion = 24,
): void {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);
CREATE TABLE cookies(creation_utc INTEGER NOT NULL, host_key TEXT NOT NULL, top_frame_site_key TEXT NOT NULL DEFAULT '',
 name TEXT NOT NULL, value TEXT NOT NULL, encrypted_value BLOB NOT NULL DEFAULT x'', path TEXT NOT NULL,
 expires_utc INTEGER NOT NULL, is_secure INTEGER NOT NULL, is_httponly INTEGER NOT NULL, last_access_utc INTEGER NOT NULL,
 has_expires INTEGER NOT NULL DEFAULT 1, is_persistent INTEGER NOT NULL DEFAULT 1, priority INTEGER NOT NULL DEFAULT 1,
 samesite INTEGER NOT NULL DEFAULT -1, source_scheme INTEGER NOT NULL DEFAULT 0, source_port INTEGER NOT NULL DEFAULT -1,
 last_update_utc INTEGER NOT NULL DEFAULT 0);`);
  db.prepare("INSERT INTO meta(key, value) VALUES ('version', ?)").run(String(metaVersion));
  const ins = db.prepare(
    `INSERT INTO cookies(creation_utc, host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly,
      last_access_utc, has_expires, is_persistent, samesite) VALUES (0, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
  );
  for (const c of cookies) {
    const enc = c.plain
      ? Buffer.alloc(0)
      : c.corrupt
        ? Buffer.concat([Buffer.from("v10"), Buffer.alloc(32, 7)])
        : encryptChromeValue(c.value, password, c.host, metaVersion);
    const exp = c.expires ?? 0;
    ins.run(
      c.host,
      c.name,
      c.plain ? c.value : "",
      enc,
      c.path ?? "/",
      exp ? toChromeTime(exp) : 0n,
      c.secure ? 1 : 0,
      c.httpOnly ? 1 : 0,
      exp ? 1 : 0,
      exp ? 1 : 0,
      c.samesite ?? -1,
    );
  }
  db.close();
}
