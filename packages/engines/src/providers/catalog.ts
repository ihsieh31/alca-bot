/**
 * The provider registry (P11): every engine a bot can run on, as plain data.
 * `kind` says how Alca talks to it — `cli` (Claude Code, Codex: their own
 * JSONL protocols), `acp` (any Agent Client Protocol agent over stdio) or
 * `api` (an HTTP model API; the host runs the tools). Detection, the model
 * list and the engine factory all read this table; nothing in core names a
 * provider. Commands, URLs and model ids are from each vendor's public docs;
 * every preset is tested against a mock only (docs/PROVIDERS.md), and the
 * person can change a command or base URL in 模型與供應商.
 */

export type ProviderKind = "cli" | "acp" | "api";
/** Wire format of an API provider. */
export type ApiFamily = "openai-chat" | "openai-responses" | "anthropic" | "gemini";
/** Where the model list comes from: a live /models call, a CLI listing, or the built-in list only. */
export type ModelsSource = "api" | "cli" | "builtin";

export interface ModelInfo {
  id: string;
  label?: string;
  /** Context window in tokens, when known. */
  contextTokens?: number;
  /** USD per million input / output tokens, when the vendor's list says. */
  inputPrice?: number;
  outputPrice?: number;
}

export interface ProviderCaps {
  /** Can use the host's tools (browser, connectors, …). */
  tools: boolean;
  vision: boolean;
  /** Takes a reasoning-effort setting. */
  reasoning: boolean;
}

/**
 * How to tell whether a CLI is logged in. `command`: exit 0 = logged in (and
 * `ok`, when given, must match the output). `files` / `env`: any present =
 * logged in. A check that is not `definitive` can only say yes; its "no"
 * means "not sure" (credentials may sit in the OS keychain).
 */
export type LoginCheck =
  | { kind: "command"; args: readonly string[]; ok?: string }
  | { kind: "files"; paths: readonly string[]; definitive?: boolean }
  | { kind: "env"; names: readonly string[]; definitive?: boolean };

/** Approval level → native permission mode ids, first offered one wins (ACP `session/set_mode`). */
/** The approval levels engines map (same names as `@alca/config` APPROVAL_LEVELS; checked by a test). */
export type ApprovalLevelName = "confirm_each_step" | "autonomous";
export type ModeMap = Readonly<Partial<Record<ApprovalLevelName, readonly string[]>>>;

export interface ProviderDef {
  id: string;
  label: string;
  kind: ProviderKind;
  /** One of the six shown first in 模型與供應商 and the bot editor. */
  pinned?: boolean;
  /** One line under the name. */
  blurb: string;
  // ── cli / acp ──
  binary?: string;
  /** Args that start the agent in ACP mode. */
  acpArgs?: readonly string[];
  /**
   * Next round §5.5 (ACP, experimental): the folders the agent itself writes
   * (session, login refresh, cache; `~` = home). With a bot's OS sandbox on,
   * the whole agent process runs in it and may write only the work folder and
   * these; an agent without them cannot run sandboxed (needs a Mac check).
   */
  stateDirs?: readonly string[];
  /** Flag that picks a model on the command line (e.g. "-m"). */
  modelArg?: string;
  login?: readonly LoginCheck[];
  /** What to run to log in. */
  loginHint?: string;
  installHint?: string;
  modes?: ModeMap;
  /** CLI that lists models (output: one id per line). */
  modelsCommand?: readonly string[];
  /** What the approval levels become natively (for docs and the settings page). */
  nativeApproval: string;
  // ── api ──
  family?: ApiFamily;
  baseUrl?: string;
  /** false: a local server that needs no key. */
  keyRequired?: boolean;
  /** Where to get a key. */
  keyUrl?: string;
  headers?: Readonly<Record<string, string>>;
  /** Has a GET /models (in its family's shape). */
  liveModels?: boolean;
  // ── both ──
  models: readonly ModelInfo[];
  defaultModel?: string;
  caps: ProviderCaps;
}

const k = (n: number) => n * 1000;
const NO_BYPASS =
  "每步確認／團隊／自主都用代理程式的一般模式：它要動手前都會問，Alca 的閘門依 bot 的權限回答；付款、寄送、刪除、發布一律問你。";
const HOST_GATE = "工具由 Alca 主機執行，每一步都經過閘門；付款、寄送、刪除、發布一律問你。";

/**
 * ACP mode ids Alca may switch to, per approval level (`@alca/config`
 * APPROVAL_LEVELS; a bot following the team is resolved to the team's level
 * first). Never a bypass / yolo mode, so the agent keeps asking the host.
 */
const ACP_MODES: ModeMap = {
  confirm_each_step: ["default", "ask"],
  autonomous: ["auto_edit", "autoEdit", "acceptEdits", "auto-edit"],
};

const acp = (
  d: Omit<ProviderDef, "kind" | "nativeApproval" | "caps"> & { caps?: Partial<ProviderCaps> },
): ProviderDef => ({
  ...d,
  kind: "acp",
  modes: d.modes ?? ACP_MODES,
  nativeApproval: NO_BYPASS,
  caps: { tools: true, vision: false, reasoning: false, ...d.caps },
});

const api = (
  d: Omit<ProviderDef, "kind" | "nativeApproval" | "caps" | "family"> & {
    family?: ApiFamily;
    caps?: Partial<ProviderCaps>;
  },
): ProviderDef => ({
  family: "openai-chat",
  keyRequired: true,
  liveModels: true,
  ...d,
  kind: "api",
  nativeApproval: HOST_GATE,
  caps: { tools: true, vision: false, reasoning: false, ...d.caps },
});

/**
 * The built-in model lists, one per vendor family — the single source the
 * CLI presets, the API presets and docs/PROVIDERS.md § Built-in models use
 * (a test keeps the doc in step). Checked on each vendor's own page on
 * 2026-11-04: Anthropic models overview, OpenAI API models and Codex models,
 * Gemini API models. Newest / recommended first. An API provider with
 * liveModels shows its own GET /models list instead; this is the fallback
 * and what the bot editor shows before a key is set.
 */
export const MODEL_FAMILIES = {
  /** Anthropic: Claude API ids; 1M context each. */
  claude: [
    { id: "claude-opus-5-5", contextTokens: 1_000_000 },
    { id: "claude-sonnet-5-5", contextTokens: 1_000_000 },
    { id: "claude-haiku-5-5", contextTokens: 1_000_000 },
    { id: "claude-fable-5-1", contextTokens: 1_000_000 },
  ],
  /** Claude Code's own aliases: always the newest of each line. */
  claudeAliases: [
    { id: "sonnet", label: "Sonnet（最新）" },
    { id: "opus", label: "Opus（最新）" },
    { id: "haiku", label: "Haiku（最新）" },
  ],
  /** OpenAI API (1.05M context each). */
  openai: [
    { id: "gpt-6.1-sol", contextTokens: 1_050_000 },
    { id: "gpt-6-astra", contextTokens: 1_050_000 },
    { id: "gpt-6.1-terra", contextTokens: 1_050_000 },
    { id: "gpt-6-luna", contextTokens: 1_050_000 },
  ],
  /** Gemini API. */
  gemini: [
    { id: "gemini-3.8-flash", contextTokens: 1_048_576 },
    { id: "gemini-4-argon", contextTokens: 1_048_576 },
    { id: "gemini-3.6-flash", contextTokens: 1_048_576 },
    { id: "gemini-3.5-flash-lite", contextTokens: 1_048_576 },
  ],
} as const satisfies Record<string, readonly ModelInfo[]>;

/** Codex CLI runs GPT-6.1 Sol with a 500K default context (Codex models page). */
const CODEX_MODELS: readonly ModelInfo[] = MODEL_FAMILIES.openai.map((m) =>
  m.id === "gpt-6.1-sol" ? { id: m.id, contextTokens: k(500) } : { id: m.id },
);

export const PROVIDERS: readonly ProviderDef[] = [
  // ── pinned ──
  {
    id: "claude-code",
    label: "Claude Code",
    kind: "cli",
    pinned: true,
    blurb: "Anthropic 的 Claude Code CLI，用你的 Claude 訂閱或 API key",
    binary: "claude",
    login: [
      { kind: "env", names: ["ANTHROPIC_API_KEY"] },
      { kind: "files", paths: ["~/.claude/.credentials.json"] },
    ],
    loginHint: "在終端機執行 claude，照提示登入",
    installHint: "npm install -g @anthropic-ai/claude-code",
    nativeApproval:
      "權限模式 default：CLI 要動手前透過 MCP 問 Alca，閘門依 bot 權限回答；主機工具一律經過閘門。",
    models: [...MODEL_FAMILIES.claudeAliases, ...MODEL_FAMILIES.claude],
    caps: { tools: true, vision: true, reasoning: true },
  },
  {
    id: "codex",
    label: "Codex CLI",
    kind: "cli",
    pinned: true,
    blurb: "OpenAI 的 Codex CLI，用你的 ChatGPT 方案或 API key",
    binary: "codex",
    login: [{ kind: "command", args: ["login", "status"] }],
    loginHint: "在終端機執行 codex login",
    installHint: "npm install -g @openai/codex",
    nativeApproval:
      "沙盒 read-only、approval_policy never：Codex 只能讀，所有變更都走 Alca 主機工具並經過閘門。",
    models: CODEX_MODELS,
    caps: { tools: true, vision: false, reasoning: true },
  },
  acp({
    id: "gemini-cli",
    label: "Gemini CLI",
    pinned: true,
    blurb: "Google 的 Gemini CLI（ACP），用 Google 帳號或 Gemini API key",
    binary: "gemini",
    acpArgs: ["--experimental-acp"],
    stateDirs: ["~/.gemini"],
    modelArg: "-m",
    login: [
      { kind: "env", names: ["GEMINI_API_KEY", "GOOGLE_API_KEY"] },
      { kind: "files", paths: ["~/.gemini/oauth_creds.json"], definitive: true },
    ],
    loginHint: "在終端機執行 gemini，選「Login with Google」",
    installHint: "npm install -g @google/gemini-cli",
    models: MODEL_FAMILIES.gemini,
    caps: { vision: true },
  }),
  acp({
    id: "opencode",
    label: "OpenCode",
    pinned: true,
    blurb: "開源的 OpenCode 代理（ACP），可接很多模型服務",
    binary: "opencode",
    acpArgs: ["acp"],
    stateDirs: [
      "~/.local/share/opencode",
      "~/.local/state/opencode",
      "~/.cache/opencode",
      "~/.config/opencode",
    ],
    login: [{ kind: "files", paths: ["~/.local/share/opencode/auth.json"] }],
    loginHint: "在終端機執行 opencode auth login",
    installHint: "npm install -g opencode-ai",
    modelsCommand: ["models"],
    models: [],
  }),
  api({
    id: "openai",
    label: "OpenAI",
    pinned: true,
    blurb: "OpenAI API（Responses；也可改用 Chat Completions）",
    family: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    keyUrl: "https://platform.openai.com/api-keys",
    models: MODEL_FAMILIES.openai,
    defaultModel: "gpt-6-luna",
    caps: { vision: true, reasoning: true },
  }),
  api({
    id: "openrouter",
    label: "OpenRouter",
    pinned: true,
    blurb: "一把 key 用幾百個模型；清單含 context 與價格",
    baseUrl: "https://openrouter.ai/api/v1",
    keyUrl: "https://openrouter.ai/keys",
    headers: { "X-Title": "Alca" },
    models: [
      { id: "openai/gpt-6-luna", contextTokens: 1_050_000 },
      { id: "anthropic/claude-sonnet-5.5", contextTokens: 1_000_000 }, // OpenRouter writes the version with a dot
      { id: "google/gemini-3.8-flash", contextTokens: 1_048_576 },
    ],
    defaultModel: "openai/gpt-6-luna",
    caps: { vision: true, reasoning: true },
  }),
  // ── more: ACP agents ──
  acp({
    id: "grok-cli",
    label: "Grok CLI",
    blurb: "Grok 的命令列代理（ACP）",
    binary: "grok",
    acpArgs: ["--acp"],
    login: [{ kind: "env", names: ["GROK_API_KEY", "XAI_API_KEY"] }],
    loginHint: "設定 XAI_API_KEY（或 GROK_API_KEY）後再啟動",
    installHint: "依官方說明安裝 grok 命令",
    models: [{ id: "grok-code-fast-1" }, { id: "grok-4" }],
  }),
  acp({
    id: "kimi-cli",
    label: "Kimi CLI",
    blurb: "Moonshot 的 Kimi CLI（ACP）",
    binary: "kimi",
    acpArgs: ["--acp"],
    loginHint: "在終端機執行 kimi，照提示登入",
    installHint: "uv tool install kimi-cli",
    models: [{ id: "kimi-k2", contextTokens: k(256) }],
  }),
  acp({
    id: "qwen-code",
    label: "Qwen Code",
    blurb: "阿里的 Qwen Code（ACP）",
    binary: "qwen",
    acpArgs: ["--experimental-acp"],
    modelArg: "-m",
    login: [
      { kind: "env", names: ["DASHSCOPE_API_KEY", "OPENAI_API_KEY"] },
      { kind: "files", paths: ["~/.qwen/oauth_creds.json"] },
    ],
    loginHint: "在終端機執行 qwen，選擇登入方式",
    installHint: "npm install -g @qwen-code/qwen-code",
    models: [{ id: "qwen3-coder-plus", contextTokens: 1_000_000 }],
  }),
  acp({
    id: "cursor-cli",
    label: "Cursor CLI",
    blurb: "Cursor 的命令列代理（ACP）",
    binary: "cursor-agent",
    acpArgs: ["acp"],
    login: [{ kind: "command", args: ["status"], ok: "logged in" }],
    loginHint: "在終端機執行 cursor-agent login",
    installHint: "curl https://cursor.com/install -fsS | bash",
    models: [{ id: "auto" }, { id: "sonnet-4.5" }, { id: "gpt-5" }],
  }),
  acp({
    id: "factory-droid",
    label: "Factory Droid",
    blurb: "Factory 的 Droid 代理（ACP）",
    binary: "droid",
    acpArgs: ["acp"],
    login: [{ kind: "env", names: ["FACTORY_API_KEY"] }],
    loginHint: "在終端機執行 droid 登入，或設定 FACTORY_API_KEY",
    installHint: "curl -fsSL https://app.factory.ai/cli | sh",
    models: [],
  }),
  acp({
    id: "antigravity",
    label: "Antigravity",
    blurb: "Google Antigravity 的代理（ACP）",
    binary: "antigravity",
    acpArgs: ["--acp"],
    loginHint: "開啟 Antigravity，用 Google 帳號登入",
    installHint: "從官方網站安裝 Antigravity",
    models: [],
  }),
  // ── more: model APIs ──
  api({
    id: "anthropic",
    label: "Anthropic API",
    blurb: "Claude 模型（Messages API）",
    family: "anthropic",
    baseUrl: "https://api.anthropic.com",
    keyUrl: "https://console.anthropic.com/settings/keys",
    models: MODEL_FAMILIES.claude,
    defaultModel: "claude-sonnet-5-5",
    caps: { vision: true, reasoning: true },
  }),
  api({
    id: "gemini",
    label: "Google Gemini API",
    blurb: "Gemini 模型（Google AI Studio 的 key）",
    family: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    keyUrl: "https://aistudio.google.com/apikey",
    models: MODEL_FAMILIES.gemini,
    defaultModel: "gemini-3.8-flash",
    caps: { vision: true, reasoning: true },
  }),
  api({
    id: "mistral",
    label: "Mistral",
    blurb: "Mistral AI 的模型",
    baseUrl: "https://api.mistral.ai/v1",
    keyUrl: "https://console.mistral.ai/api-keys",
    models: [
      { id: "mistral-large-latest", contextTokens: k(128) },
      { id: "mistral-medium-latest", contextTokens: k(128) },
      { id: "codestral-latest", contextTokens: k(256) },
    ],
    defaultModel: "mistral-medium-latest",
  }),
  api({
    id: "minimax",
    label: "MiniMax",
    blurb: "MiniMax 的模型（OpenAI 相容）",
    baseUrl: "https://api.minimax.io/v1",
    keyUrl: "https://platform.minimax.io",
    liveModels: false,
    models: [{ id: "MiniMax-M2", contextTokens: k(204.8) }],
    defaultModel: "MiniMax-M2",
  }),
  api({
    id: "cerebras",
    label: "Cerebras",
    blurb: "很快的推論（OpenAI 相容）",
    baseUrl: "https://api.cerebras.ai/v1",
    keyUrl: "https://cloud.cerebras.ai",
    models: [{ id: "gpt-oss-120b" }, { id: "llama-3.3-70b" }, { id: "qwen-3-32b" }],
    defaultModel: "gpt-oss-120b",
  }),
  api({
    id: "groq",
    label: "Groq",
    blurb: "很快的推論（OpenAI 相容）",
    baseUrl: "https://api.groq.com/openai/v1",
    keyUrl: "https://console.groq.com/keys",
    models: [
      { id: "openai/gpt-oss-120b", contextTokens: k(131.072) },
      { id: "llama-3.3-70b-versatile", contextTokens: k(131.072) },
    ],
    defaultModel: "llama-3.3-70b-versatile",
  }),
  api({
    id: "deepseek",
    label: "DeepSeek",
    blurb: "DeepSeek 的模型（OpenAI 相容）",
    baseUrl: "https://api.deepseek.com/v1",
    keyUrl: "https://platform.deepseek.com/api_keys",
    models: [
      { id: "deepseek-chat", contextTokens: k(128) },
      { id: "deepseek-reasoner", contextTokens: k(128) },
    ],
    defaultModel: "deepseek-chat",
    caps: { reasoning: true },
  }),
  api({
    id: "xai",
    label: "xAI",
    blurb: "Grok 模型（OpenAI 相容）",
    baseUrl: "https://api.x.ai/v1",
    keyUrl: "https://console.x.ai",
    models: [{ id: "grok-4" }, { id: "grok-code-fast-1" }, { id: "grok-3-mini" }],
    defaultModel: "grok-4",
    caps: { vision: true, reasoning: true },
  }),
  api({
    id: "together",
    label: "Together AI",
    blurb: "開源模型託管（OpenAI 相容）",
    baseUrl: "https://api.together.xyz/v1",
    keyUrl: "https://api.together.ai/settings/api-keys",
    models: [
      { id: "meta-llama/Llama-3.3-70B-Instruct-Turbo" },
      { id: "Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8" },
    ],
    defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
  }),
  api({
    id: "fireworks",
    label: "Fireworks",
    blurb: "開源模型託管（OpenAI 相容）",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    keyUrl: "https://fireworks.ai/account/api-keys",
    models: [{ id: "accounts/fireworks/models/llama-v3p3-70b-instruct" }],
    defaultModel: "accounts/fireworks/models/llama-v3p3-70b-instruct",
  }),
  api({
    id: "ollama",
    label: "Ollama",
    blurb: "本機模型，不需要金鑰",
    baseUrl: "http://127.0.0.1:11434/v1",
    keyRequired: false,
    models: [{ id: "llama3.1" }, { id: "qwen2.5-coder" }],
    defaultModel: "llama3.1",
  }),
  api({
    id: "lmstudio",
    label: "LM Studio",
    blurb: "本機模型，不需要金鑰",
    baseUrl: "http://127.0.0.1:1234/v1",
    keyRequired: false,
    models: [],
    defaultModel: "local-model",
  }),
];

export function providerDef(id: string): ProviderDef | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/** The six shown first, in this order. */
export const PINNED_IDS = PROVIDERS.filter((p) => p.pinned).map((p) => p.id);
