import { type ConfineSpec, DATA_ENTRIES } from "@alca/os";
import type { EngineLaunchConfig } from "../types.ts";

/** Name of the permission tool our MCP server exposes, as the CLI addresses it. */
export const PERMISSION_SERVER = "alca";
export const PERMISSION_TOOL = `mcp__${PERMISSION_SERVER}__approve`;
/** Name of the MCP server that carries the host's own tools (browser, …). */
export const HOST_TOOLS_SERVER = "alcatools";
/** How the CLI addresses a host tool: `mcp__alcatools__browser_click`. */
export const HOST_TOOL_PREFIX = `mcp__${HOST_TOOLS_SERVER}__`;

/** `mcp__alcatools__browser_click` → `browser_click`; anything else → undefined. */
export function hostToolName(cliName: string): string | undefined {
  return cliName.startsWith(HOST_TOOL_PREFIX) ? cliName.slice(HOST_TOOL_PREFIX.length) : undefined;
}

export interface PermissionServerLaunch {
  /** Executable for the MCP server (usually process.execPath, i.e. node). */
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
}

export function mcpConfigJson(server: PermissionServerLaunch, hostTools?: PermissionServerLaunch): string {
  const entry = (s: PermissionServerLaunch) => ({
    type: "stdio",
    command: s.command,
    args: s.args,
    env: s.env,
  });
  return JSON.stringify({
    mcpServers: {
      [PERMISSION_SERVER]: entry(server),
      ...(hostTools ? { [HOST_TOOLS_SERVER]: entry(hostTools) } : {}),
    },
  });
}

/**
 * Review 2026-11-04b S1: the person's own Claude Code configuration must not
 * decide for Alca. Allow rules in ~/.claude/settings.json or in the work
 * folder's .claude/settings(.local).json would let a tool run without ever
 * calling the permission tool, hooks would run commands outside Alca, and
 * MCP servers from ~/.claude.json or .mcp.json would hand the bot tools Alca
 * never sees. So every launch:
 *   --setting-sources ""   loads none of the user / project / local settings
 *                          (managed policy still applies; it cannot be removed);
 *   --strict-mcp-config    only the servers in --mcp-config (Alca's own);
 *   --settings {...}       hooks off for anything that is still loaded.
 * Login is unaffected: credentials (macOS Keychain, ~/.claude/.credentials.json)
 * are not a setting source, and CLAUDE_CONFIG_DIR is left as the person set it
 * (changing it would select a different Keychain entry). Not verified against
 * the real CLI here (docs/DEVICE-TEST.md); an `apiKeyHelper` or `env` block in
 * ~/.claude/settings.json no longer applies — use ANTHROPIC_API_KEY instead.
 */
export function isolationArgs(dataDir?: string, confine?: ConfineSpec): string[] {
  return [
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--settings",
    JSON.stringify({
      disableAllHooks: true,
      ...(dataDir ? { permissions: { deny: dataDenyRules(dataDir) } } : {}),
      ...(confine ? { sandbox: claudeSandbox(confine) } : {}),
    }),
  ];
}

/**
 * Next round §5.5: Claude Code's own Bash sandbox (Seatbelt / bubblewrap),
 * set from the same spec Alca's own commands run in, in the one `--settings`
 * block above (`--setting-sources ""` does not drop `--settings`; docs:
 * https://code.claude.com/docs/en/sandboxing).
 *
 * - `failIfUnavailable`: no sandbox → the CLI refuses to start; the turn
 *   fails, it never runs unsandboxed with the setting on.
 * - `allowUnsandboxedCommands: false`: no `dangerouslyDisableSandbox` retry.
 * - `autoAllowBashIfSandboxed: false`: every Bash still asks the permission
 *   tool, i.e. Alca's gate — the sandbox loosens no card.
 * - network `none`: an empty allowlist with `strictAllowlist`; `open`:
 *   `allowedDomains: ["*"]`. Whether the bare `*` is honoured in
 *   `allowedDomains` (it is for `WebFetch(domain:*)` since 2.1.186) is NOT
 *   verified here (docs/DEVICE-TEST.md §C). A `WebFetch(domain:*)` allow
 *   rule is not used: it would also let the WebFetch tool run unasked.
 *
 * Only Bash (and its children) is inside; Read / Edit / Write / WebFetch,
 * MCP servers and hooks are not — they stay behind Alca's gate, protect.ts
 * and the deny rules (SECURITY.md).
 */
export function claudeSandbox(c: ConfineSpec): Record<string, unknown> {
  return {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    autoAllowBashIfSandboxed: false,
    filesystem: {
      denyRead: [...c.denyRead],
      denyWrite: [...c.denyWriteInside],
      allowWrite: [c.tmpDir, ...c.extraWritable],
    },
    network: c.network === "none" ? { allowedDomains: [], strictAllowlist: true } : { allowedDomains: ["*"] },
  };
}

/**
 * S2.1, prevention on Claude Code's side: deny rules (which the CLI applies
 * itself, before any prompt) for the data folder's keys, database, logs and
 * profiles. `//` marks an absolute path in Claude Code's permission rules.
 * The host's own check (core protect.ts) stays the authority: it also covers
 * other bots' folders and shell commands, and every other engine.
 */
export function dataDenyRules(dataDir: string): string[] {
  const abs = `//${dataDir.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "")}`;
  return DATA_ENTRIES.flatMap((e) => [`Read(${abs}/${e})`, `Edit(${abs}/${e})`]);
}

/**
 * Mac test 2026-11-04b A8: built-in Claude Code tools that act outside the
 * turn and never call the permission tool. `CronCreate` put a recurring prompt
 * into the long-lived router process (it would have fired the next morning
 * with nobody there); `Agent` / `Task` start a sub-agent the host never sees;
 * `RemoteTrigger`, `PushNotification`, `ScheduleWakeup` reach out on their
 * own. No role gets them: `--disallowedTools` on every launch (merged with a
 * role's own list), the router additionally gets an allowlist (`--tools`), and
 * the core denies and stops a process that ran one anyway (phases/infer.ts).
 * Names from Claude Code 2.1 (`claude --help`, the report's event log); a name
 * the CLI does not know is ignored. Scheduling belongs to Alca's 例行工作.
 */
export const CLAUDE_BACKGROUND_TOOLS: readonly string[] = Object.freeze([
  "CronCreate",
  "CronDelete",
  "CronList",
  "ScheduleWakeup",
  "RemoteTrigger",
  "PushNotification",
  "Agent",
  "Task",
  "Skill",
  "EnterWorktree",
  "ExitWorktree",
]);

/** `--disallowedTools a,b` given more than once (or in a role's extra args) folds into one flag with the background tools. */
function withDisallowed(args: readonly string[]): string[] {
  const out: string[] = [];
  const names = new Set<string>(CLAUDE_BACKGROUND_TOOLS);
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--disallowedTools" || a === "--disallowed-tools") {
      for (const n of (args[i + 1] ?? "").split(/[,\s]+/)) if (n) names.add(n);
      i++;
      continue;
    }
    out.push(a);
  }
  out.push("--disallowedTools", [...names].join(","));
  return out;
}

/**
 * Arguments for one long-lived `claude -p` process in stream-json mode.
 * Only the stable prompt layer goes on the command line; per-turn context is
 * sent inside each user message, so the system prompt never changes mid-thread.
 */
export function buildClaudeArgs(
  cfg: EngineLaunchConfig,
  opts: {
    resumeSessionId?: string;
    permissionServer?: PermissionServerLaunch;
    /** Host tools server (needs the permission server: it shares the bridge). */
    hostToolsServer?: PermissionServerLaunch;
    /** Alca's data folder: the CLI is told to deny reads and edits of its keys and database (S2.1). */
    protectedDataDir?: string;
  },
): string[] {
  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode",
    cfg.approvalMode,
    ...isolationArgs(opts.protectedDataDir, cfg.confine),
  ];
  if (opts.permissionServer) {
    args.push(
      "--mcp-config",
      mcpConfigJson(opts.permissionServer, opts.hostToolsServer),
      "--permission-prompt-tool",
      PERMISSION_TOOL,
    );
    // Host tools are gated by the host when the call arrives (inspect → policy
    // → card → sensitive-action gate), so the CLI need not prompt for them.
    if (opts.hostToolsServer) args.push("--allowedTools", `mcp__${HOST_TOOLS_SERVER}`);
  }
  if (cfg.model) args.push("--model", cfg.model);
  if (cfg.stablePrompt) args.push("--append-system-prompt", cfg.stablePrompt);
  if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
  args.push(...(cfg.extraArgs ?? []));
  return withDisallowed(args);
}
