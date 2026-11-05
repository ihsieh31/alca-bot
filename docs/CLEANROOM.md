# Clean-room rules

Alca Agent learns from public projects at the level of **ideas and architecture patterns**, which are not protected by copyright. We never copy their code, schemas, protocol names, prompt text or branding.

1. **What implementers may read:** only our own plan documents and concept notes (written in our words). Implementers do not open the source trees of the studied projects while writing Alca code.
2. **Our own names:** event types, table and column names, module layout, helper APIs, prompt text and UI copy are named and written by us. Do not reuse other projects' product names or mascots in identifiers, file names, docs or UI.
3. **No restricted code:** source-available directories that are not under an open license are off limits, even for reading.
4. **No pasting:** no snippets from other repositories, gists or answers whose license is unclear. If a third-party library is needed, depend on it through the package manager and keep its license notice.
5. **Attribution:** because nothing is copied, permissive-license attribution duties do not arise. If that ever changes (we vendor a file on purpose), the file keeps its original header and is listed in a `THIRD_PARTY_NOTICES` file in the same PR.
6. **Review:** PRs that add a new subsystem state in the description which concept notes they relied on. Reviewers reject code that looks transliterated from another project.
7. **When in doubt:** write a short design note in our own words first, then implement from the note.

## G1 sources

- SPAKE2 v2 (`packages/link/src/spake2.ts`): written from RFC 9382 itself (protocol flow, transcript, key schedule, the P-256 `M` / `N` constants). The four Appendix B test vectors are copied verbatim into `packages/link/test/fixtures/rfc9382-vectors.ts` as test data, with the RFC named as their source.
- Elliptic-curve group operations: `@noble/curves` (MIT), a dependency through the package manager (rule 4), pinned exactly; the phone build copies its files unchanged with their license (`THIRD_PARTY_NOTICES.md`, rule 5). No noble code was pasted into our sources.

## P1 sources

- Claude Code CLI stream-json interface, `--permission-prompt-tool` and `--resume`: public Anthropic documentation only (CLI reference, "Run Claude Code programmatically", Agent SDK permission docs). The fake CLI in `packages/engines/testing/` was written from those docs.
- MCP stdio server: the public Model Context Protocol specification (JSON-RPC `initialize`, `tools/list`, `tools/call`).
- Everything else in P1 was implemented from our own plan documents.

## P2 sources

- Chrome DevTools Protocol: the public protocol reference (Target, Page, DOM, Accessibility, Input, Runtime domains; `--remote-debugging-pipe` NUL-delimited framing) and Chromium's public notes on the Chrome 136 remote-debugging change.
- Alca Browser concepts (shared browser, Spaces, script mode, `@N` refs bound to real nodes, takeover, layered sensitive-action gates): our own plan v2 §C (written in our words). No studied project's source tree was opened while implementing P2; identifiers, tool names, the snapshot format and the script format are ours.
- Bots as owners: plan v3; `worker_id` reservation: plan v4.

## P2b sources

- MCP stdio server for host tools: the public Model Context Protocol specification (`initialize`, `tools/list`, `tools/call`, `isError`, `instructions`).
- Claude Code CLI `--mcp-config` with several servers, `mcp__<server>__<tool>` naming and `--allowedTools`: public Anthropic CLI documentation only. The fake CLI's new `[mcp:…]` directive was written from those docs.
- Everything else (bridge `/tool` route, call matching, gating path) from our own plan documents.

## P3 sources

- Super-agent concept (a resident router per bot that only talks and dispatches; isolated workers per task; two-stage trigger filtering; stream pass-through; inline vs spill with an id-based recall chain; async start / stop; a watchdog outside the workers): taken at the level of ideas from one public article that describes the approach in prose, restated in our own words in plan v4. No source tree of any studied project was opened while implementing P3; the table and column names (migration 4), the agents channel event types, the router tool names and schemas, the prompt text, the spill summary rule and the watchdog checks are ours.
- Claude Code CLI `--disallowedTools` (removing built-in tools from the router's CLI), several `--mcp-config` servers and `--resume` per worker: public Anthropic CLI documentation only.
- Everything else from our own plan documents.

## P4 sources

- SPAKE2: the public IETF description (RFC 9382) at the level of the protocol idea (blinded Diffie-Hellman shares with two fixed points, a transcript hash). Our instantiation is our own: P-256 via WebCrypto ECDH for the secret scalars, `M` / `N` hashed onto the curve from our own labels (not the RFC's constants), our password-scalar derivation, transcript layout and message names.
- Signed ephemeral Diffie-Hellman for sessions (the SIGMA idea of signing the transcript, not the keys alone): public cryptography literature, restated in our own words. HKDF (RFC 5869), AES-GCM, ECDSA / ECDH P-256 as exposed by the W3C Web Cryptography API; P-256 point arithmetic from the public SEC 1 / NIST curve formulas.
- QR encoder: the public QR code standard's structure (byte mode, Reed–Solomon error correction, masks, format / version information) as described in public references; written from scratch. Tests decode with the system `zbarimg` tool, not a vendored library.
- WebSocket (RFC 6455) server endpoint for the relay and the LAN listener: written from the RFC (clients use the platform `WebSocket`).
- PWA: the public Web App Manifest, Service Worker and IndexedDB specifications and MDN; iOS safe-area insets and home-screen behaviour from Apple's public web documentation.
- Hands daemon, relay matching (nameplates, mailboxes), the phone RPC op table and scopes, the PWA design and all UI copy: our own plan documents (v4 §7 for stateless hands). No source tree of any studied project was opened while implementing P4.

## P5 sources

- Memory and learning concepts (a shared user model plus per-agent notes, provenance on every item, said-outright vs inferred, supersede instead of overwrite, explicit remember / forget commands, a never-learn-again list for what was forgotten, budgeted recall placed in the user message, skills proposed after a task and saved only with the person's approval, a skill never widening permissions): our own plan documents (v4 memory + learning chapter), written in our words. No source tree of any studied project was opened while implementing P5; the table and column names (migration 6), the learning channel event types, the router tools `memory_search` / `skill_load`, the extraction rules, the tombstone scheme, the skill draft format, the prompt text and all UI copy are ours.
- HMAC-SHA-256 (RFC 2104) for the tombstone digests and shingles; the Luhn checksum for card numbers and the public format of Taiwanese national ids for the secret filter: public references.
- SQLite FTS5 (external-content tables, triggers) from the public SQLite documentation; reciprocal rank fusion for the optional hybrid search: the public information-retrieval literature, restated in our words.
- Web Share API (`navigator.share` with files) for the phone export: the public W3C specification and MDN.

## P6 sources

- Composio REST API v3.1 (tool-router sessions, Connect Links, connected accounts, tools search / execute, trigger instances, webhook subscriptions, the V3 webhook envelope and its `webhook-id` / `webhook-timestamp` / `webhook-signature` HMAC-SHA-256 scheme, tool tags): Composio's public documentation (docs.composio.dev), read on 2026-11-03 and restated in our design note. No SDK is used or vendored; the client, the mock server in `packages/connectors/testing/` and every name in them are ours.
- Routines, checks before the model, a read failure that is not "nothing new", the cursor that moves only with the saved result, 提前做 drafts that are used only through a new confirmed request: our own plan documents (v5), in our words. Five-field cron in an IANA zone: the public cron format and the ECMAScript `Intl` API.
- OS secret stores: Apple's public `security(1)` man page and the freedesktop Secret Service / `secret-tool(1)` documentation; AES-GCM through Node's `crypto` (WebCrypto-equivalent primitives).
- No source tree of any studied project was opened while implementing P6; the table and column names (migration 7), the agents channel event types, tool names and schemas, prompt text, the classifier's word lists and all UI copy are ours.

## P7 sources

- OpenAI-compatible chat completions (messages, `tools` / `tool_calls`, SSE streaming with `data:` lines and `[DONE]`, function-call arguments arriving in pieces, `Authorization: Bearer`): the public chat-completions API reference, plus the public docs of OpenRouter, Ollama and LM Studio for their compatible endpoints and default addresses.
- Gemini API (`streamGenerateContent?alt=sse`, `contents` / `parts`, `functionDeclarations`, `functionCall` / `functionResponse`, `x-goog-api-key`, the schema subset it accepts): Google's public Gemini API documentation.
- Team concepts (bot profiles with a role and a lead, ask vs delegate, a peer conversation per request, a chain that never revisits a bot, depth and open-request limits, a delegation that only narrows approval level and app access, a trail of requests and steps, @mention vs delegation): our own plan documents (v5), in our words.
- The local mock server in `packages/engines/testing/` was written from those public docs. No source tree of any studied project was opened while implementing P7; the table and column names (migration 8), the agents channel event types, the peer tool names and schemas, the report tags, prompt text and all UI copy are ours.

## P8 sources

- Web Push: RFC 8030 (Generic Event Delivery Using HTTP Push: `TTL`, `Urgency`, 201 / 404 / 410 / 429 semantics), RFC 8291 (Message Encryption for Web Push: ECDH P-256, HKDF, the `aes128gcm` content coding of RFC 8188; our encryption is checked byte-for-byte against the RFC's example) and RFC 8292 (VAPID: ES256 JWT with `aud`, `exp`, `sub`, the `vapid t=…, k=…` header); the W3C Push API and Notifications API specifications and MDN for `PushManager.subscribe`, `applicationServerKey`, the service worker `push` / `notificationclick` events.
- Apple's public web documentation on Web Push for web apps added to the Home Screen (iOS 16.4+), Home Screen web-app storage and `apple-touch-icon`; Google's public PWA documentation (web.dev) on install prompts (`beforeinstallprompt`), `navigator.storage.persist` and maskable icons.
- Tauri 2: the public documentation at tauri.app (configuration schema, capabilities and permissions, tray icon, window, the single-instance, deep-link and autostart plugins, `tauri build` targets including `universal-apple-darwin`, GitHub Actions prerequisites, and the macOS signing / notarization and Windows signing guides) and the crates' public API docs on docs.rs. Plugin builder options were confirmed against the crates' published source in the local cargo registry, a dependency, not a studied project.
- Service managers: Apple's public `launchd.plist(5)` / `launchctl(1)` man pages, the systemd `systemd.service(5)` / `systemd.exec(5)` / `systemd-analyze(1)` man pages, Microsoft's public Task Scheduler XML schema documentation and `schtasks` reference.
- GitHub Actions: GitHub's public workflow syntax documentation and the READMEs of the actions used (checkout, setup-node, pnpm/action-setup, upload- / download-artifact, dtolnay/rust-toolchain, Swatinem/rust-cache); `gh release create` from the GitHub CLI manual; actionlint and ShellCheck as linters.
- No source tree of any studied project was opened while implementing P8; the payload format `{v, t, id}`, the table and column names (migration 9), the Link push ops, the 診斷 sheet, the service unit / plist / task contents, the shell's supervisor and tray, `install.sh`, `pack-core.ts` and all UI copy are ours.

## P9 sources

- Codex CLI: OpenAI's public Codex CLI documentation and its published `--help` text — `codex exec` (non-interactive mode), `--json` (JSONL events: `thread.started`, `turn.started` / `turn.completed` with usage, `turn.failed`, `item.started` / `item.completed` with `agent_message`, `command_execution`, `file_change`, `mcp_tool_call`, `web_search`, and `error`), `codex exec resume <session id>`, the prompt on stdin, `--sandbox read-only`, approval policy, `-c key=value` config overrides and the `mcp_servers.<name>.command / args / env` configuration of the public config reference. The fake CLI in `packages/engines/testing/` was written from those docs.
- Reconnect and reachability: our own plan documents (v5, P9) for the stable mailbox, the relay `probe`, the self-check and the endpoints list; WebSocket ping / close semantics from RFC 6455; Tailscale's public documentation of `tailscale serve` for the direct-address example in RUNNING.
- Model-based memory extraction: our own design note (propose ≤ 3 items as JSON, verbatim quote of the person's words required, always inferred), in our words; no prompt text from elsewhere.
- Smoke tests: the same public API references as P6 / P7 (Composio REST v3.1, OpenAI-compatible chat completions on OpenRouter, the Gemini API) and the Claude Code / Codex CLI docs.
- No source tree of any studied project was opened while implementing P9; the relay ops (`probe`, `nameplate.reopen`, `ping` / `pong`), the `endpoints` event, `link.json`, the 連線 dialog, the reconnect banner, `CodexEngine` and its event mapping, the extraction prompt and parser, migration 10, the `ALCA_SMOKE_*` variables and all UI copy are ours.

## P10 sources

- Google Identity: Google's public documentation for Google Identity Services on the web (the `google.accounts.id` JavaScript API: `initialize`, `renderButton`, the credential response, `auto_select`, FedCM, the button's branding options and the CSP / COOP notes for the library), "Verify the Google ID token on your server side" (JWKS at `https://www.googleapis.com/oauth2/v3/certs`, `iss`, `aud`, `exp`, `sub` as the stable account id), OAuth 2.0 for Mobile & Desktop Apps / installed apps (loopback IP redirect, PKCE, that a Desktop client's secret is not treated as a secret), the OpenID Connect implicit flow with `response_type=id_token` and `nonce`, and the Google Cloud Console help for OAuth consent screens and client IDs (Web application, Desktop app, authorized JavaScript origins and redirect URIs, test users).
- RFC 8252 (OAuth 2.0 for Native Apps: loopback interface redirection on 127.0.0.1 with a random port, § 7.3, and § 8 security), RFC 7636 (PKCE: S256, verifier length 43–128), RFC 7519 / 7515 (JWT, JWS compact form, RS256 = RSASSA-PKCS1-v1_5 with SHA-256), RFC 7517 (JWK sets), RFC 5869 (HKDF, already used by Link) and RFC 2104 (HMAC) for the account key.
- Short authentication strings with a commitment (a party commits to its ephemeral share before learning the other's, so a man in the middle gets one guess at a 6-digit number): the general construction as described in public protocol literature (e.g. the numeric-comparison idea of Bluetooth Secure Simple Pairing and ZRTP's SAS), in our words; message layout, labels and code are ours.
- Cloudflare Workers / Durable Objects: Cloudflare's public developer documentation (WebSocketPair and `accept()`, `Response` with `webSocket`, Durable Object bindings, `idFromName`, storage `get` / `put` / `list` / `delete`, `blockConcurrencyWhile`, SQLite-backed classes in `[[migrations]] new_sqlite_classes`, `wrangler secret put`, `[vars]`, the 1 MiB WebSocket message limit). Vercel's public documentation for `vercel.json` (`buildCommand`, `installCommand`, `outputDirectory`, `headers`, `rewrites`, `redirects`), monorepo root directories and environment variables.
- The fake Google issuer / OAuth server in `services/rendezvous/test/fake-google.ts` and the GIS stand-in in the screenshot script were written from those public docs. No source tree of any studied project was opened while implementing P10; the relay ops (`computer.register`, `computers.list`, `connect`), the `enroll*` messages and labels, the registry format, the routes, the UI and all copy are ours.

## P11 sources

- Agent Client Protocol: the public specification at agentclientprotocol.com (JSON-RPC 2.0 over stdio; `initialize` with protocol version and capabilities, `session/new` / `session/load`, `session/set_mode`, `session/set_model`, `session/prompt` and its stop reasons, `session/update` notifications for message chunks and tool calls, `session/request_permission` with its options, `session/cancel`, the auth-required error, MCP servers passed in `session/new`); JSON-RPC 2.0 from its public specification. The fake ACP agent in `packages/engines/testing/fake-acp.ts` was written from that spec.
- ACP agents: the public READMEs / docs / `--help` of Gemini CLI (`--experimental-acp`), OpenCode (`opencode acp`, `opencode models`, `opencode auth login`), Qwen Code, Grok CLI, Kimi CLI, Cursor CLI, Factory Droid and Antigravity for binary names, ACP flags, install commands and where logins live; where those were unclear the preset is marked best-guess in PROVIDERS.md.
- Model APIs: the public API references of OpenAI (Responses: `input` items, `function_call` / `function_call_output`, `store`, `reasoning.effort`, streaming events; Chat Completions; `GET /models`), Anthropic (Messages streaming events, `tool_use` / `tool_result`, `input_json_delta`, `x-api-key`, `anthropic-version`, prompt caching, `GET /v1/models`), Google Gemini (`models.list`), OpenRouter (`/models` with `context_length` and `pricing`), and the OpenAI-compatible endpoints documented by Mistral, MiniMax, Cerebras, Groq, DeepSeek, xAI, Together, Fireworks, Ollama and LM Studio (base URLs, key headers, default local ports).
- Model ids, context sizes and capability flags in the catalog are from those vendors' public model pages; prices shown in the UI come only from a live list (the screenshot mock's prices are illustrative).
- No source tree of any studied project was opened while implementing P11; the catalog shape, status names, the mode map, migration 11's tables and columns, the routes, the UI and all copy are ours.

## P14 sources

- The project's own plan document for P14 (written in our words), which describes the concepts at the level of ideas only: optional per-agent features that are off by default and carry a usage cap; proactive suggestions that must come from a concrete new signal, offer one thing at a time and do the homework first; a ledger of what an assistant offered and what the person answered, used to lower the rate of a kind of suggestion the person declines; conversation guidelines (answer first, one question, ask only what changes the next step, no repeated offers, use memory without reciting it); preferences that must be applied for a kind of action; and a second-pass check of a reply before it stands. These are general product ideas found in many assistants and in public writing about assistant design; no other project's code, prompt text, schemas, event names or UI copy were used.
- Scoring weights, the threshold, the add-on registry, table and column names (migration 17), event types (`addon.capped`, `offer.created`, `offer.updated`, `reply.revised`), Link op names, prompt text (the conversation rules and their examples, the candidate, homework, check and rewrite prompts) and all UI copy are ours. The eval scenarios are fictional and contain no real personal data.
- Public documentation used: zod's for the settings schemas; Anthropic's public Claude Code CLI documentation for the opt-in live evals (`-p`, `--model haiku`, `--output-format text`, `--system-prompt`), as in P1.
- No source tree of any studied project was opened while implementing P14.

## Worker harness sources

- **External open-source agent frameworks, at the level of public design concepts only.** The worker harness design (written in our words) compared Alca with publicly documented open-source agent frameworks; they are referred to here only generically as external reference projects. What was taken from them is ideas, not code. The concept categories adopted:
  - **read-before-write version stamps**: edit and overwrite refuse a file that was not read or changed since it was read, apply_patch refuses a stale read and reminds about an unread file, and every write is read back and hash-checked (`core/src/harness/coding/*`);
  - **result hashes against loops**: a repeat is a call whose signature _and_ result hash did not change (`core/src/loop-guard.ts`);
  - **background summary ahead of compaction**: a handover summary prepared before the context is full (`core/src/harness/context.ts`, `agents/harness-run/compact.ts`);
  - **crash reconciliation**: on restart, work that already did something outward is handed to a person, not redone (`agents/harness-run/reconcile.ts`);
  - **a capability matrix**: each engine declares whether its native tools ask before writing or running, and the host checks it before dispatching (`engines/src/harness-matrix.ts`);
  - also: already-applied patch detection, host-run verification after the last change, NEEDS_INPUT instead of a worker asking the person directly, and two harness profiles over one outer layer.
- **All code was written anew.** No code, prompt text, schema, event name, table or column name was copied from any external reference project. The module layout (`harness-run/*`, `harness/*`), the `decideNext` rules, the dispatch ledger (migrations 18 and 19), event kinds (`verify.started`, `verify.result`, `auto_allowed`, …), `WorkerHarness` fields, tool names and descriptions, prompts (繁中 and English) and all UI copy are ours. The eval scenarios are fictional and contain no real personal data.
- **Engines Alca drives.** The Codex app-server driver (`engines/src/codex/app-server/*`) follows Codex's public app-server protocol description; which approval policy asks before what was checked against Codex's open-source code (noted in `engine.ts`), and the driver itself is our own code tested against our own fake app-server. Claude Code flags (`--max-turns`, `--disallowedTools`, stream-json result subtypes) come from Anthropic's public CLI documentation.
- **Libraries** are used through the package manager under their own licenses (QuickJS for `browser_script`, as in Phase 4).
