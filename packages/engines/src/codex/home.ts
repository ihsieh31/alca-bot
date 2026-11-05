import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Codex's own home for Alca's launches (review 2026-11-04b S1).
 *
 * `codex exec` reads `$CODEX_HOME/config.toml` (default ~/.codex). With
 * `approval_policy = "never"`, any `mcp_servers.*` there — GitHub, Slack, a
 * filesystem server — would be called directly, outside Codex's read-only
 * sandbox and outside Alca's gateway; a profile could also change the
 * sandbox. So Alca runs Codex with CODEX_HOME pointing at a folder it owns:
 *
 * - `config.toml` is Alca's (rewritten on every launch; no MCP servers, no
 *   profiles; Alca's own `alcatools` server and the sandbox come on the
 *   command line);
 * - `auth.json` is a link to the person's real one (a copy where links are
 *   not allowed), so `codex login` keeps working and token refreshes are seen;
 * - `sessions/` links to the real one, so `resume` finds earlier sessions.
 *
 * Not verified against the real CLI here (docs/DEVICE-TEST.md). A person who
 * keeps their login in the OS keyring (`cli_auth_credentials_store`) or needs
 * a custom `model_provider` must set it again for Alca (see docs/PROVIDERS.md).
 */
export const CODEX_HOME_CONFIG = `# Written by Alca on every Codex launch (review 2026-11-04b S1).
# Your own ~/.codex/config.toml (its MCP servers, profiles, approval and sandbox
# settings) is deliberately not used: Alca passes the sandbox, the approval
# policy and its own tools on the command line, and gates everything else.
`;

/** The person's own Codex home. */
export function realCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME || join(homedir(), ".codex");
}

function link(target: string, at: string): void {
  try {
    const st = lstatSync(at);
    if (st.isSymbolicLink() && readlinkSync(at) === target) return;
    // A stale link or an old copy: replace it (a copy is refreshed from the real file).
    if (st.isSymbolicLink() || st.isFile()) rmSync(at, { force: true });
    else return; // a real folder the person put there: leave it
  } catch {
    // does not exist yet
  }
  try {
    symlinkSync(target, at);
  } catch {
    try {
      copyFileSync(target, at);
      chmodSync(at, 0o600);
    } catch {
      // no login yet: Codex says so and the engine shows the login hint
    }
  }
}

/** Create (or refresh) Alca's Codex home at `dir`; returns `dir`. */
export function prepareCodexHome(dir: string, real: string = realCodexHome()): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writeFileSync(join(dir, "config.toml"), CODEX_HOME_CONFIG, { mode: 0o600 });
  if (existsSync(join(real, "auth.json"))) link(join(real, "auth.json"), join(dir, "auth.json"));
  if (existsSync(join(real, "sessions"))) link(join(real, "sessions"), join(dir, "sessions"));
  return dir;
}
