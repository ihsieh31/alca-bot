import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { HostTool } from "../turn.ts";
import { confine, shown } from "./workdir.ts";

/**
 * Alca's own file tools (P13), for every engine (an API model has no file
 * tools of its own; Codex's own sandbox is read-only). Every path is
 * confined to the calling bot's working folder: relative paths start there,
 * and `..` or a symlink that leads outside is refused. `file_write` and
 * `file_edit` are `write` calls: the gate decides, and the edit journal keeps
 * the file as it was first, so the turn can be undone.
 */

const MAX_READ = 200_000;
const MAX_WRITE = 2_000_000;

export function fileTools(workDir: (botId: string) => string): HostTool[] {
  const root = (ctx?: { botId: string }) => {
    if (!ctx) throw new Error("沒有 bot");
    return workDir(ctx.botId);
  };
  return [
    {
      spec: {
        name: "file_list",
        description: "列出工作資料夾裡的檔案（path 相對於工作資料夾，預設是最上層）",
        inputSchema: { type: "object", properties: { path: { type: "string" } } },
      },
      actionClass: "read",
      run: async (a, _s, ctx) => {
        const base = root(ctx);
        const dir = confine(base, typeof a.path === "string" && a.path ? a.path : ".");
        const items = readdirSync(dir, { withFileTypes: true })
          .slice(0, 500)
          .map((d) => `${d.isDirectory() ? "📁" : "  "} ${shown(base, `${dir}/${d.name}`)}`);
        return items.length ? items.join("\n") : "（空的資料夾）";
      },
    },
    {
      spec: {
        name: "file_read",
        description: "讀取工作資料夾裡的一個文字檔",
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
      actionClass: "read",
      run: async (a, _s, ctx) => {
        const p = confine(root(ctx), String(a.path ?? ""));
        if (!statSync(p).isFile()) throw new Error("這不是檔案");
        const text = readFileSync(p, "utf8");
        return text.length > MAX_READ ? `${text.slice(0, MAX_READ)}\n…（截斷，共 ${text.length} 字）` : text;
      },
    },
    {
      spec: {
        name: "file_write",
        description: "在工作資料夾裡建立或覆寫一個文字檔（可以復原）",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" }, content: { type: "string" } },
          required: ["path", "content"],
        },
      },
      actionClass: "write",
      run: async (a, _s, ctx) => {
        const base = root(ctx);
        const p = confine(base, String(a.path ?? ""));
        const content = String(a.content ?? "");
        if (content.length > MAX_WRITE) throw new Error("內容太長");
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, content);
        return `已寫入 ${shown(base, p)}（${content.length} 字）`;
      },
    },
    {
      spec: {
        name: "file_edit",
        description: "把工作資料夾裡一個檔案中唯一出現的 old 換成 new（可以復原）",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" }, old: { type: "string" }, new: { type: "string" } },
          required: ["path", "old", "new"],
        },
      },
      actionClass: "write",
      run: async (a, _s, ctx) => {
        const base = root(ctx);
        const p = confine(base, String(a.path ?? ""));
        const before = readFileSync(p, "utf8");
        const old = String(a.old ?? "");
        if (!old) throw new Error("old 不能是空的");
        const at = before.indexOf(old);
        if (at < 0) throw new Error("找不到 old 的內容");
        if (before.indexOf(old, at + 1) >= 0) throw new Error("old 出現不只一次；請多帶一點前後文");
        writeFileSync(p, before.slice(0, at) + String(a.new ?? "") + before.slice(at + old.length));
        return `已修改 ${shown(base, p)}`;
      },
    },
  ];
}
