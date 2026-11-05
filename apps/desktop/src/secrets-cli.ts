// `alca secrets …` (next-round design §1.3, §6.4): look at, move, and when
// beyond repair reset the core's own secrets. Values are never printed.
//
//   alca secrets status [--data-dir <dir>] [--json]
//       secrets.json and its .bak, where the Link identity / VAPID key are
//       (vault or still in the file), where the vault key is (keychain or the
//       degraded 0600 file, and why)
//   alca secrets export --to-file <path> --confirm [--data-dir <dir>]
//       write the core's keys to ONE 0600 file in the pre-D1 secrets.json
//       format: for moving computers, and BEFORE A DOWNGRADE (an older version
//       reads it when it is copied over secrets.json)
//   alca secrets import <path> --confirm [--data-dir <dir>]
//       the reverse: keys into this folder's vault, the token into secrets.json
//   alca secrets reset --confirm [--data-dir <dir>]
//       a new identity on the next start (phones re-pair)
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { storeAndVerify, type Vault, VaultError, writeFileAtomic } from "@alca/os";
import {
  CORE_SECRET_FIELDS,
  fieldProblem,
  isValidCoreSecrets,
  MARKER,
  MOVED,
  parseCoreSecretsFile,
  readSecretsFile,
  SECRETS_FILE,
  VAULT_NAMES,
  writeSecretsFileAndBackup,
} from "./core-secrets.ts";
import { defaultDataDir, describeKeyStatus, lockDownDataDir, openVault } from "./data-dir.ts";
import { runningCorePid } from "./db-cli.ts";

const USAGE = `用法：
  alca secrets status [--data-dir <資料夾>] [--json]
  alca secrets export --to-file <檔案> --confirm [--data-dir <資料夾>]
  alca secrets import <檔案> --confirm [--data-dir <資料夾>]
  alca secrets reset --confirm [--data-dir <資料夾>]`;

type FileState = "ok" | "missing" | "broken";
type Where = "vault" | "file" | "absent" | "unknown";
type Out = (line: string) => void;

export interface SecretsStatus {
  file: FileState;
  backup: FileState;
  /** Per key: in the vault, still in secrets.json (moved on the next start), absent, or unknown. */
  fields: Record<string, Where>;
  /** secrets.json's marker: "vault" once the keys were moved (Phase D1). */
  marker: string | null;
  /** Left-over copies: `secrets.json.corrupt-*` (set aside by a recovery) and `*.reset-*`. */
  setAside: string[];
  vault: {
    file: boolean;
    backup: boolean;
    keyFile: boolean;
    /** Opened fine, could not be opened (with why), or not made yet. */
    open: "ok" | "error" | "none";
    error?: string;
    key: { where: string; degraded: boolean; reason?: string };
    /** Names of the core's own entries (`core.*`), never values. */
    coreEntries: string[];
  };
}

function stateOf(path: string): FileState {
  if (!existsSync(path)) return "missing";
  return isValidCoreSecrets(readFileSync(path)) ? "ok" : "broken";
}

const stamp = () =>
  new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");

export async function secretsStatus(root: string, vault: Vault = openVault(root)): Promise<SecretsStatus> {
  const path = join(root, SECRETS_FILE);
  const file = stateOf(path);
  const backup = stateOf(`${path}.bak`);
  const source = file === "ok" ? path : backup === "ok" ? `${path}.bak` : undefined;
  const map = source ? parseCoreSecretsFile(readFileSync(source)) : undefined;
  const vaultFile = existsSync(join(root, "vault.json")) || existsSync(join(root, "vault.json.bak"));
  let names: string[] = [];
  let open: SecretsStatus["vault"]["open"] = vaultFile ? "ok" : "none";
  let error: string | undefined;
  try {
    // Reads only: an absent vault answers without its key, so nothing is written to a keychain.
    names = await vault.names();
  } catch (err) {
    open = "error";
    error = err instanceof Error ? err.message : String(err);
  }
  const fields: Record<string, Where> = {
    "core.localToken": map ? ("core.localToken" in map ? "file" : "absent") : "unknown",
  };
  for (const f of MOVED)
    fields[f] =
      map && f in map
        ? "file"
        : names.includes(VAULT_NAMES[f])
          ? "vault"
          : open === "error"
            ? "unknown"
            : "absent";
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    entries = [];
  }
  return {
    file,
    backup,
    fields,
    marker: map?.[MARKER] ?? null,
    setAside: entries.filter((n) => n.startsWith(`${SECRETS_FILE}.corrupt-`) || n.includes(".reset-")).sort(),
    vault: {
      file: existsSync(join(root, "vault.json")),
      backup: existsSync(join(root, "vault.json.bak")),
      keyFile: existsSync(join(root, "vault.key")),
      open,
      ...(error ? { error } : {}),
      key: vault.keyStatus(),
      coreEntries: names.filter((n) => n.startsWith("core.")).sort(),
    },
  };
}

const label: Record<FileState, string> = { ok: "正常", missing: "不存在", broken: "讀不出來" };
const whereLabel: Record<Where, string> = {
  vault: "在保管庫",
  file: "在 secrets.json",
  absent: "沒有（下次啟動會產生）",
  unknown: "無法判斷",
};

function printStatus(st: SecretsStatus, out: Out): void {
  out(`  secrets.json：${label[st.file]}；備份 secrets.json.bak：${label[st.backup]}`);
  for (const [f, v] of Object.entries(st.fields)) {
    const moving = v === "file" && f !== "core.localToken" ? "（舊版的位置，下次啟動會搬進保管庫）" : "";
    out(`    ${f}：${whereLabel[v]}${moving}`);
  }
  out(
    `  保管庫：vault.json ${st.vault.file ? "有" : "沒有"}，備份 ${st.vault.backup ? "有" : "沒有"}` +
      (st.vault.open === "error" ? `；打不開：${st.vault.error}` : ""),
  );
  out(`  ${describeKeyStatus(st.vault.key)}`);
  if (st.setAside.length)
    out(`  留下的舊檔：${st.setAside.join("、")}（可能含舊的金鑰，確認不需要後可刪除）`);
  if (st.file === "broken" && st.backup === "ok") out("  下次啟動會自動用備份還原。");
  if (st.file === "broken" && st.backup !== "ok")
    out("  兩份都不能用：放回舊副本，或執行 `alca secrets reset --confirm`（手機要重新配對）。");
  if (st.marker === "vault")
    out(
      "  降級到舊版之前，先執行 `alca secrets export --to-file <檔案> --confirm`（舊版只讀 secrets.json）。",
    );
}

function refuseWhileRunning(root: string, out: Out, what: string): boolean {
  const pid = runningCorePid(root);
  if (!pid) return false;
  out(`  Alca 核心正在執行（pid ${pid}）。請先停止它（alca service uninstall 或關掉終端機），再${what}。`);
  return true;
}

/** Export: the pre-D1 secrets.json format (an older version reads it as is) plus every other `core.*` entry. */
async function exportTo(root: string, to: string, out: Out): Promise<number> {
  const target = resolve(to);
  if (existsSync(target)) {
    out(`  ${target} 已經存在；換一個檔名（不會覆寫）。`);
    return 2;
  }
  if (!existsSync(dirname(target))) {
    out(`  資料夾 ${dirname(target)} 不存在。`);
    return 2;
  }
  const r = readSecretsFile(root);
  if (r.state === "absent") {
    out("  這個資料夾還沒有 secrets.json（Alca 沒有啟動過），沒有東西可以匯出。");
    return 3;
  }
  const vault = openVault(root);
  const result: Record<string, string> = { "core.localToken": r.value["core.localToken"] as string };
  for (const f of MOVED) {
    const v = r.value[f] ?? (await vault.get(VAULT_NAMES[f]));
    if (v === undefined) {
      out(`  找不到 ${f}（保管庫裡沒有 ${VAULT_NAMES[f]}），沒有匯出。`);
      return 3;
    }
    result[f] = v;
  }
  const moved: string[] = Object.values(VAULT_NAMES);
  for (const n of await vault.names())
    if (n.startsWith("core.") && !moved.includes(n)) result[n] = (await vault.get(n)) as string;
  writeFileAtomic(target, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  out(`  已匯出到 ${target}（0600）：${Object.keys(result).join("、")}。`);
  out("  這個檔案是明文的私鑰：用完請刪除，不要放進雲端同步或 Alca 的資料夾。");
  out(`  降級到舊版：停止 Alca、安裝舊版後，把它複製成 ${join(root, SECRETS_FILE)} 再啟動。`);
  return 0;
}

async function importFrom(root: string, from: string, out: Out): Promise<number> {
  const source = resolve(from);
  if (!existsSync(source)) {
    out(`  找不到 ${source}。`);
    return 2;
  }
  let map: Record<string, string>;
  try {
    map = parseCoreSecretsFile(readFileSync(source));
  } catch (err) {
    out(`  ${source} 不是可用的匯出檔：${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  for (const f of CORE_SECRET_FIELDS)
    if (fieldProblem(f, map[f])) {
      out(`  ${source} 少了 ${f}（或格式不對），沒有匯入。`);
      return 2;
    }
  // Importing into a folder that does not exist yet (moving to a new data
  // folder) creates it owner-only first; the vault's atomic write needs it
  // (mac device test 2026-11-05 BUG-2: ENOENT on .vault.json.<pid>.tmp).
  mkdirSync(root, { recursive: true, mode: 0o700 });
  lockDownDataDir(root);
  const vault = openVault(root);
  const entries: Record<string, string> = {};
  for (const f of MOVED) entries[VAULT_NAMES[f]] = map[f] as string;
  for (const [k, v] of Object.entries(map))
    if (k.startsWith("core.") && k !== "core.localToken" && k !== MARKER) entries[k] = v;
  const before = await vault.get(VAULT_NAMES["link.identityKey"]);
  await storeAndVerify(vault, entries);
  // The current file (if any) is kept as `.reset-<ts>`: it is what phones were paired with.
  const path = join(root, SECRETS_FILE);
  const ts = stamp();
  for (const name of [path, `${path}.bak`]) if (existsSync(name)) renameSync(name, `${name}.reset-${ts}`);
  writeSecretsFileAndBackup(root, { "core.localToken": map["core.localToken"] as string, [MARKER]: "vault" });
  lockDownDataDir(root);
  out(`  已匯入：${Object.keys(entries).join("、")} 進保管庫（${vault.backend}），權杖寫進 secrets.json。`);
  if (before && before !== entries[VAULT_NAMES["link.identityKey"]])
    out(
      "  這個資料夾原本的身分被取代了（之前的 secrets.json 已改名保留；保管庫的前一份在 vault.json.bak）。",
    );
  out("  匯出檔是明文的私鑰：確認 Alca 正常後請刪除它。");
  return 0;
}

async function reset(root: string, out: Out): Promise<number> {
  const ts = stamp();
  const moved: string[] = [];
  const setAside = (name: string) => {
    const from = join(root, name);
    if (!existsSync(from)) return;
    renameSync(from, `${from}.reset-${ts}`);
    moved.push(`${name}.reset-${ts}`);
  };
  const vault = openVault(root);
  let vaultNote = "保管庫（API 金鑰、Telegram 權杖、網站登入）不受影響。";
  try {
    // Only the identity and the push key; `core.dbKey` (Phase F2) stays, or the database could not be read.
    await vault.deleteMany(Object.values(VAULT_NAMES));
  } catch (err) {
    if (!(err instanceof VaultError)) throw err;
    for (const n of ["vault.json", "vault.json.bak", "vault.key"]) setAside(n);
    vaultNote = `保管庫打不開（${err.message}），已一起改名保留：API 金鑰、Telegram 權杖、網站登入都要重新設定。`;
  }
  for (const n of [SECRETS_FILE, `${SECRETS_FILE}.bak`]) setAside(n);
  out(moved.length ? `  已改名保留：${moved.join("、")}。` : "  沒有要改名的檔案。");
  out(`  下次啟動會產生新的身分。${vaultNote}`);
  return 0;
}

/** A vault that does not open (its key gone): say so instead of a stack trace; nothing was changed. */
async function vaultGuard(fn: () => Promise<number>, out: Out): Promise<number> {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof VaultError)) throw err;
    out(`  保管庫打不開：${err.message}。沒有改動任何檔案。`);
    out(
      "  若這個資料夾是從另一台電腦搬來的：先 `alca secrets reset --confirm`（把打不開的保管庫改名保留），再匯入。",
    );
    return 3;
  }
}

export async function secretsCli(argv: string[], out: Out = console.log): Promise<number> {
  const [sub, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      "data-dir": { type: "string" },
      json: { type: "boolean" },
      confirm: { type: "boolean" },
      "to-file": { type: "string" },
    },
  });
  const root = resolve(values["data-dir"] ?? defaultDataDir());
  if (sub === "status") {
    const st = await secretsStatus(root);
    if (values.json) out(JSON.stringify(st, null, 2));
    else printStatus(st, out);
    return (st.file === "broken" && st.backup !== "ok") || st.vault.open === "error" ? 1 : 0;
  }
  if (sub === "export") {
    const to = values["to-file"];
    if (!to) {
      out(USAGE);
      return 2;
    }
    if (!values.confirm) {
      out("  匯出檔會含 Alca 的私鑰（明文、0600）：拿到它的人可以冒充這台電腦。確定的話加上 --confirm。");
      return 2;
    }
    if (refuseWhileRunning(root, out, "匯出")) return 3;
    return vaultGuard(() => exportTo(root, to, out), out);
  }
  if (sub === "import") {
    const from = positionals[0];
    if (!from) {
      out(USAGE);
      return 2;
    }
    if (!values.confirm) {
      out("  匯入會取代這個資料夾的身分與權杖（原本的檔案改名保留）。確定的話加上 --confirm。");
      return 2;
    }
    if (refuseWhileRunning(root, out, "匯入")) return 3;
    return vaultGuard(() => importFrom(root, from, out), out);
  }
  if (sub === "reset") {
    if (!values.confirm) {
      out("  這會讓 Alca 下次啟動時產生新的身分與權杖：已配對的手機要重新配對，推播要重新訂閱。");
      out("  保管庫打得開時，API 金鑰、Telegram 權杖不受影響。確定的話加上 --confirm。");
      return 2;
    }
    if (refuseWhileRunning(root, out, "重設")) return 3;
    return reset(root, out);
  }
  out(USAGE);
  return 2;
}
