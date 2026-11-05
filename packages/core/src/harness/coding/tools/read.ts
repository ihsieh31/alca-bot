import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { basename, dirname, extname } from "node:path";
import type { HostTool } from "@alca/tools";
import { confine } from "../../../workspace/workdir.ts";
import { nestedInstructions } from "../project.ts";
import { decodeText, isUtf8 } from "../text.ts";
import { obj, shownPath, type ToolEnv } from "./common.ts";

/**
 * Plan §4: `read` — a text file with line numbers (offset from 1, 2000 lines
 * or 50 KB a call), a folder's listing, an image's note, a refusal for a
 * binary file. It records what was read (edit / write / apply_patch refuse a
 * file changed since) and, the first time something in a sub-folder is read,
 * that folder's AGENTS.md.
 */

const READ_LIMIT = 2000;
const READ_MAX_BYTES = 50 * 1024;
const LINE_MAX = 2000;
const IMAGE_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
// biome-ignore format: a word list reads better packed
const BINARY_EXT = new Set([
  ".zip", ".gz", ".tgz", ".7z", ".rar", ".exe", ".dll", ".so", ".dylib", ".o", ".a", ".class", ".jar",
  ".wasm", ".pyc", ".sqlite", ".db", ".woff", ".woff2", ".ttf", ".otf", ".mp3", ".mp4", ".mov", ".wav",
  ".pdf", ".docx", ".xlsx", ".pptx",
]);

export function isBinary(path: string, head: Buffer): boolean {
  if (BINARY_EXT.has(extname(path).toLowerCase())) return true;
  if (head.includes(0)) return true;
  if (!head.length) return false;
  let ctrl = 0;
  for (const b of head) if (b < 0x09 || (b > 0x0d && b < 0x20)) ctrl++;
  return ctrl / head.length > 0.3;
}

export function readTool(env: ToolEnv): HostTool {
  return {
    spec: {
      name: "read",
      description:
        "讀檔（offset 從 1 開始、limit 預設 2000 行；圖片可讀）。目錄會列出內容。輸出每行前面是 `行號│`。改檔前一定要先讀。",
      inputSchema: obj(
        {
          path: { type: "string" },
          offset: { type: "integer", minimum: 1 },
          limit: { type: "integer", minimum: 1 },
        },
        ["path"],
      ),
    },
    actionClass: "read",
    run: async (a, _s, ctx) => {
      const root = env.dir(ctx);
      const p = confine(root, String(a.path ?? ""));
      const shown = shownPath(root, p);
      const offset = typeof a.offset === "number" ? a.offset : 1;
      const limit = typeof a.limit === "number" ? a.limit : READ_LIMIT;
      if (!existsSync(p)) {
        const stem = basename(p).toLowerCase().slice(0, 4);
        const near = existsSync(dirname(p))
          ? readdirSync(dirname(p))
              .filter((n) => stem && n.toLowerCase().includes(stem))
              .slice(0, 3)
          : [];
        throw new Error(`找不到檔案：${shown}${near.length ? `\n可能是：\n${near.join("\n")}` : ""}`);
      }
      const st = statSync(p);
      if (st.isDirectory()) {
        const items = readdirSync(p, { withFileTypes: true })
          .map((d) => (d.isDirectory() ? `${d.name}/` : d.name))
          .sort();
        return items.slice(offset - 1, offset - 1 + limit).join("\n") || "（空的資料夾）";
      }
      const fd = openSync(p, "r");
      const head = Buffer.alloc(Math.min(8192, st.size));
      try {
        readSync(fd, head, 0, head.length, 0);
      } finally {
        closeSync(fd);
      }
      const mime = IMAGE_EXT[extname(p).toLowerCase()];
      if (mime)
        return env.images
          ? `[圖片 ${mime}，${st.size} bytes：${shown}]`
          : `[圖片 ${mime}，目前模型不支援影像，未附上]`;
      if (isBinary(p, head))
        throw new Error(
          `無法以文字讀取二進位檔：${shown}（${st.size} bytes）。如需檢視請用 bash（file / strings / xxd）。`,
        );
      const raw = readFileSync(p);
      const utf8 = isUtf8(raw);
      const text = decodeText(raw.toString("utf8")).text;
      const lines = text.split("\n");
      if (lines.length > 1 && lines.at(-1) === "") lines.pop();
      const total = lines.length;
      if (offset > Math.max(1, total)) throw new Error(`offset ${offset} 超出檔案範圍（共 ${total} 行）`);
      const out: string[] = [];
      let bytes = 0;
      let cut = false;
      for (let n = offset - 1; n < total && out.length < limit; n++) {
        let l = lines[n] as string;
        if (l.length > LINE_MAX) l = `${l.slice(0, LINE_MAX)}…（本行共 ${l.length} 字元，已截斷）`;
        const row = `${n + 1}│${l}`;
        bytes += Buffer.byteLength(row) + 1;
        if (bytes > READ_MAX_BYTES) {
          cut = true;
          break;
        }
        out.push(row);
      }
      const last = offset - 1 + out.length;
      const tail = cut
        ? `已達 50KB 上限：顯示第 ${offset}–${last} 行。用 offset=${last + 1} 繼續。`
        : last < total
          ? `顯示第 ${offset}–${last} 行（共 ${total} 行）。用 offset=${last + 1} 繼續。`
          : `檔案結束（共 ${total} 行）。`;
      const s = env.state(ctx);
      s.reads.note(p);
      const enc = utf8
        ? ""
        : `\n注意：${shown} 不是 UTF-8 編碼（可能是 Big5 等），上面以 UTF-8 解讀，無法解碼的位元組顯示為 �。edit／write／apply_patch 不能改這個檔，要改請用 bash 依原編碼處理。`;
      return `<file path="${shown}" lines="${offset}-${last}" total="${total}">\n${out.join("\n")}\n</file>\n${tail}${enc}${nestedInstructions(p, root, s.instructions)}`;
    },
  };
}
