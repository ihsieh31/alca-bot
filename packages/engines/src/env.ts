/**
 * The environment an engine's child process gets (review 2026-11-04b M6).
 *
 * Engines used to inherit the core's whole environment: `ALCA_RELAY_SECRET`
 * of a self-hosted relay, smoke-test keys, cloud credentials from the
 * person's shell — all of it readable by the model's shell. Now only an
 * allow-list passes: what a program needs to run at all (PATH, HOME, locale,
 * temp folders, proxies and CA bundles, the Windows basics), plus the
 * variables of the engine's own provider (`ANTHROPIC_*` / `CLAUDE_*` for
 * Claude Code, `OPENAI_*` / `CODEX_*` for Codex, the ACP agent's key names).
 * `ALCA_*` never passes; what Alca hands an engine on purpose (its baseEnv,
 * the launch env, a vault key) is added after the filter by the engine.
 */

const BASE_NAMES = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LANGUAGE",
  "TERM",
  "COLORTERM",
  "TZ",
  "TMPDIR",
  "TMP",
  "TEMP",
  "PWD",
  "EDITOR",
  "VISUAL",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "REQUESTS_CA_BUNDLE",
  "NVM_DIR",
  "NVM_BIN",
  "VOLTA_HOME",
  "PNPM_HOME",
  "BUN_INSTALL",
  "DENO_DIR",
  "GOPATH",
  "GOROOT",
  "CARGO_HOME",
  "RUSTUP_HOME",
  "JAVA_HOME",
  "PYENV_ROOT",
  "VIRTUAL_ENV",
  "CONDA_PREFIX",
  "HOMEBREW_PREFIX",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "DBUS_SESSION_BUS_ADDRESS",
  "XAUTHORITY",
  "__CF_USER_TEXT_ENCODING",
  // Windows
  "SYSTEMROOT",
  "SystemRoot",
  "SYSTEMDRIVE",
  "SystemDrive",
  "WINDIR",
  "windir",
  "COMSPEC",
  "ComSpec",
  "PATHEXT",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "ProgramData",
  "PROGRAMFILES",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "USERPROFILE",
  "USERNAME",
  "HOMEDRIVE",
  "HOMEPATH",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "OS",
]);

const BASE_PREFIXES = ["LC_", "XDG_"];

/** Provider variables per engine family (a prefix ends in `_`). */
export const ENGINE_ENV: Readonly<Record<string, readonly string[]>> = {
  "claude-code": [
    "ANTHROPIC_",
    "CLAUDE_",
    "DISABLE_",
    "MCP_",
    "MAX_THINKING_TOKENS",
    "BASH_DEFAULT_TIMEOUT_MS",
    "BASH_MAX_TIMEOUT_MS",
    "FAKE_CLAUDE_", // this repo's test fake (testing/fake-claude.ts)
    // Bedrock / Vertex, only when the person chose them for Claude Code (see `engineEnv`)
  ],
  codex: ["OPENAI_", "CODEX_", "AZURE_OPENAI_", "RUST_LOG", "FAKE_CODEX_"],
  acp: [
    "GEMINI_",
    "GOOGLE_API_KEY",
    "GOOGLE_GENAI_",
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_CLOUD_LOCATION",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "QWEN_",
    "DASHSCOPE_",
    "OPENCODE_",
    "OPENROUTER_",
    "OPENAI_",
    "ANTHROPIC_",
    "MOONSHOT_",
    "KIMI_",
    "DEEPSEEK_",
    "MISTRAL_",
    "GROQ_",
    "XAI_",
    "CURSOR_",
    "AUGMENT_",
    "GOOSE_",
    "FAKE_ACP_",
  ],
};

const matches = (name: string, list: readonly string[]) =>
  list.some((p) => (p.endsWith("_") ? name.startsWith(p) : name === p));

/**
 * Filter `env` (normally `process.env`) down to what an engine of `family`
 * may see. `extra` names more variables (e.g. an ACP agent's `keyEnv`).
 */
export function engineEnv(
  env: NodeJS.ProcessEnv,
  family: keyof typeof ENGINE_ENV,
  extra: readonly string[] = [],
): NodeJS.ProcessEnv {
  const allow = [...(ENGINE_ENV[family] ?? []), ...extra];
  // Claude Code on Bedrock / Vertex reads the cloud's own credentials: only then do they pass.
  if (family === "claude-code" && env.CLAUDE_CODE_USE_BEDROCK) allow.push("AWS_");
  if (family === "claude-code" && env.CLAUDE_CODE_USE_VERTEX)
    allow.push("GOOGLE_APPLICATION_CREDENTIALS", "CLOUD_ML_REGION", "ANTHROPIC_VERTEX_", "VERTEX_");
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || k.startsWith("ALCA_")) continue;
    if (BASE_NAMES.has(k) || matches(k, BASE_PREFIXES) || matches(k, allow)) out[k] = v;
  }
  return out;
}
