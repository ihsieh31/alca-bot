import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { loadSettingsFile, type Settings } from "@alca/config";
import type { IdentityJwk } from "@alca/link";
import { defaultKeySource, type KeyStatus, Vault, type VaultBackend, vaultBackendFromEnv } from "@alca/os";
import type { VapidJwk } from "@alca/push";
import { appendAudit, type Store } from "@alca/store";
import { type CoreSecrets, type LoadedCoreSecrets, loadCoreSecrets } from "./core-secrets.ts";
import { log } from "./log.ts";

export interface DataDir {
  root: string;
  dbPath: string;
  settings: Settings;
  /** The core's own secrets (secrets.json), typed. */
  core: CoreSecrets;
  /** The same values as a map, every one of them secret (redaction, the startup check). */
  secrets: Record<string, string>;
  /** The core's long-term Link identity (ECDSA P-256), pinned by every paired device. */
  linkIdentity: IdentityJwk;
  /** The core's VAPID key pair for Web Push (P8); never leaves this computer. */
  vapidKey: VapidJwk;
  /** User policy rules (rules.json). A file that cannot be parsed yields one invalid rule → everything denied. */
  rules: () => readonly unknown[];
  /**
   * The folder's one sealed vault (SecretStore): connector, provider and
   * Telegram secrets, site logins, the core's Link identity and VAPID key, and
   * (Phase F2) the data key. Every user of a vault gets this instance.
   */
  vault: Vault;
  /** What happened to the long-term keys this start (moved into the vault, or the move failed). */
  migration?: LoadedCoreSecrets["migration"];
}

export interface OpenDataDirOptions {
  /** Where the vault key may live: "auto" (OS keychain, else the 0600 file) or "file". */
  keySource?: VaultBackend;
}

/** The vault backend for this process: tests never touch the person's keychain. */
export function vaultBackend(prefer?: VaultBackend): VaultBackend {
  return prefer ?? (process.env.VITEST ? "file" : vaultBackendFromEnv());
}

/** The folder's vault (not opened yet: nothing reads a keychain until a value is needed). */
export function openVault(root: string, prefer?: VaultBackend): Vault {
  return new Vault(join(root, "vault.json"), defaultKeySource(root, vaultBackend(prefer)), {
    onRecover: (note) => log.warn(`保管庫檔案壞了，已用備份還原：${note}`),
  });
}

/** One line for the log / status about where the vault key is (§6.4 "明確標示"). */
export function describeKeyStatus(st: KeyStatus): string {
  const where =
    st.where === "keychain-macos"
      ? "macOS 鑰匙圈"
      : st.where === "secret-service"
        ? "Secret Service（系統鑰匙圈）"
        : st.where === "file"
          ? "檔案 vault.key（0600）"
          : "尚未決定";
  return st.degraded
    ? `保管庫金鑰：${where}——降級：${st.reason ?? "沒有可用的系統鑰匙圈"}；這時保管庫的保護程度約等於 0600 的明文檔`
    : `保管庫金鑰：${where}`;
}

export function defaultDataDir(): string {
  return process.env.ALCA_DATA_DIR ?? join(homedir(), ".alca");
}

/** Folders in the data folder whose every file is private (M5). */
const PRIVATE_DIRS = ["logs", "backups", "engines"];

/**
 * Review 2026-11-04b M5: owner-only on EVERY start, not only when created.
 * A data folder made by someone else (`--data-dir` at an existing folder, the
 * shell or another tool making ~/.alca first) or files written under the
 * default umask (state.sqlite, core.log, backups) would otherwise be readable
 * by other accounts on the computer. The folder and its private sub-folders
 * become 0700, every regular file at the top level and in those folders 0600.
 * Links are not followed; the bots' own work folders are left as they are
 * (a person's project files keep their modes).
 */
export function lockDownDataDir(root: string): void {
  const fix = (p: string, mode: number) => {
    try {
      const st = lstatSync(p);
      if (st.isSymbolicLink()) return;
      if ((st.mode & 0o777) !== mode) chmodSync(p, mode);
    } catch {
      // gone, or not ours: the owner check at startup reports what matters
    }
  };
  fix(root, 0o700);
  const files = (dir: string) => {
    try {
      return readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
  };
  for (const e of files(root)) {
    if (e.isFile()) fix(join(root, e.name), 0o600);
    else if (e.isDirectory() && PRIVATE_DIRS.includes(e.name)) {
      fix(join(root, e.name), 0o700);
      for (const f of files(join(root, e.name)))
        if (f.isFile()) fix(join(root, e.name, f.name), 0o600);
        else if (f.isDirectory()) fix(join(root, e.name, f.name), 0o700);
    } else if (e.isDirectory()) fix(join(root, e.name), 0o700);
  }
}

/**
 * Open (or create) the data directory: settings, the SQLite path, the folder's
 * vault, and the core's secrets (the API token in secrets.json; the Link
 * identity and VAPID key in the vault, moved there on the first start of
 * Phase D1), all owner-only. Async since D1: the keys are read from the vault.
 */
export async function openDataDir(dir: string, o: OpenDataDirOptions = {}): Promise<DataDir> {
  const root = resolve(dir);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  lockDownDataDir(root);
  const settings = loadSettingsFile(join(root, "config.json"), (l) => log.warn(l));
  const vault = openVault(root, o.keySource);
  // Throws CoreSecretsError (with how to recover) rather than making a new identity.
  const loaded = await loadCoreSecrets(root, vault);
  if (loaded.recovered) log.warn(`secrets.json 壞了，已用備份還原：${loaded.recovered}`);
  if (loaded.migration?.state === "moved")
    log.info(`Link 身分與推播金鑰已從 secrets.json 搬進保管庫（${loaded.migration.to}）`);
  if (loaded.migration?.state === "failed")
    log.warn(
      `Link 身分與推播金鑰這次沒有搬進保管庫，仍用 secrets.json 的值，下次啟動再試：${loaded.migration.error}`,
    );
  const keyStatus = vault.keyStatus();
  // A fall back is a warning; a file the person asked for (ALCA_VAULT_BACKEND=file) is information.
  if (keyStatus.degraded && !keyStatus.forced) log.warn(describeKeyStatus(keyStatus));
  else log.info(describeKeyStatus(keyStatus));
  // The move rewrote secrets.json(.bak) and may have made vault.json / vault.key: owner-only too.
  lockDownDataDir(root);
  const rulesPath = join(root, "rules.json");
  const rules = () => {
    if (!existsSync(rulesPath)) return [];
    try {
      const parsed = JSON.parse(readFileSync(rulesPath, "utf8")) as unknown;
      return Array.isArray(parsed) ? parsed : [{ invalid: "rules.json must be an array" }];
    } catch {
      return [{ invalid: "rules.json is not valid JSON" }]; // fail closed
    }
  };
  return {
    root,
    dbPath: join(root, "state.sqlite"),
    settings,
    core: loaded.core,
    secrets: loaded.map,
    linkIdentity: loaded.core.linkIdentity,
    vapidKey: loaded.core.vapidKey,
    rules,
    vault,
    ...(loaded.migration ? { migration: loaded.migration } : {}),
  };
}

/** §6.4 step 4: one audit row when the keys moved into the vault (names only, never values). */
export function auditSecretsMoved(store: Store, to: string): void {
  appendAudit(store.db, {
    ts: new Date().toISOString(),
    initiator: { kind: "user", id: "desktop" },
    actor: { kind: "system", id: "core" },
    action: "secrets.migrated",
    actionClass: "write",
    target: "secrets.json",
    decision: "allow",
    detail: { to, keys: ["core.linkIdentity", "core.vapidKey"] },
  });
}
