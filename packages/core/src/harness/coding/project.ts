import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { realish } from "../../workspace/workdir.ts";

/**
 * Plan §4 (moved from the P15 archive): the project instructions a coding
 * worker gets. From the repo root (nearest `.git` above the work folder, else
 * the folder itself) down to the work folder, one file per level —
 * `AGENTS.override.md`, `AGENTS.md`, `CLAUDE.md` — shallow first, so deeper
 * ones come later and weigh more; 32 KiB in total. A folder below the work
 * folder adds its file the first time the worker reads something there,
 * within what is left of the same 32 KiB (8 KiB per file at most).
 *
 * The check commands are the host's (agents/harness-run/verify.ts).
 */

export const INSTRUCTION_NAMES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
export const INSTRUCTIONS_MAX_BYTES = 32 * 1024;
const NESTED_MAX_BYTES = 8 * 1024;

const within = (root: string, p: string) => {
  const r = relative(root, p);
  return r === "" || (!r.startsWith("..") && !r.startsWith(sep) && r !== "..");
};

export function repoRoot(dir: string): string {
  const start = realish(resolve(dir));
  let d = start;
  for (;;) {
    if (existsSync(join(d, ".git"))) return d;
    const up = dirname(d);
    if (up === d) return start;
    d = up;
  }
}

function instructionFile(dir: string): string | undefined {
  for (const n of INSTRUCTION_NAMES) {
    const p = join(dir, n);
    try {
      if (statSync(p).isFile()) return p;
    } catch {
      // next name
    }
  }
  return undefined;
}

const readClean = (p: string) => readFileSync(p, "utf8").replace(/^\uFEFF/, "");
const enc = new TextEncoder();
const bytes = (s: string) => enc.encode(s).length;

/** The longest prefix of `text` within `room` bytes (whole characters). */
function cutTo(text: string, room: number): string {
  let cut = "";
  let n = 0;
  for (const ch of text) {
    const b = bytes(ch);
    if (n + b > room) break;
    cut += ch;
    n += b;
  }
  return cut;
}

export interface LoadedInstructions {
  text: string;
  files: string[];
  skipped: string[];
  /** Bytes used of the budget (what is left goes to the folders found later). */
  used: number;
}

/** The instruction files from the repo root down to `workdir`, within the byte budget. */
export function loadInstructions(workdir: string, max = INSTRUCTIONS_MAX_BYTES): LoadedInstructions {
  const root = repoRoot(workdir);
  const chain: string[] = [];
  for (let d = realish(resolve(workdir)); ; d = dirname(d)) {
    chain.unshift(d);
    if (d === root || dirname(d) === d) break;
  }
  const parts: string[] = [];
  const files: string[] = [];
  const skipped: string[] = [];
  let used = 0;
  for (const d of chain) {
    const f = instructionFile(d);
    if (!f) continue;
    const body = readClean(f);
    if (!body.trim()) continue;
    if (used >= max) {
      skipped.push(f);
      continue;
    }
    const text =
      used + bytes(body) > max
        ? `${cutTo(body, max - used)}\n[… 指令檔超過 32KiB 上限，已截斷；完整內容請 read ${f}]`
        : body;
    used += bytes(text);
    files.push(f);
    parts.push(
      `<instructions source="${relative(root, f) || f}" scope="${d === root ? "project" : "directory"}">\n${text}\n</instructions>`,
    );
  }
  if (skipped.length)
    parts.push(`（還有指令檔沒有載入：${skipped.map((s) => relative(root, s)).join("、")}）`);
  return { text: parts.join("\n"), files, skipped, used };
}

/** What a worker has loaded so far: the files, and the bytes of the 32 KiB budget used. */
export interface InstructionBudget {
  seen: Set<string>;
  used: number;
  max?: number;
}

/**
 * Instructions of folders between a file just read and the work folder that
 * were not loaded yet: once per folder per worker, the first time something
 * there is read, within what is left of the budget.
 */
export function nestedInstructions(file: string, workdir: string, budget: InstructionBudget): string {
  // Both sides real (Mac test B1): a linked work folder must still contain its own files.
  const base = realish(resolve(workdir));
  const real = realish(resolve(file));
  if (!within(base, real)) return "";
  const max = budget.max ?? INSTRUCTIONS_MAX_BYTES;
  const found: string[] = [];
  for (let d = dirname(real); d !== base && within(base, d); d = dirname(d)) {
    const f = instructionFile(d);
    if (f && !budget.seen.has(f)) found.unshift(f);
  }
  const out: string[] = [];
  for (const f of found) {
    budget.seen.add(f);
    const body = readClean(f);
    if (!body.trim()) continue;
    const room = Math.min(NESTED_MAX_BYTES, max - budget.used);
    if (room <= 0) {
      out.push(`（${relative(base, f)} 沒有載入：指令檔已達 32KiB 上限；需要時請 read 它）`);
      continue;
    }
    const text =
      bytes(body) > room ? `${cutTo(body, room)}\n[… 已截斷；完整內容請 read ${relative(base, f)}]` : body;
    budget.used += bytes(text);
    out.push(`<instructions source="${relative(base, f)}" scope="directory">\n${text}\n</instructions>`);
  }
  return out.length
    ? `\n<system-reminder>\n以下是這些子資料夾的專案指令，處理其中的檔案時適用：\n${out.join("\n")}\n</system-reminder>`
    : "";
}
