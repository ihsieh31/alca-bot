import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { HostTool } from "@alca/tools";
import { confine } from "../../../workspace/workdir.ts";
import { withFileLock } from "../lock.ts";
import { applyChunks, parsePatch } from "../patch.ts";
import { loadText, notUtf8, saveText, type TextFormat } from "../text.ts";
import { obj, shownPath, type ToolEnv } from "./common.ts";

/**
 * Plan §4: `apply_patch` — Add / Delete / Update (+ Move to) in one call.
 * It takes the lock of every file it touches (sorted), checks that no file
 * the worker read changed since (an Update of a stale file is refused),
 * computes every change in memory, writes with a hash read-back and rolls
 * every file back if one write fails. Parts already in the files (an Add of
 * the same content, a Delete of a file that is gone, chunks already applied)
 * are reported as applied, not as errors. An Update of a file that is not
 * UTF-8 is refused (the model is told to use bash).
 *
 * Research audit A1: an Update of a file the worker never read with `read`
 * is not refused, only noted in the result. Requiring the read would break
 * the patch flow as it is used: models that look at files through grep or
 * bash (`cat`, `sed -n`) and then patch them, a patch that adds / moves /
 * updates in one go, and the "same patch twice is already applied" check.
 * A blind patch cannot land silently anyway: every chunk's context and
 * removed lines must match the file as it is, and a file read earlier that
 * changed since is still refused (`stale`).
 */

interface Write {
  path: string;
  text: string | null;
  fmt: TextFormat;
}

export function patchTool(env: ToolEnv): HostTool {
  return {
    spec: {
      name: "apply_patch",
      description:
        "用 patch 改多個檔：'*** Begin Patch' … '*** End Patch'，區段 '*** Add File: p'（每行 +）、'*** Delete File: p'、'*** Update File: p'（可接 '*** Move to: q'，chunk 以 '@@ 錨點' 開頭，行首 ' ' 上下文、'-' 刪除、'+' 新增）。全部算好才寫，失敗會回滾；已經套用過的部分會回報「已套用」。",
      inputSchema: obj({ patch: { type: "string" } }, ["patch"]),
    },
    actionClass: "write",
    run: async (a, _s, ctx) => {
      const root = env.dir(ctx);
      const ops = parsePatch(String(a.patch ?? ""));
      if (typeof ops === "string") throw new Error(ops);
      const targets = ops.flatMap((op) => [
        confine(root, op.path),
        ...(op.kind === "update" && op.moveTo ? [confine(root, op.moveTo)] : []),
      ]);
      return withFileLock(targets, () => {
        const s = env.state(ctx);
        const writes: Write[] = [];
        const lines: string[] = [];
        const unread: string[] = [];
        let applied = 0;
        for (const op of ops) {
          const p = confine(root, op.path);
          const shown = shownPath(root, p);
          if (op.kind === "add") {
            const text = `${op.lines.join("\n")}\n`;
            if (existsSync(p)) {
              if (!statSync(p).isDirectory() && loadText(p).text === text) {
                applied++;
                lines.push(`= ${shown}（已套用）`);
                continue;
              }
              throw new Error(`Add File 的目標已存在：${shown}，請改用 Update File`);
            }
            writes.push({ path: p, text, fmt: { bom: false, eol: "\n" } });
            lines.push(`A ${shown}`);
          } else if (op.kind === "delete") {
            if (!existsSync(p)) {
              applied++;
              lines.push(`= ${shown}（已刪除，已套用）`);
              continue;
            }
            if (statSync(p).isDirectory()) throw new Error(`Delete File 的目標是目錄：${shown}`);
            const stale = s.reads.stale(p, shown);
            if (stale) throw new Error(stale);
            writes.push({ path: p, text: null, fmt: { bom: false, eol: "\n" } });
            lines.push(`D ${shown}`);
          } else {
            const to = op.moveTo ? confine(root, op.moveTo) : undefined;
            if (!existsSync(p)) {
              // A move that already happened: the source is gone and the target has the change.
              if (to && existsSync(to)) {
                const f = loadText(to);
                const r = applyChunks(f.text, op.chunks, shownPath(root, to));
                if (typeof r !== "string" && r.text === f.text) {
                  applied++;
                  lines.push(`= ${shown} -> ${shownPath(root, to)}（已套用）`);
                  continue;
                }
              }
              throw new Error(`Update File 找不到檔案：${shown}`);
            }
            const stale = s.reads.stale(p, shown);
            if (stale) throw new Error(stale);
            const neverRead = !s.reads.has(p);
            const f = loadText(p);
            if (!f.utf8) throw new Error(notUtf8(shown));
            const r = applyChunks(f.text, op.chunks, shown);
            if (typeof r === "string") throw new Error(r);
            if (to) {
              if (existsSync(to)) throw new Error(`Move to 的目標已存在：${shownPath(root, to)}`);
              writes.push({ path: to, text: r.text, fmt: f }, { path: p, text: null, fmt: f });
              lines.push(`R ${shown} -> ${shownPath(root, to)}`);
              if (neverRead) unread.push(shown);
            } else if (r.text === f.text) {
              applied++;
              lines.push(`= ${shown}（已套用）`);
            } else {
              writes.push({ path: p, text: r.text, fmt: f });
              lines.push(`M ${shown}${r.applied ? `（其中 ${r.applied} 段已套用）` : ""}`);
              if (neverRead) unread.push(shown);
            }
          }
        }
        commit(writes);
        for (const w of writes) {
          if (w.text === null) s.reads.forget(w.path);
          else s.reads.note(w.path);
        }
        if (!writes.length)
          return `已套用：這個 patch 的內容已經都在檔案裡，這次沒有寫入。\n${lines.join("\n")}`;
        const note = unread.length
          ? `\n提醒：${unread.join("、")} 修改前沒有用 read 讀過。patch 的上下文已和檔案比對過才寫入，但下次請先 read 確認現況再改（edit／write 一定要先 read）。`
          : "";
        return `patch 已套用並回讀確認：\n${lines.join("\n")}${applied ? `\n（${applied} 個區段原本就已套用）` : ""}${note}`;
      });
    },
  };
}

/** Write every change; on a failure put every file back the way it was. */
function commit(writes: readonly Write[]): void {
  const backup = writes.map((w) => ({
    path: w.path,
    before: existsSync(w.path) ? readFileSync(w.path) : null,
  }));
  try {
    for (const w of writes) {
      if (w.text === null) rmSync(w.path);
      else saveText(w.path, w.text, w.fmt);
    }
  } catch (err) {
    for (const b of [...backup].reverse()) {
      try {
        if (b.before === null) rmSync(b.path, { force: true });
        else writeFileSync(b.path, b.before);
      } catch {
        // best effort
      }
    }
    throw new Error(`寫入失敗（${String((err as Error).message)}），已回滾本次 patch 的所有變更。`);
  }
}
