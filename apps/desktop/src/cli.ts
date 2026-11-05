// `alca` command line (P8): the always-on core as a per-user service.
//
//   alca service install [--engine claude-code|demo] [--data-dir <dir>] [-- <more main.ts flags>]
//   alca service uninstall [--data-dir <dir>]
//   alca service status [--data-dir <dir>] [--json]
//   alca start [main.ts flags]       run the core in this terminal (same as `pnpm desktop`)
//   alca pair                        print a pairing code + QR (same as `pnpm desktop:pair`)
//   alca open [--data-dir <dir>]     ask the running core to open a window (review 2026-11-04b S2.2)
//   alca db backups|backup|restore|verify|compact   the state database (P13 + next round §3/§4, see db-cli.ts)
//   alca secrets status|export|import|reset   the core's own secrets (see secrets-cli.ts)
//   alca export thread <id> / alca import <file>   one conversation out and back in (R5.6, transfer-cli.ts)
//   alca update check|install|rollback|status   new versions (Phase E, see update-cli.ts)
//
// `scripts/install.sh` puts a launcher for this at ~/.alca/bin/alca.

import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadSettingsFile } from "@alca/config";
import { scriptArgs } from "./argv.ts";
import { defaultDataDir } from "./data-dir.ts";
import { dbCli } from "./db-cli.ts";
import { secretsCli } from "./secrets-cli.ts";
import { defaultSpec, install, logTail, type ServiceStatus, status, uninstall } from "./service.ts";
import { transferCli } from "./transfer-cli.ts";
import { updateCli } from "./update-cli.ts";

const USAGE = `用法：
  alca service install [--engine claude-code|demo] [--data-dir <資料夾>] [-- <其他核心參數>]
  alca service uninstall
  alca service status [--json]
  alca start [核心參數]
  alca pair
  alca open
  alca db backups | backup | restore <備份> | verify | compact
  alca secrets status | export --to-file <檔案> --confirm | import <檔案> --confirm | reset --confirm
  alca update check | install [--version <tag>] | rollback | status
  alca export thread <對話 id> [--out <檔案>] [--passphrase] [--memories]
  alca import <匯出檔> [--passphrase]`;

function print(st: ServiceStatus, json: boolean) {
  if (json) return console.log(JSON.stringify(st, null, 2));
  const where = { darwin: "launchd（LaunchAgent）", linux: "systemd --user", win32: "工作排程器" }[
    st.platform
  ];
  console.log(`  服務：${where}`);
  console.log(
    `  狀態：${st.installed ? (st.running ? `執行中${st.pid ? `（pid ${st.pid}）` : ""}` : `已安裝，未執行（${st.detail}）`) : "未安裝"}`,
  );
  console.log(`  設定檔：${st.unitPath}`);
  console.log(`  紀錄檔：${st.logFile}`);
  if (st.warning) console.log(`  注意：${st.warning}`);
}

/**
 * `alca open`: the window is opened by the core itself (a launch code only it
 * can mint goes in the fragment; S2.2), so this asks the running core to.
 */
async function openCli(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { "data-dir": { type: "string" } } });
  const dir = values["data-dir"] ?? defaultDataDir();
  let token: string | undefined;
  try {
    token = (JSON.parse(readFileSync(join(dir, "secrets.json"), "utf8")) as Record<string, string>)[
      "core.localToken"
    ];
  } catch {
    token = undefined;
  }
  if (!token) {
    console.error(`找不到 Alca 的資料（${dir}）；請先啟動：alca start`);
    return 1;
  }
  const port = loadSettingsFile(join(dir, "config.json"), () => undefined).engineering.port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/ui/open`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
    });
    const b = (await res.json().catch(() => ({}))) as { opened?: boolean; error?: string };
    if (!res.ok || !b.opened) {
      console.error(b.error ?? `核心沒有開啟視窗（HTTP ${res.status}）`);
      return 1;
    }
    console.log("  已在瀏覽器開啟 Alca。");
    return 0;
  } catch {
    console.error(`核心沒有在執行（127.0.0.1:${port}）；請先啟動：alca start 或 alca service install`);
    return 1;
  }
}

export async function cli(argv: string[]): Promise<number> {
  const [cmd, sub, ...rest] = argv;
  if (cmd === "start") {
    process.argv = [process.argv[0] as string, "main.ts", ...argv.slice(1)];
    await import("./main.ts");
    return -1; // main.ts keeps running
  }
  if (cmd === "pair") {
    process.argv = [process.argv[0] as string, "pair.ts", ...argv.slice(1)];
    await import("./pair.ts");
    return -1;
  }
  if (cmd === "db") return dbCli(argv.slice(1));
  if (cmd === "secrets") return secretsCli(argv.slice(1));
  if (cmd === "update") return updateCli(argv.slice(1));
  if (cmd === "open") return openCli(argv.slice(1));
  if (cmd === "export" || cmd === "import") return transferCli(cmd, argv.slice(1));
  if (cmd !== "service" || !sub) {
    console.log(USAGE);
    return cmd ? 2 : 0;
  }
  const dash = rest.indexOf("--");
  const own = dash >= 0 ? rest.slice(0, dash) : rest;
  const extraArgs = dash >= 0 ? rest.slice(dash + 1) : [];
  const { values } = parseArgs({
    args: own,
    options: {
      engine: { type: "string" },
      "data-dir": { type: "string" },
      json: { type: "boolean" },
    },
  });
  const spec = defaultSpec({
    dataDir: values["data-dir"] ?? defaultDataDir(),
    ...(values.engine ? { engine: values.engine } : {}),
    extraArgs,
  });
  if (!["darwin", "linux", "win32"].includes(spec.platform)) {
    console.error(`這個系統（${spec.platform}）還不支援背景服務。`);
    return 1;
  }
  const json = !!values.json;
  if (sub === "install") {
    const st = install(spec);
    if (!json)
      console.log(
        st.running
          ? "\n  Alca 核心已設成背景服務，登入後會自動啟動。\n"
          : "\n  已寫入服務設定，但還沒看到它在執行：\n",
      );
    print(st, json);
    if (!json && spec.platform === "linux")
      console.log("\n  想在還沒登入時也執行：sudo loginctl enable-linger $USER");
    if (!json) console.log("\n  配對手機：alca pair（或在桌面介面按「手機」）\n");
    return st.installed ? 0 : 1;
  }
  if (sub === "uninstall") {
    const st = uninstall(spec);
    if (!json) console.log("\n  已移除背景服務（資料夾與紀錄檔都保留）。\n");
    print(st, json);
    return 0;
  }
  if (sub === "status") {
    const st = status(spec);
    print(st, json);
    if (!json) {
      const tail = logTail(spec);
      if (tail.length) console.log(`\n  紀錄檔最後幾行：\n${tail.map((l) => `    ${l}`).join("\n")}`);
    }
    return st.running ? 0 : 3;
  }
  console.log(USAGE);
  return 2;
}

/**
 * Run as a script (not imported)? Compares real paths, so a checkout whose path
 * has spaces (`import.meta.url` encodes them as %20) or symlinks still runs.
 */
function isMain(url: string): boolean {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return realpathSync(fileURLToPath(url)) === realpathSync(arg);
  } catch {
    return false;
  }
}

if (isMain(import.meta.url)) {
  const code = await cli(scriptArgs());
  if (code >= 0) process.exit(code);
}
