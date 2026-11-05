// Alca hands daemon: a stateless executor on another machine.
//
//   node --disable-warning=ExperimentalWarning apps/hands/src/main.ts pair <code> --rendezvous <url> [--name <n>] [--fingerprint <fp>]
//   node --disable-warning=ExperimentalWarning apps/hands/src/main.ts run --workdir <dir>
//
//   --state <file>   identity + pinned core key (default ~/.alca-hands/device.json, 0600)
//   --no-lan         do not try the core's LAN address first
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { pairHands, runHands } from "./daemon.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    rendezvous: { type: "string" },
    name: { type: "string" },
    fingerprint: { type: "string" },
    workdir: { type: "string" },
    state: { type: "string" },
    "no-lan": { type: "boolean" },
  },
});
const statePath = values.state ?? join(homedir(), ".alca-hands", "device.json");
const [cmd, code] = positionals;

if (cmd === "pair") {
  if (!code || !values.rendezvous) {
    console.error("用法：pair <配對碼> --rendezvous <網址>");
    process.exit(2);
  }
  const c = await pairHands({
    statePath,
    relayUrl: values.rendezvous,
    code,
    ...(values.name ? { name: values.name } : {}),
    ...(values.fingerprint ? { fingerprint: values.fingerprint } : {}),
  });
  console.log(`已配對「${c.coreName}」（裝置 ${c.deviceId}）。接著執行：run --workdir <資料夾>`);
} else if (cmd === "run" || cmd === undefined) {
  if (!values.workdir) {
    console.error("用法：run --workdir <允許的工作資料夾>");
    process.exit(2);
  }
  const d = await runHands({
    statePath,
    workdir: values.workdir,
    preferLan: !values["no-lan"],
    onStatus: (s, why) => console.log(`[hands] ${s}${why ? `（${why}）` : ""}`),
  });
  console.log(`[hands] 工作資料夾：${d.executor.root}`);
  const stop = () => {
    d.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
} else {
  console.error(`未知指令：${cmd}（可用：pair、run）`);
  process.exit(2);
}
