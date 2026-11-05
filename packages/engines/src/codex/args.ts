// Command line for one `codex exec` turn, written from the public Codex CLI
// docs (`codex exec --json`, `codex exec resume <SESSION_ID>`, `-c key=value`
// config overrides, `--sandbox`, `-m`, `-C`). Each turn is its own process;
// the conversation continues through `resume` with the stored session id.
import type { EngineLaunchConfig } from "../types.ts";

export interface CodexMcpServer {
  command: string;
  args: readonly string[];
  /** Only non-secret values here (file paths, a thread id): this ends up on the command line. */
  env: Readonly<Record<string, string>>;
}

/** A TOML value for `-c`: JSON strings and arrays of strings are valid TOML too. */
const tomlString = (s: string) => JSON.stringify(s);
const tomlTable = (o: Readonly<Record<string, string>>) =>
  `{${Object.entries(o)
    .map(([k, v]) => `${k} = ${tomlString(v)}`)
    .join(", ")}}`;

/** `-c` overrides that register Alca's host tools server (`alcatools`) for one Codex process. */
export function hostToolsOverrides(t: CodexMcpServer): string[] {
  return [
    "-c",
    `mcp_servers.alcatools.command=${tomlString(t.command)}`,
    "-c",
    `mcp_servers.alcatools.args=${JSON.stringify(t.args)}`,
    "-c",
    `mcp_servers.alcatools.env=${tomlTable(t.env)}`,
  ];
}

/**
 * Codex's own tools run in its read-only sandbox with no approval prompts
 * (`approval_policy = "never"`): it can read and think, but anything that
 * changes the world has to go through Alca's host tools over MCP, where the
 * gateway decides and the person approves.
 */
export function buildCodexArgs(
  cfg: EngineLaunchConfig,
  o: { resumeSessionId?: string; hostTools?: CodexMcpServer } = {},
): string[] {
  const args = ["exec", "--json", "--skip-git-repo-check", "-C", cfg.cwd, "--sandbox", "read-only"];
  args.push("-c", `approval_policy=${tomlString("never")}`);
  if (cfg.model) args.push("-m", cfg.model);
  if (o.hostTools) args.push(...hostToolsOverrides(o.hostTools));
  args.push(...(cfg.extraArgs ?? []));
  if (o.resumeSessionId) args.push("resume", o.resumeSessionId);
  // The prompt comes on stdin.
  args.push("-");
  return args;
}

/** Codex names a host tool `alcatools` / `<name>` (server, tool) in its MCP items. */
export const CODEX_HOST_SERVER = "alcatools";
