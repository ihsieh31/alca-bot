// The core's own secrets (next-round design §1, §6).
//
// - `core.localToken` (the loopback bearer token) stays in `<data>/secrets.json`
//   (0600, written only through `writeFileAtomic` with a `.bak`): `alca open`,
//   `desktop:pair` and the Rust desktop shell read it there. It is never copied
//   into the vault, and the long-term keys are never written back here
//   (user decision 11-05: no plaintext double-write; export before a downgrade).
// - The Link identity and the VAPID key live in the sealed vault (SecretStore
//   `core.linkIdentity`, `core.vapidKey`), whose key the OS keychain holds.
//   Older data folders keep them in secrets.json (`link.identityKey`,
//   `push.vapidKey`); the first start of this version moves them (§6.4).
//
// Rule (§1.3): a value is generated only when it is ABSENT everywhere it could
// be. A malformed value, a vault that does not open (its keychain item gone),
// or a marker that says "in the vault" with nothing there is an error with how
// to recover — never a new identity, because that unpairs every phone.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { generateIdentityJwkSync, type IdentityJwk, isIdentityJwk } from "@alca/link";
import {
  readWithRecovery,
  SecretFileCorruptError,
  type SecretStore,
  storeAndVerify,
  sweepStaleTemps,
  VaultError,
  writeFileAtomic,
} from "@alca/os";
import { generateVapidKey, isVapidJwk, type VapidJwk } from "@alca/push";

export const SECRETS_FILE = "secrets.json";

export interface CoreSecrets {
  /** Loopback bearer token; also read by `alca open`, `desktop:pair` and the desktop shell. */
  localToken: string;
  /** The core's long-term Link identity (ECDSA P-256), pinned by every paired device. */
  linkIdentity: IdentityJwk;
  /** The core's VAPID key pair for Web Push; never leaves this computer. */
  vapidKey: VapidJwk;
}

/** The secrets.json field names (the two keys only in folders not yet migrated, and in exports). */
export const CORE_SECRET_FIELDS = ["core.localToken", "link.identityKey", "push.vapidKey"] as const;
/** secrets.json → vault entry names for the keys that move (§6.3). */
export const VAULT_NAMES = {
  "link.identityKey": "core.linkIdentity",
  "push.vapidKey": "core.vapidKey",
} as const;
export type MovedField = keyof typeof VAULT_NAMES;
export const MOVED = Object.keys(VAULT_NAMES) as MovedField[];
/** The marker in secrets.json once the keys are in the vault (§6.6). */
export const MARKER = "core.secretsIn";

/** The core's secrets cannot be used as they are; the message says how to recover. */
export class CoreSecretsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoreSecretsError";
  }
}

/** Why a value (under its secrets.json or vault name) is not usable; undefined when it is. */
export function fieldProblem(name: string, v: unknown): string | undefined {
  if (typeof v !== "string") return `${name} is not a string`;
  if (name === "core.localToken") return v.trim().length >= 32 ? undefined : `${name} is too short`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(v);
  } catch {
    return `${name} is not JSON`;
  }
  const identity = name === "link.identityKey" || name === "core.linkIdentity";
  const ok = identity ? isIdentityJwk(parsed) : isVapidJwk(parsed);
  return ok ? undefined : `${name} is not a valid key pair`;
}

/**
 * Parse secrets.json strictly: a flat object of strings whose known fields,
 * when present, are well formed. Throws on anything else; used both to read
 * the file and to decide whether the current copy may become the `.bak`.
 */
export function parseCoreSecretsFile(b: Buffer): Record<string, string> {
  const v = JSON.parse(b.toString("utf8")) as unknown;
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("secrets.json is not an object");
  const map = v as Record<string, unknown>;
  for (const [k, val] of Object.entries(map))
    if (typeof val !== "string") throw new Error(`${k} is not a string`);
  for (const f of CORE_SECRET_FIELDS) {
    if (!(f in map)) continue;
    const p = fieldProblem(f, map[f]);
    if (p) throw new Error(p);
  }
  return map as Record<string, string>;
}

export function isValidCoreSecrets(b: Buffer): boolean {
  try {
    parseCoreSecretsFile(b);
    return true;
  } catch {
    return false;
  }
}

export const recoveryHelp = (path: string) =>
  [
    `${path} 讀不出來（檔案壞了，或某個欄位格式不對），備份 ${path}.bak 也不能用。`,
    "Alca 沒有改動任何檔案，也沒有產生新的身分（那會讓已配對的手機全部失效）。",
    "修復方式（先停止 Alca）：",
    `  1. 若你有這個檔案的舊副本（例如 Time Machine），把它放回 ${path}，再啟動；`,
    "  2. 或執行 `alca secrets reset --confirm`：舊檔改名保留，下次啟動產生新的身分與權杖（已配對的手機要重新配對，推播要重新訂閱）。",
    "  `alca secrets status` 會列出各欄位與備份的狀態（不顯示值）。",
  ].join("\n");

/** §6.4: the vault (where the identity now lives) does not open, or lacks the identity. */
export const vaultHelp = (why: string) =>
  [
    `保管庫打不開或少了 Alca 的身分（手機配對用的私鑰）：${why}`,
    "Alca 沒有產生新的身分。常見原因：保管庫的金鑰不在這台電腦的鑰匙圈裡（被刪除，或只把資料夾搬到了另一台電腦／另一個帳號）。",
    "修復方式（先停止 Alca）：",
    "  1. 換電腦：在舊電腦執行 `alca secrets export --to-file <檔案> --confirm`，再在這台執行 `alca secrets import <檔案> --confirm`；",
    "  2. 或執行 `alca secrets reset --confirm`：產生新的身分（手機要重新配對）；保管庫打不開時，裡面的 API 金鑰與網站登入也要重新設定。",
  ].join("\n");

export interface LoadedCoreSecrets {
  core: CoreSecrets;
  /** The same values under their secrets.json names (the startup check). */
  map: Record<string, string>;
  /** Set when secrets.json was broken and restored from its `.bak` (for the log). */
  recovered?: string;
  /**
   * What happened to the keys this start: "moved" (from secrets.json into the
   * vault, now only there), "failed" (the move did not complete: secrets.json
   * untouched, the core runs on its values, the next start tries again).
   */
  migration?: { state: "moved"; to: string } | { state: "failed"; error: string };
}

const textOf = (map: Record<string, string>) => `${JSON.stringify(map, null, 2)}\n`;

/** Read secrets.json with `.bak` recovery; an unreadable pair is CoreSecretsError. */
export function readSecretsFile(root: string): ReturnType<typeof readWithRecovery<Record<string, string>>> {
  const path = join(root, SECRETS_FILE);
  try {
    return readWithRecovery(path, parseCoreSecretsFile);
  } catch (err) {
    if (err instanceof SecretFileCorruptError) throw new CoreSecretsError(recoveryHelp(path));
    throw err;
  }
}

/**
 * Write secrets.json AND its `.bak` with the same content (no `.bak` of the
 * previous copy): used when the keys leave the file, so the old plaintext
 * copy does not stay behind in the backup (§6.4 step 2).
 */
export function writeSecretsFileAndBackup(root: string, map: Record<string, string>): void {
  const path = join(root, SECRETS_FILE);
  const text = textOf(map);
  writeFileAtomic(path, text, { mode: 0o600 });
  writeFileAtomic(`${path}.bak`, text, { mode: 0o600 });
}

/** Keep a usable `.bak`, and never one that still holds keys the main file no longer has. */
function tendBackup(path: string): void {
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  const bak = `${path}.bak`;
  let stale = true;
  if (existsSync(bak))
    try {
      const b = parseCoreSecretsFile(readFileSync(bak));
      const main = parseCoreSecretsFile(Buffer.from(text));
      stale = MOVED.some((f) => f in b && !(f in main));
    } catch {
      stale = true;
    }
  if (stale) writeFileAtomic(bak, text, { mode: 0o600 });
}

function parseKey<T>(name: string, text: string): T {
  const p = fieldProblem(name, text);
  if (p)
    throw new CoreSecretsError(
      `保管庫裡的 ${name} 格式不對（${p}）。Alca 沒有產生新的身分。\n` +
        "若保管庫最近才壞掉：停止 Alca，把 vault.json.bak 放回 vault.json 再啟動；否則用 `alca secrets import` 或 `alca secrets reset --confirm`。",
    );
  return JSON.parse(text) as T;
}

/**
 * Load the core's secrets for a data folder: the token from secrets.json, the
 * two long-term keys from `store` (the folder's vault), moving them there
 * from secrets.json when an older version left them in the file.
 */
export async function loadCoreSecrets(root: string, store: SecretStore): Promise<LoadedCoreSecrets> {
  const path = join(root, SECRETS_FILE);
  sweepStaleTemps(root, SECRETS_FILE);
  const r = readSecretsFile(root);
  const file: Record<string, string> = r.state === "absent" ? {} : { ...r.value };
  let changed = false;
  if (!("core.localToken" in file)) {
    file["core.localToken"] = randomBytes(32).toString("hex");
    changed = true;
  }

  // secrets.json wins while it still has a key: that is the copy the running
  // core and every paired phone have been using.
  const fromFile = MOVED.filter((f) => f in file);
  // A vault that does not open only stops the start when a key must come from it.
  let inVault: Partial<Record<MovedField, string>> = {};
  let vaultProblem: string | undefined;
  try {
    for (const f of MOVED) {
      const v = await store.get(VAULT_NAMES[f]);
      if (v !== undefined) inVault[f] = v;
    }
  } catch (err) {
    if (!(err instanceof VaultError)) throw err;
    if (fromFile.length < MOVED.length) throw new CoreSecretsError(vaultHelp(err.message));
    vaultProblem = err.message;
    inVault = {};
  }
  const values = {} as Record<MovedField, string>;
  const toVault: Record<string, string> = {};
  for (const f of MOVED) {
    const v = inVault[f];
    if (f in file) {
      values[f] = file[f] as string;
      if (v !== values[f]) toVault[VAULT_NAMES[f]] = values[f];
    } else if (v !== undefined) {
      parseKey(VAULT_NAMES[f], v);
      values[f] = v;
    } else if (file[MARKER] === "vault") {
      // The file says the key was moved, and the vault does not have it.
      throw new CoreSecretsError(
        vaultHelp(`${VAULT_NAMES[f]} 不在保管庫裡（secrets.json 標記為已搬進保管庫）`),
      );
    } else {
      values[f] = JSON.stringify(f === "link.identityKey" ? generateIdentityJwkSync() : generateVapidKey());
      toVault[VAULT_NAMES[f]] = values[f];
    }
  }

  let migration: LoadedCoreSecrets["migration"];
  let stored = false;
  if (vaultProblem) migration = { state: "failed", error: vaultProblem };
  else if (Object.keys(toVault).length) {
    try {
      // One write, then read back from the file (not the cache) before the file copy goes.
      await storeAndVerify(store, toVault);
      stored = true;
    } catch (err) {
      if (!fromFile.length) throw err; // a first start that cannot store its new keys: nothing to fall back on
      migration = { state: "failed", error: err instanceof Error ? err.message : String(err) };
    }
  } else stored = true;

  if (stored && (fromFile.length || file[MARKER] !== "vault")) {
    for (const f of fromFile) delete file[f];
    file[MARKER] = "vault";
    writeSecretsFileAndBackup(root, file);
    if (fromFile.length) migration = { state: "moved", to: store.backend };
  } else if (changed) {
    writeFileAtomic(path, textOf(file), { mode: 0o600, backup: true, validate: isValidCoreSecrets });
  }
  // A `.bak` made only "on the next write" would almost never exist (these
  // values do not change), and one left from before the move (a crash between
  // the two writes) must not keep the keys in plaintext.
  tendBackup(path);

  const core: CoreSecrets = {
    localToken: file["core.localToken"] as string,
    linkIdentity: parseKey<IdentityJwk>("core.linkIdentity", values["link.identityKey"]),
    vapidKey: parseKey<VapidJwk>("core.vapidKey", values["push.vapidKey"]),
  };
  const map = {
    "core.localToken": core.localToken,
    "link.identityKey": values["link.identityKey"],
    "push.vapidKey": values["push.vapidKey"],
  };
  return {
    core,
    map,
    ...(r.state === "recovered" ? { recovered: r.note } : {}),
    ...(migration ? { migration } : {}),
  };
}
