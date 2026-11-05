/**
 * The one list of tool names that run a shell command line (security fix
 * 2026-11-05: a host tool named `hands_run` or `shell` used to skip the
 * command-content classification that only `Bash` / `bash` got, so a
 * `git push origin main` through it never became a publish card).
 *
 * Every place that asks "is this a shell tool?" reads these sets, so a new
 * shell tool is added here once and gets the same classification, the same
 * shell floor and the same 完全授權 line check everywhere. An ACP agent's
 * native tool is recognized by its `kind: "execute"` instead (classify.ts).
 */

/** Tools whose `command` argument is a shell command line. */
export const SHELL_COMMAND_TOOLS: ReadonlySet<string> = new Set([
  // Claude Code's native Bash.
  "Bash",
  // The coding harness's own bash.
  "bash",
  // The hands daemon (a paired device's executor), as a host tool.
  "hands_run",
  // Codex's command requests (exec and app-server) and any host tool named shell.
  "shell",
  // Codex's newer command tool and the OpenAI local shell tool.
  "exec_command",
  "local_shell",
]);

/** Tools whose `input` argument is typed into a running shell session (also a command line). */
export const SHELL_STDIN_TOOLS: ReadonlySet<string> = new Set(["bash_input"]);

/** Any tool that runs a shell command line, by name. */
export function isShellToolName(tool: string): boolean {
  return SHELL_COMMAND_TOOLS.has(tool) || SHELL_STDIN_TOOLS.has(tool);
}

/** The command line a named shell tool runs, or undefined when it is not one (or carries no text). */
export function namedShellCommand(tool: string, input: Record<string, unknown> = {}): string | undefined {
  if (SHELL_COMMAND_TOOLS.has(tool)) return typeof input.command === "string" ? input.command : undefined;
  if (SHELL_STDIN_TOOLS.has(tool)) return typeof input.input === "string" ? input.input : undefined;
  return undefined;
}
