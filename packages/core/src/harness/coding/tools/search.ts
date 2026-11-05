import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { HostTool } from "@alca/tools";
import { confine } from "../../../workspace/workdir.ts";
import { globToRegex, walkFiles } from "../ignore.ts";
import { repoRoot } from "../project.ts";
import { isDir, obj, shownPath, type ToolEnv } from "./common.ts";

/**
 * Plan §4: `grep` and `glob`. With ripgrep installed they run it (it honours
 * `.gitignore`, also outside a git repo: `--no-require-git`); without it, the
 * built-in walk (ignore.ts) with a JS regex does the same job. Both cap what
 * they return (grep 100 lines by default, glob 200 files; at most 1000) and
 * say so when there is more; a line is cut at 500 characters.
 */

export const GREP_DEFAULT = 100;
export const GLOB_DEFAULT = 200;
export const SEARCH_MAX = 1000;
const LINE_CUT = 500;

let found: string | false | undefined;

/** ripgrep's path when it is installed (looked up once). */
export function findRipgrep(): string | false {
  if (found !== undefined) return found;
  try {
    execFileSync("rg", ["--version"], { stdio: "ignore", timeout: 3000 });
    found = "rg";
  } catch {
    found = false;
  }
  return found;
}

interface RgOut {
  stdout: string;
  error?: string;
}

function rg(bin: string, args: string[], cwd: string, signal?: AbortSignal): Promise<RgOut> {
  return new Promise((done) => {
    execFile(
      bin,
      args,
      { cwd, maxBuffer: 16 * 1024 * 1024, ...(signal ? { signal } : {}) },
      (err, stdout, stderr) => {
        const code = (err as { code?: number | string } | null)?.code;
        if (err && code !== 1) return done({ stdout: "", error: stderr || String(err.message) });
        done({ stdout });
      },
    );
  });
}

const posix = (p: string) => p.split(sep).join("/");
const cap = (n: unknown, d: number) => Math.min(SEARCH_MAX, typeof n === "number" && n > 0 ? n : d);
const cutLine = (l: string) => (l.length > LINE_CUT ? `${l.slice(0, LINE_CUT)}…[本行已截斷]` : l);

/** Files under `base` (or `base` itself) that pass `.gitignore` and the glob, from the built-in walk. */
function walkSelect(root: string, base: string, glob: string | undefined): string[] {
  if (!isDir(base)) return [base];
  // The rules start at the repository root (its .gitignore counts), else at the worker's folder.
  const repo = repoRoot(base);
  const { files } = walkFiles(existsSync(join(repo, ".git")) ? repo : root, base);
  if (!glob) return files;
  const re = globToRegex(glob, glob.includes("/"));
  return files.filter((f) => re.test(posix(relative(base, f))));
}

export interface GrepArgs {
  pattern: string;
  path?: string;
  glob?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  context?: number;
  outputMode?: "lines" | "files" | "count";
}

/** The built-in grep: the shapes of ripgrep's `-n --with-filename`, `-l` and `-c`. */
export function jsGrep(root: string, base: string, a: GrepArgs, limit: number): string[] {
  const flags = a.ignoreCase ? "i" : "";
  let re: RegExp;
  try {
    re = new RegExp(a.literal ? a.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : a.pattern, flags);
  } catch (err) {
    throw new Error(`${String((err as Error).message)}（正規表示式有問題時可以設 literal: true）`);
  }
  const mode = a.outputMode ?? "lines";
  const ctxN = mode === "lines" ? Math.min(10, a.context ?? 0) : 0;
  const out: string[] = [];
  for (const f of walkSelect(root, base, a.glob)) {
    let text: string;
    try {
      text = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    if (text.includes("\0")) continue;
    const name = posix(relative(root, f));
    const lines = text.split("\n");
    let count = 0;
    const shown = new Set<number>();
    lines.forEach((l, i) => {
      if (!re.test(l)) return;
      count++;
      if (mode !== "lines") return;
      for (let k = Math.max(0, i - ctxN); k <= Math.min(lines.length - 1, i + ctxN); k++) {
        if (shown.has(k)) continue;
        shown.add(k);
        const sep = k === i ? ":" : "-";
        out.push(`${name}${sep}${k + 1}${sep}${lines[k]}`);
      }
    });
    if (count && mode === "files") out.push(name);
    if (count && mode === "count") out.push(`${name}:${count}`);
    if (out.length > limit) break;
  }
  return out;
}

export function grepTool(env: ToolEnv): HostTool {
  return {
    spec: {
      name: "grep",
      description:
        "搜尋檔案內容（尊重 .gitignore；有 ripgrep 就用它）。outputMode lines／files／count；limit 預設 100、最多 1000；glob 篩檔名。",
      inputSchema: obj(
        {
          pattern: { type: "string" },
          path: { type: "string" },
          glob: { type: "string" },
          ignoreCase: { type: "boolean" },
          literal: { type: "boolean" },
          context: { type: "integer", minimum: 0 },
          limit: { type: "integer", minimum: 1 },
          outputMode: { type: "string", enum: ["lines", "files", "count"] },
        },
        ["pattern"],
      ),
    },
    actionClass: "read",
    run: async (raw, signal, ctx) => {
      const a = raw as unknown as GrepArgs & { limit?: number };
      const root = env.dir(ctx);
      const target = confine(root, typeof a.path === "string" && a.path ? a.path : ".");
      const limit = cap(a.limit, GREP_DEFAULT);
      const mode = a.outputMode ?? "lines";
      let rows: string[];
      if (env.rg) {
        const args = ["--no-config", "--color=never", "--hidden", "--no-require-git", "--glob=!.git"];
        if (mode === "files") args.push("-l");
        else if (mode === "count") args.push("-c");
        else args.push("-n", "--with-filename");
        if (a.ignoreCase) args.push("-i");
        if (a.literal) args.push("-F");
        if (typeof a.context === "number" && mode === "lines")
          args.push("-C", String(Math.min(10, a.context)));
        if (typeof a.glob === "string" && a.glob) args.push("--glob", a.glob);
        args.push("--", String(a.pattern), relative(root, target) || ".");
        const out = await rg(env.rg, args, root, signal);
        if (out.error)
          throw new Error(`${out.error.split("\n")[0]}（正規表示式有問題時可以設 literal: true）`);
        rows = out.stdout
          .split("\n")
          .filter(Boolean)
          .map((l) => l.replace(/^\.\//, ""));
      } else rows = jsGrep(root, target, a, limit);
      rows = rows.map(cutLine);
      if (!rows.length) return "沒有符合的結果。";
      const more = rows.length > limit;
      return `${rows.slice(0, limit).join("\n")}${more ? `\n[已達 ${limit} 筆上限，還有更多。可加大 limit（最多 ${SEARCH_MAX}），或縮小 pattern／path／glob]` : ""}`;
    },
  };
}

const mtime = (f: string) => {
  try {
    return statSync(f).mtimeMs;
  } catch {
    return 0;
  }
};

export function globTool(env: ToolEnv): HostTool {
  return {
    spec: {
      name: "glob",
      description:
        "依檔名樣式找檔（例如 **/*.test.ts；尊重 .gitignore），新改的在前；limit 預設 200、最多 1000。",
      inputSchema: obj(
        { pattern: { type: "string" }, path: { type: "string" }, limit: { type: "integer", minimum: 1 } },
        ["pattern"],
      ),
    },
    actionClass: "read",
    run: async (a, signal, ctx) => {
      const root = env.dir(ctx);
      const base = confine(root, typeof a.path === "string" && a.path ? a.path : ".");
      if (!isDir(base)) throw new Error(`glob 的 path 必須是目錄：${shownPath(root, base)}`);
      const limit = cap(a.limit, GLOB_DEFAULT);
      const pattern = String(a.pattern ?? "");
      let files: string[];
      if (env.rg) {
        const out = await rg(
          env.rg,
          ["--no-config", "--files", "--hidden", "--no-require-git", "--glob=!.git", "--glob", pattern, "."],
          base,
          signal,
        );
        if (out.error) throw new Error(out.error.split("\n")[0]);
        files = out.stdout
          .split("\n")
          .filter(Boolean)
          .map((f) => resolve(base, f));
      } else files = walkSelect(root, base, pattern);
      const sorted = files
        .map((f) => ({ f, t: mtime(f) }))
        .sort((x, y) => y.t - x.t || (x.f < y.f ? -1 : 1))
        .map((x) => posix(relative(root, x.f)));
      if (!sorted.length) return "沒有符合的檔案。";
      return `${sorted.slice(0, limit).join("\n")}${sorted.length > limit ? `\n[顯示前 ${limit} 筆（共 ${sorted.length} 筆）。請用更精確的 pattern 或 path]` : ""}`;
    },
  };
}
