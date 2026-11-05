# Roadmap

Where Alca stands, what is not verified yet, and what comes next. What changed in each version is in
[CHANGELOG.md](../CHANGELOG.md); how the pieces fit together is in [ARCHITECTURE.md](ARCHITECTURE.md).

## Status

Alca is **pre-1.0 and not yet published as a release**. `v0.2.0` exists as a draft release; everything after it is
on `main` under _Unreleased_ in the changelog. The code is covered by unit, integration and end-to-end tests
(fake engines, a fake Claude Code / Codex CLI, a headless Chromium, a local relay), but large parts have only
been run against those fakes. Expect rough edges on real devices.

## What is built

| Area              | Built                                                                                                                                                                                                                        |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core              | Turn pipeline (8 phases), stable / volatile prompt layers, loop guard, jobs with restart recovery, at-most-once scheduler, startup safety check                                                                              |
| Agents            | One router per bot that talks and dispatches; parallel workers under a `coding` or `general` harness with budgets, host-run verification, an optional reviewer, NEEDS_INPUT questions and a dispatch ledger                  |
| Safety            | One policy gateway (resolve → decide → audit → execute), frozen always-confirm classes (pay, send, delete, publish), approval cards, hash-chained audit log, OS sandbox (Seatbelt / bubblewrap), 完全授權 with git snapshots |
| Engines           | Claude Code CLI, Codex CLI (app-server), OpenAI-compatible / OpenAI Responses / Anthropic / Gemini APIs, ACP, an offline demo engine; MCP host-tool bridge                                                                   |
| Browser           | Alca's own Chromium (Spaces, `@N` snapshots, takeover, sensitive-action gate at the action and network layers, Chrome cookie import)                                                                                         |
| Memory and skills | Memories with source, versions and tombstones; rule- and model-based learning; skills; care moments; 主動留意 (proactive offers) with telemetry and a labeled eval corpus                                                    |
| Apps and routines | Connected apps through the user's own Composio account or their own MCP servers; routines with checks before the model; web search (Brave / Tavily / SearXNG)                                                                |
| Team              | Several bots with their own engines and rules, delegation between them                                                                                                                                                       |
| Phone and devices | Alca Link (PAKE pairing, signed sessions, sealed frames), phone PWA (chat, approvals, offline cache and outbox, WebRTC direct path, Web Push), Google sign-in with a code typed on the computer, `hands` daemon              |
| Desktop and ops   | Loopback web UI (素 Plain design, 繁中 and English), Tauri 2 desktop shell, `alca` CLI, always-on service (launchd / Task Scheduler / systemd), installers, `alca update`, backups, column encryption                        |
| Relay             | Self-hostable Node rendezvous server, or the same protocol on Cloudflare Workers + Durable Objects                                                                                                                           |

## Not verified yet

These parts are written and tested against fakes, but have not been confirmed on real devices or real accounts.
[DEVICE-TEST.md](DEVICE-TEST.md) is the checklist for confirming them by hand.

- iPhone Home Screen app: push notifications, resume, keyboard and safe areas, storage eviction; Android install.
- The desktop shell, the always-on service and the installers on a clean Mac / Windows / Linux machine.
- Signed and notarized releases (the pipeline exists; it needs real signing secrets) and the release signature
  used by `alca update`.
- The Codex app-server protocol against current Codex CLI versions.
- Google sign-in, Composio and MCP servers, and web search providers against the real services.
- The OS sandbox and the browser's network gate on a real macOS install.

## Next

Known gaps, roughly in priority order. Issues and pull requests are welcome on any of them.

1. **Real-device fixes.** Work from the [DEVICE-TEST.md](DEVICE-TEST.md) results, each fix with a regression
   test wherever a headless browser can reproduce it.
2. **First published release.** Follow [RELEASE.md § 3](RELEASE.md#3-draft--published-checklist); then the
   Tauri updater becomes possible. Still open: a bundled core on Windows and cloud-HSM Windows signing.
3. **Key and model failover.** When an API key fails or runs out of quota mid-run, switch to the bot's next
   configured model service and record the switch.
4. **Conversation tools.** Retry the last turn, fork from a message, and search across past conversations.
5. **Local embeddings (opt-in).** A small local embedder so recall and proactive relevance use meaning, not
   only character bigrams.
6. **Declarative hooks.** User hooks (for example, run a command when a worker finishes) behind the policy
   gateway; importing `SKILL.md` skills.
7. **Performance.** Bundle the core at pack time, lazy-load pairing code on the phone, batch streamed deltas.
   See [design/PERFORMANCE.md](design/PERFORMANCE.md).
8. **Harness details.** Per-harness engine and model in the bot editor; card numbers and one-time codes from
   the vault (only passwords today); cross-process file locks for coding tools; remote MCP OAuth; stdio MCP
   servers inside the sandbox.
9. **More reach.** Re-pairing a lost phone from a notification; a cheaper router model as its own setting;
   creating routines from chat or the phone.

## History

Alca was built in phases. Each one is described in the [changelog](../CHANGELOG.md).

| Phase              | What it added                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------- |
| P0                 | Monorepo skeleton, event protocol and JSON Schema, SQLite store, settings schema                        |
| P1                 | Core turn pipeline, Claude Code engine, jobs, policy gateway, desktop chat                              |
| P2 / P2b           | Alca Browser; browser tools for Claude Code                                                             |
| P3                 | Router and workers, triggers, watchdog                                                                  |
| P4                 | Alca Link, phone PWA, `hands` daemon                                                                    |
| P5                 | Memory, learning, skills                                                                                |
| P6                 | Connected apps, routines, 提前做                                                                        |
| P7                 | Team of bots, more engines                                                                              |
| P8                 | Always-on service, Web Push, desktop shell, installers                                                  |
| P9 (`v0.1.0`)      | Stable address, reconnect, Codex, model-based memory extraction, smoke tests                            |
| P10–P12            | Google sign-in for the phone, providers and models, zero-config sign-in                                 |
| P13–P14 (`v0.2.0`) | Evals, Telegram, working folders and undo, phone offline mode, WebRTC, add-ons, 主動留意                |
| Unreleased         | Worker harness, OS sandbox, keychain vault, column encryption, `alca update`, care moments, 素 Plain UI |
