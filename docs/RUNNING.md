# Running Alca

Requirements: Node ≥ 22.18 and pnpm. Everything runs on your machine; the server only binds `127.0.0.1`.

On macOS, a 「隔離並保留登入」 Space can take a one-time **import of logins from your Chrome** (從 Chrome 匯入登入… in the browser panel: pick sites, macOS asks for the Keychain). It never touches the shared profile; see [SECURITY.md](SECURITY.md#alca-browser-first-run-download-network-layer-gate-chrome-cookie-import-p13).

```sh
pnpm install
pnpm check          # typecheck (core + desktop UI + phone PWA) · lint · ≤ 800 lines · protocol spec · tests
```

## 1. Offline demo engine (no model, no login)

```sh
pnpm desktop:demo
# same as: node --disable-warning=ExperimentalWarning apps/desktop/src/main.ts --engine demo --data-dir .alca-dev
```

The terminal prints a URL like `http://127.0.0.1:4317/#token=…`. Open it in a browser (the token travels in the fragment and is then kept in session storage). Try:

- 「幫我寫一則筆記：明天十點開會」 → approval card for a write (under 每步確認)
- 「刪除購物清單」 → approval card for a delete (always confirmed, whatever the level)
- 「問我下午的會議要排幾點」 → question card
- 「給我一段長一點的回答」 → slow streaming; press `Esc` to interrupt

## 2. Claude Code engine with the fake CLI (no login)

The fake CLI speaks the same stream-json shapes and drives our MCP permission tool for real:

```sh
pnpm desktop --engine claude-code \
  --claude-bin "node --disable-warning=ExperimentalWarning packages/engines/testing/fake-claude.ts" \
  --data-dir .alca-dev
```

Directives you can type: `[bash:git status]` (permission prompt → approval card), `[bash:rm -rf dist]` (classified as delete), `[ask:要哪個？|A|B]` (question card), `[slow]` (interrupt with Esc), `[crash]` (process dies; next turn respawns with `--resume`).

## 3. Claude Code engine with a real `claude` login

```sh
npm i -g @anthropic-ai/claude-code   # or your usual install
claude auth login                    # once; `claude auth status` should exit 0
pnpm desktop --engine claude-code --workdir ~/some/project
```

- One `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages` process per thread, launched with `--permission-mode default`, `--mcp-config` (our permission server) and `--permission-prompt-tool mcp__alca__approve`. Anything the CLI would prompt for becomes an approval card.
- The process is reused across turns and restarted only when its launch config changes (model, working dir, stable prompt, env); the restart resumes the stored session with `--resume`.
- A conversation whose process has sat idle (no turn running) for 10 minutes has it stopped; its next turn starts a new process and resumes the stored session (`--resume`; Codex: `thread/resume`). `ALCA_ENGINE_IDLE_MINUTES` changes the limit (`0` keeps processes until Alca exits).
- To pick a model, set it in `<data-dir>/config.json`: `{"models": {"engines": [{"id": "claude-code", "kind": "cli", "model": "sonnet"}]}}`.

## 4. Alca Browser

Alca drives its **own** Chromium (Chrome for Testing or a system Chromium), never your everyday Chrome profile — Chrome 136+ refuses remote debugging there anyway. **If none is found, the app downloads Chrome for Testing on first run** into `<data-dir>/browser/bin` (about 200 MB zipped and about 370 MB unpacked on mac-arm64, resumable, checksum-checked; it starts in the background as soon as the core starts, not at the first browser task; progress in the browser panel; `--no-browser-download` turns this off). To provide one yourself instead, install one of:

- Chrome for Testing: `npx @puppeteer/browsers install chrome@stable --path ~/.alca/browser/bin` (found automatically under `<data-dir>/browser/bin`), or
- a system Chromium (`apt install chromium`, `brew install --cask chromium`), or point `ALCA_CHROMIUM=/path/to/chrome` at any binary.

> **macOS signature.** `codesign -dv` on the downloaded `Google Chrome for Testing` shows `Signature=adhoc` (linker-signed) and `spctl --assess` complains about missing resources. That is how Chrome for Testing ships: its Mach-O signature is embedded in the executable, and Alca's unzip writes every entry byte for byte (each one CRC-32 checked against the archive), keeps modes and symlinks, and skips nothing — so nothing is lost in extraction. The download is not quarantined (Node writes it, not a browser), so Gatekeeper does not prompt. Your everyday Google Chrome is never used, even when it is installed.

```sh
pnpm desktop:demo                      # a browser window opens on the first Space
pnpm desktop:demo -- --browser headless   # no window; watch it in the UI panel
```

The default `--browser window` opens a real Chrome for Testing window on your desktop. While the screen is locked (or the window is hidden on another space) macOS does not draw it, so the browser panel stays on 「正在連上畫面…」 until you unlock; `--browser headless` always streams frames.

In the demo, type 「幫我在示範商店結帳」 (or the 「試試瀏覽器」 starter): the agent opens a fake shop (served on its own loopback port; nothing is charged), takes a snapshot and wants to press 「確認付款」 — a payment card appears in the chat and over the live frame. Press 接手 to drive the page yourself (click / type / scroll on the frame, or type a URL), then 交還給 Alca; the agent's queued step runs after hand-back, and refs from before are void. `⌘/Ctrl+B` toggles the panel.

Profiles: `<data-dir>/browser/profile` (shared Spaces), `<data-dir>/browser/spaces/<id>` (persistent isolated Spaces), screenshots in `<data-dir>/browser/shots/`.

Tests: `packages/browser/test/chromium.test.ts` and `apps/desktop/test/browser.test.ts` run against a real headless Chromium (`$ALCA_TEST_CHROMIUM`, else the normal lookup) and a local fixture site; they skip when no Chromium is found.

## 5. Claude Code + Alca Browser (P2b)

With `--engine claude-code` the browser tools are handed to the CLI as MCP tools (`mcp__alcatools__browser_open`, `…_snapshot`, `…_click`, …). The model never drives Chromium directly: each call goes back into the desktop process over the loopback bridge, and runs exactly like a host tool — the tool's live inspection (the button a click would press), the policy gateway with its audit row, an approval card when needed (payment / send / delete / publish **always**), the sensitive-action gate against the class that was approved, as the thread's bot, in that bot's Space for the thread, queued while you drive.

```sh
# real CLI (logged in once with `claude auth login`)
pnpm desktop --engine claude-code --browser window --workdir ~/some/project

# offline, with the fake CLI and the demo shop of section 4 (any http page works)
pnpm desktop --engine claude-code --browser window \
  --claude-bin "node --disable-warning=ExperimentalWarning packages/engines/testing/fake-claude.ts" \
  --data-dir .alca-dev
```

With the fake CLI, type browser calls as directives (several in one message run in order; `$ref(text)` picks the `@N` of the line in the previous result that contains the text):

```
[mcp:browser_open {"url":"http://127.0.0.1:PORT/checkout"}][mcp:browser_snapshot {}][mcp:browser_click {"ref":"$ref(確認付款)"}]
```

You get a card for opening the page (under 每步確認), the snapshot runs (a read), and the pay click puts up a **payment** card in the chat and over the live frame; 拒絕 means the button is never pressed. Press 接手 before a step and it waits (`queued`) until 交還給 Alca.

- The CLI is launched with a second MCP server (`alcatools`, `packages/engines/src/claude/tools-mcp.ts`) next to the permission server, and `--allowedTools mcp__alcatools`: the CLI does not prompt for these tools because the host gates every call when it arrives. If a CLI prompts anyway, the prompt is let through and the call is still gated once.
- The tool list (names, descriptions, schemas only) is in a 0600 temp file; changing the set of host tools restarts the CLI process (resumed with `--resume`). No credential, cookie or local token is ever passed to the CLI; logins stay in the Space's Chromium profile.
- `--browser off` gives the CLI no browser tools.

## 6. Router and workers (P3, the default)

Every bot is a resident router (talks to you, dispatches) plus isolated workers (do the work in their own session and browser Space). This is the default; `--agents direct` gives the P1 / P2 single-turn path back.

```sh
pnpm desktop:demo                       # demo router + workers + judge (no model, no login)
pnpm desktop --engine claude-code       # router CLI + one CLI process per worker
```

With the demo, try:

- 「同時幫我做兩件事：在示範商店結帳，再整理一份藍牙耳機的比價報告」 → two workers at once; the worker panel opens by itself. The shop worker stops at a payment card in its own Space (the card says which bot and which worker); the price report is long, so the router gets a summary and recalls the full text page by page.
- 「幫我一直盯著信箱，有回信就告訴我」 → a worker that polls forever; the watchdog stops it and the router tells you why.

The worker panel (top-bar 工人 button or `⌘/Ctrl+I`) lists workers in progress and finished; click one to watch its own live stream and to stop it. On Claude Code the router's CLI is launched with every built-in tool removed and only the four router tools (`worker_start`, `worker_status`, `worker_stop`, `recall`) over MCP; each worker gets its own CLI process (resumed with `--resume`) with the host tools. Tuning lives in `config.json` under `engineering.workers` (`maxConcurrent`, `inlineChars`, `summaryChars`, budgets, `watchdogSec`, `stuckSec`, `loopWindow`, `loopRepeats`).

Triggers: `POST /api/triggers {threadId, name, source: "timer"|"manual", config?, rule?, semantic?}` and `POST /api/triggers/:id/fire {text, from?, streamKey?, explicit?}`; code rules run first, the model judges only candidates.

## 7. Alca Link: phone + hands (P4)

Link is off until the desktop knows a rendezvous. The rendezvous only matches pairing codes and forwards ciphertext; run your own (it keeps nothing on disk).

### Self-host the rendezvous

```sh
node --disable-warning=ExperimentalWarning apps/phone-pwa/scripts/build.ts      # → apps/phone-pwa/dist
pnpm rendezvous --pwa apps/phone-pwa/dist                                        # http://127.0.0.1:8787, WebSocket /v0/link
```

On a server, expose it over TLS (a phone page must be https to keep its keys and to be installable): either `--host 0.0.0.0 --tls-cert cert.pem --tls-key key.pem`, or keep it on loopback behind your TLS proxy with `--trust-proxy` (client address = the rightmost `X-Forwarded-For` entry, the one your proxy appended, used for rate limits; `--trust-proxy-hops N` / `ALCA_RELAY_TRUST_PROXY=N` behind N proxies of yours) and `--origin https://your.host` to pin the browser origin. Same options as env vars (`ALCA_RELAY_HOST`, `ALCA_RELAY_PORT`, `ALCA_RELAY_TLS_CERT`, `ALCA_RELAY_TLS_KEY`, `ALCA_RELAY_PWA`, `ALCA_RELAY_TRUST_PROXY=1`, `ALCA_RELAY_ORIGINS`). Whoever serves the PWA serves the code that holds the phone's key: serve it yourself ([SECURITY.md](SECURITY.md)).

### Pair a phone

```sh
pnpm desktop --rendezvous https://your.host          # or config.json {"advanced": {"rendezvousUrl": "https://your.host"}}
pnpm desktop:pair                                    # prints a code + terminal QR (or press 手機 in the desktop sidebar)
```

Scan the QR with the phone camera (it opens `https://your.host/#pair=…`) or open the PWA and type the code (`NNN-SSS-SSS`, single use, 120 s by default: `engineering.pairingCodeTtlSec`). Compare the safety number on both screens, then add the page to the home screen. In the 手機 dialog, tick 允許這支手機接手瀏覽器 to grant `control_computer` (takeover); every phone gets `chat`, `approve`, `view_screen`. Revoke there too: it is permanent and ends live sessions at once. `--link-lan <port>` also listens on the LAN for devices that can use it (hands daemons; an https page cannot open `ws://`). `--pwa-url <url>` points the QR at a PWA served somewhere other than the rendezvous.

Local try-out without TLS: `pnpm rendezvous --pwa apps/phone-pwa/dist`, `pnpm desktop:demo --rendezvous http://127.0.0.1:8787`, then open `http://127.0.0.1:8787` in a desktop browser at phone size (localhost counts as a secure context).

### Run hands on another machine

```sh
pnpm hands pair 381-204-957 --rendezvous https://your.host [--name build-box] [--fingerprint <core fingerprint>]
pnpm hands run --workdir ~/alca-work                 # stateless; reconnects on its own
```

State (its identity + the pinned core key) is in `~/.alca-hands/device.json` (0600; `--state <file>`), `--no-lan` skips the core's LAN address. The core's agents then see `hands_devices`, `hands_run`, `hands_read_file`, `hands_write_file`, `hands_list_files`; each call goes through the policy gateway and its approval card before it is sent, and runs only inside the work directory with a clean environment.

## 8. Memory and skills (P5)

Learning is on by default in both modes (`--agents router` and `direct`); everything stays in `state.sqlite` on this computer and no embedding model or network call is involved. Turn it off with `config.json` `{"advanced": {"learning": false}}` (no curation, no skill proposals; what is stored stays readable and deletable). Tuning: `engineering.memory` (`recallTokens` = recall budget per router turn, default 400; `skillHints`, default 3; `skillMinSteps` = successful tool calls before a task is proposed as a skill, default 2).

With the demo (`pnpm desktop:demo`), try:

- 「記住我喜歡喝燕麥奶拿鐵，少冰」 → saved as 你說的 (confirmed); 「我住在高雄」 → learned as 推測 with a confidence; open 記憶與技能 in the sidebar to see where each came from, edit (a new version), confirm, move between 共用 / 只有這個 Bot, export, or 忘記 (every version deleted; a hash keeps Alca from learning it again; 「讓 Alca 可以重新學習」 clears those hashes).
- 「忘記我喜歡燕麥奶拿鐵」 in the chat does the same as the 忘記 button (and the reply says so).
- 「幫我整理這週的週報」 → a two-step task; when the worker finishes, a 學到一個做法 card appears under the chat: 存成技能, 編輯後存 or 不用. Ask 「再幫我整理一次週報」 and the router hands the saved skill to the worker.
- 「幫我在示範商店結帳」 (with the demo shop of section 4 / a Chromium) → the proposal marks the payment step 含一律確認; after saving it, the next checkout still stops at the payment card, even under `autonomous`.

On the phone: thread drawer → 記憶與技能 (search, filters, 沒錯 / 編輯 / 忘記, export via the share sheet), and the 學到一個做法 row at the end of a chat opens the proposal sheet (deciding needs the phone's `approve` scope). API: `/api/memory`, `/api/skills` (list in `apps/desktop/src/memory-routes.ts`).

## 9. Connected apps and routines (P6)

Alca uses apps (Gmail, Google 日曆, GitHub, Slack, …) through **your own Composio account**: OAuth tokens live at Composio, the Composio API key lives only on this computer.

1. **Set the key.** Create a key in the Composio dashboard, then open 連接 in the sidebar and paste it. Alca checks it with Composio once and keeps it in `vault.json` in the data directory (AES-GCM; its key in the macOS keychain or the Secret Service, else a 0600 `vault.key` file). The keychain is touched only when the vault first needs its key — when you save the first secret, or read one saved before — never at start-up and never with a probe item. The item is `alca-agent` / `vault-key` for the default data folder (`~/.alca`) and `alca-agent` / `vault-key-<12 hex of the folder's path hash>` for any other `--data-dir`, so a test run or a second data folder never reads or overwrites your main item. `ALCA_VAULT_BACKEND=file` (or the older `ALCA_VAULT_KEY=file`) keeps the key in the 0600 file only — use it for tests and throw-away data folders. Since next round D1 the vault also holds the core's Link identity and VAPID key, so the first start creates the keychain item even before you save a secret; the log (and `alca secrets status`) says where the vault key is and, when it is the 0600 file, why (§ 21). The page shows only `••••` and the last four characters; 更換 / 移除 replace or delete it. The phone never sees it.
2. **Connect apps.** In 連接, choose an app and give the account a label (「工作」, 「個人」). Alca opens Composio's Connect Link in your browser; sign in there, come back, and the account turns 已連接 (or press 重新整理). Two accounts of one app are fine: the agent has to name the one it means.
3. **Decide who may use what.** Per account and per bot: 不能用, 只讀 (read tools only) or 可操作. Sending, publishing, deleting and paying still ask every time, and stop at the daily quota (`engineering.connectors.dailyQuota`, default send 30 / publish 10 / delete 10 / payment 0).
4. **Routines.** In 例行工作 → 新增: a name, when (every N minutes, a daily / weekday time in a time zone, or once), which app account to look at, what to tell you about, and 提前做 (prepare drafts ahead). Each check reads the app with plain code first; only new items start an AI run (`engineering.routines.maxAiRunsPerDay`, default 24 per bot). A failed read shows red with the reason, keeps its place and retries later (15 min doubling to 4 h by default).
5. **App events (optional).** For 「收到新信就叫醒 bot」 the app needs somewhere to deliver: your own relay. With `--rendezvous` set, a trigger chip on an account registers a webhook mailbox at `<relay>/v0/hooks/<id>`; Composio posts there, the core pulls every `relayPollSec` (20 s) with a token only it holds and checks Composio's signature before anything runs. The relay keeps mailboxes in memory; to keep them across a relay restart run it with `--hooks-file /var/lib/alca/hooks.json` (or `ALCA_RELAY_HOOKS_FILE`), written 0600.

Offline, `pnpm desktop:demo` starts a local Composio stand-in (key `mock-composio-key-0001`, the Connect Link completes by itself): try 「幫我看看工作信箱有沒有要回的信」, 「幫我回王小明的信，跟他說報價週三中午前寄給他」 (a send card, nothing goes out until 允許), and a routine on Gmail 「工作」 with 提前做 (a reply draft appears under 例行工作). `--composio-url <base>` points at another Composio-compatible base URL.

On the phone: thread drawer → 連接與例行工作 (accounts and access, routines on / off / 現在檢查, drafts 用這份 / 丟掉); a connected-app send arrives as a sheet with the account, recipient, subject and body. Reading needs the phone's `chat` scope, every change `approve`.

## 10. A team of bots (P7)

Everything in sections 1–9 belongs to a bot; with P7 you can have several. Open 團隊 in the sidebar.

1. **Create a bot.** 新增 bot: a name, an avatar, a tone and a role (one line, e.g. 「研究和比價」; teammates and the lead route by it). 進階 holds the bot's own instructions, its engine and model, its approval level (the team's, 每步確認 or 自主), its browser profile (shared, isolated, isolated and kept) and its memory mode (the team's shared memory, its own, or none). Bots are created and edited on the desktop only; 封存 asks in the editor's footer and can be undone (the default bot cannot be archived).
2. **Talk to one.** Pick a bot in the sidebar roster (on the phone: a bot's sheet → 和它對話), or start a message with `@name` (the 對 X 說 chip shows who will answer). That bot answers in the same conversation, with its byline; this is not a delegation. A **lead** (團隊 → 協作規則 → 領頭) takes every new conversation and hands it on by role when that fits.
3. **Let them work together.** A bot can ask a teammate a question or hand it work; the teammate works in its own conversation with its own workers, and the answer comes back to the bot that asked. 團隊 → 協作規則: 隊友交辦 `自動` (no card), `交辦先問我` (default: a card before a delegation, questions go straight through) or `都先問我`; 最多轉交幾層 (depth, default 2, at most 5); how many requests may be open at once (default 4). A bot already in the chain is never asked again. Any card the teammate raises shows in **your** conversation the chain started from. 協作紀錄 (and a peer row in the chat) shows each step and the teammate's conversation, and can stop a request.
4. **Other model services.** In the bot editor, 進階 → ＋ 新增模型服務: OpenRouter, Ollama (local), LM Studio (local), Gemini, or 其他（OpenAI 相容） with your own base URL. Paste the key once (OpenRouter and Gemini need one, the local ones do not): it goes into the local vault as `engine:<id>`, is never shown again or sent over Link, and travels only in the request header (`Authorization` for OpenAI-compatible services, `x-goog-api-key` for Gemini). A remote base URL must be https; http is accepted only on loopback. Then pick the service and a model as that bot's engine. API: `POST /api/engines/providers {kind, label, baseUrl, model, key?}`.

With the demo (`pnpm desktop:demo`), add a bot named 研究員 with the role 「研究和比價」, then try 「請研究員幫我整理藍牙耳機的比價報告」 (a delegation card under the default rule, then the teammate's worker and its report), 「問研究員下週三有沒有空」 (a question, straight through), `@研究員 你好` (it answers here), and 「請研究員刪除購物清單」 (the delete card from the teammate's worker appears in your conversation).

On the phone: thread drawer → 團隊 (roster, what each bot is doing, who waits for you, rules, lead), a bot's sheet (和它對話), one request's trail (stop needs `approve`), `@` above the composer. The phone sees engine names only, never a base URL or key.

## 11. Desktop shell (P8)

`apps/desktop-shell` is a Tauri 2 app: one window around the core's own UI, a tray / menu-bar icon (等你決定：N 件 with an amber dot), 登入時開啟, `alca://pair` and `alca://open`, one instance. It keeps no state; if a core already runs on the port (the service of § 12, or `pnpm desktop`) it attaches, otherwise it starts the core `scripts/install.sh` installed (`~/.alca/app`) or `$ALCA_CORE_CMD`, restarts it after a crash and stops it with SIGTERM on quit — also when the shell itself gets SIGTERM / SIGINT / SIGHUP; a core it started exits by itself when the shell is gone (`ALCA_SUPERVISOR_PID`), so a killed shell leaves no core on the port. `$ALCA_CORE_CMD` / `$ALCA_CORE_ARGS` are split like a shell does, so a path with spaces goes in quotes (as in the example below). A `--data-dir` or `--engine` already in them is kept (the shell reads the port and token from that folder too). Details, build commands and what is verified: [apps/desktop-shell/README.md](../apps/desktop-shell/README.md).

```sh
cd apps/desktop-shell/src-tauri && cargo test          # unit tests (Linux needs libwebkit2gtk-4.1-dev, libappindicator3-dev)
cd apps/desktop-shell && ALCA_CORE_CMD="node --disable-warning=ExperimentalWarning '$PWD/../desktop/src/main.ts'" ALCA_ENGINE=demo \
  pnpm exec tauri dev                         # the app against this checkout
cd apps/desktop-shell && CI=true pnpm exec tauri build --bundles dmg   # a local macOS .dmg
```

On macOS set `CI=true` for a local `.dmg`: otherwise the bundler lays the window out by driving Finder with AppleScript, which fails with 「AppleEvent 逾時 (-1712)」 unless the terminal has Automation access to Finder. The release workflow sets it.

Release builds come from `.github/workflows/release.yml` on a `v*` tag (macOS universal `.dmg`, Windows `.exe`, Linux `.deb` / `.AppImage`). The macOS and Linux apps carry their own core + Node 22 (`scripts/stage-shell-core.sh`; unpacked on first start into `<data-dir>/bundled/<version>`), so they run without `install.sh`; Windows still needs the core installed, with `scripts/install.ps1` (§ 12). macOS builds are ad-hoc signed (Tauri `signingIdentity: "-"` through the `--config` overlay; `codesign --force --deep -s -` as a fallback), and signed with a Developer ID and notarized only when the `APPLE_*` repository secrets are set. The macOS job ships the App twice: in the `.dmg` and as `Alca-macos.app.tar.gz` + `Alca-macos.app.tar.gz.sha256` (Alca.app at the top, symlinks kept). Manual checks: [DEVICE-TEST.md § G](DEVICE-TEST.md).

**The macOS App from the terminal (no Gatekeeper prompt).** One line; while the repo is private the GitHub CLI has to be signed in (`gh auth login`):

```sh
gh release download --repo ihsieh31/alca-bot --pattern install.sh --output - | bash -s -- --app-only   # private repo
curl -fsSL https://github.com/ihsieh31/alca-bot/releases/latest/download/install.sh | bash -s -- --app-only   # once public
# options: --version <tag> · --app-dir <dir> (default ~/Applications) · --yes (replace an existing Alca.app, the old one kept as Alca.app.bak-<time>)
#          --app-tarball <file|url> + --app-sha256 <hex> (a tarball you already have) · --app / --no-app with a full install
```

It downloads `Alca-macos.app.tar.gz` (with curl, or `gh release download` when curl cannot reach a private release), checks its SHA-256 and `codesign --verify --deep --strict`, and moves `Alca.app` into `~/Applications`. Files curl or gh write carry no `com.apple.quarantine` mark, so `open ~/Applications/Alca.app` starts it without a Gatekeeper prompt. A full release install on macOS (`install.sh` without `--app-only`) brings the App too; `--no-app` skips it. A **`.dmg` downloaded in a browser** is quarantined: open it once, then 系統設定 → 隱私權與安全性 → 「仍要打開」 next to the Alca line → your password; it does not ask again. A tarball you downloaded in a browser keeps its mark too, and `install.sh --app-tarball` says so.

## 12. Install and the always-on core (P8)

```sh
bash scripts/install.sh --local .                 # from this checkout (tracked files only; needs its node_modules)
bash scripts/install.sh --tarball alca-core.tar.gz   # needs alca-core.tar.gz.sha256 next to it, or --sha256 <hex> (else --insecure)
curl -fsSL https://github.com/ihsieh31/alca-bot/releases/latest/download/install.sh | bash   # the latest release (the repo is private: download it signed in, then --tarball)
# options: --prefix <dir> (default ~/.alca) · --engine claude-code|demo · --no-service · --sha256 <hex> · --attestation · --insecure · --app / --no-app / --app-only (macOS, see § 11) · -- <core flags>
bash scripts/install.sh --local . --engine demo -- --rendezvous https://your.host
```

It checks Node ≥ 22.18, unpacks the core and the built PWA into `~/.alca/app` (data files next to it are never touched; a re-install replaces only `app/`), writes the launcher `~/.alca/bin/alca`, runs `alca service install` and prints the pairing steps. `scripts/pack-core.ts --tar out/alca-core.tar.gz` makes the same tarball the release ships (workspace links + one hoisted `zod`; runs with plain `node`, no pnpm).

**Windows** (Phase E): `scripts/install.ps1` does the same with the same release files and rules (Node ≥ 22.18, `.sha256` required unless `--insecure`, a draft needs `--version <tag>`, a private repo goes through `gh`). Windows does not run a downloaded script by default, so:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 --version v0.2.0
powershell -ExecutionPolicy Bypass -File .\install.ps1 --tarball .\alca-core.tar.gz --no-service
# options: --prefix <dir> (default ~\.alca) · --engine · --site · --sha256 · --insecure · --no-service · -- <core flags>
```

It writes `~\.alca\bin\alca.cmd` and registers the Task Scheduler task. The packed core's symlinks (listed in `ALCA_LINKS.json`) become directory junctions, so neither Developer Mode nor administrator rights are needed.

**Updates** (Phase E, [RELEASE.md § 6](RELEASE.md#6-updates-alca-update)): `alca update check | install | rollback | status`. The core checks once a day and only notifies (設定 → 關於; `engineering.updates.check: "off"` to stop it, `channel: "prerelease"` for release candidates); `install` asks first, backs up `state.sqlite`, keeps the previous version as `app.prev`, restarts the service and rolls back by itself when the new version does not answer `/api/health`.

The service, from a checkout or the launcher:

```sh
pnpm alca service install --engine demo -- --rendezvous https://your.host   # or: ~/.alca/bin/alca service install …
pnpm alca service status          # running? pid, unit / plist path, last log lines (exit 3 when not running)
pnpm alca service uninstall       # stops it, removes the unit; data and logs stay
pnpm alca pair                    # a pairing code + terminal QR
```

The unit runs `<data-dir>/service/run-core.sh`, which starts the core with the Node used at install time and, if that one is gone (nvm / fnm / volta switched or removed it), with a Node ≥ 22.18 on the PATH or in the usual places (Homebrew, `/usr/local`, `~/.nvm`, `~/.volta`, fnm, asdf), writing which one to `core.log`; with none it logs what to do and waits a minute before launchd / systemd try again. `status` warns when the recorded Node is gone (a unit written before this pinned Node itself: `alca service install` again). Windows runs Node directly.

macOS: a LaunchAgent in `~/Library/LaunchAgents` (starts at login in your GUI session; `KeepAlive` true, so it comes back within ~10 s whenever it exits, a plain `kill` included — `uninstall` stops it for good). Linux: a systemd `--user` unit (`Restart=always`; `systemctl --user stop alca-core` stops it until the next login; `sudo loginctl enable-linger $USER` to run before you log in). Windows: a Task Scheduler task at logon. Logs: `<data-dir>/logs/core.log`. `GET /api/status` (local token) is what the tray reads.

## 13. Notifications on the phone (Web Push, P8)

Needs the PWA on **https** (the relay with TLS, § 7) and, on iPhone, the PWA added to the Home Screen first (iOS 16.4+; pair from the Home Screen app). After pairing the phone offers 「有事等你決定時，提醒你」, or turn it on in 裝置 → 通知; 診斷 → 傳一則測試通知 checks the whole path. The core keeps a VAPID key pair in its local vault (`secrets.json` before next round D1) and POSTs encrypted pings straight to the phone's push service (Apple, Google, Mozilla, Microsoft only); a ping says only that something waits (`{v, t, id}`), and the phone fetches the details over the Link session once opened. A phone with the app open gets an in-app banner instead. `$ALCA_PUSH_CONTACT` (a `mailto:` or `https:` URI) is the VAPID contact the push services see (default: settings `engineering.push.contact`, `mailto:admin@example.com` until you set your own). Push is on only when Link is (a rendezvous is set). The relay also answers `/diag` with a redirect to `/#diag`, so the 診斷 link in [DEVICE-TEST.md](DEVICE-TEST.md) can be typed by hand.

## 14. Smoke tests against real accounts (P9, opt-in)

`pnpm test` and CI never touch a real account. `pnpm smoke` (`vitest.smoke.config.ts`, files in `apps/desktop/smoke/`) does, and only for the blocks whose variable you set; every call is a key check, a read or a plain chat turn, and nothing is sent, posted, bought or deleted.

```sh
ALCA_SMOKE_COMPOSIO_KEY=… pnpm smoke                     # key check, a session, connected accounts, Gmail tool search (read-only)
ALCA_SMOKE_OPENROUTER_KEY=… ALCA_SMOKE_GEMINI_KEY=… pnpm smoke   # a plain turn + a follow-up, and one host-tool call in the host-loop shape
ALCA_SMOKE_CLAUDE=1 ALCA_SMOKE_CODEX=1 pnpm smoke        # your own CLI logins: a reply, the session recorded, resume after a restart
ALCA_SMOKE_CLAUDE=1 ALCA_SMOKE_CLAUDE_MODEL=haiku npx vitest run --config vitest.smoke.config.ts apps/desktop/smoke/router-dispatch.smoke.ts
                                                         # the default router + worker mode on the real CLI: the router dispatches a worker (catches ToolSearch-style breaks)
```

| Variable                                               | Meaning                                                                                            |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `ALCA_SMOKE_COMPOSIO_KEY`                              | Your Composio API key (never printed; a failure message is checked not to contain it)              |
| `ALCA_SMOKE_COMPOSIO_BASE`, `ALCA_SMOKE_COMPOSIO_USER` | REST base (default `https://backend.composio.dev/api/v3.1`), smoke user id (default `alca-smoke`)  |
| `ALCA_SMOKE_OPENROUTER_KEY`, `…_BASE`, `…_MODEL`       | OpenRouter key; base (default `https://openrouter.ai/api/v1`); model (default `openai/gpt-6-luna`) |
| `ALCA_SMOKE_GEMINI_KEY`, `ALCA_SMOKE_GEMINI_MODEL`     | Gemini API key; model (default `gemini-3.8-flash`)                                                 |
| `ALCA_SMOKE_CLAUDE`, `ALCA_SMOKE_CODEX`                | `1` = the `claude` / `codex` on your PATH, or the command to run; logged in beforehand             |
| `ALCA_SMOKE_CLAUDE_MODEL`, `ALCA_SMOKE_CODEX_MODEL`    | Optional model override                                                                            |

## 15. 連線: a stable address, Tailscale / LAN, automatic reconnect (P9)

The relay mailbox is this install's persistent opaque id, derived from its Link key, so restarting the core or the relay never changes what a paired phone dials. The core checks itself every 15 minutes (a ping on its relay socket, and a probe of its own mailbox from outside) and re-registers when either fails. A phone that loses the computer keeps retrying on its own (backoff with jitter; the banner shows the tries so far, the next try and 現在重試) and never needs a new pairing code for that.

Desktop: 手機與裝置 → 連線設定 opens the 連線 dialog — the self-check state with 現在檢查, the mailbox id, the addresses the phone knows, and two optional fields saved in `<data-dir>/link.json` (0600; nothing in it is secret):

- **自己的穩定網址** — your own relay (self-hosted, § 7, or on your own domain behind TLS). Saving it moves the core there after telling every live phone the new address (a sealed `endpoints` event), so paired phones follow without re-pairing. Open the PWA from that address and add that one to the Home Screen.
- **直連位址（Tailscale／區網）** — up to 4 `wss://` (or `ws://` for hands) URLs that reach this computer's LAN listener directly. Start the core with `--link-lan 4318`, then e.g. `tailscale serve --bg --https=443 http://127.0.0.1:4318` and enter `wss://<machine>.<tailnet>.ts.net`. Phones try the direct addresses first, then each relay, and remember what worked.

The same over the API (local token): `GET /api/link/connection`, `PUT /api/link/connection {relayUrl?, directUrls?}`, `POST /api/link/connection/check`; any paired phone reads it as the `link.health` op (its 診斷 shows one row per relay plus the core's last self-check). A pairing code now survives typos: up to 5 wrong tries, one claimer at a time; success or the 5th failure burns it.

## 16. Codex CLI engine and model-based memory extraction (P9)

A bot can run on the Codex CLI: in the bot editor (團隊 → 編輯 → 進階 → 引擎) pick 「Codex CLI」. The core runs one `codex exec --json` process per turn (resuming the stored session), keeps Codex's own tools in its read-only sandbox with approvals off, and gives it the host tools over MCP, where the gateway decides as for every engine. The command is `codex` by default; `--codex-bin "<cmd>"` or `$ALCA_CODEX` changes it. Log in to Codex once yourself (`codex login`); Alca never sees that login.

記憶整理 (same 進階 section) is `規則（預設）` or `也請模型整理`: with the second, after each turn the bot's own engine is asked, in a separate tool-less conversation, for at most three things worth keeping. A proposal counts only when it quotes the person's own words from that turn; it is always stored as inferred, still passes the secret filter and the 忘記 tombstones, and the rule extractor stays the floor (any model error or timeout leaves the rules' result). `PATCH /api/bots/:id {memoryExtract: "rules" | "model"}` sets it over the API.

## 17. 用 Google 登入: a fixed phone site, no pairing code (P10, P12)

The full deployment (Google Cloud Console clicks, Vercel, Cloudflare, the release's build variables) is in [DEPLOY.md](DEPLOY.md). In short you need **one Web application OAuth client** whose JavaScript origin is the phone site (e.g. your Vercel URL); the computer signs in through that site (P12), so it needs no client or secret. A release carries the official relay / site / client ID; elsewhere set `ALCA_OFFICIAL_SITE_URL` (and optionally `_RELAY_URL`, `_GOOGLE_CLIENT_ID`) or use 連線.

- **Relay** with Google: `pnpm rendezvous --google-client-id WEB_ID --google-client-id DESKTOP_ID --accounts-file accounts.json` (or `$ALCA_RELAY_GOOGLE_CLIENT_IDS`, `$ALCA_RELAY_ACCOUNTS_FILE`, `$ALCA_RELAY_SECRET`), or deploy `services/relay-worker` to Cloudflare (`wrangler secret put ALCA_RELAY_SECRET`, `GOOGLE_CLIENT_IDS` var, `wrangler deploy`). The relay keeps only `HMAC(secret, Google sub) → computers`.
- **Phone site**: `ALCA_RELAY_URL=https://relay… ALCA_GOOGLE_CLIENT_ID=WEB_ID node --disable-warning=ExperimentalWarning apps/phone-pwa/scripts/build.ts` writes `dist/config.json`; on Vercel set the same two variables with Root Directory `apps/phone-pwa` (`vercel.json` has the build, headers and rewrites). Without `ALCA_GOOGLE_CLIENT_ID` the site shows pairing codes only, as before.
- **Computer**: **手機與裝置 → 用 Google 登入**: the default browser opens `<site>/computer-signin`, Google, then a one-shot `http://127.0.0.1:<port>/google-callback` listener; the computer is listed under that account. **停用** takes it off the list. Self-host with a Desktop client instead: `config.json` → `"engineering": {"google": {"clientId": "DESKTOP_ID", "clientSecret": "…"}}` (loopback + PKCE).
- **A new phone**: open the site → 使用 Google 帳戶繼續 → the computer (picked for you when it is the only one) → the phone shows a **6-digit code** → type it in the sheet 「輸入手機上的驗證碼」 on the computer (it appears over any screen; 5 tries, 5 min). The phone is then an ordinary trusted device: it reconnects with its key alone, no prompt, shows up in the device list, and is revoked there. Pairing codes (「用配對碼連線」) stay as the fallback.
- API (loopback): `GET|POST|DELETE /api/link/remote`, `GET /api/link/enrollments`, `POST /api/link/enrollments/:id {allow}`.
- Local try-out with a fake Google: the e2e tests (`apps/desktop/test/google-remote.test.ts`, `services/rendezvous/test/google-account.test.ts`) and `ALCA_SHOTS_ONLY=p10 pnpm screenshots` run everything against `services/rendezvous/test/fake-google.ts`.

## 18. 模型與供應商: pick a provider, then a model (P11)

Open **模型與供應商** in the sidebar. The six pinned providers come first (Claude Code, Codex CLI, Gemini CLI, OpenCode, OpenAI, OpenRouter); the rest are under **更多供應商**. Each shows 可用 / 需登入 / 需金鑰 / 未安裝 and what to do: install the CLI, log in to it in a terminal (Alca never sees that login), or paste an API key (kept in the local encrypted vault, never shown again). You can override a CLI's command or an API's base URL, switch OpenAI between Responses and Chat Completions, and set a default model. **＋ 新增自訂供應商** adds an ACP agent (command + optional key and the env variable it goes in) or an OpenAI- / Anthropic-compatible service (base URL + key + models).

In a bot's editor (團隊 → 編輯 → 進階) pick **供應商**, then **模型** (searchable, with context and price where the vendor lists them; you can type any id). Every provider, its kind, how to log in and what was actually tested: [PROVIDERS.md](PROVIDERS.md). API: `/api/providers…` (same page).

## 19. Evals: scripted scenarios against fake engines (P13)

```sh
pnpm evals                       # every scenario; report in evals-report/report.{json,md}; exit 1 on a failure
pnpm evals --filter injection    # one category (router, approvals, memory, routines, team, injection) or an id part
pnpm evals --out /tmp/report
```

No model, no network: router / worker engines are scripted, tools record their calls, the store is in memory. Each scenario records named checks, so a run is a full scorecard rather than the first failure. Scenarios live in `packages/evals/scenarios/`; add one whenever a change touches routing, approvals, memory, routines, delegation or how outside text reaches a prompt. CI runs it as its own job and uploads the report.

## 20. Telegram as a reply channel (P13)

1. In Telegram, talk to **@BotFather** → `/newbot` → copy the token.
2. Desktop: **手機與裝置 → Telegram**, paste the token (checked with Telegram, then sealed in the local vault; never shown again).
3. Send your bot any message from your own Telegram account. It does not answer yet, but the dialog lists the chat under 最近想跟 Alca 說話的聊天 → **加入** (or type your numeric chat id).
4. Pick which bot answers, tick **啟用**, **儲存**.

Each allowed chat talks to one conversation of that bot (`/new` starts another); replies come back as plain text. Only private chats on the list are answered; anyone else gets no reply. **Telegram cannot approve**: when a card is waiting you get a notice without details, and you answer on the computer or a paired phone. Telegram bots are not end-to-end encrypted, so what the bot says passes through Telegram's servers. The core long-polls (no webhook, no inbound port); state is in `<data-dir>/telegram.json` (0600, no token, no message text). API: `GET / PUT /api/telegram`, `PUT / DELETE /api/telegram/token`.

## 21. Backups of the state database (P13)

Before a migration runs on a database that has data, the core copies it to `<data-dir>/backups/state-v<from>-<time>.sqlite` (the newest five are kept) and prints where.

```sh
pnpm alca db backups                     # list them, newest first (--json for a machine-readable list)
pnpm alca db backup                      # take one now
# stop the core first (quit the app; for the always-on core: pnpm alca service uninstall, then install again after)
pnpm alca db restore state-v14-<time>.sqlite   # a name from the list or a path
pnpm alca db verify                      # check the audit log's hash chain and the outside anchor (works while the core runs)
pnpm alca db verify --file <backup>      # check a backup instead (no anchor); --json for machine-readable output
pnpm alca db compact                     # core stopped: switch a large old database to incremental vacuum
```

All take `--data-dir <dir>` (default: the usual data dir). Restore checks the file's integrity and that this build knows its schema, then moves the current `state.sqlite` aside as `state.sqlite.before-restore-<time>` (nothing is deleted) and copies the backup in; the next start migrates it forward again (with a new backup).

### Keys and secrets (not in these backups)

The database backups do not contain `vault.json` (API keys, site logins, since next round D1 the core's Link identity and VAPID key, and since Phase F2 the data key `core.dbKey`) or `secrets.json` (the loopback token). Since F2 the conversation text in the database and in every backup is encrypted with `core.dbKey`: **a backup does not open without that key**, so keep a `secrets export` of it somewhere safe. Their own safety nets are the `.bak` next to each file and an export:

```sh
pnpm alca secrets status                 # where each key is (vault / secrets.json), where the vault key is (keychain, or the 0600 file and why); never values
# the commands below need the core stopped
pnpm alca secrets export --to-file ~/alca-keys.json --confirm   # one 0600 plaintext file: delete it after use
pnpm alca secrets import ~/alca-keys.json --confirm             # on the new computer / data folder
pnpm alca secrets reset --confirm        # last resort: a new identity on the next start (phones pair again)
```

- **Moving computers**: copying the data folder alone is not enough — the vault's key is in the old computer's keychain, and the database is encrypted with `core.dbKey`, which is in the vault. Export on the old one (the export carries `core.dbKey`), copy the folder, then import **before the first start** (a start that finds an encrypted database and no `core.dbKey` stops and says so; it never makes a new key over it) (if the copied vault does not open on the new computer, `reset --confirm` first sets it aside; API keys are then entered again).
- **Downgrading** below next round D1: export **first**, install the older version, copy the export over `<data-dir>/secrets.json`, then start. An older version that finds no `link.identityKey` in `secrets.json` makes a new identity and every phone has to pair again.
- The first start of D1 moves an older folder's identity and VAPID key out of `secrets.json` (and its `.bak`) into the vault; if that fails, nothing changes and the next start tries again. Linux without a Secret Service (or without a D-Bus session, e.g. over SSH) keeps the vault key in a 0600 `vault.key` (marked as degraded); Linux with a Secret Service is tested against `gnome-keyring` in a D-Bus session only, not on a real desktop.

### Column encryption (Phase F2)

- The first start of F2 makes `core.dbKey` in the vault; from then on every conversation, event and memory is written encrypted. Rows from before are encrypted by a background pass (a minute after the start, then hourly, resumed after a restart). 設定 → 資料 → 加密 shows how many rows are left and where the vault key is (keychain, or the 0600 `vault.key` — then the key is effectively next to the database).
- The old backups (and any `state.sqlite.before-restore-*`) still hold plaintext. Once nothing is left, 設定 → 資料 offers 「刪除舊備份並立刻做一份加密備份」 (from a window Alca opened). After that there is no way back to a version older than F2.
- `alca db restore` refuses a backup encrypted with another key. A conversation export (`.alca-export`) is plaintext or passphrase-sealed and does not need the key.

### One conversation: export and import (next round R5.6)

A single conversation goes out to a `.alca-export` file and comes back in as a **new** conversation (never over an existing one; a deleted conversation comes back with a new id).

```sh
pnpm alca export thread <thread id>                     # → ./alca-thread-<id>-<yyyymmdd>.alca-export (0600, never overwrites)
pnpm alca export thread <thread id> --out ~/x.alca-export --passphrase   # asks for a passphrase (≥ 8) twice: sealed for another computer
pnpm alca export thread <thread id> --memories          # also the memories learned in it
# the core must be stopped for an import (it adds a conversation; beside a running core use 設定 → 資料 → 匯入)
pnpm alca import ~/x.alca-export [--passphrase]         # asks for the passphrase when the file is sealed
```

Both take `--data-dir <dir>`. Export works with the core running (through its local API) or stopped (read-only, straight from the database). The passphrase is read from the terminal (or one line of stdin), never from the command line. An unsealed file holds the conversation's full text in plaintext. Not carried: engine sessions (the next turn starts a new one), the audit log (the import writes its own `data.restored` row), connected-app grants and secrets. Events older than the retention period in an imported conversation go at the next hourly prune. In the desktop: the conversation row's 匯出, and 設定 → 資料 (匯出對話 / 匯入對話; importing needs a window Alca opened). The phone has neither (files do not go through the relay). API: `POST /api/export` `{scope: "thread", id, options?: {passphrase?, memories?}}` answers the file; `POST /api/import` `{data: <base64>, passphrase?}` needs the approve key.

## 22. 設定 (P13)

Desktop: the sliders icon in the sidebar footer (or `#open=settings`, `#open=settings:backups` for one area). 團隊權限, 從對話學習, 手機通知 and 模型與供應商 (the default bot's provider and model) first; 進階 has 連線 (site / relay official or self-hosted, Google sign-in, paired devices with 撤銷, the default scopes for newly paired devices — remote control is never a default — 允許配對新裝置, a self-hosted https rendezvous), 瀏覽器 (status, 下載瀏覽器, 需要時自動下載瀏覽器), Telegram, 資料 (what is kept how long — the audit log forever, messages until the conversation is deleted, run / job events and outside content 90 days, 7 daily backups; the hourly sweep's last and next run; 驗證稽核紀錄; the backup list and 現在備份 (runs on the database worker); 事件迴圈｜慢查詢 with 詳細 (slow calls and the busiest statements, never their parameters; thresholds in `engineering.perf`, `ALCA_SQL_TRACE=1` logs every call ≥ 10 ms); 匯出對話 / 匯入對話; restore with `alca db restore`, see § 21. Retention, the daily backup and the hourly audit check run only with the agents clock, not with `--agents direct`) and 關於 (version, data folder, 打開記錄檔資料夾, log level). Changes go to `<data-dir>/config.json`; fields read only at start say 重新啟動 Alca 後生效. Payment / send / delete / publish confirmation is not a setting. API (loopback only): `GET /api/settings`, `PATCH /api/settings` with any of `level`, `learning`, `pushPreview`, `defaultScopes`, `allowPairing`, `rendezvousUrl` (`null` for the default), `logLevel`, `browserAutoDownload`; `GET / POST /api/settings/backups`, `GET /api/settings/data`, `GET /api/settings/perf`, `POST /api/settings/verify`, `GET /api/settings/about`, `POST /api/settings/open-logs`, `POST /api/settings/open-data`. Keys removed in P13 are dropped from an old `config.json` with a warning.

## Options

| Flag                    | Default                                  | Meaning                                                                |
| ----------------------- | ---------------------------------------- | ---------------------------------------------------------------------- |
| `--engine`              | `demo`                                   | `demo` or `claude-code`                                                |
| `--claude-bin`          | `claude`                                 | Command (and leading args) for the CLI                                 |
| `--codex-bin`           | `$ALCA_CODEX` / `codex`                  | Command for the Codex CLI a bot can pick (P9)                          |
| `--workdir`             | `<data>/bots/<id>/work` per bot          | Folder bots without their own 工作資料夾 work in (checked; P13)        |
| `--data-dir`            | `~/.alca` (`$ALCA_DATA_DIR`)             | `state.sqlite`, `secrets.json` (0600), `config.json`, `rules.json`     |
| `--port`                | `4317`                                   | Loopback port                                                          |
| `--host`                | `127.0.0.1`                              | Must be loopback; anything else refuses to start                       |
| `--browser`             | `window`                                 | Alca Browser: `window`, `headless` or `off`                            |
| `--chromium`            | `$ALCA_CHROMIUM` / lookup                | Chromium / Chrome for Testing binary                                   |
| `--no-browser-download` | off                                      | Do not fetch Chrome for Testing on first run when no Chromium is found |
| `--agents`              | `router`                                 | `router` (resident router + workers) or `direct` (one turn)            |
| `--rendezvous`          | `advanced.rendezvousUrl`                 | Alca Link rendezvous (phone + hands); unset = Link off                 |
| `--link-lan`            | off                                      | Also accept Link devices directly on this LAN port (0 = any free)      |
| `--pwa-url`             | the rendezvous                           | Where the phone PWA is served, for the QR link                         |
| `--composio-url`        | `engineering.connectors.composioBaseUrl` | Composio REST base (default `https://backend.composio.dev/api/v3.1`)   |
| `--composio-mock`       | off                                      | Offline: a local Composio stand-in (with `desktop:demo`)               |

`rules.json` (optional) is an array of policy rules, e.g. `[{"id": "no-push", "effect": "deny", "action": "Bash"}]`. A file that cannot be parsed denies everything until fixed (fail closed). The permission level lives in `config.json`: `{"permissions": {"level": "autonomous"}}` (default `confirm_each_step`).

## Screenshots

```sh
# Playwright is not a repo dependency; install it anywhere, plus a CJK font on Linux (fonts-noto-cjk).
# It reuses our Chromium ($ALCA_CHROMIUM or the lookup), so Playwright's own browser download is not needed.
PLAYWRIGHT_MODULE=/path/to/node_modules/playwright ALCA_CHROMIUM=/usr/bin/chromium \
  pnpm screenshots docs/screenshots          # desktop, then phone (ALCA_SHOTS_PHONE=0 skips the phone)
# phone only:
PLAYWRIGHT_MODULE=… ALCA_CHROMIUM=… node --disable-warning=ExperimentalWarning apps/phone-pwa/scripts/screenshot.ts docs/screenshots
# team shots only (P7), desktop and phone:
ALCA_SHOTS_ONLY=team PLAYWRIGHT_MODULE=… ALCA_CHROMIUM=… pnpm screenshots docs/screenshots
# P9 shots only (連線 dialog, bot editor on Codex CLI (a stand-in `codex` on PATH), the phone's reconnect banner):
ALCA_SHOTS_ONLY=p9 PLAYWRIGHT_MODULE=… ALCA_CHROMIUM=… pnpm screenshots docs/screenshots
# P10 shots only (phone: Google sign-in, the account's computers, the number while it waits; desktop: the new-device sheet):
ALCA_SHOTS_ONLY=p10 PLAYWRIGHT_MODULE=… ALCA_CHROMIUM=… pnpm screenshots docs/screenshots
# P11 shots only (模型與供應商 with OpenRouter open, the bot editor's model picker, 新增自訂供應商; fake CLIs + a mock model list, no network):
ALCA_SHOTS_ONLY=p11 PLAYWRIGHT_MODULE=… ALCA_CHROMIUM=… pnpm screenshots docs/screenshots
# 設定 and the conversation list (封存 / 刪除 / 載入更多), desktop only:
ALCA_SHOTS_ONLY=settings PLAYWRIGHT_MODULE=… ALCA_CHROMIUM=… pnpm screenshots docs/screenshots
# Phase 6 worker harness shots only (worker panel, snapshots, bot editor 進階; phone worker cards) — see docs/screenshots/README.md:
PLAYWRIGHT_MODULE=… ALCA_CHROMIUM=… pnpm screenshots:p6
# P8 phone shots only (push prompt, 診斷, a card opened from a notification):
ALCA_SHOTS_ONLY=p8 PLAYWRIGHT_MODULE=… ALCA_CHROMIUM=… node --disable-warning=ExperimentalWarning apps/phone-pwa/scripts/screenshot.ts docs/screenshots
```

These scripts write into the folder you give (`docs/screenshots` by default). Only the images listed in [screenshots/README.md](screenshots/README.md) are committed; that page also covers the 「素 Plain」 review scripts (`shots-plain.ts`) the README images come from.

## Keyboard shortcuts (UI)

`⌘/Ctrl+B` browser panel · `⌘/Ctrl+I` worker panel · `⌘/Ctrl+J` new thread · `⌘/Ctrl+K` search threads · `Alt+↑/↓` switch thread · `/` focus the composer · `Enter` send, `Shift+Enter` newline · `Esc` interrupt · `⌘/Ctrl+Enter` 允許一次 · `⌘/Ctrl+Shift+Backspace` 拒絕 · `1`–`9` pick a question choice · `?` help.
