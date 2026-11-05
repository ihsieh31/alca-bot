// Phase E updater: is this the file the release meant? Two layers, and which one applies is
// decided by the installed core, never by the download:
//
// 1. Release signature. release.yml signs SHA256SUMS (every asset's checksum) with the
//    Ed25519 key in the ALCA_RELEASE_SIGNING_KEY secret → SHA256SUMS.sig (base64). The public
//    key (repository variable ALCA_RELEASE_PUBLIC_KEY) is packed into the core as
//    apps/desktop/release-keys.json. A core that carries a key installs only a release whose
//    SHA256SUMS verifies against it: a missing or wrong signature is a refusal.
// 2. Checksum only. A core packed without a key checks SHA256SUMS (or <asset>.sha256) and says
//    so: the checksum comes from the same release page, so it catches a damaged download, not
//    a replaced release.
import { createHash, createPublicKey, type KeyObject, verify } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { UpdateError } from "./update-release.ts";

export const RELEASE_KEYS_FILE = "apps/desktop/release-keys.json";
export const SUMS_FILE = "SHA256SUMS";
export const SIG_FILE = "SHA256SUMS.sig";

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** `sha256sum` output: `<hex>  <name>` or `<hex> *<name>` per line. */
export function parseSums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line.trim());
    if (m) out.set((m[2] as string).trim(), (m[1] as string).toLowerCase());
  }
  return out;
}

/** One Ed25519 public key: PEM, or base64 of the DER SubjectPublicKeyInfo. */
export function parsePublicKey(text: string): KeyObject {
  const t = text.trim();
  const key = t.startsWith("-----BEGIN")
    ? createPublicKey(t)
    : createPublicKey({ key: Buffer.from(t, "base64"), format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "ed25519") throw new UpdateError("發布簽章的公開金鑰不是 Ed25519");
  return key;
}

/** The keys from ALCA_RELEASE_PUBLIC_KEY: one PEM, or base64 DER keys separated by commas / whitespace. */
export function releaseKeysFromEnv(value: string | undefined): string[] {
  const v = value?.trim();
  if (!v) return [];
  const parts = v.startsWith("-----BEGIN") ? [v] : v.split(/[\s,]+/).filter(Boolean);
  return parts.map((p) => parsePublicKey(p).export({ format: "der", type: "spki" }).toString("base64"));
}

/** pack-core: write release-keys.json into the packed tree when the build has a key. */
export function writeReleaseKeys(appRoot: string, env: Record<string, string | undefined>): string[] {
  const keys = releaseKeysFromEnv(env.ALCA_RELEASE_PUBLIC_KEY);
  if (keys.length) writeFileSync(join(appRoot, RELEASE_KEYS_FILE), `${JSON.stringify({ keys }, null, 2)}\n`);
  return keys;
}

/** The keys this installed core trusts (none = checksum-only updates). A broken file is an error, not "none". */
export function loadReleaseKeys(appRoot: string): KeyObject[] {
  const f = join(appRoot, RELEASE_KEYS_FILE);
  if (!existsSync(f)) return [];
  let keys: unknown;
  try {
    keys = (JSON.parse(readFileSync(f, "utf8")) as { keys?: unknown }).keys;
  } catch {
    throw new UpdateError(`${RELEASE_KEYS_FILE} 壞了；更新已停止（重新安裝 Alca 可以修好）`);
  }
  if (!Array.isArray(keys) || !keys.length)
    throw new UpdateError(`${RELEASE_KEYS_FILE} 沒有金鑰；更新已停止`);
  return keys.map((k) => parsePublicKey(String(k)));
}

/** A signature file: base64 text (what release.yml writes) or the raw 64 bytes. */
function signatureBytes(sig: Buffer): Buffer {
  if (sig.length === 64) return sig;
  const b = Buffer.from(sig.toString("utf8").trim(), "base64");
  return b;
}

export function verifySums(sums: Buffer, sig: Buffer, keys: readonly KeyObject[]): boolean {
  const s = signatureBytes(sig);
  if (s.length !== 64) return false;
  return keys.some((k) => {
    try {
      return verify(null, sums, k, s);
    } catch {
      return false;
    }
  });
}

export type VerifyMode = "signed" | "checksum";

export interface AssetCheck {
  /** The downloaded file. */
  file: string;
  /** Its name on the release (the line in SHA256SUMS). */
  name: string;
  sums?: Buffer;
  sig?: Buffer;
  /** `<asset>.sha256` (older releases have no SHA256SUMS). */
  sidecar?: string;
  /** --sha256 on the command line. */
  expected?: string;
  keys: readonly KeyObject[];
}

/** Throws UpdateError unless the file is the one the release names; says which layer held. */
export function checkAsset(c: AssetCheck): { mode: VerifyMode; sha256: string } {
  const got = sha256File(c.file);
  let want: string | undefined;
  let mode: VerifyMode = "checksum";
  if (c.keys.length) {
    if (!c.sums || !c.sig)
      throw new UpdateError(
        `這個版本沒有發布簽章（${SUMS_FILE}／${SIG_FILE}），而目前的 Alca 只接受有簽章的更新；已停止`,
      );
    if (!verifySums(c.sums, c.sig, c.keys)) throw new UpdateError(`發布簽章不符（${SIG_FILE}）；已停止`);
    want = parseSums(c.sums.toString("utf8")).get(c.name);
    if (!want) throw new UpdateError(`${SUMS_FILE} 裡沒有 ${c.name}；已停止`);
    mode = "signed";
  } else if (c.expected) {
    want = c.expected.toLowerCase();
  } else if (c.sums) {
    want = parseSums(c.sums.toString("utf8")).get(c.name);
  }
  if (!want && c.sidecar) want = /^[0-9a-fA-F]{64}/.exec(c.sidecar.trim())?.[0]?.toLowerCase();
  if (!want) throw new UpdateError(`找不到 ${c.name} 的檢查碼；已停止`);
  if (want !== got) throw new UpdateError(`${c.name} 的檢查碼不符；已停止`);
  return { mode, sha256: got };
}

export function modeText(mode: VerifyMode): string {
  return mode === "signed"
    ? "發布簽章正確（Ed25519，金鑰隨目前安裝的 Alca 而來）"
    : "只驗檢查碼：同一個 release 頁面提供，能發現下載損壞，不能發現 release 被換掉（這個 Alca 沒有帶發布簽章金鑰）";
}
