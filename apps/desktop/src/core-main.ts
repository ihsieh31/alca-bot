// The desktop core's command line, loaded by main.ts after the compile cache
// is on (PERF-2026-11). Options: see main.ts.
import { parseArgs } from "node:util";
import { StartupRefusedError } from "@alca/core";
import { scriptArgs } from "./argv.ts";
import { defaultDataDir } from "./data-dir.ts";
import { openInBrowser } from "./open-url.ts";
import { supervisorPid, watchParent } from "./parent-watch.ts";
import { startDesktop } from "./start.ts";

const { values } = parseArgs({
  args: scriptArgs(),
  options: {
    engine: { type: "string", default: "demo" },
    "claude-bin": { type: "string" },
    "codex-bin": { type: "string" },
    workdir: { type: "string" },
    "data-dir": { type: "string" },
    port: { type: "string" },
    host: { type: "string" },
    browser: { type: "string", default: "window" },
    chromium: { type: "string" },
    "no-browser-download": { type: "boolean" },
    agents: { type: "string", default: "router" },
    rendezvous: { type: "string" },
    "link-lan": { type: "string" },
    "pwa-url": { type: "string" },
    "composio-url": { type: "string" },
    "composio-mock": { type: "boolean" },
    "no-open": { type: "boolean" },
  },
});

const engine =
  values.engine === "claude-code" ? "claude-code" : values.engine === "demo" ? "demo" : undefined;
if (!engine) {
  console.error(`未知的引擎：${values.engine}（可用：demo、claude-code）`);
  process.exit(2);
}

const agents = values.agents === "direct" ? "direct" : "router";
const browser = values.browser === "off" || values.browser === "headless" ? values.browser : "window";

try {
  const app = await startDesktop({
    engine,
    dataDir: values["data-dir"] ?? defaultDataDir(),
    ...(values["claude-bin"] ? { claudeCommand: values["claude-bin"].split(/\s+/).filter(Boolean) } : {}),
    ...(values["codex-bin"] ? { codexCommand: values["codex-bin"].split(/\s+/).filter(Boolean) } : {}),
    ...(values.workdir ? { workdir: values.workdir } : {}),
    ...(values.port ? { port: Number(values.port) } : {}),
    ...(values.host ? { host: values.host } : {}),
    browser,
    ...(values.chromium ? { chromium: values.chromium } : {}),
    browserDownload: values["no-browser-download"] !== true,
    agents,
    ...(values.rendezvous ? { rendezvous: values.rendezvous } : {}),
    ...(values["link-lan"] !== undefined ? { lanPort: Number(values["link-lan"]) } : {}),
    ...(values["pwa-url"] ? { pwaUrl: values["pwa-url"] } : {}),
    ...(values["composio-url"] ? { composioBaseUrl: values["composio-url"] } : {}),
    ...(values["composio-mock"] ? { composioMock: true } : {}),
    // The desktop shell writes one-time launch codes for its window on our stdin (S2.2).
    ...(process.env.ALCA_UI_CODES === "stdin" ? { uiCodes: process.stdin } : {}),
  });
  console.log(`\n  Alca 已啟動（引擎：${engine}，${agents === "router" ? "對話＋任務" : "單一回合"}）`);
  // A terminal is a person at the keyboard: open the window for them. As a service (core.log) nothing opens.
  const opened = process.stdout.isTTY && !values["no-open"] ? openInBrowser(app.openUrl) : false;
  console.log(`  網址：${app.url}${opened ? "（已在瀏覽器開啟）" : ""}`);
  console.log("  開啟視窗：alca open（或桌面程式）\n");
  console.log(`  資料夾：${app.dataDir}`);
  if (app.link)
    console.log(
      `  Alca Link：${app.link.host.status === "online" ? "已連上" : "連線中"} ${app.link.host.relayUrl}（金鑰 ${app.link.safetyNumber}）\n  配對手機：pnpm desktop:pair（或在介面按「手機」）`,
    );
  if (app.composioMock)
    console.log(`  連接（示範）：本機的 Composio 替身，在「連接」頁輸入 key：${app.composioMock.key}`);
  console.log("  按 Ctrl+C 結束。\n");
  const stop = async () => {
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  // Started by the desktop shell: stop when it is gone, even if it could not stop us (SIGKILL, a crash).
  const shell = supervisorPid();
  if (shell)
    watchParent({
      pid: shell,
      onGone: () => {
        console.log("  桌面程式已結束，核心跟著停止。");
        void stop();
      },
    });
} catch (err) {
  if (err instanceof StartupRefusedError) {
    console.error(`拒絕啟動：${err.problems.map((p) => `${p.code}（${p.detail}）`).join("；")}`);
    process.exit(1);
  }
  throw err;
}
