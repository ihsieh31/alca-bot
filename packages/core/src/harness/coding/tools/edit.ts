import { existsSync, statSync } from "node:fs";
import type { HostTool } from "@alca/tools";
import { confine } from "../../../workspace/workdir.ts";
import { withFileLock } from "../lock.ts";
import { type EditSpec, editApplied, LEVEL_WORD, planEdits } from "../match.ts";
import { loadText, notUtf8, saveText, type TextFormat } from "../text.ts";
import { type HostToolContext, lineDelta, obj, shownPath, type ToolEnv } from "./common.ts";

/**
 * Plan §4: `edit` (several exact replacements, all or none) and `write`
 * (create, or overwrite a file read before). Both hold the file's lock while
 * they read, change and write it; both read the file back after writing and
 * compare its hash. An edit already in the file is reported as applied, not
 * as an error, and writes nothing. A file that is not UTF-8 is refused (the
 * model is told to use bash), and mixed line endings are kept line by line.
 */

export function normalizeEdits(a: Record<string, unknown>): EditSpec[] {
  let edits: unknown = a.edits;
  if (typeof edits === "string") {
    try {
      edits = JSON.parse(edits);
    } catch {
      edits = [];
    }
  }
  if (edits && !Array.isArray(edits)) edits = [edits];
  const list = (Array.isArray(edits) ? edits : []) as Array<Record<string, unknown>>;
  return list.map((e) => ({
    old: String(e.old ?? e.oldString ?? e.oldText ?? ""),
    new: String(e.new ?? e.newString ?? e.newText ?? ""),
    ...(e.replaceAll === true ? { replaceAll: true } : {}),
  }));
}

export function editTool(env: ToolEnv): HostTool {
  return {
    spec: {
      name: "edit",
      description:
        "改檔：edits 是多筆 {old, new, replaceAll?}；每個 old 必須在原檔唯一命中（或 replaceAll）、彼此不重疊；全部成功才寫入。改之前要先 read。已經改好的（old 不在、new 已在）會回報「已套用」。",
      inputSchema: obj(
        {
          path: { type: "string" },
          edits: {
            type: "array",
            items: obj(
              { old: { type: "string" }, new: { type: "string" }, replaceAll: { type: "boolean" } },
              ["old", "new"],
            ),
          },
        },
        ["path", "edits"],
      ),
    },
    actionClass: "write",
    run: async (a, _s, ctx) => {
      const root = env.dir(ctx);
      const p = confine(root, String(a.path ?? ""));
      const shown = shownPath(root, p);
      const edits = normalizeEdits(a);
      return withFileLock(p, () => {
        if (!existsSync(p)) {
          if (edits.length === 1 && edits[0]?.old === "") return writeFile(env, p, shown, edits[0].new, ctx);
          throw new Error(`找不到檔案：${shown}。要建立新檔請用 write。`);
        }
        if (statSync(p).isDirectory()) throw new Error(`${shown} 是目錄，不是檔案。`);
        const s = env.state(ctx);
        const file = loadText(p);
        if (!file.utf8) throw new Error(notUtf8(shown));
        // Already applied needs no fresh read: nothing is written, the file is only looked at.
        if (edits.length && edits.every((e) => e.old && e.old !== e.new && editApplied(file.text, e))) {
          s.reads.note(p);
          return `已套用：${shown} 已經是要改成的內容（old 已不在、new 已在），這次沒有寫入。`;
        }
        const stale = s.reads.check(p, shown);
        if (stale) throw new Error(stale);
        const plan = planEdits(file.text, edits, shown);
        if (typeof plan === "string") throw new Error(plan);
        if (plan.text === file.text) {
          s.reads.note(p);
          return `已套用：${shown} 已經是要改成的內容，這次沒有寫入。`;
        }
        saveText(p, plan.text, file);
        s.reads.note(p);
        const delta = lineDelta(file.text, plan.text);
        return [
          `已修改 ${shown}：套用 ${plan.replacements} 處替換（+${delta.added} −${delta.removed} 行），已回讀確認。`,
          ...(plan.applied.length ? [`edits[${plan.applied.join("、")}] 原本就已套用，沒有重複修改。`] : []),
          ...plan.loose.map(
            (l) => `注意：edits[${l.index}] 以「${LEVEL_WORD[l.level]}」寬鬆比對成功，請確認結果。`,
          ),
        ].join("\n");
      });
    },
  };
}

function writeFile(
  env: ToolEnv,
  p: string,
  shown: string,
  content: string,
  ctx: HostToolContext | undefined,
): string {
  const s = env.state(ctx);
  const exists = existsSync(p);
  let fmt: TextFormat = { bom: false, eol: "\n" };
  let before = "";
  const lf = content.replace(/\r\n?/g, "\n");
  if (exists) {
    const f = loadText(p);
    if (!f.utf8) throw new Error(notUtf8(shown));
    if (f.text === lf) {
      s.reads.note(p);
      return `已套用：${shown} 的內容已經和要寫入的一樣，這次沒有寫入。`;
    }
    const stale = s.reads.check(p, shown);
    if (stale)
      throw new Error(
        stale.startsWith("修改前") ? `覆寫既有檔案前請先 read ${shown}（避免覆蓋你沒看過的內容）。` : stale,
      );
    fmt = f;
    before = f.text;
  }
  saveText(p, lf, fmt);
  s.reads.note(p);
  const size = Buffer.byteLength(content);
  const big = size > 1024 * 1024 ? `\n檔案很大（${size} bytes），請確認這是預期的。` : "";
  if (!exists) return `已建立 ${shown}（${lf.split("\n").length} 行），已回讀確認。${big}`;
  const d = lineDelta(before, lf);
  return `已覆寫 ${shown}（+${d.added} −${d.removed} 行），已回讀確認。${big}`;
}

export function writeTool(env: ToolEnv): HostTool {
  return {
    spec: {
      name: "write",
      description: "建立新檔或整檔覆寫（覆寫既有檔前要先 read）。保留原檔的 BOM 與行尾。",
      inputSchema: obj({ path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
    },
    actionClass: "write",
    run: async (a, _s, ctx) => {
      const root = env.dir(ctx);
      const p = confine(root, String(a.path ?? ""));
      if (existsSync(p) && statSync(p).isDirectory())
        throw new Error(`${shownPath(root, p)} 是目錄，不是檔案。`);
      return withFileLock(p, () => writeFile(env, p, shownPath(root, p), String(a.content ?? ""), ctx));
    },
  };
}
