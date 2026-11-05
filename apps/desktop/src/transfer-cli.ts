// `alca export thread <id>` / `alca import <file>` (R5.6): one conversation
// out to a `.alca-export` file and back in as a new conversation.
//
//   alca export thread <id> [--out <檔案>] [--passphrase] [--memories] [--data-dir <dir>]
//   alca import <檔案> [--passphrase] [--data-dir <dir>]
//
// Export: with the core running, through its local API (POST /api/export,
// the local token in <data>/secrets.json); with it stopped, straight from the
// database (read-only). Import adds a conversation, which the core guards
// with the approve key that only a window it opened holds: with the core
// running the CLI cannot import and says where to (設定 → 資料 → 匯入); with
// it stopped it opens the store itself (migrations first) and imports there.
// `--passphrase` reads the passphrase from the terminal (or one line of
// stdin), never from the command line, so it stays out of shell history.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { loadSettingsFile } from "@alca/config";
import { getDataKey } from "@alca/os";
import { bindSealer, exportThread, openDatabase, openStore, Sealer } from "@alca/store";
import { defaultDataDir, openVault } from "./data-dir.ts";
import { exportFileName, transferError } from "./data-transfer.ts";
import { runningCorePid } from "./db-cli.ts";

const USAGE = `用法：
  alca export thread <對話 id> [--out <檔案>] [--passphrase] [--memories] [--data-dir <資料夾>]
  alca import <匯出檔> [--passphrase] [--data-dir <資料夾>]`;

export interface TransferCliOptions {
  out?: (line: string) => void;
  /** The passphrase prompt (tests pass one in). */
  ask?: (prompt: string) => Promise<string>;
  /** The running core's address and token (tests; normally read from the data folder). */
  core?: { url: string; token: string };
}

/** One line from the terminal without echo (or from a pipe). */
/**
 * R7 (Phase F2): with the core stopped the CLI opens the database itself, so
 * it reads the data key from the vault (never makes one: a database without a
 * key is either unsealed, or the store refuses it with the reason).
 */
async function cliSealer(root: string): Promise<Sealer | undefined> {
  const ring = await getDataKey(openVault(root));
  return ring ? new Sealer(ring) : undefined;
}

export function askHidden(prompt: string): Promise<string> {
  return new Promise((done) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: !!process.stdin.isTTY,
    });
    const r = rl as unknown as { _writeToOutput?: (s: string) => void; output: NodeJS.WritableStream };
    if (process.stdin.isTTY) {
      process.stderr.write(prompt);
      r._writeToOutput = () => undefined;
    }
    rl.once("line", (line) => {
      rl.close();
      if (process.stdin.isTTY) process.stderr.write("\n");
      done(line);
    });
    rl.once("close", () => done(""));
  });
}

function parse(args: string[]) {
  return parseArgs({
    args,
    allowPositionals: true,
    options: {
      out: { type: "string" },
      passphrase: { type: "boolean" },
      memories: { type: "boolean" },
      "data-dir": { type: "string" },
    },
  });
}

function localCore(root: string): { url: string; token: string } | undefined {
  let token: string | undefined;
  try {
    token = (JSON.parse(readFileSync(join(root, "secrets.json"), "utf8")) as Record<string, string>)[
      "core.localToken"
    ];
  } catch {
    token = undefined;
  }
  if (!token) return undefined;
  const port = loadSettingsFile(join(root, "config.json"), () => undefined).engineering.port;
  return { url: `http://127.0.0.1:${port}`, token };
}

export async function transferCli(
  cmd: "export" | "import",
  argv: string[],
  o: TransferCliOptions = {},
): Promise<number> {
  const out = o.out ?? console.log;
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch {
    out(USAGE);
    return 2;
  }
  const { values, positionals } = parsed;
  const root = resolve(values["data-dir"] ?? defaultDataDir());
  const dbPath = join(root, "state.sqlite");
  const ask = o.ask ?? askHidden;
  if (cmd === "export") {
    const [scope, id] = positionals;
    if (scope !== "thread" || !id) {
      out(scope === "bot" ? "  目前只能匯出單一對話（alca export thread <id>）。" : USAGE);
      return 2;
    }
    let passphrase: string | undefined;
    if (values.passphrase) {
      passphrase = await ask("設定這個匯出檔的密語（至少 8 個字）：");
      if (passphrase.length < 8) {
        out("  密語至少 8 個字。");
        return 2;
      }
      if ((await ask("再輸入一次：")) !== passphrase) {
        out("  兩次的密語不一樣。");
        return 2;
      }
    }
    const file = resolve(values.out ?? exportFileName(id));
    if (existsSync(file)) {
      out(`  ${file} 已經存在，沒有覆蓋。請用 --out 指定別的檔名。`);
      return 1;
    }
    const opts = { ...(passphrase ? { passphrase } : {}), ...(values.memories ? { memories: true } : {}) };
    if (runningCorePid(root)) {
      const core = o.core ?? localCore(root);
      if (!core) {
        out(`  找不到 Alca 的資料（${root}）。`);
        return 1;
      }
      let res: Response;
      try {
        res = await fetch(`${core.url}/api/export`, {
          method: "POST",
          headers: { authorization: `Bearer ${core.token}`, "content-type": "application/json" },
          body: JSON.stringify({ scope: "thread", id, options: opts }),
        });
      } catch {
        out(`  連不上執行中的核心（${core.url}）。`);
        return 1;
      }
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        out(`  沒有匯出：${b.error ?? `HTTP ${res.status}`}`);
        return 1;
      }
      writeFileSync(file, Buffer.from(await res.arrayBuffer()), { mode: 0o600, flag: "wx" });
    } else {
      if (!existsSync(dbPath)) {
        out(`  找不到資料庫：${dbPath}`);
        return 3;
      }
      const db = openDatabase({ path: dbPath, readOnly: true });
      try {
        bindSealer(db, await cliSealer(root));
        exportThread(db, id, file, opts);
      } catch (e) {
        out(`  沒有匯出：${transferError(e).text}`);
        return 1;
      } finally {
        db.close();
      }
    }
    out(`  已匯出到 ${file}`);
    out(
      passphrase
        ? "  檔案已用密語加密；在另一台電腦用 alca import 或 設定 → 資料 → 匯入，輸入同一個密語。"
        : "  注意：這個檔案含對話全文（未加密，權限只限你自己）。要帶到別台電腦請改用 --passphrase。",
    );
    return 0;
  }
  // import
  const arg = positionals[0];
  if (!arg) {
    out(USAGE);
    return 2;
  }
  const file = resolve(arg);
  if (!existsSync(file)) {
    out(`  找不到檔案：${file}`);
    return 1;
  }
  const pid = runningCorePid(root);
  if (pid) {
    out(`  Alca 核心正在執行（pid ${pid}）。匯入會新增對話，需要 Alca 開啟的視窗核准：`);
    out("  請到 設定 → 資料 → 匯入（alca open 開一個視窗），或先停止核心再執行 alca import。");
    return 3;
  }
  const passphrase = values.passphrase ? await ask("這個匯出檔的密語：") : undefined;
  let store: ReturnType<typeof openStore>;
  try {
    const sealer = await cliSealer(root);
    store = openStore(dbPath, undefined, { inlineJobs: true, ...(sealer ? { sealer } : {}) });
  } catch (e) {
    out(`  沒有匯入：${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  try {
    const r = await store.jobs.run("importThread", file, passphrase ? { passphrase } : {});
    const msgs = r.counts.messages ?? 0;
    out(`  已匯入成新的對話 ${r.threadId}（${msgs} 則訊息）。`);
    out("  早於保留期的事件紀錄會在下一次每小時整理時照規則刪除。");
    return 0;
  } catch (e) {
    out(`  沒有匯入：${transferError(e).text}`);
    return 1;
  } finally {
    await store.stop();
  }
}
