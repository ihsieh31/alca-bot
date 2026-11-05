/**
 * Plan §4 (moved from the P15 archive): finding `old` text for an edit. Levels, the
 * first one with a hit wins: L1 exact; L2 lines without trailing blanks; L3
 * L2 plus Unicode punctuation folded; L4 common indentation removed (the
 * replacement is re-indented by the difference); L5 escapes undone once, then
 * L1–L3 again. Hits are mapped back to original offsets; a loose hit only
 * rewrites the lines it covers. Every edit must hit once (unless replaceAll),
 * loose hits may not be much bigger than `old`, edits may not overlap.
 *
 * Already applied (plan §4): an edit whose `old` is gone and whose `new` is
 * there (or whose every `old` hit already sits inside a `new` that contains
 * it) is not an error — a retried call after a lost reply must not fail or
 * apply twice. It is reported as applied and nothing is written for it.
 */

export type MatchLevel = "exact" | "trailing" | "unicode" | "indent" | "escape";
export const LEVEL_WORD: Record<MatchLevel, string> = {
  exact: "精確",
  trailing: "行尾空白",
  unicode: "Unicode 標點",
  indent: "縮排彈性",
  escape: "跳脫還原",
};

export interface EditSpec {
  old: string;
  new: string;
  replaceAll?: boolean;
}

interface Hit {
  start: number;
  end: number;
  level: MatchLevel;
  indentDelta?: number;
  /** Line-based hit: first and last line index. */
  lines?: [number, number];
}

const PUNCT: Record<string, string> = {};
for (const c of "\u2010\u2011\u2012\u2013\u2014\u2015\u2212") PUNCT[c] = "-";
for (const c of "\u2018\u2019\u201A\u201B\u2032") PUNCT[c] = "'";
for (const c of "\u201C\u201D\u201E\u201F\u2033") PUNCT[c] = '"';
for (const c of "\u00A0\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u202F\u205F\u3000")
  PUNCT[c] = " ";
PUNCT["\u2026"] = "...";
PUNCT["\u200B"] = "";
PUNCT["\uFEFF"] = "";

export function foldUnicode(s: string): string {
  let out = "";
  for (const ch of s) out += PUNCT[ch] ?? ch;
  return out;
}

const lineStarts = (text: string): number[] => {
  const s = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") s.push(i + 1);
  return s;
};

const minIndent = (lines: string[]): number => {
  let m = Number.POSITIVE_INFINITY;
  for (const l of lines) if (l.trim()) m = Math.min(m, l.length - l.trimStart().length);
  return Number.isFinite(m) ? m : 0;
};

/** Line-window search under a per-line normalizer. */
function lineHits(
  content: string,
  old: string,
  norm: (l: string) => string,
  level: MatchLevel,
  indent = false,
): Hit[] {
  const cl = content.split("\n");
  let ol = old.split("\n");
  if (ol.length > 1 && ol.at(-1) === "") ol = ol.slice(0, -1);
  if (!ol.length) return [];
  const starts = lineStarts(content);
  const oi = indent ? minIndent(ol) : 0;
  const on = ol.map((l) => norm(indent ? l.slice(Math.min(oi, l.length - l.trimStart().length)) : l));
  const hits: Hit[] = [];
  for (let i = 0; i + ol.length <= cl.length; i++) {
    const win = cl.slice(i, i + ol.length);
    const wi = indent ? minIndent(win) : 0;
    let ok = true;
    for (let k = 0; k < ol.length && ok; k++) {
      const w = win[k] as string;
      ok = norm(indent ? w.slice(Math.min(wi, w.length - w.trimStart().length)) : w) === on[k];
    }
    if (!ok) continue;
    const last = i + ol.length - 1;
    hits.push({
      start: starts[i] as number,
      end: (starts[last] as number) + (cl[last] as string).length,
      level,
      lines: [i, last],
      ...(indent ? { indentDelta: wi - oi } : {}),
    });
  }
  return hits;
}

function exactHits(content: string, old: string, level: MatchLevel): Hit[] {
  const hits: Hit[] = [];
  if (!old) return hits;
  for (let at = content.indexOf(old); at >= 0; at = content.indexOf(old, at + old.length))
    hits.push({ start: at, end: at + old.length, level });
  return hits;
}

const undoEscapes = (s: string) =>
  s.replace(/\\(n|t|"|'|\\|`|\$)/g, (_m, c: string) => (c === "n" ? "\n" : c === "t" ? "\t" : c));

export function findHits(content: string, old: string): Hit[] {
  const trail = (l: string) => l.replace(/[ \t]+$/, "");
  const levels: Array<() => Hit[]> = [
    () => exactHits(content, old, "exact"),
    () => lineHits(content, old, trail, "trailing"),
    () => lineHits(content, old, (l) => trail(foldUnicode(l)), "unicode"),
    () => lineHits(content, old, (l) => trail(foldUnicode(l)), "indent", true),
    () => {
      const u = undoEscapes(old);
      if (u === old) return [];
      for (const f of [
        () => exactHits(content, u, "escape"),
        () => lineHits(content, u, trail, "escape"),
        () => lineHits(content, u, (l) => trail(foldUnicode(l)), "escape"),
      ]) {
        const h = f();
        if (h.length) return h;
      }
      return [];
    },
  ];
  for (const l of levels) {
    const h = l();
    if (h.length) return h;
  }
  return [];
}

const LINE_NO = /^\s*\d+│/;

/** Strip `N│` prefixes the model copied from `read` output (only when every non-empty line has one). */
export function stripLineNumbers(e: EditSpec): EditSpec {
  const ls = e.old.split("\n").filter((l) => l.trim());
  if (!ls.length || !ls.every((l) => LINE_NO.test(l))) return e;
  const strip = (s: string) =>
    s
      .split("\n")
      .map((l) => l.replace(LINE_NO, ""))
      .join("\n");
  return { ...e, old: strip(e.old), new: strip(e.new) };
}

/** The closest place to `old`'s first line (a hint for the model, never applied). */
export function nearest(content: string, old: string): { line: number; snippet: string } | undefined {
  const first = old
    .split("\n")
    .find((l) => l.trim())
    ?.trim();
  if (!first) return undefined;
  const cl = content.split("\n");
  let best = -1;
  let score = 0;
  for (let i = 0; i < cl.length; i++) {
    const l = (cl[i] as string).trim();
    if (!l) continue;
    let s = 0;
    const n = Math.min(l.length, first.length);
    while (s < n && l[s] === first[s]) s++;
    const common = s / Math.max(l.length, first.length);
    if (common > score) {
      score = common;
      best = i;
    }
  }
  if (best < 0 || score < 0.3) return undefined;
  return { line: best + 1, snippet: cl.slice(best, best + 3).join("\n") };
}

function reindent(text: string, delta: number): string {
  if (!delta) return text;
  return text
    .split("\n")
    .map((l) => {
      if (!l.trim()) return l;
      if (delta > 0) return " ".repeat(delta) + l;
      const cut = Math.min(-delta, l.length - l.trimStart().length);
      return l.slice(cut);
    })
    .join("\n");
}

export interface PlannedEdits {
  text: string;
  loose: Array<{ index: number; level: MatchLevel }>;
  replacements: number;
  /** Edits found already applied (indexes); nothing was changed for them. */
  applied: number[];
}

/** Whether `e` is already in `content`: `old` gone and `new` there, or every `old` inside a `new`. */
export function editApplied(content: string, e: EditSpec, hits = findHits(content, e.old)): boolean {
  if (!e.new.trim()) return false;
  const news = findHits(content, e.new);
  if (!news.length) return false;
  if (!hits.length) return true;
  if (!e.new.includes(e.old)) return false;
  return hits.every((h) => news.some((n) => n.start <= h.start && h.end <= n.end));
}

const lineOf = (content: string, at: number) => content.slice(0, at).split("\n").length;

/** Apply all edits or none; a string error names the edit that failed. */
export function planEdits(content: string, raw: readonly EditSpec[], shown: string): PlannedEdits | string {
  if (!raw.length) return "edits 至少需要一筆替換。";
  const edits = raw.map((e) =>
    stripLineNumbers({ ...e, old: e.old.replace(/\r\n?/g, "\n"), new: e.new.replace(/\r\n?/g, "\n") }),
  );
  const spans: Array<Hit & { index: number; repl: string }> = [];
  const loose: PlannedEdits["loose"] = [];
  const applied: number[] = [];
  for (const [i, e] of edits.entries()) {
    if (e.old === "") return `edits[${i}].old 不可為空。要整檔覆寫請用 write。`;
    if (e.old === e.new) return `edits[${i}] 的 old 與 new 相同，沒有變更。`;
    const hits = findHits(content, e.old);
    if (editApplied(content, e, hits)) {
      applied.push(i);
      continue;
    }
    if (!hits.length) {
      const n = nearest(content, e.old);
      return `在 ${shown} 中找不到 edits[${i}].old。它必須與檔案內容完全一致（包含空白、縮排與換行）。${n ? `最相近的位置在第 ${n.line} 行附近：\n${n.snippet}` : ""}`;
    }
    if (hits.length > 1 && !e.replaceAll)
      return `edits[${i}].old 在 ${shown} 中出現 ${hits.length} 次（第 ${hits
        .slice(0, 3)
        .map((h) => lineOf(content, h.start))
        .join("、")} 行…）。請加入更多上下文使其唯一，或設定 replaceAll: true。`;
    const level = (hits[0] as Hit).level;
    if (level !== "exact") {
      loose.push({ index: i, level });
      const oldLines = e.old.split("\n").length;
      for (const h of hits) {
        const seg = content.slice(h.start, h.end);
        if (
          seg.split("\n").length > oldLines + 2 ||
          seg.length > Math.max(e.old.length + 200, e.old.length * 2)
        )
          return `edits[${i}] 的寬鬆比對結果比 old 大得多，已拒絕以免誤改。請重新 read 並提供完全一致的 old。`;
      }
    }
    for (const h of hits) {
      let repl = e.new;
      if (h.level === "indent" && h.indentDelta) repl = reindent(repl, h.indentDelta);
      if (h.level !== "exact" && e.old.endsWith("\n") && repl.endsWith("\n")) repl = repl.slice(0, -1);
      spans.push({ ...h, index: i, repl });
    }
  }
  spans.sort((a, b) => a.start - b.start);
  for (let k = 1; k < spans.length; k++) {
    const a = spans[k - 1] as (typeof spans)[number];
    const b = spans[k] as (typeof spans)[number];
    if (a.end > b.start)
      return `edits[${a.index}] 與 edits[${b.index}] 的範圍重疊。請合併成一筆，或改成互不重疊的區段。`;
  }
  let text = content;
  for (const s of [...spans].reverse()) text = text.slice(0, s.start) + s.repl + text.slice(s.end);
  if (text === content && !applied.length)
    return "替換後的內容與原檔相同，未寫入。可能是特殊字元或該段文字已是目標內容。";
  return { text, loose, replacements: spans.length, applied };
}
