/**
 * P15 B3 (plan v11.1 §2 S0): tool output limits. Every result is capped at
 * 2,000 lines or 50 KB; reads keep the head, shell output keeps mostly the
 * tail (20 % head / 80 % tail), everything else is cut in the middle. Only
 * whole lines are kept; a single line longer than the budget is cut on a UTF-8
 * boundary. A cut result is spilled whole and the model gets where and how big.
 */

export const OUTPUT_MAX_LINES = 2000;
export const OUTPUT_MAX_BYTES = 50 * 1024;

export type CutMode = "head" | "tail" | "headtail";

export interface Truncated {
  text: string;
  truncated: boolean;
  totalLines: number;
  totalBytes: number;
  omittedLines: number;
}

const enc = new TextEncoder();
const bytes = (s: string) => enc.encode(s).length;

/** The first `max` bytes of `s`, never splitting a character. */
export function headBytes(s: string, max: number): string {
  let out = "";
  let n = 0;
  for (const ch of s) {
    const b = bytes(ch);
    if (n + b > max) break;
    out += ch;
    n += b;
  }
  return out;
}

/** The last `max` bytes of `s`, never splitting a character. */
export function tailBytes(s: string, max: number): string {
  const chars = [...s];
  let out = "";
  let n = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    const ch = chars[i] as string;
    const b = bytes(ch);
    if (n + b > max) break;
    out = ch + out;
    n += b;
  }
  return out;
}

function splitLines(text: string): string[] {
  const lines = text.split("\n");
  // A trailing newline does not count as a line.
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines;
}

function takeHead(lines: string[], maxLines: number, maxBytes: number): string[] {
  const out: string[] = [];
  let n = 0;
  for (const l of lines) {
    const b = bytes(l) + 1;
    if (out.length >= maxLines || n + b > maxBytes) {
      if (out.length === 0) out.push(`${headBytes(l, Math.max(0, maxBytes - 1))}…`);
      break;
    }
    out.push(l);
    n += b;
  }
  return out;
}

function takeTail(lines: string[], maxLines: number, maxBytes: number): string[] {
  const out: string[] = [];
  let n = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i] as string;
    const b = bytes(l) + 1;
    if (out.length >= maxLines || n + b > maxBytes) {
      if (out.length === 0) out.unshift(`…${tailBytes(l, Math.max(0, maxBytes - 1))}`);
      break;
    }
    out.unshift(l);
    n += b;
  }
  return out;
}

export function truncateText(
  text: string,
  o: { mode: CutMode; maxLines?: number; maxBytes?: number; headShare?: number },
): Truncated {
  const maxLines = o.maxLines ?? OUTPUT_MAX_LINES;
  const maxBytes = o.maxBytes ?? OUTPUT_MAX_BYTES;
  const lines = splitLines(text);
  const totalBytes = bytes(text);
  const base = { totalLines: lines.length, totalBytes };
  if (lines.length <= maxLines && totalBytes <= maxBytes)
    return { text, truncated: false, omittedLines: 0, ...base };
  if (o.mode === "head") {
    const kept = takeHead(lines, maxLines, maxBytes);
    return { text: kept.join("\n"), truncated: true, omittedLines: lines.length - kept.length, ...base };
  }
  if (o.mode === "tail") {
    const kept = takeTail(lines, maxLines, maxBytes);
    return { text: kept.join("\n"), truncated: true, omittedLines: lines.length - kept.length, ...base };
  }
  const share = o.headShare ?? 0.2;
  const head = takeHead(lines, Math.floor(maxLines * share), Math.floor(maxBytes * share));
  const rest = lines.slice(head.length);
  const tail = takeTail(rest, maxLines - head.length, maxBytes - Math.floor(maxBytes * share));
  const omitted = lines.length - head.length - tail.length;
  const omittedBytes = Math.max(0, totalBytes - bytes(head.join("\n")) - bytes(tail.join("\n")));
  return {
    text: `${head.join("\n")}\n[… 已省略 ${omitted} 行 / ${omittedBytes} bytes …]\n${tail.join("\n")}`,
    truncated: true,
    omittedLines: omitted,
    ...base,
  };
}

/** Which end of a tool's output matters (v11 B3): reads the head, shell the tail, others the middle is cut. */
export function cutModeFor(tool: string): CutMode {
  if (/^(read|file_read|files_read|Read|history_read)$/.test(tool)) return "head";
  if (/^(bash|bash_poll|bash_input|Bash|hands_run|shell)$/.test(tool)) return "headtail";
  return "headtail";
}

/**
 * Cap one tool result; a cut one is spilled whole (`spill` returns its id or
 * path) and the text says the original size and where to read the rest.
 */
export function shapeToolOutput(
  tool: string,
  output: string,
  spill: (full: string) => string | undefined,
): { text: string; spilled?: string } {
  const mode = cutModeFor(tool);
  const t = truncateText(output, { mode, headShare: tool.startsWith("bash") || tool === "Bash" ? 0.2 : 0.5 });
  if (!t.truncated) return { text: output };
  let where: string | undefined;
  try {
    where = spill(output);
  } catch {
    where = undefined;
  }
  const how =
    mode === "head"
      ? "用 offset 讀下一段"
      : where
        ? "需要中間的內容時用 history_read 或 recall 取回全文"
        : "請縮小範圍重新執行";
  const note = `[輸出已截斷：原本 ${t.totalLines} 行 / ${t.totalBytes} bytes${where ? `；全文：${where}` : ""}。${how}]`;
  return { text: `${t.text}\n${note}`, ...(where ? { spilled: where } : {}) };
}
