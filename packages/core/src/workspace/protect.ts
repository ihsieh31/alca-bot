import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { PROTECTED_CONFIG_MARKS } from "@alca/os";
import { shellCommandOf, splitCommands, substitutions } from "@alca/policy";
import { isWithin, realish } from "./workdir.ts";

/**
 * Review 2026-11-04b S2.1 and S1.4: what a bot's native tools may not touch.
 *
 * 1. Alca's data folder. `secrets.json` (the local token, the Link identity
 *    key, the VAPID key), `vault.json`, `state.sqlite` (every conversation and
 *    memory, every bot), `backups/`, `logs/`, the browser profile and the
 *    engines' homes live there. A native read, edit or shell command whose
 *    path (resolved through `..` and symlinks) or command line reaches it is
 *    DENIED — not asked — at every level. The bot's own work folder is the one
 *    exception (by default it is `<data>/bots/<id>/work`).
 * 2. Engine and tool configuration inside the work folder (`.claude/`,
 *    `.codex/`, `.gemini/`, `.mcp.json`, `.git/hooks/`, `.envrc`, …): a
 *    write there could change how the next session runs (allow rules, hooks,
 *    MCP servers). It asks at every level (a person may want it; the bot
 *    alone may not).
 *
 * Shell commands are matched by their words, not run: a path built at run
 * time (`$(echo …|base64 -d)`) is not seen. Under 自主 that is what the
 * shell floor is for (the command asks), and the approval endpoint needs a
 * credential no bot can read (desktop `ui-session.ts`), so even a read token
 * cannot approve anything.
 */

/** Argument keys that name a file or folder, for CLI / ACP tools and Alca's own. */
const PATH_KEYS = [
  "file_path",
  "filePath",
  "path",
  "notebook_path",
  "directory",
  "dir",
  "cwd",
  "target",
  "source",
  "destination",
  "abs_path",
  "absolute_path",
];

/** Every path a tool call names (absolute, or from `cwd`). */
export function pathsOf(args: Record<string, unknown>, cwd: string | undefined): string[] {
  const out: string[] = [];
  const add = (p: unknown) => {
    if (typeof p !== "string" || !p || p.includes("\0")) return;
    const e = expandHome(p);
    if (isAbsolute(e)) out.push(resolve(e));
    else if (cwd) out.push(resolve(cwd, e));
  };
  for (const k of PATH_KEYS) add(args[k]);
  if (Array.isArray(args.paths)) for (const p of args.paths) add(p);
  if (Array.isArray(args.locations))
    for (const l of args.locations) add((l as { path?: unknown } | null)?.path);
  // Glob / Grep with an absolute pattern (`/Users/me/.alca/*.json`).
  if (typeof args.pattern === "string" && /^([/~]|[A-Za-z]:\\)/.test(args.pattern)) add(args.pattern);
  // Codex's apply_patch: [{path, kind, …}]
  if (Array.isArray(args.changes)) for (const c of args.changes) add((c as { path?: unknown } | null)?.path);
  return out.slice(0, 50);
}

function expandHome(p: string, home = homedir()): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return p.replace(/^\$\{?HOME\}?(?=\/|$)/, home);
}

/** The words of a command line that could be paths (quotes undone, substitutions included). */
function wordsOf(command: string): string[] {
  const words = splitCommands(command).flat();
  for (const s of substitutions(command)) words.push(...splitCommands(s).flat());
  // `>file`, `2>>log`, `--out=/x`: the part after the operator / `=`.
  return words.flatMap((w) => [w, w.replace(/^\d*[<>]+&?/, ""), w.slice(w.indexOf("=") + 1)]);
}

export interface ProtectOptions {
  /** Alca's data folder (resolved). */
  data: string;
  /** The bot's working folder (resolved), the one place inside `data` it may use. */
  workDir?: string | undefined;
  home?: string;
}

/** Why this call reaches Alca's data folder (a reason = deny), or undefined. */
export function reachesDataFolder(
  tool: string,
  args: Record<string, unknown>,
  o: ProtectOptions,
): string | undefined {
  const data = realish(o.data);
  const own = o.workDir ? realish(o.workDir) : undefined;
  const inside = (p: string) => {
    const r = realish(p);
    return isWithin(data, r) && !(own && isWithin(own, r));
  };
  const said = `Alca 的資料夾（金鑰、資料庫、其他 bot 的資料）bot 不能讀寫`;
  for (const p of pathsOf(args, own)) if (inside(p)) return `${said}：${p}`;
  const command = shellCommandOf(tool, args);
  if (command === undefined) return undefined;
  if (command.includes(data) || command.includes(o.data)) return said;
  if (/\$\{?ALCA_DATA_DIR\b/.test(command)) return said;
  const home = o.home ?? homedir();
  const homeAlca = join(home, ".alca");
  const mentionsHomeAlca = /(~|\$\{?HOME\}?)\/\.alca(\/|\b|$)/.test(command) || command.includes(homeAlca);
  if (mentionsHomeAlca && isWithin(realish(homeAlca), data)) return said;
  for (const w of wordsOf(command)) {
    if (!/[/~.]/.test(w)) continue;
    const e = expandHome(w, home);
    const abs = isAbsolute(e) ? resolve(e) : own ? resolve(own, e) : undefined;
    if (abs && inside(abs)) return `${said}：${w}`;
  }
  return undefined;
}

/** Engine / tool configuration a write could plant (S1.4), as path segments (shared with the OS sandbox). */
const CONFIG_MARKS = PROTECTED_CONFIG_MARKS;

const markIn = (p: string): string | undefined => {
  const parts = p.split(/[\\/]+/);
  for (const m of CONFIG_MARKS) {
    const seg = m.split("/");
    for (let i = 0; i + seg.length <= parts.length; i++)
      if (seg.every((s, k) => parts[i + k] === s)) return m;
  }
  return undefined;
};

/**
 * Why this write would plant engine or tool configuration (a reason = ask at
 * every level), or undefined. `edits` are the paths an edit tool changes.
 */
export function plantsConfig(
  tool: string,
  args: Record<string, unknown>,
  edits: readonly string[],
): string | undefined {
  for (const p of edits) {
    const m = markIn(p);
    if (m) return `要改引擎或工具的設定檔（${m}），可能改變之後怎麼執行，先問你`;
  }
  const command = shellCommandOf(tool, args);
  if (command === undefined) return undefined;
  for (const w of wordsOf(command)) {
    const m = markIn(w.replaceAll(sep, "/"));
    if (m) return `指令碰到引擎或工具的設定檔（${m}），可能改變之後怎麼執行，先問你`;
  }
  return undefined;
}
