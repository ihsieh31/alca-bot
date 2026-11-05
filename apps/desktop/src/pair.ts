// Pair a phone with the running desktop.
//
//   node --disable-warning=ExperimentalWarning apps/desktop/src/pair.ts [--data-dir <dir>] [--port <n>]
//
// Review 2026-11-04b S2.2: a pairing code is as good as a new device (with the
// default scopes, approving included), so making one needs the approve key
// that only a window the core opened holds — the local token is not enough,
// or a bot that read secrets.json could pair itself a "phone" and approve its
// own payment. This asks the core to open its window at the 手機 dialog
// (`#open=pair`), where the code and QR are shown.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadSettingsFile } from "@alca/config";
import { scriptArgs } from "./argv.ts";
import { defaultDataDir } from "./data-dir.ts";

const { values } = parseArgs({
  args: scriptArgs(),
  options: { "data-dir": { type: "string" }, port: { type: "string" }, scopes: { type: "string" } },
});
const dir = values["data-dir"] ?? defaultDataDir();
const token = (JSON.parse(readFileSync(join(dir, "secrets.json"), "utf8")) as Record<string, string>)[
  "core.localToken"
];
const port =
  values.port ?? String(loadSettingsFile(join(dir, "config.json"), () => undefined).engineering.port);
const res = await fetch(`http://127.0.0.1:${port}/api/ui/open`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({ open: "pair" }),
}).catch(() => undefined);
const b = (await res?.json().catch(() => ({}))) as { opened?: boolean; error?: string } | undefined;
if (!res?.ok || !b?.opened) {
  console.error(`無法開啟配對畫面：${b?.error ?? res?.status ?? "核心沒有在執行"}`);
  process.exit(1);
}
console.log("\n  已在瀏覽器開啟 Alca 的「手機」畫面：用手機掃描那裡的 QR code。");
if (values.scopes) console.log("  （權限在那個畫面上選；--scopes 已不再使用。）");
console.log("");
