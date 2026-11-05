/**
 * Plan §2.7: what a worker actually did, counted by the harness from its tool
 * events — never from what the worker says. Files it changed, commands it
 * ran (with exit codes when the tool reports one), pages it opened, actions
 * it sent through connected apps, and which of the commands were tests.
 */

import { SHELL_COMMAND_TOOLS } from "@alca/policy";

export interface ToolEventPair {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  output: string;
  /** The class the gate saw (outward = send / payment / publish / delete). */
  actionClass?: string;
}

export interface CommandAction {
  command: string;
  ok: boolean;
  exitCode: number | null;
}

export interface HarnessActions {
  filesChanged: string[];
  commands: CommandAction[];
  pages: string[];
  connector: string[];
  testsRun: CommandAction[];
  /** v11.1 §4 S7 evidence: counts, the last errors and the outward actions. */
  toolCalls: number;
  okToolCalls: number;
  errors: string[];
  outward: string[];
}

export const emptyActions = (): HarnessActions => ({
  filesChanged: [],
  commands: [],
  pages: [],
  connector: [],
  testsRun: [],
  toolCalls: 0,
  okToolCalls: 0,
  errors: [],
  outward: [],
});

const OUTWARD_CLASSES = new Set(["send", "payment", "publish", "delete"]);
const OUTWARD_SHELL = /\bgit\s+(push|commit)\b|\bcurl\b[^|;&]*-X\s*(POST|PUT|DELETE|PATCH)\b/i;

/** Pages without their query string (it can carry a token). */
const pageOf = (url: string) => {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url.split("?")[0] ?? url;
  }
};

/** Tools that change files, and where their path is. Native CLI names and Alca's own. */
const FILE_TOOLS = new Set([
  "write",
  "edit",
  "file_write",
  "file_edit",
  "files_write",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "hands_write",
]);
/** The shell tools whose `command` is a command line: the one list in @alca/policy (shell-tools.ts). */
const SHELL_TOOLS = SHELL_COMMAND_TOOLS;
const PAGE_TOOLS = new Set(["browser_open", "browser_navigate", "web_fetch", "WebFetch"]);
/** Tools that read a background process's output again (polling is not a loop while the output changes). */
export const POLL_TOOLS: ReadonlySet<string> = new Set([
  "bash_poll",
  "BashOutput",
  "bash_output",
  "process_poll",
]);
const CONNECTOR_TOOLS = new Set(["connector_use_tool", "tool_call", "app_mail_send", "draft_save"]);

const TEST_RE =
  /(^|[\s;&|(])((p?npm|yarn|bun)\s+(run\s+)?(test|check|typecheck|lint)|vitest|jest|pytest|go\s+test|cargo\s+(test|check|clippy)|tsc(\s|$)|ruff|mypy|biome\s+check|make\s+(test|check))/;

/** Shell commands that may change files (sed -i, redirects, moves, installs, git apply …). */
const SHELL_WRITE_RE =
  /(\bsed\s+-i|[^2&]>\s*[^&\s]|\btee\b|\b(mv|cp|rm|mkdir|touch|chmod|ln)\s|\bgit\s+(apply|checkout|restore|reset|merge|rebase|am|stash)\b|\b(p?npm|yarn|bun|pip|cargo|go)\s+(install|add|remove|get|update)\b|\bpatch\b)/;

export const isFileTool = (tool: string): boolean => FILE_TOOLS.has(tool) || tool === "apply_patch";
export const isShellTool = (tool: string): boolean => SHELL_TOOLS.has(tool);
/** A known check command (tests, typecheck, lint, build checks): a red result is a normal failure. */
export const isCheckCommand = (command: string): boolean => TEST_RE.test(command);

/** The shell command of a call, when it is one. */
export function commandOf(tool: string, args: Record<string, unknown>): string | undefined {
  if (!SHELL_TOOLS.has(tool)) return undefined;
  const c = args.command ?? args.cmd;
  return typeof c === "string" ? c : Array.isArray(c) ? c.join(" ") : undefined;
}

/** Whether a finished call may have changed the files (an edit tool, or a shell command that writes). */
export function changesFiles(tool: string, args: Record<string, unknown>, ok: boolean): boolean {
  if (!ok) return false;
  if (isFileTool(tool)) return true;
  // An ACP agent's native edit / delete / move (its tool is named by a free-text title).
  if (typeof args.kind === "string" && ["edit", "delete", "move"].includes(args.kind)) return true;
  const c = commandOf(tool, args);
  return c !== undefined && !isCheckCommand(c) && SHELL_WRITE_RE.test(c);
}

/** Whether a finished call reached outside (send / payment / publish / delete, git push, a POST). */
export function isOutwardCall(e: Pick<ToolEventPair, "tool" | "args" | "ok" | "actionClass">): boolean {
  if (!e.ok) return false;
  const shell = commandOf(e.tool, e.args ?? {}) ?? "";
  return (!!e.actionClass && OUTWARD_CLASSES.has(e.actionClass)) || OUTWARD_SHELL.test(shell);
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** `[exit 3]`, `exit code: 3`, `Exit code 3`, `exitCode=3` … from a shell tool's output. */
export function exitCodeOf(output: string): number | null {
  const m = /\bexit(?:\s*code)?\s*[:=]?\s*(-?\d{1,3})\b/i.exec(output);
  return m ? Number(m[1]) : null;
}

/** Paths an apply_patch body touches (`*** Update File: p`, `*** Add File: p`, `*** Delete File: p`). */
export function patchPaths(patch: string): string[] {
  const out: string[] = [];
  for (const m of patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm))
    out.push((m[1] ?? "").trim());
  for (const m of patch.matchAll(/^\*\*\* Move to: (.+)$/gm)) out.push((m[1] ?? "").trim());
  return out.filter(Boolean);
}

const add = (list: string[], v: string | undefined) => {
  if (v && !list.includes(v)) list.push(v.slice(0, 500));
};

/** Fold one finished call into the ledger. Failed calls count only as commands (a failed command still ran). */
export function noteAction(a: HarnessActions, e: ToolEventPair): void {
  const args = e.args ?? {};
  a.toolCalls++;
  if (e.ok) a.okToolCalls++;
  else {
    a.errors.push(`${e.tool}：${e.output.slice(0, 200)}`);
    if (a.errors.length > 3) a.errors.shift();
  }
  const shell = SHELL_TOOLS.has(e.tool) ? (str(args.command) ?? "") : "";
  if (e.ok && ((e.actionClass && OUTWARD_CLASSES.has(e.actionClass)) || OUTWARD_SHELL.test(shell)))
    add(a.outward, `${e.actionClass ?? "shell"}：${e.tool}${shell ? ` ${shell.slice(0, 80)}` : ""}`);
  if (SHELL_TOOLS.has(e.tool)) {
    const command = str(args.command) ?? str(args.cmd) ?? "";
    if (!command) return;
    const c: CommandAction = { command: command.slice(0, 300), ok: e.ok, exitCode: exitCodeOf(e.output) };
    if (c.exitCode !== null && c.exitCode !== 0) c.ok = false;
    a.commands.push(c);
    if (TEST_RE.test(command)) a.testsRun.push(c);
    return;
  }
  if (!e.ok) return;
  if (FILE_TOOLS.has(e.tool))
    add(a.filesChanged, str(args.path) ?? str(args.file_path) ?? str(args.notebook_path));
  else if (e.tool === "apply_patch")
    for (const p of patchPaths(str(args.patch) ?? str(args.input) ?? "")) add(a.filesChanged, p);
  else if (PAGE_TOOLS.has(e.tool)) {
    const u = str(args.url);
    if (u && a.pages.length < 20) add(a.pages, pageOf(u));
  } else if (CONNECTOR_TOOLS.has(e.tool))
    add(
      a.connector,
      `${e.tool}${(str(args.slug) ?? str(args.tool)) ? `:${str(args.slug) ?? str(args.tool)}` : ""}`,
    );
  else if (e.tool === "browser_script" || e.tool === "browser_run_script")
    for (const u of scriptUrls(args)) add(a.pages, u);
}

function scriptUrls(args: Record<string, unknown>): string[] {
  const steps = (args.script as { steps?: unknown } | undefined)?.steps ?? args.steps;
  if (!Array.isArray(steps)) return [];
  return steps
    .map((s) => (s && typeof s === "object" ? str((s as Record<string, unknown>).url) : undefined))
    .filter((u): u is string => !!u);
}

/** The ledger of a list of finished calls. */
export function actionsFrom(events: readonly ToolEventPair[]): HarnessActions {
  const a = emptyActions();
  for (const e of events) noteAction(a, e);
  return a;
}

export function actionsEmpty(a: HarnessActions): boolean {
  return (
    !a.filesChanged.length &&
    !a.commands.length &&
    !a.pages.length &&
    !a.connector.length &&
    !a.outward.length
  );
}

/** The ledger as the router reads it, next to the worker's own words. */
export function actionLines(a: HarnessActions, defuse: (s: string) => string): string[] {
  if (actionsEmpty(a))
    return ["實際動作（harness 從工具事件算出）：沒有改檔、沒有跑指令、沒有開頁面、沒有連接動作"];
  const out = [
    `實際動作（harness 從工具事件算出，和自述對照）：工具呼叫 ${a.toolCalls} 次、成功 ${a.okToolCalls} 次`,
  ];
  if (a.outward.length) out.push(`- 對外動作：${a.outward.map(defuse).join("、")}`);
  if (a.errors.length) out.push(`- 最後的錯誤：${a.errors.map(defuse).join("｜")}`);
  if (a.filesChanged.length) out.push(`- 改了檔案：${a.filesChanged.map(defuse).join("、")}`);
  if (a.commands.length)
    out.push(
      `- 跑了指令：${a.commands
        .slice(-12)
        .map(
          (c) =>
            `${defuse(c.command)}（${c.exitCode !== null ? `結束碼 ${c.exitCode}` : c.ok ? "成功" : "失敗"}）`,
        )
        .join("；")}`,
    );
  if (a.testsRun.length)
    out.push(`- 其中測試／檢查：${a.testsRun.filter((t) => t.ok).length}／${a.testsRun.length} 通過`);
  if (a.pages.length) out.push(`- 開了頁面：${a.pages.slice(-12).map(defuse).join("、")}`);
  if (a.connector.length) out.push(`- 連接動作：${a.connector.map(defuse).join("、")}`);
  return out;
}
