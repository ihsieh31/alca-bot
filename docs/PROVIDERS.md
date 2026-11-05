# Providers (P11)

Every engine a bot can run on is one row of the provider registry, `packages/engines/src/providers/catalog.ts`. Detection (`detect.ts`), the model list (`models.ts`) and the engine factory (`factory.ts`) all read that table; nothing in core names a provider. In the desktop app it is **模型與供應商** (sidebar): the six pinned providers first, the rest folded under **更多供應商**, then **＋ 新增自訂供應商**. A bot picks **供應商 → 模型** in its editor (團隊 → 編輯 → 進階); the phone shows a bot's provider and model read-only.

## Kinds

- **cli** — Claude Code and Codex CLI, each through its own documented JSONL protocol (RUNNING § 2–3, § 16).
- **acp** — any agent that speaks the [Agent Client Protocol](https://agentclientprotocol.com) over stdio (`engines/src/acp/`): `initialize`, `session/new` | `session/load`, `session/set_mode`, `session/set_model`, `session/prompt` with streamed `session/update`, `session/request_permission` answered by Alca's gate, `session/cancel`. Host tools reach the agent as a stdio MCP server through the same bridge as Claude Code.
- **api** — an HTTP model API; Alca runs the loop and every tool call goes through the gate. Families: `openai-responses` (OpenAI Responses, `store: false`), `openai-chat` (Chat Completions and every OpenAI-compatible vendor), `anthropic` (Messages), `gemini` (`streamGenerateContent`).

## Status

Each provider shows one of **可用 · 需登入 · 需金鑰 · 未安裝** with a one-line fix:

- cli / acp: the binary is looked up on `PATH` (or the command you set), `--version` is read, then the login checks run. A `command` check is definitive (exit 0 = logged in, non-zero = 需登入). A `files` / `env` check can only say yes unless marked definitive — credentials may sit in the OS keychain — so when nothing is found the provider stays 可用 with its version and "若要求登入：…" instead of 需登入.
- api: 需金鑰 until a key is in the local encrypted vault (`engine:<id>`); keys are never returned by the API, views only say whether one is set. Ollama and LM Studio need no key.
- Results are cached for 60 s; the refresh button (`GET /api/providers?fresh=1`) runs them again.

## Models

Live where the vendor has a list: `GET /models` in the OpenAI shape (OpenRouter also gives context length and per-token prices, shown per million tokens), the Anthropic and Gemini shapes, or a CLI listing (`opencode models`). Otherwise, or when the live call fails, the built-in list is shown with a note. A model id can always be typed by hand; the picker is searchable.

### Built-in models

One list per vendor family in `catalog.ts` (`MODEL_FAMILIES`); the CLI and API presets of the same vendor share it, and a test keeps this section in step. Checked on each vendor's own page on 2026-11-04 ([Anthropic models overview](https://docs.claude.com/en/docs/about-claude/models/overview), [OpenAI API models](https://platform.openai.com/docs/models), [Codex models](https://developers.openai.com/codex/models), [Gemini API models](https://ai.google.dev/gemini-api/docs/models)). Newest or recommended first.

| Family        | Used by                                | Model ids                                                                         |
| ------------- | -------------------------------------- | --------------------------------------------------------------------------------- |
| claudeAliases | Claude Code (first in its list)        | `sonnet`, `opus`, `haiku` — Claude Code's aliases for the newest of each line     |
| claude        | Claude Code, Anthropic API             | `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`, `claude-fable-5-1`    |
| openai        | OpenAI API, Codex CLI (`codex -m …`)   | `gpt-6.1-sol`, `gpt-6-astra`, `gpt-6.1-terra`, `gpt-6-luna`                       |
| gemini        | Gemini API, Gemini CLI (`gemini -m …`) | `gemini-3.8-flash`, `gemini-4-argon`, `gemini-3.6-flash`, `gemini-3.5-flash-lite` |

Defaults: Anthropic API `claude-sonnet-5-5`, OpenAI `gpt-6-luna`, Gemini API `gemini-3.8-flash`, OpenRouter `openai/gpt-6-luna`. Codex uses a 500K default context for `gpt-6.1-sol`. When a vendor renames its models, change `MODEL_FAMILIES` only.

## Approval levels

Alca's levels (每步確認 · 團隊預設 · 自主) never map to a vendor's bypass / "yolo" mode:

- Claude Code: permission mode `default`; the CLI asks Alca over MCP before acting.
- Codex CLI: `--sandbox read-only`, `approval_policy=never`; every change goes through Alca's host tools and the gate.
- ACP agents: `session/set_mode` to the first offered of — 每步確認 `default` / `ask`; 團隊預設 `default`; 自主 `auto_edit` / `autoEdit` / `acceptEdits` / `auto-edit`. Every `session/request_permission` is answered by the gate; payment, send, delete and publish always ask the person.
- API providers: the host runs the tools; every step goes through the gate.

## The table

**Tested** is honest: every row is exercised only against a local mock (a fake ACP agent, fake CLIs, the mock HTTP server in `packages/engines/testing/`). Claude Code and Codex CLI can additionally be run against a real login with `pnpm smoke` (RUNNING § 14), and OpenRouter / Gemini API likewise; no other provider has been run for real. Rows marked **preset best-guess** have ACP arguments and login checks inferred from the vendor's public material and not confirmed against the real CLI — if one does not start, change its command in 模型與供應商 (the override is kept per provider) or add it as a custom ACP agent.

📌 = one of the six pinned.

| Provider          | id              | Kind                   | How to log in / set a key                                                                                                                                                                                | Models                    | Tested    | Notes                                                                      |
| ----------------- | --------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | --------- | -------------------------------------------------------------------------- |
| Claude Code 📌    | `claude-code`   | cli                    | 啟動 `claude`；登入：在終端機執行 claude，照提示登入（偵測：$ANTHROPIC_API_KEY；`~/.claude/.credentials.json`）；安裝：`npm install -g @anthropic-ai/claude-code`                                        | 內建 + 手填               | mock only |                                                                            |
| Codex CLI 📌      | `codex`         | cli                    | 啟動 `codex`；登入：在終端機執行 codex login（偵測：`codex login status`）；安裝：`npm install -g @openai/codex`                                                                                         | 內建 + 手填               | mock only |                                                                            |
| Gemini CLI 📌     | `gemini-cli`    | acp                    | 啟動 `gemini --experimental-acp`；登入：在終端機執行 gemini，選「Login with Google」（偵測：$GEMINI_API_KEY / $GOOGLE_API_KEY；`~/.gemini/oauth_creds.json`）；安裝：`npm install -g @google/gemini-cli` | 內建 + 手填               | mock only | ACP 參數取自官方文件                                                       |
| OpenCode 📌       | `opencode`      | acp                    | 啟動 `opencode acp`；登入：在終端機執行 opencode auth login（偵測：`~/.local/share/opencode/auth.json`）；安裝：`npm install -g opencode-ai`                                                             | CLI `opencode models`     | mock only | ACP 參數取自官方文件                                                       |
| OpenAI 📌         | `openai`        | api · openai-responses | API key → 模型與供應商 → 設定金鑰（本機加密金庫）；取得：https://platform.openai.com/api-keys                                                                                                            | live `GET /models` + 內建 | mock only |                                                                            |
| OpenRouter 📌     | `openrouter`    | api · openai-chat      | API key → 模型與供應商 → 設定金鑰（本機加密金庫）；取得：https://openrouter.ai/keys                                                                                                                      | live `GET /models` + 內建 | mock only |                                                                            |
| Grok CLI          | `grok-cli`      | acp                    | 啟動 `grok --acp`；登入：設定 XAI_API_KEY（或 GROK_API_KEY）後再啟動（偵測：$GROK_API_KEY / $XAI_API_KEY）；安裝：`依官方說明安裝 grok 命令`                                                             | 內建 + 手填               | mock only | **preset best-guess**（ACP 參數與登入偵測依公開資訊推測，未對真 CLI 驗證） |
| Kimi CLI          | `kimi-cli`      | acp                    | 啟動 `kimi --acp`；登入：在終端機執行 kimi，照提示登入（無法偵測登入，只看是否安裝）；安裝：`uv tool install kimi-cli`                                                                                   | 內建 + 手填               | mock only | **preset best-guess**（ACP 參數與登入偵測依公開資訊推測，未對真 CLI 驗證） |
| Qwen Code         | `qwen-code`     | acp                    | 啟動 `qwen --experimental-acp`；登入：在終端機執行 qwen，選擇登入方式（偵測：$DASHSCOPE_API_KEY / $OPENAI_API_KEY；`~/.qwen/oauth_creds.json`）；安裝：`npm install -g @qwen-code/qwen-code`             | 內建 + 手填               | mock only | ACP 參數取自官方文件                                                       |
| Cursor CLI        | `cursor-cli`    | acp                    | 啟動 `cursor-agent acp`；登入：在終端機執行 cursor-agent login（偵測：`cursor-agent status`）；安裝：`curl https://cursor.com/install -fsS \| bash`                                                      | 內建 + 手填               | mock only | **preset best-guess**（ACP 參數與登入偵測依公開資訊推測，未對真 CLI 驗證） |
| Factory Droid     | `factory-droid` | acp                    | 啟動 `droid acp`；登入：在終端機執行 droid 登入，或設定 FACTORY_API_KEY（偵測：$FACTORY_API_KEY）；安裝：`curl -fsSL https://app.factory.ai/cli \| sh`                                                   | 手填                      | mock only | **preset best-guess**（ACP 參數與登入偵測依公開資訊推測，未對真 CLI 驗證） |
| Antigravity       | `antigravity`   | acp                    | 啟動 `antigravity --acp`；登入：開啟 Antigravity，用 Google 帳號登入（無法偵測登入，只看是否安裝）；安裝：`從官方網站安裝 Antigravity`                                                                   | 手填                      | mock only | **preset best-guess**（ACP 參數與登入偵測依公開資訊推測，未對真 CLI 驗證） |
| Anthropic API     | `anthropic`     | api · anthropic        | API key → 模型與供應商 → 設定金鑰（本機加密金庫）；取得：https://console.anthropic.com/settings/keys                                                                                                     | live `GET /models` + 內建 | mock only |                                                                            |
| Google Gemini API | `gemini`        | api · gemini           | API key → 模型與供應商 → 設定金鑰（本機加密金庫）；取得：https://aistudio.google.com/apikey                                                                                                              | live `GET /models` + 內建 | mock only |                                                                            |
| Mistral           | `mistral`       | api · openai-chat      | API key → 模型與供應商 → 設定金鑰（本機加密金庫）；取得：https://console.mistral.ai/api-keys                                                                                                             | live `GET /models` + 內建 | mock only |                                                                            |
| MiniMax           | `minimax`       | api · openai-chat      | API key → 模型與供應商 → 設定金鑰（本機加密金庫）；取得：https://platform.minimax.io                                                                                                                     | 內建                      | mock only |                                                                            |
| Cerebras          | `cerebras`      | api · openai-chat      | API key → 模型與供應商 → 設定金鑰（本機加密金庫）；取得：https://cloud.cerebras.ai                                                                                                                       | live `GET /models` + 內建 | mock only |                                                                            |
| Groq              | `groq`          | api · openai-chat      | API key → 模型與供應商 → 設定金鑰（本機加密金庫）；取得：https://console.groq.com/keys                                                                                                                   | live `GET /models` + 內建 | mock only |                                                                            |
| DeepSeek          | `deepseek`      | api · openai-chat      | API key → 模型與供應商 → 設定金鑰（本機加密金庫）；取得：https://platform.deepseek.com/api_keys                                                                                                          | live `GET /models` + 內建 | mock only |                                                                            |
| xAI               | `xai`           | api · openai-chat      | API key → 模型與供應商 → 設定金鑰（本機加密金庫）；取得：https://console.x.ai                                                                                                                            | live `GET /models` + 內建 | mock only |                                                                            |
| Together AI       | `together`      | api · openai-chat      | API key → 模型與供應商 → 設定金鑰（本機加密金庫）；取得：https://api.together.ai/settings/api-keys                                                                                                       | live `GET /models` + 內建 | mock only |                                                                            |
| Fireworks         | `fireworks`     | api · openai-chat      | API key → 模型與供應商 → 設定金鑰（本機加密金庫）；取得：https://fireworks.ai/account/api-keys                                                                                                           | live `GET /models` + 內建 | mock only |                                                                            |
| Ollama            | `ollama`        | api · openai-chat      | 本機伺服器，免金鑰（http://127.0.0.1:11434/v1）                                                                                                                                                          | live `GET /models` + 內建 | mock only |                                                                            |
| LM Studio         | `lmstudio`      | api · openai-chat      | 本機伺服器，免金鑰（http://127.0.0.1:1234/v1）                                                                                                                                                           | live `GET /models` + 內建 | mock only |                                                                            |

## Custom providers

**＋ 新增自訂供應商** (`POST /api/providers`) adds one of:

- **ACP 代理** — name, command (binary + args, run without a shell; it must start in ACP mode), optional key and the env variable it is given in (the key is put into the agent's environment at spawn only), model list.
- **OpenAI 相容** / **Anthropic 相容** — name, base URL (`https://` for a remote service, `http://` only on loopback), key (optional for a local server), model list.

Custom providers are stored in `engine_providers` (migration 11); their keys in the vault. Built-in providers keep only the person's overrides (base URL or command, the OpenAI wire, a default model) in `provider_settings`.

## API (loopback)

```
GET    /api/providers?fresh=1          every provider with status + one-line fix
POST   /api/providers                  {kind: acp|openai|anthropic, label, command? | baseUrl?, key?, keyEnv?, models?}
GET    /api/providers/:id
PATCH  /api/providers/:id              {baseUrl?, command?, family?, defaultModel?}  (built-in)
DELETE /api/providers/:id              (custom)
PUT    /api/providers/:id/key          {key}  → local vault
DELETE /api/providers/:id/key
GET    /api/providers/:id/models?refresh=1
```
