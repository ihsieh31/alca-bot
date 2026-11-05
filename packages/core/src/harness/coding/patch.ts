import { foldUnicode } from "./match.ts";

/**
 * Plan §4 (moved from the P15 archive): `apply_patch` — a file-oriented patch format
 * with Add / Delete / Update (+ Move to) sections and context-located chunks.
 * Parsing errors carry the line number. Chunks are found with growing
 * leniency (exact → trailing blanks → both ends → Unicode punctuation folded);
 * context lines keep the file's own text; uniqueness is checked at the level
 * that matched; everything is computed in memory first. A chunk whose old
 * lines are gone and whose new lines are already there counts as applied
 * (plan §4: a retried patch must neither fail nor apply twice).
 */

export type PatchOp =
  | { kind: "add"; path: string; lines: string[] }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; moveTo?: string; chunks: Chunk[] };

export interface Chunk {
  anchor?: string;
  old: string[];
  new: string[];
  /** Per old line: true = context (kept from the file), false = removed. */
  ctx: boolean[];
  eof: boolean;
}

export function parsePatch(input: string): PatchOp[] | string {
  let lines = input
    .trim()
    .split("\n")
    .map((l) => l.replace(/\r$/, ""));
  if (/^<<['"]?EOF['"]?$/.test((lines[0] ?? "").trim()) && (lines.at(-1) ?? "").trim().endsWith("EOF"))
    lines = lines.slice(1, -1);
  if ((lines[0] ?? "").trim() !== "*** Begin Patch") return "patch 第 1 行：第一行必須是 '*** Begin Patch'";
  if ((lines.at(-1) ?? "").trim() !== "*** End Patch")
    return `patch 第 ${lines.length} 行：最後一行必須是 '*** End Patch'`;
  const ops: PatchOp[] = [];
  const seen = new Set<string>();
  let i = 1;
  const end = lines.length - 1;
  const header = (l: string) => /^\*\*\* (Add|Delete|Update) File: /.test(l.trim());
  while (i < end) {
    const h = (lines[i] as string).trim();
    const m = /^\*\*\* (Add|Delete|Update) File: (.+)$/.exec(h);
    if (!m)
      return `patch 第 ${i + 1} 行：'${h}' 不是有效的區段標頭。可用：'*** Add File: <path>'、'*** Delete File: <path>'、'*** Update File: <path>'`;
    const path = (m[2] as string).trim();
    if (seen.has(path)) return `patch 第 ${i + 1} 行：同一個 patch 中多次操作 ${path}`;
    seen.add(path);
    i++;
    if (m[1] === "Delete") {
      ops.push({ kind: "delete", path });
      continue;
    }
    if (m[1] === "Add") {
      const body: string[] = [];
      while (i < end && !header(lines[i] as string)) {
        const l = lines[i] as string;
        if (!l.startsWith("+")) return `patch 第 ${i + 1} 行：Add File 的每一行必須以 '+' 開頭`;
        body.push(l.slice(1));
        i++;
      }
      ops.push({ kind: "add", path, lines: body });
      continue;
    }
    let moveTo: string | undefined;
    const mv = /^\*\*\* Move to: (.+)$/.exec((lines[i] ?? "").trim());
    if (mv) {
      moveTo = (mv[1] as string).trim();
      i++;
    }
    const chunks: Chunk[] = [];
    let cur: Chunk | undefined;
    const flush = () => {
      if (cur && (cur.old.length || cur.new.length)) chunks.push(cur);
      cur = undefined;
    };
    while (i < end && !header(lines[i] as string)) {
      const l = lines[i] as string;
      const t = l.trimEnd();
      if (t.startsWith("@@")) {
        flush();
        const a = t.slice(2).trim();
        cur = { ...(a ? { anchor: a } : {}), old: [], new: [], ctx: [], eof: false };
      } else if (t === "*** End of File") {
        cur ??= { old: [], new: [], ctx: [], eof: false };
        cur.eof = true;
      } else {
        cur ??= { old: [], new: [], ctx: [], eof: false };
        const mark = l[0];
        if (l === "" || mark === " ") {
          const text = l.slice(1);
          cur.old.push(text);
          cur.new.push(text);
          cur.ctx.push(true);
        } else if (mark === "-") {
          cur.old.push(l.slice(1));
          cur.ctx.push(false);
        } else if (mark === "+") cur.new.push(l.slice(1));
        else
          return `patch 第 ${i + 1} 行：無法辨識的行 '${l.slice(0, 80)}'：Update 區段中每行須以 ' '（上下文）、'+'（新增）或 '-'（刪除）開頭`;
      }
      i++;
    }
    flush();
    if (!chunks.length) return `patch：Update 區段 '${path}' 沒有任何變更行`;
    ops.push({ kind: "update", path, ...(moveTo ? { moveTo } : {}), chunks });
  }
  return ops;
}

const NORMS: Array<(s: string) => string> = [
  (s) => s,
  (s) => s.trimEnd(),
  (s) => s.trim(),
  (s) => foldUnicode(s).trim(),
];

function matchAt(lines: string[], pat: string[], at: number, norm: (s: string) => string): boolean {
  for (let k = 0; k < pat.length; k++)
    if (norm(lines[at + k] ?? "\u0000") !== norm(pat[k] as string)) return false;
  return true;
}

/** Every start of `pat` at or after `start`, at the first level that has any; `eof` tries the end first. */
export function seekAll(lines: string[], pat: string[], start: number, eof: boolean): number[] {
  if (!pat.length) return [start];
  for (const norm of NORMS) {
    const hits: number[] = [];
    if (eof) {
      const at = lines.length - pat.length;
      if (at >= start && matchAt(lines, pat, at, norm)) return [at];
    }
    for (let i = start; i + pat.length <= lines.length; i++) if (matchAt(lines, pat, i, norm)) hits.push(i);
    if (hits.length) return hits;
  }
  return [];
}

/** Apply an Update's chunks to LF text; a string is the error. `applied` counts chunks already in the file. */
export function applyChunks(
  text: string,
  chunks: readonly Chunk[],
  path: string,
): string | { text: string; applied: number } {
  const endsNl = text.endsWith("\n");
  const lines = (endsNl ? text.slice(0, -1) : text).split("\n");
  if (text === "") lines.length = 0;
  const reps: Array<{ at: number; del: number; add: string[] }> = [];
  let cursor = 0;
  let applied = 0;
  for (const [k, ch0] of chunks.entries()) {
    let ch = ch0;
    if (ch.anchor) {
      const a = seekAll(lines, [ch.anchor], cursor, false);
      if (!a.length) return `在 ${path} 中找不到錨點行 '${ch.anchor}'`;
      cursor = (a[0] as number) + 1;
    }
    if (!ch.old.length) {
      if (!ch.anchor && !ch.eof) return `chunk #${k + 1}：純新增的 chunk 需要 @@ 錨點或 *** End of File`;
      const at = ch.anchor ? cursor : Math.max(0, lines.length - ch.new.length);
      if (ch.new.length && seekAll(lines, ch.new, at, false)[0] === at) {
        applied++;
        cursor = at + ch.new.length;
        continue;
      }
      reps.push({ at: ch.anchor ? cursor : lines.length, del: 0, add: ch.new });
      continue;
    }
    let hits = seekAll(lines, ch.old, cursor, ch.eof);
    if (!hits.length && ch.old.at(-1) === "") {
      const trim = (a: string[]) => (a.at(-1) === "" ? a.slice(0, -1) : a);
      ch = { ...ch, old: trim(ch.old), new: trim(ch.new), ctx: ch.ctx.slice(0, ch.old.length - 1) };
      hits = seekAll(lines, ch.old, cursor, ch.eof);
    }
    if (!hits.length) {
      const done = ch.new.some((l) => l.trim()) ? seekAll(lines, ch.new, 0, false) : [];
      if (done.length) {
        applied++;
        cursor = Math.max(cursor, (done[0] as number) + ch.new.length);
        continue;
      }
      return `在 ${path} 中找不到下列內容（chunk #${k + 1}）：\n${ch.old.join("\n")}`;
    }
    if (hits.length > 1 && !ch.anchor && !ch.eof)
      return `chunk #${k + 1} 在 ${path} 中有多個符合位置（第 ${(hits[0] as number) + 1}、${(hits[1] as number) + 1} 行），請加 @@ 錨點或更多上下文`;
    const pos = hits[0] as number;
    // context lines keep the file's own text; only removed / added lines change
    const out: string[] = [];
    let ni = 0;
    for (let oi = 0; oi < ch.old.length; oi++) {
      if (ch.ctx[oi]) {
        while (ni < ch.new.length && ch.new[ni] !== ch.old[oi]) out.push(ch.new[ni++] as string);
        out.push(lines[pos + oi] as string);
        ni++;
      }
    }
    while (ni < ch.new.length) out.push(ch.new[ni++] as string);
    reps.push({ at: pos, del: ch.old.length, add: out });
    cursor = pos + ch.old.length;
  }
  reps.sort((a, b) => a.at - b.at);
  for (let k = 1; k < reps.length; k++)
    if (
      (reps[k - 1] as (typeof reps)[number]).at + (reps[k - 1] as (typeof reps)[number]).del >
      (reps[k] as (typeof reps)[number]).at
    )
      return `${path} 的 chunk 範圍重疊`;
  for (const r of [...reps].reverse()) lines.splice(r.at, r.del, ...r.add);
  return { text: lines.join("\n") + (endsNl || (text === "" && lines.length) ? "\n" : ""), applied };
}
