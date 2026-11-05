# Changelog

All notable changes to Alca Agent. Phase details, and what is still unverified, are in [docs/ROADMAP.md](docs/ROADMAP.md).

## Unreleased

### Open-source preparation

- **License: Apache-2.0.** `LICENSE` carries the full Apache License 2.0 text, `NOTICE` names the copyright
  holder, every `package.json` and the desktop shell's `Cargo.toml` say `Apache-2.0` (workspace packages stay
  `private: true` so nothing is published to npm by accident). `THIRD_PARTY_NOTICES.md` now lists every runtime
  dependency the packed core ships and summarises the Tauri crates' licenses; none is GPL / AGPL only (MPL-2.0:
  `mediabunny`, `cssparser`, `selectors`, `dtoa-short`, `option-ext`, used unmodified).
- **README** rewritten in Traditional Chinese (`README.md`) and English (`README.en.md`): what Alca is, features,
  current 「素 Plain」 screenshots, an architecture diagram, the repository layout, installation per OS, phone
  pairing, providers and models, development and the checks a pull request must pass. `docs/README.md` indexes
  the documentation.
- **Docs tidied for outside contributors**: internal agent handoff notes, device-test reports and review notes
  are removed; the lasting performance decisions moved to `docs/design/PERFORMANCE.md`; `docs/ROADMAP.md` is a
  public roadmap (what is built, what is not verified, what comes next); `docs/DEVICE-TEST.md` is a manual test
  checklist for contributors; `CONTRIBUTING.md` accepts contributions under Apache-2.0.
- **Stored files**: the 87 screenshots of the earlier UI are replaced by 7 current ones (`docs/` 28 MB → about
  1 MB); a stray tarball at the root is gone; eval reports and local screenshot runs are git-ignored;
  `pnpm evals:live` writes into `evals-report/live/`.
- **Privacy**: demo seeds, screenshot scripts and tests use fictional names, emails and places only.

### Care moments (`docs/design/CARE-MOMENTS.md`)

- **Alca can say one right line at the right moment, and stays quiet otherwise.** When the person is leaving (晚安 / 先這樣 / good night) or an exchange ends on its own (「不用」, 「這樣就好」, putting an offer off), and a dated personal event of theirs is close (an exam, interview, trip, birthday … within 72 hours), the router's turn context carries an `<alca:moment>` block with that one item and a short rule: confirm what is handled, at most one warm line, no question, no new offer, never say how it knows. On every other turn there is no block; the stable system prompt is unchanged. It is a pipeline, not a prompt:
  - **capture**: dated life events become `life:<category>:<name>` memories with the absolute local day/time and zone resolved when heard (「後天」 never goes stale); a move supersedes, a cancellation takes it off the timeline; questions, wishes, past events and deadlines are not events (`@alca/memory` `life.ts`, `resolveDay`);
  - **situation** and **decision** by code: local time, closing intent (zh/en), end of exchange, still here after good night, mid-task, session length, heavy tone, language; hard gates, then `importance × proximity × moment × feedback weight` against a threshold, at most one item, a fixed reason word per decision;
  - **post-check** on the reply: a line about an item not chosen, a second care line, naming the source, or a question / offer after a goodbye is removed (`reply.revised`, before 回覆檢查);
  - **feedback**: the next message is the reaction (positive / ignored / 別再提); weights per category, `suppress:care*` rules the person owns, `CareMoments.metrics()` (precision, quiet reasons).
- **Migration 32**: `care_log` (decisions, shown lines, mentions, reactions; ids, category and reason words, numbers only — no content); erased with its thread, kept 90 days.
- **Evals**: a labeled corpus of 24 fictional cases (7 should speak, 17 should not: mid-task, quick questions, daytime acknowledgements, already mentioned, said elsewhere, second goodbye, heavy, suppressed, too far, medical …) through the real pipeline in an obedient and a "tempted" model mode, gated at recall 1 and zero false care lines (vitest and `pnpm evals --filter care`); four `evals:live` cases.
- **Review fixes**: the post-check keeps 「你要我改的…都改好了」 (a bare 「要我」 is an offer only as a question), finds a trailing offer behind blank lines, keeps a plain report about an item discussed earlier in the thread, never cuts a fenced code block, and splits Chinese so 「！？」 runs and closing quotes stay with their sentence; memory off writes nothing (no suppression rule, no cancellation note); 只用自己的筆記 reads only the bot's own events; editing a life event in the memory page moves its `due_at` (free text without a day takes it off the timeline).
- Assistant messages are now stamped with the turn's clock (was the wall clock), so a thread's order holds under a test clock.

### Harness and 主動留意 accuracy (gap analysis 2026-11)

- **The calendar read asks for the upcoming window** (P1): 主動留意's calendar source and a routine's calendar poll call `GOOGLECALENDAR_EVENTS_LIST` with `timeMin` = now, `timeMax` = now + 14 days, `singleEvents: true` and `orderBy: "startTime"` (`pollArguments` in `@alca/connectors`). Without them Google's `events.list` returns events from the start of the calendar in an unspecified order, so the 20 items read were almost always past events and dropped — calendar cards were close to impossible. A routine's own arguments still win; a `syncToken` call gets no window. The reader also says whether its answer was the whole window (no full page, no next page).

- **A failed candidate call no longer loses the evidence** (P2): 主動留意 moved its source cursors before the candidate completion, so a timeout or an error meant that mail / event / deadline was never looked at again. The cursors now move only after a parsed answer (an empty list counts); a throw or an answer that is not the JSON asked for is `model_failed`, keeps the evidence for the next scan, and doubles the scan interval (up to 8×). After 3 failures in a row the evidence is let go, so a broken model cannot spend every scan on it.
- **Runner-up candidates are kept** (P3): the 2nd and 3rd candidates that pass the threshold (already paid for) wait in a short queue in the add-on's state (24 h, or until due) and become cards when no homework is running, re-scored first (no model call). The volume rules still apply (they queue as cards when the window is closed).

- **Items are re-scored as they come due** (P4): a dated candidate that scored under the threshold only because it was far off (a deadline seen 10 days out) used to be "seen" forever. It is now watched and re-scored with no model call 3 days, 1 day and 6 hours before it is due, and becomes a card the first time it passes. A calendar event's evidence id carries its `updated` time (`cal:<id>@<updated>`), so a moved or edited event is new evidence and goes through the candidate step again; cancelled events are skipped. Upgrading: each upcoming event is looked at once more (its id gained a version); a card already made for it is still recognised by its old id.

- **A queued card is checked again before it is shown, and one matter is one card** (P8, P9, P10): before a queued card is shown, a suppress rule written since, its evidence gone from the source's last _complete_ read (a cancelled event, a forgotten deadline, an approval already answered, a routine that recovered), a moved event (`changed`), or a card about the same matter already shown or answered makes it expire instead. New candidates get the same checks (`duplicate` / `gone` / `changed` score reasons), against this add-on's cards of the last 14 days (expired unseen ones do not count) and against each other in one scan — a calendar event and its invitation mail become one card. "Same matter" compares the facts' key words (common time / filler / proposal words removed, `STOP_GRAMS`) and, when both are dated, needs them within 36 hours. A read that may be cut off (a full page) proves nothing. Mail is not judged by presence (an unread mail that was opened is not handled); whether the person replied needs a thread read and is a follow-up.

- **Less mail noise, stricter relevance** (P5, P6, P7): 主動留意's Gmail read searches `is:unread in:inbox -category:promotions -category:social -category:forums` (routines keep their plain `is:unread in:inbox`), and mail labelled promotions / social / forums / spam is dropped in code too. `category:updates` stays in on purpose (bills, statements, shipping): that mail and mail from no-reply / newsletter / marketing senders is marked 大量寄送 for the candidate step and scores 0 (`bulk`) when it reads as a promotion (特價 / 優惠 / 限時 / sale …) or, unless it is about money, when it has nothing in common with what Alca knows about the person. Relevance ignores common words (明天, 時間, 報告的「要我…嗎」 frame, `STOP_GRAMS`) and needs 3 key words in common for full marks (2 → half): 「明天要上課」 no longer makes 「明天特價」 relevant.

- **主動留意 is measured** (P14): every candidate a scan (or a queue re-score) looks at is a row in the new `proactive_candidates` table (**migration 29**): its score parts, which kinds of source it cited, its drop reason (`below_threshold`, `duplicate`, `bulk`, `gone`, `suppressed` …), what became of it (`offered` / `queued` / `homework` / `runner_up` / `watch` / `dropped` / `revalidated_out`) and the card it made. No content is stored (no fact, action or evidence id), so it is not a sealed table; rows are kept 90 days. `GET /api/bots/:id/addons` (and the Link op `team.bots.addons.list`) now carries `metrics` on 主動留意: cards, shown, accepted / declined / ignored / expired counts and `acceptRate` / `dismissRate` / `ignoredRate` over the last 30 days (over decided cards; null until there is one), candidates per outcome and per drop reason. The settings screens do not show it yet.

- **A labeled 主動留意 corpus with CI gates** (§4.6): `packages/evals` has 39 fictional cases (should surface, should stay quiet, near-due escalation, dedupe, quiet hours and the daily maximum, suppress rules, cancelled / moved before shown, promotional and bulk mail, model failure) run through the real pipeline with a scripted candidate step (no live model). Each piece of evidence belongs to a labeled matter; precision, recall, F1, false interrupts and duplicates are computed over the corpus and gated in the normal vitest run (`packages/evals/test/proactive-precision.test.ts`: precision ≥ 0.9, recall ≥ 0.8, 0 false interrupts, 0 duplicates) and in `pnpm evals` (`proactive.precision-corpus`). Today: precision 1, recall 1 (with the bulk check or the pre-show revalidation removed, precision drops to 0.79 and the gate fails). The corpus also moved relevance: one shared key bigram is half relevance (a two-character name such as 東京 is one bigram), three is full.

- **Codex without the retired `untrusted` approval policy** (gap #3): Codex removed `approval_policy = "untrusted"` (openai/codex#39630, Aug 2026; a current CLI refuses it — CLI 0.149 per reports). Alca's non-full-access Codex coding engine sent it. When `thread/start` / `thread/resume` / `turn/start` refuses the policy, the engine now switches to `on-request` for the rest of its life and ends that turn with `engine.codex_untrusted_retired` (not retryable; nothing ran) saying why and what to do; its harness row becomes `codexAppServerOnRequest`, so Alca's own gate refuses Codex coding below 完全授權 with that sentence, and at 完全授權 it runs with a git snapshot before every turn (as before). If `on-request` is refused too (e.g. a managed `requirements.toml`), the turn ends with `engine.codex_policy_rejected` naming the policy. An older CLI that still takes `untrusted` is unchanged. Not verified against a real Codex CLI (fake app-server only; DEVICE-TEST U4-3).

- **Codex's policy is checked before the first turn** (item 5): when a bot's Codex engines are made, a short-lived `codex app-server` is asked once whether it takes `untrusted` (`thread/start` on an ephemeral thread in Alca's own CODEX_HOME; no turn, no model call). A refusal switches the coding engine to `on-request` right away, so the coding fit check gives the reason before anything is dispatched and the core log has one warning; no coding turn has to fail first. A CLI that cannot start, or answers with another error, changes nothing (the first turn still handles it).

- **Idle CLI processes are stopped** (gap #10): Claude Code and the Codex app-server kept one process per conversation (each thread, router and worker) until Alca exited. A conversation whose process has sat idle for 10 minutes with no turn running now has it stopped; its next turn starts a new one and resumes the stored session (`--resume` / `thread/resume`). `ALCA_ENGINE_IDLE_MINUTES` changes the limit (`0` keeps them). The sweep timer never keeps the core alive and stops with the engine.

- **An offer's text and action are sealed** (item 4, **migration 30**): 主動留意 writes its cards from mail and calendar facts, so `offers.text` / `action` are now sealed columns like a message (written sealed, read through the store). `seal_gate` gains an `offers` row and the "an offer is not rewritten" trigger lets the background pass turn plaintext into the sealed form only; the pass runs again over the offers already stored, and backups taken until it finishes count as plaintext (設定 → 資料). The category and the evidence ids stay plain (`topic` was sealed too by migration 31, below).

- **A router on an API model no longer forgets the start of a long conversation silently** (gap #9): the HTTP engines (OpenAI-compatible, OpenAI Responses, Anthropic, Gemini) kept the last 80 messages and dropped the rest. Now what is cut goes into a rolling summary at the head of the stored history — a user message (`[Alca: summary of earlier messages in this conversation]`) plus a one-word assistant reply, so every API's turn order holds and the stable system layer (prompt cache) is untouched; each later cut folds the previous summary in. It is deterministic (no extra model call): what the person stated that reads as a standing fact (names, dates, amounts, allergies, preferences, 記得 / 不要 …) is pinned across every cut (16 lines), the rest is one short line per dropped message (24 lines, 3,000 characters at most). Tool results (web pages, files) never go in. The history is also bounded by size (about 240,000 serialized characters), and a cut always starts on a real user turn. A model-written summary is a follow-up.

### Fixes from the code review of 2026-11-05 (`fix/device-report-2026-11-05` vs `f943c2f`)

- **Deleting a conversation deletes its offers** (#1): `scrubThread` (and so a backup scrub) now deletes the thread's `offers` rows and unlinks their `proactive_candidates` rows, so a card from a deleted thread is no longer pending or answerable (「好」 used to start a worker in the deleted thread). Decided offers are pruned after 90 days.
- **No candidate words left in plaintext** (#2, #3, **migration 31**): `offers.topic` (a literal 30-character prefix of the sealed action) and `bot_addons.state_json` (主動留意's queue and homework, up to 31 candidates with fact and action) are sealed columns now; 別再提這類 matches on the opened topic. The background pass seals what is already stored; backups taken until it finishes count as plaintext.
- **A session that will not resume is said, not hidden** (#4): when Claude Code's `--resume` finds no conversation or Codex's `thread/resume` fails, the stored session is forgotten, the turn runs in a fresh one, and the timeline gets a notice in the bot's language ("The earlier context could not be restored …"). Idle reaping made resumes common, so this used to be silent context loss after every 10 idle minutes (Codex) or a failure on every later turn (Claude).
- **The SSE buffer cap starts after the initial replay** (#5): a client whose replay was over 4 MB was cut before it could read anything and reconnected into the same cut, forever.
- **Connector calls run only as the slug's own toolkit** (#6): `execute` / `readRaw` require the account's toolkit to be the slug's (`GITHUB_CREATE_ISSUE` with only an MCP server `github` is `no_account` again, not a call to that server). The forgiving app match (toolkit / MCP id / name / label) applies only to the model-supplied `app` of `connector_find_tool`.
- **主動留意 presence and versions** (#7, #8, #9): queued calendar cards from before the versioned ids stay present instead of expiring as "gone"; calendar evidence is versioned on start / end / status (a hash), not `updated`, so an RSVP or a description edit no longer re-runs the paid candidate step; a presence list cut at 500 ids counts as incomplete.
- **Link sees device rows written by another connection** (#10): the device revision folds in `PRAGMA data_version`, so a restore, an import or a second store on the file revokes a removed phone without a restart.
- **Codex policy handling is narrower and gentler** (#11, #12, #13): a refusal counts as the retired `untrusted` policy only with approval-policy context (an "untrusted project" message no longer downgrades the engine); the policy probe no longer kills a process whose first turn is still setting up, and its refusal names the policy it sent; a new Claude Code launch for a key waits until its released process has exited, so two CLIs never write one session.
- **API-model history stays user-first** (#14): when a long tool loop leaves no user turn to cut on, the trim no longer starts on an assistant message (a permanent 400 on Anthropic): a user message with the summary of what was dropped goes in front. The summary pair's reply is recognised only by its exact text (`OK.`), so a tool call after a summary is never mistaken for it.
- **The honesty note is quieter and speaks the reply's language** (#15): an English reply counts as a done claim only when it claims the work as a whole ("it's done", "all done", "I've completed …", "successfully finished") in a sentence that reports no failure — "the worker finished, but the build failed" and "3 of 5 steps completed" no longer get a note. The note is in English when the reply is.
- **The compile cache moved out of the shared temp dir** (#16): it is `<data>/cache/compile` (0700, the data folder 0700), not `os.tmpdir()/node-compile-cache`, where another account on the computer could plant code cache. `$NODE_COMPILE_CACHE` still wins and `NODE_DISABLE_COMPILE_CACHE=1` still turns it off.
- **No mail words in a homework worker's title**: 主動留意's read-only homework worker was titled 「主動留意：<the fact>」, and `workers.title` is not sealed. It is now 「主動留意・<category>」 (e.g. 主動留意・讀書); the fact is only in the sealed goal.

### Fixes from the Mac device test of 2026-11-05

- **A new data folder no longer uses the shared `vault-key` keychain item** (BUG-1, P4/M6/F4c). The old shared item is read only for a folder that already has a vault (`vault.json` or its `.bak`); once that vault opens with it, the same key is saved to the folder's own `vault-key-<12 hex>` item, read back, and used from then on, so the shared item is never written. A brand-new folder creates its own item on the first save.
- **`alca secrets import` into a folder that does not exist yet works** (BUG-2, P6): the folder is created owner-only (0700, its files 0600) before the vault is written, instead of failing with `ENOENT … .vault.json.<pid>.tmp`.
- **MCP servers and connected apps work from Claude Code bots** (BUG-3, Q2): `connector_find_tool`'s `app` accepts the toolkit (`mcp-fs`), the MCP server id (`fs`), the shown name or the account label, and `connector_accounts` prints the exact `app=` value; the general harness offers `connector_accounts` / `connector_find_tool` / `connector_use_tool` directly (they were only in the lazy catalog, so a CLI worker calling them by name got "No such tool available"), and `tool_search` also searches the connected apps and MCP servers. A dispatch whose goal names a connected app or MCP is general even when it is about files (the heuristic sent it to a coding worker, which has no connector tools); the router's harness rule says so in both languages.
- **No message text or worker goal in plaintext in `jobs`** (BUG-4, F1-4): a turn job's title is the fixed word `turn` (it was the first 80 characters of the message), a worker's job no longer copies the worker's title or its goal (up to 4,000 characters; `workers.goal` is sealed), and `jobs.title` / `input` / `result` are sealed columns read and written only through the store (`insertJobRow`, `jobRow`, `jobRows`, `setJobResult`). **Migration 28** replaces the copies already stored and makes the background pass walk `jobs` again; backups taken until it finishes count as plaintext (設定 → 資料). The settings text now says that only the short titles of chats and workers stay unencrypted.
- **Worker questions are tidied by the host** (BUG-6, BUG-13, O3b/O7): a question's own leading number (「1. 」「2、」「(1)」「Q1:」) is taken off, so the panels no longer show 「1. 1.」; a recommended mark with more words (「（推薦，選擇最多）」「(recommended: …)」, or a trailing 「 建議」) is recognised, and the option carrying it is moved first and the mark removed. The live eval `needs-input.options-recommended-first` judges the question that offers the two venues instead of `questions[0]`.
- **Replies follow the language of the person's latest message** (BUG-5, T7): the opening lines of every prompt said 「預設使用繁體中文回覆」 even for a bot set to English; they now have an English copy, and both say to reply in the language of the latest message (the bot's language only when that is unclear), relayed worker results included. The English router prompt has no Chinese line left. New live case `language.follows-latest-message` (13 cases in `pnpm evals:live`).
- **Token budgets hold on Claude Code** (N4, N7): the Claude Code stream parser books each model message's usage as it arrives (`assistant` lines, `message_start` / `message_delta` stream events; per message id, so a message streamed in several lines counts once) and books from the turn's `result` only what those did not, so a worker's token budget stops a long CLI turn while it runs instead of at its end (主動留意's homework went to 74,026 tokens against a 30,000 daily cap). A worker whose booked tokens already reached its budget ends on `budget` without the report-only pass (that pass is a model call too). Add-on completions (回覆檢查, 主動留意's candidates) add up every usage reading of the turn (Claude Code per message, Codex app-server in deltas; only the last one was kept) and never book 0: a turn with no reading, or one cut off by the check's timeout before the engine answered, is estimated from the prompt.
- **An unverified worker is not relayed as done** (O5b): the report the router reads carries a verdict line under the tag, 「結果：未驗證（unverified）：…。不是完成（not done）。」 (or 只做了一部分／卡住了／在等使用者回答／最後一個步驟失敗／已停止), and the closing line for `unverified` says to tell the person it was changed but not checked; the router rule names 未驗證 and asks for each worker separately; the 「Alca 註記」 also catches 都做了／做好了／處理好了 and English claims (「done」「completed」「finished」, unless negated). The desktop card does not show the verdict line (its status word already says it).
- **A data-folder read Claude Code refused itself is told in Alca's words and is not a breach** (M2): Claude Code's deny rules refuse a Read / Edit / Grep / Glob of Alca's data folder before the permission tool is asked; the timeline now says 「Alca 的資料夾（…）bot 不能讀寫：<path>」 with the CLI's words in brackets, and the turn goes on (it was stopped as 「引擎沒有經過確認就執行了」 although nothing ran). A failed shell command on the data folder is still a breach (it may have run). The model itself still reads the CLI's message: hooks stay off, so Alca cannot give the CLI another reason.
- **Docs**: the shell's binary is `alca-desktop-shell` (DEVICE-TEST M5 said `alca_desktop_shell`); DEVICE-TEST M10 accepts 「卡住了」／需要你確認 as well as 「沒有完成」 for a browser that did not start (a harness worker that reports `blocked` is `needs_review` by design, B6); T3 says the `pnpm alca` command line is 繁中 only and only the shell follows `LANG`.

### Google direct removed (Gmail / Calendar through Composio only)

- **Gmail and Google Calendar are read only through Composio.** Next round D3's Google direct (Gmail / Calendar with your own OAuth client, 追加權限, polled 收件匣有新信 triggers, the Google card under 連接 › 直接連線與 MCP) is removed at the owner's choice.
- **Upgrading**: migration 27 disconnects any Google-direct account (grants deleted, its triggers off) and the desktop deletes its refresh tokens from the vault at start; remove Alca at myaccount.google.com/permissions to end the grant at Google.
- Unchanged: Composio, MCP servers (stdio / Streamable HTTP), web search, `web_fetch`, and 用 Google 帳號啟用遠端 (`engineering.google` is still its client).

### Pairing: PAKE v1 removed (G1 follow-up)

- **Pairing protocol v1 is removed** from the computer, the link library, the phone page and the hands daemon: pairing and Google-account enrollment run PAKE v2 (RFC 9382 with key confirmation) only. The v1 code (`pake.ts`, `p256.ts`, `hashToPoint`, the v1 branches of `handshake.ts` / `enroll.ts`) is gone; a frozen copy stays under `packages/link/test/fixtures/v1/` only so the tests can play an old peer. A grep guard test keeps it out of shipped code.
- **No setting brings it back**: `engineering.link.pakeV1` (and the link library's `allowPakeV1`) is removed. An old `config.json` that still has `engineering.link` opens with a warning and the key is dropped.
- A phone page, Home Screen app or computer that offers only v1 (or no `pk`) gets `upgrade_required` on the same refusal path as before: nothing is stored, the phone page says 「請更新後重新配對」, the computer's 手機與裝置 dialog says an old phone was refused and has to update and pair again, and each refusal is audited (`link.pair` / `link.enroll`, decision `deny`, `refused: "pake_v1"`; `detail.legacy` is gone). A new phone that meets a v1-only computer stops with `downgrade` and asks to update the computer.
- **Devices set up with `v0.2.0` must update and pair again.** Devices already paired keep reconnecting: the session handshake never ran a PAKE and is unchanged (`LINK_VERSION` 1); no stored key came from v1 (docs/RELEASE.md § 5).
- The QR still carries `pk=2` and the wire keeps the `pk` list, for negotiating a later version.

### OS sandbox and browser channels (next round Phase C)

- **Model commands run in the OS sandbox** at 自主 and 完全授權 (per bot: 自動 / 一律開 / 關; network 可連網 by default or 不連網): writes only in the work folder, its temp folder and package caches; Alca's data folder and the home folder's secrets unreadable; `.git/config`, `.git/hooks` and engine configuration not writable even inside the folder. macOS Seatbelt, Linux bubblewrap; Claude Code's own Bash sandbox, Codex's writable roots, ACP agents wrapped whole. No sandbox on this computer: the work still runs with a warning on the worker panel (desktop and phone) and an audit row; 一律開 refuses. `unsandboxed: true` asks at every level. Loosening needs the approve key; the phone only tightens. Migration 22 (`bots.sandbox`).
- **Alca's own git is hardened** (snapshots, reviewer): no fsmonitor, hooks, ssh command, external diff, textconv or pager from a work folder's config.
- **Browser channels (R3)**: Space tabs bypass service workers and a Space's service / shared workers are gated before they run; WebRTC is refused in agent tabs (and Chromium starts with `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`, which on its own did not stop a loopback connection in CI); a WebSocket frame that looks like a payment / send / delete / publish the step was not granted stops the tab (`about:blank`) with a notice that it **may already have happened** and an audit row `browser.channel.stopped` — the first frame cannot be held; two stops on a host stop its sockets as they open.
- Evals `harness.coding.sandbox-write-outside`, `harness.coding.sandbox-fsmonitor`; DEVICE-TEST § R (9 Mac checks).

### Releases: install.ps1, alca update, signing pipeline (next round Phase E)

- **Windows core installer `scripts/install.ps1`** (also a release file): the same release files and rules as `install.sh` — a version tag (a draft is never "latest": it says to add `--version`), SHA-256 required, `gh` for a private repo, Node ≥ 22.18, Task Scheduler. The packed core's symlinks are listed in `ALCA_LINKS.json` and laid as junctions (no Developer Mode, no administrator). Checked on Windows PowerShell 5.1 by the new `install-windows` workflow.
- **`alca update check | install | rollback | status`** for cores installed by the scripts. A daily check from the hourly maintenance slot only notifies (設定 → 關於, 檢查更新); installing asks first, backs up `state.sqlite`, keeps `app.prev`, restarts the service and rolls back by itself when the new version does not answer. `engineering.updates` (`check: notify|off`, `channel: stable|prerelease`).
- **Release signature**: `SHA256SUMS` over every release file, signed (Ed25519) when `ALCA_RELEASE_SIGNING_KEY` is set; the packed core carries the public key (`ALCA_RELEASE_PUBLIC_KEY`) and then accepts only signed updates.
- **release.yml**: notarizes and staples the `.dmg` (notarytool) and checks App and `.dmg` with Gatekeeper; Windows Authenticode with a `.pfx` (`WINDOWS_CERTIFICATE`), checked `Valid`; each platform's signing state in the job summary and the release notes; still a draft only, and a missing secret still never fails the run.
- **docs/RELEASE.md**: what the owner prepares (Apple Developer, certificates, every secret), the draft → published checklist, the checks before going public (`scripts/pre-public-check.sh`: names, deploy values, gitleaks over the whole history), the `pakeV1` transition (decided: deny; v1 since removed).

### The core's keys in the keychain-backed vault (next round Phase D1)

- **The Link identity and the VAPID key move from `secrets.json` into the sealed vault** (whose key is in the macOS Keychain or the Secret Service) on the first start; `secrets.json` and its `.bak` keep only the loopback token. A failed move changes nothing and is retried; a vault that does not open never leads to a new identity.
- **Before downgrading to an older version, run `alca secrets export --to-file <file> --confirm`** and copy that file over `secrets.json`: an older version that finds no identity in `secrets.json` makes a new one (every phone would have to pair again). There is no plaintext copy kept for downgrades.
- **The vault key's fall back to a 0600 file is shown**: the start log and `alca secrets status` say where the key is and why (forced, no keychain, the keychain's own error). The keychain item is now created on the first start.
- **`alca secrets export | import`** for moving computers; `alca secrets reset` keeps API keys and the future data key.
- `@alca/os`: `ensureDataKey` / `getDataKey` / `rotateDataKey` / `deriveSubkey` (the data key Phase F2 will use), `Vault.readBack` / `setMany` / `deleteMany` / `keyStatus`; `openDataDir` is async and makes the folder's one vault.

### Data retention and the audit check (next round Phase B)

- **Retention** (hourly, in the agents sweep's existing slot): `run_events` of finished runs and `job_events` of finished jobs after 90 days; trigger events, spills, watchdog and peer events, routine runs (newest 20 per routine kept) after 90 days; the audit log forever. Settings `engineering.retention`.
- **Deleting a conversation now deletes its `run_events`, `job_events`, spills and inbox rows** (before, its run log stayed).
- **Migration 21**: `retention_gate`; the append-only tables delete only through an open gate (≥ 7 days old, finished owner) or a deleted conversation — enforced by triggers. `audit_log` is unchanged (never deleted).
- **`secure_delete = ON`**, an hourly `wal_checkpoint(TRUNCATE)`, weekly incremental vacuum, and a one-time switch to `auto_vacuum = INCREMENTAL` (files up to 500 MB; `alca db compact` for larger ones).
- **Daily backups**, 7 kept, counted apart from the five migration / manual backups.
- **`alca db verify`** and 設定 → 資料 → 驗證稽核紀錄: one streaming verifier with an outside anchor (`audit.anchor`) that also catches a cut-off tail or a restored older backup; the hourly sweep checks the new rows and sends `system.alert` once on a failure.

### Worker harness — coding / general harnesses

- **Two layers.** Every worker runs under a `coding` or `general` harness. Alca always owns the outer layer (dispatch contract, budget, gate, host verification, "what it did" from events, NEEDS_INPUT, ledger, reviewer); an API-key engine runs Alca's own loop with coding or general tools, a subscription CLI keeps its native loop with permission requests sent to Alca's gate.
- **Capability check before work starts**: each engine declares what it can do (`engines/src/harness-matrix.ts`); `checkHarnessFit` refuses a dispatch an engine cannot do safely and tells the router in a sentence. Claude Code gets one instance per harness (`--max-turns` as a backstop); Codex gets an app-server driver; ACP coding stays in the agent's asking mode.
- **Host verification**: after the last file change a fresh green check is needed before a coding task counts as done (dispatch `checks`, AGENTS.md / CLAUDE.md, or the project's own scripts); three red rounds end as `unverified`. Optional independent reviewer per bot (off by default).
- **Coding tools for API engines**: read, edit, write, apply_patch (already-applied detection, read-back hash, stale-read check, non-UTF-8 files refused, mixed line endings kept), grep / glob, bash sessions (pipefail, background, process-group cleanup, filtered environment), todo; AGENTS.md loaded in layers.
- **General tools**: `web_fetch` (public addresses only), `await_event` / `list_waits`, `browser_script` gains hover / setChecked / css, vault passwords on `https` exact-origin pages; 主動留意, 提前做 and routines run on the general harness.
- **NEEDS_INPUT**: 1–3 questions with a recommended option; person-only questions; the router answers with `worker_answer` when allowed; you answer from the desktop worker panel or the phone; text questions expire after 72 h.
- **One set of stop rules** in LoopGuard (call signature + result hash), compaction between passes with a summary prepared ahead, a stop after three stalled turns, restart reconcile that never redoes an outward action.
- **完全授權** per bot (desktop only, warning + second confirmation; the phone can only turn it off): file changes, commands, plain `git push` and file deletes run without a card; payments and outward sends still ask. Every auto-allowed call is audited (`auto_allowed`). Git snapshots before each coding turn, restorable and purgeable from the worker panel.
- **Security fix**: shell-running tools of every name (`shell`, `hands_run`, …) are classified by their command, so `git push` through them asks as a publish.
- **UI**: worker panel (harness, phase, checks, budget, questions, reviewer gaps, 完全授權 log, snapshots), bot editor 進階 (default harness, reviewer, budget caps, 完全授權), phone worker sheet with answers.
- **Protocol**: optional `WorkerState.harness`; `POST /api/workers/:id/answer`, `GET /api/snapshots`, `POST /api/snapshots/restore` / `purge`; Link `workers.answer` (approve).
- **Migration 18**: `bots.harness`, `dispatches` (writer fence), append-only `dispatch_events`, `harness_waits`. **Migration 19**: `bots.full_access`, `git_snapshots`.
- **Evals**: 31 offline harness scenarios; `pnpm evals:live --harness` (haiku, by hand only).
- Unverified on real devices: Claude Code `--max-turns`, the Codex app-server (no Codex available), coding tools with a real API model. Docs: ARCHITECTURE, PROTOCOL, ROADMAP (known gaps), SECURITY, DEVICE-TEST § O, CLEANROOM.

### P14 — add-ons (擴充), 主動留意, conversations that use memory

- **Built-in add-ons per bot** (`00ab65a`): a static registry — 主動留意, 回覆檢查, and 提前做 / 小模型審 shell shown as add-ons over their P13 settings. Off by default; each bot turns its own on; settings checked by each add-on's schema; daily token / run caps per bot and local day (`addon.capped`, 「今天的額度用完了」). Desktop bot editor → 擴充; the phone bot sheet lists them with today's usage. Migration 17 (`bot_addons`, `addon_usage`, `offers`, `memories.applies_to`, `memories.due_at`).
- **Conversation rules for every bot** (`60e6be1`): answer first, one question at a time, ask late, consequences before anything irreversible, change direction after two refusals, at most one doable offer (none after a goodbye), no repeated offers, memory without show-off — 繁中 / English, in the cached stable layer.
- **Must-follow preferences** (`aacd09d`): 「寫信不要提到 X」「買東西一律選可退款」 apply whenever the bot does that kind of action, shown as 已套用 on the approval card.
- **Offer ledger** (`e950efa`): what a bot offered at the end of a reply and what you said; declined offers are not repeated in that conversation.
- **主動留意** (`d910d90`): when something concrete is new (a deadline you mentioned, a calendar item, mail, a failing routine), the bot looks it up read-only and offers one thing — 好 / 先不用 / 別再提這類 — in its 主動留意 conversation, the desktop card strip and the phone's 待處理. Nothing new costs nothing; quiet hours, a daily count and a minimum gap apply; it never sends anything itself.
- **回覆檢查** (`429e5bc`, `8903411`): checks each router reply and rewrites it once when it breaks a rule; the revised reply replaces the original on desktop and phone, marked 已修改. Pick which model does the check per bot (default: the bot's own router model) — a small, cheap one works.
- **Evals** (`dd3a87b`, `783c324`): 41 new fictional scenarios; `pnpm evals:live` (haiku only, by hand, never in CI).
- Docs: ARCHITECTURE, PROTOCOL (`addon.capped`, `offer.created` / `offer.updated`, `reply.revised`; `team.bots.addons.*`, `offers.list` / `offers.answer`), ROADMAP (P14 and its deviations from the plan), SECURITY, DEVICE-TEST § N, CLEANROOM.

## 0.2.0 — 2026-11-04

> Afterword (2026-11-05): tagged `v0.2.0` at `16360c1`; the third release run (41793826816) succeeded and left a draft release (ad-hoc signed, not notarized; Windows `.exe` unsigned). Not published yet, so a download without a version finds nothing: name the tag (`--version v0.2.0`). The lines below that say the release workflow has not run are as written on 2026-11-04.

### P13 — macOS test 2 fixes (report of 2026-11-04b)

- **Router and workers cannot schedule or spawn on their own** (`1fd9d88`, A8): Claude Code's built-in `CronCreate` / `ScheduleWakeup` / `Agent` / `Skill` / … are disallowed on every launch, the router gets an allowlist (`--tools AskUserQuestion,ToolSearch`), and a run that saw one is stopped and its engine process released, so a session-only job dies with it. A learned skill keeps the person's own 「每天 09:30」.
- **Shell writes outside the work folder ask under 自主; `~` is home** (`c97a69c`, A9): redirections, `tee`, `cp`/`mv` destinations, `touch`, `sed -i`, `curl -o`, … are read as write targets; Alca's file tools expand `~/…` instead of creating `<work>/~/…`.
- **Bridge token off the command line** (`8d668ed`, E1): written to a 0600 `bridge.json`; `ps` shows only the file name.
- **Keychain only when a secret is kept** (`1e673b0`, E7): no probe item at start; one item per data folder; `ALCA_VAULT_BACKEND=file`.
- **Desktop shell: `ALCA_CORE_CMD` with spaces** (`841e7cf`, D2): split with shell quoting rules (no new crate).
- **UI** (`cb0287d`, A7 / B0 / B5 / B6): overlay dialogs (模型與供應商, the bot editor) take focus, keep Tab inside and close on Esc; `#token=…&open=settings` opens 設定, with its 管理供應商 link; an `http://` relay is refused with a sentence (API 400); `browserAutoDownload` under `--no-browser-download` answers 409.
- **Browser** (`06e56b0`, `9d19ff7`, C1 / C2): with the download off, the error names 設定 → 進階 → 瀏覽器 (or the flag); the download is 「約 200 MB」 and starts with Alca; RUNNING.md explains the ad-hoc signature (upstream) and that everyday Chrome is not used. Backup names carry their full name as a title (B8).
- **Scripts** (`b8fda2d`, `93c3733`, `46904e0`): `pnpm desktop:demo -- …` works (C3); a failed `install.sh` removes the empty prefix it created (A6); the service unit's PATH keeps only stable folders (E6).
- **Regression tests** (`08e8a94`): E2 (data-folder `config.json` / `secrets.json` read denied under 每步確認, no card), E3 (core.log written like launchd: no token, 0600), E4 (literal `~/.ssh` refused through the API).
- **A failed worker is not reported as done** (`3da24f6`, C2): the worker keeps its failed-step count and the last step's error (migration 16: `workers.tool_errors`, `last_tool_error`); the router's report carries `ok="false"` and the failed step; when the router still claims completion, an 「Alca 註記」 follows its reply; desktop and phone timelines show the worker as failed.
- **⌘A and the editing shortcuts on takeover** (`639bc93`, C3): ⌘A / C / X / Z and ⇧⌘Z (Ctrl on other systems) reach the page as CDP editing commands; ⌘V still pastes the person's own clipboard; a real-Chromium select-all-then-type test runs in CI.
- **Read-only lines with `$?` run without a card** (`927d989`, `6607847`, A4): read-only commands joined by `;`, `&&`, `||` or a pipe with plain variables and special parameters do not ask; re-expanded values (`${!X}`, `${X@P}`, `$'\x..'`, arithmetic on a named variable) now ask at every level.
- **Built-in model lists** (`8ec802b`, B4): one list per vendor (`MODEL_FAMILIES`), checked against the vendors' pages on 2026-11-04; docs/PROVIDERS.md has the same table, kept in step by a test.
- **Screenshots** (`83e5b49`, A3): the phone's notification-approval shot waits for network idle and the card's actions, and retries once (not re-run here: no Chromium in the sandbox).
- **Honest level wording** (`ce7fd18`): the bot editor, worker panel, phone bot form and team page say Alca's _recognised_ payment / send / delete / publish actions always ask.
- **The macOS App without a Gatekeeper prompt** (`602df88`, `bd4f7bc`, D1): `install.sh --app-only` (and `--app` with a full release install on macOS) downloads `Alca-macos.app.tar.gz` with curl, or the GitHub CLI while the repo is private, checks its SHA-256 and `codesign --verify --deep --strict`, keeps symlinks and installs into `~/Applications` (asks before replacing, keeps a backup); curl / gh add no quarantine mark, so it opens without Gatekeeper. `release.yml` ad-hoc signs the macOS App when there are no `APPLE_*` secrets (Tauri `signingIdentity: "-"` through the `--config` overlay, the bundled Node ad-hoc signed first, `codesign --force --deep -s -` + a remade `.dmg` as the fallback) and uploads `Alca-macos.app.tar.gz` + `.sha256` next to the `.dmg`. A `.dmg` downloaded in a browser still needs 系統設定 → 隱私權與安全性 → 「仍要打開」 once (README, RUNNING.md § 11).
- **CI runs actionlint** (`bd4f7bc`) on the workflows (v1.7.7, its tarball checked against a pinned SHA-256).
- Not in this pass: Developer ID signing and notarization (D1, needs a person and an Apple account); the release workflow's macOS job has not run yet (no tag pushed). Real-Mac re-checks: DEVICE-TEST § M (M10–M14 for this last batch).

### P13 — review 2026-11-04b: security (S1, S2, H1, H2, M4–M6, L7)

- **Engine configuration no longer decides for Alca** (`b034304`, S1 + M6): Claude Code runs with `--setting-sources ""`, `--strict-mcp-config` and `--settings {disableAllHooks}` (the person's allow rules, hooks and MCP servers do not apply); Codex runs with `CODEX_HOME` at `<data>/engines/codex` (Alca's `config.toml`, the login linked); engine children get an allow-listed environment without `ALCA_*`.
- **Native calls checked in every role, data folder out of reach** (`70de9bd`, S1.3 / S1.4 / S2.1 / M4): a native call an engine ran without asking stops the run when Alca would have asked (workers too; Codex's sandbox exempts only its own shell / reads, never another MCP server); a native read / edit / shell command that reaches Alca's data folder is denied at every level; writing engine / tool configuration (`.claude/`, `.mcp.json`, `.git/hooks`, …) asks; sensitive home folders (`~/.ssh`, `~/.aws`, `~/Library`, …) cannot be work folders.
- **Shell and MCP floor** (`4987981`, H1 + H2): under 自主 only known programs used in readable ways run without a person; interpreters with inline code, variables as programs, network / remote tools and unknown programs ask; third-party MCP tools fail closed to `send`.
- **Approving needs a key the bots cannot read** (S2.2 + S2.3): approving, making a pairing code, confirming an enrollment and widening a device's scopes need an in-memory approve key (`x-alca-approve` + same-origin `Origin`) as well as the local token, which alone now gets 403. A window gets the key once from a one-time launch code in its fragment (`POST /api/ui/session`); the core mints codes when it opens a window (`alca open`, new; `POST /api/ui/open`), and the **desktop shell** writes its own codes on the core's stdin (`ALCA_UI_CODES=stdin`) before it opens its window, so the shell's window can approve again (Rust: `Supervisor::launch_code`, `paths::launch_code`, `getrandom`). A window without the key opens one that has it. `alca pair` opens the 手機 dialog instead of printing a code. The core no longer prints the token: it prints the address and opens the window itself when started from a terminal (`--no-open`).
- **Owner-only files on every start** (M5): the data folder and its folders 0700, files at the top level and in `logs/`, `backups/`, `engines/` 0600, fixed at each start; a backup is 0600 when written; `alca service install` creates `core.log` 0600 first. `core.log` no longer contains `#token=`.
- **Phone memory changes need `approve`** (L7): `memory.update` / `memory.forget` over Alca Link; a chat-only phone shows 「這台手機沒有核准權限…請在電腦上的 設定 → 連線 調整」 up front and when the computer refuses.
- **Honest wording**: 設定 (團隊權限), the browser panel's empty state, the chat starter and the team screen say Alca's _recognised_ dangerous actions always ask, and that under 自主 what a bot's own script file does inside cannot be checked line by line.
- **One version in the engines**: ACP `clientInfo` and the MCP servers' `info` read `ALCA_VERSION` (from `packages/engines/package.json`, 0.2.0) instead of `"0.1.0"`; `pnpm check:versions` fails on a `version: "x.y.z"` literal in source.
- Docs: SECURITY.md § Review 2026-11-04b (model and residual risks: script files, Codex sandbox reads seen only afterwards, the launch code on the opener's command line); DEVICE-TEST § L (real Claude Code login with the isolation flags, Codex `CODEX_HOME` with a keyring login, approving from the shell window, file modes, chat-only phone).
- Not in this pass: an OS sandbox for shell commands and script files (S2.4); real-CLI and real-Mac checks (DEVICE-TEST § L).

### P13 — review 2026-11-04b polish (L1, L2, L6, L8, L9, L11, L12, M8)

- **Phone timeline, @ menu, 權限 label, Telegram** (`0967889`, L1 / L2 / L11): the phone names our ids in words (「第 N 份結果」, 「第 N 個工人」) and never shows raw JSON arguments; the team chat `@` menu is as wide as the composer and scrolls; the sidebar's 權限 label is a button that opens 設定 and no longer truncates; the Telegram enable dialog says Telegram's servers see the full reply text.
- **Keychain over stdin, offline-cache limits** (`173f91b`, L6 / L12): the macOS vault key is written with `security -i` on stdin, never in argv; SECURITY.md says the phone cache's KEK sits in the same browser profile as the ciphertext. Untested on a real Mac (DEVICE-TEST F4c).
- **Mac test leftovers** (`d87f44e`, M8): the service starts through `run-core.sh`, which falls back to another Node ≥ 22.18 when the install-time one is gone (DEVICE-TEST F4b); 「我喜歡…」 / 「我希望回答…」 are preferences; learned-skill triggers skip numbered steps and step fragments; conversation titles cut at a clause and show a URL's host; the built-in model lists are current (Claude 5.5 / Fable 5.1, GPT-6 Astra / 6.1 Sol / 6.1 Terra / 6 Luna, Gemini 4 Argon / 3.8 Flash / 3.5 Flash-Lite, each checked on the provider's model page on 2026-11-04).
- **Forbidden name check** (`136417d`, L8): `showBot` / `showBotForm`; `pnpm check:names` is part of `pnpm check`.
- **Splits** (`926b124`, L9): `ui/app.ts`, `ui/browser.ts`, `ui/browser.css`, phone `styles/screens.css` and `core/agent.ts` (→ `agent-types.ts`) are under 600 lines; no behaviour change.
- Not in this pass: `core.log` mode 0644 with the local token in it (from the mac report); `LICENSE` / `package.json` license (the user decides); `node:sqlite` experimental and synchronous.

### P13 — review 2026-11-04b: deploy values, release supply chain, relay

- **Deploy-value check** (review H3): `check-deploy-values` also catches bundle ids / service labels made from the project domain, `GOCSPX-` secrets, Telegram bot tokens, Vercel `prj_` / `team_` ids, PEM private keys, OpenRouter / OpenAI / Anthropic keys, Slack, AWS, Composio, Cloudflare account ids and `*.pages.dev` hosts, and scans Markdown and `docs/`; placeholders pass only from a narrow list (an `example` label, the test client IDs, keys marked as fixtures). Neutral ids: `local.alca.desktop` (shell; `ALCA_BUNDLE_ID` repository variable for a release) and `local.alca.core` (LaunchAgent; `$ALCA_SERVICE_LABEL`); `alca service install` / `uninstall` remove an agent an older build wrote under the old label.
- **Release supply chain** (review H4): `APPLE_*` secrets only in the signing steps' env; every action pinned by SHA (+ Dependabot); the Tauri CLI pinned in `pnpm-lock.yaml` (`apps/desktop-shell/package.json`); build provenance attestations when the repository is public; `install.sh` refuses a tarball without a checksum it can verify (`--sha256`, `<file>.sha256`; `--insecure` to override; `--attestation` to check provenance).
- **One version** (review M7): every `package.json`, `tauri.conf.json` and `Cargo.toml` at **0.2.0**; `pnpm check:versions` keeps them equal and release.yml checks the tag against them. No tag yet.
- **Relay** (review M1, M2, M3, L3, L4): `--trust-proxy` takes the rightmost `X-Forwarded-For` entry (`--trust-proxy-hops N`); hello deadline (10 s), idle timeout (30 min), 32 sockets per address, a total socket cap, a byte budget per connection and at most 8 channels per address to one core, on both relays. The Workers relay gains `/v0/hooks` webhook mailboxes (one Durable Object per mailbox, migration `v2`, same protocol as the Node relay), `MAX_SOCKETS`, `RELAY_MODE=production` (an empty `ALLOWED_ORIGINS` refuses browser sockets), and a `/healthz` that says `ok:false` + why when `ALCA_RELAY_SECRET` is missing; `wrangler.toml` keeps the dashboard's variables (`keep_vars`, no `[vars]`) and sets `workers_dev = false` / `preview_urls = false`: the custom domain is the only endpoint, with no `workers.dev` fallback (self-hosters may turn it on).
- **Phone site CSP** (review L5): a build with `ALCA_RELAY_URL` narrows `connect-src` to that relay (+ `wss://*.ts.net`, Google Identity Services, `ALCA_CSP_CONNECT_EXTRA`) with a `<meta>` CSP.
- **Docs** (review L10): the macOS test report of 2026-11-04 was added to the repository (later removed with the other internal reports when the repository was prepared for open source).

### P13 — macOS test fixes (report of 2026-11-04, branch `mac-test`)

- **Router on Claude Code ≥ 2.1** (`885dcf3`): the CLI's built-in `ToolSearch` (and `AskUserQuestion`) no longer counts as the router acting on its own, and `claude` is started with `ENABLE_TOOL_SEARCH=false`, so the first dispatch works again. New opt-in smoke `apps/desktop/smoke/router-dispatch.smoke.ts` (real router → worker dispatch).
- **Paths with a space** (`a990cff`): the `alca` CLI, `check:deploy-values`, `pack-core`, `gen-official-config` and the phone build / screenshot scripts silently did nothing from a folder with a space; they compare real paths now.
- **Shell floor reads commands** (`a9c6dba`): `git -C <dir> push`, `git -c k=v push`, `/bin/rm`, `sh -c …`, wrappers like `env` / `sudo` / `xargs` are classified as publish / delete under 自主 too.
- **Undo for shell edits** (`b13487f`): a cleared shell call's changes inside the work folder are journaled, so 復原 covers `printf > file` and the like.
- **Desktop shell** (`6f2417c`): quitting the shell with `kill` / Ctrl+C stops the core it started; a core started by the shell exits when the shell is gone (even after SIGKILL); a `--data-dir` / `--engine` in `ALCA_CORE_CMD` is kept. `CI=true` for a local `.dmg` (Finder AppleScript timeout).
- **install.sh on bash 3.2, temp folders** (`dd8c4ff`): `--no-service` no longer stops at an empty array under `set -u`; macOS's temp folder (`/var/folders` → `/private/var/folders`) and `/tmp` can hold a bot's folder.
- **Desktop UI** (`46d73b0`): 記憶與技能 → 例行工作 / 連接 no longer squeezes the pane under the sidebar; sidebar buttons have accessible names; skill triggers keep URLs whole; the card for an edit outside the work folder names it and its path under 每步確認 too.
- **Always-on core** (`35b55a9`): launchd `KeepAlive` true and systemd `Restart=always`, so a plain `kill <pid>` restarts it (DEVICE-TEST F3); `alca service install` waits for the core before it reports; status shows launchd's whole state (「not running」, not 「not」).
- **Tests** (`8e26f53`): the relay worker's stored-subject check and the browser download 503 test no longer flake; real-server and real-browser tests get 30 s.
- Not done from the report: the bot editor's built-in model list, 「我喜歡…」 sorted as a fact, title truncation, skill steps cut at 「，」, the service plist pinning an nvm node path, `core.log` mode 0644 with the local token in it; the phone (§ 6) was not tested.

### P13 — fixes, backups, conversation list, 設定

- **Run limits** (`ff7ee75`): `engineering.turnTimeoutSec` now stops a turn that runs too long (error `turn.timeout`; an engine that ignores the interrupt is closed after a grace and the thread is usable again); `engineering.maxConcurrentRuns` (default 8) caps every run at once, conversations ahead of workers, and a run waiting for an approval gives its slot back.
- **Connectors without core** (`5b80782`): the host contracts moved to `@alca/tools`; `@alca/connectors` depends on tools / config / policy / store only.
- **One provider path** (`19df3b0`): the P7 model-service route (`/api/engines/providers`) and its presets are gone; every bot engine other than the default comes from the P11 registry. Fix: a keyless service on the LAN / Tailscale (Ollama, LM Studio on another machine) may use `http://`.
- **Desktop server** (`5317080`): one app context and a declarative route table (405 for a known path under another method).
- **Defused fences** (`ffd0d57`), **crypto tests** (`8a34d46`), **evals** (`c179af4`), **open-source docs** (`3564ff3`), **Telegram** (`bea4abc`, `b30b45d`), **Chromium download + network gate** (`77353d9`), **agent features** (`37d6b91`), **phone forms** (`d000534`), **WebRTC** (`245da87`): see the sections below.
- **UI split** (`42fbba5`): desktop UI files next to the 800-line cap split; no behaviour change.
- **Router on ACP / API engines** (`d3c7300`): the router only talks and dispatches there too; an ACP router always runs in asking mode; a router turn whose engine ran a native tool that can change something without asking is stopped (`router.native_tool`). One approval-level vocabulary (`APPROVAL_LEVELS`, `LEVEL_WORDS`, `effectiveLevel`, `strictestLevel` in `@alca/config`); a bot following the team runs its ACP agent in the team's level.
- **Gate re-audit** (`1643ff6`): a Composio tool the provider cannot describe fails closed to at least send; connector shortcuts grant nothing beyond a read without a host call context; `browser_tabs new` goes through the navigate gate; Link watches stop when a device's scope is taken away. SECURITY.md gate audit section.
- **Backups before a migration** (`cc5054f`): `<data>/backups/state-v<from>-<time>.sqlite`, newest five kept; `alca db backups | backup | restore <file>` (restore checks integrity and the schema, refuses while a core runs, moves the current file aside).
- **Conversation list** (`bd983af`): pages of 50 with 載入更多; 封存 and 刪除 (behind a confirm) on the desktop, 已封存的對話; the phone drawer's ⋯ → 封存 / 刪除 (second tap confirms; needs `approve`). Delete removes messages, drafts and engine sessions and keeps a tombstone row (migration 15); refused while a run, a routine, an enabled trigger or a live worker uses the conversation. `GET /api/threads?limit&before&archived=1`, `POST /api/threads/:id/archive`, `DELETE /api/threads/:id`; Link `threads.archive`, `threads.delete`.
- **Settings clean-up** (B1, `2d0faf4`): keys nothing read are gone (`models.defaultEngine`, `models.suggestFallbackOnQuota`, `connections.accounts`, `advanced.dataDir`, `engineering.engineIdleShutdownSec`, `engineering.promptCacheKeepWarmSec`, `engineering.offlineMailboxHours`); an old `config.json` still loads, with a warning per dropped key, and loses them on the next save. `devices.pushPreview: "none"` now turns Web Push off; `advanced.logLevel` now sets how much the core logs (timestamped lines).
- **設定** (B3, `3353f82`): the desktop's 設定 dialog (sliders icon in the sidebar footer) — 團隊權限 每步確認 / 自主 with the fixed always-ask line, 從對話學習, 手機通知; 進階: default scopes for new devices, 允許配對新裝置, 自架會合伺服器 (https), 記錄等級. Saved to `config.json`; level, learning, notifications and log level apply at once, the rest after a restart (shown). `GET / PATCH /api/settings`, loopback only. Screenshots: `ALCA_SHOTS_ONLY=settings`.
- **設定, complete:** simple first — 團隊權限, 學習, 手機通知, **模型與供應商** (the default bot's provider and model with the bot editor's picker; 管理供應商 opens 模型與供應商). Under 進階, with a jump row: **連線** (official or self-hosted phone site and relay, Google sign-in state, paired devices with 撤銷 behind a second tap, buttons into 連線 and 配對新手機, plus default scopes, pairing and the start-up relay), **瀏覽器** (status, 下載瀏覽器, the new `advanced.browserAutoDownload` switch, live; locked when started with `--no-browser-download`), **Telegram** (status + its dialog), **備份** (list, 現在備份; restore stays `alca db restore` with the core stopped), **關於** (version, data folder, 打開資料夾 / 打開記錄檔資料夾, log level). New: `GET / POST /api/settings/backups`, `GET /api/settings/about`, `POST /api/settings/open-logs`, `POST /api/settings/open-data`. Every control is exercised by `settings-areas.test.ts` and by the screenshot run, which checks the store / files after each click.

### P13 — agent features: working folders, undo, shell review, 提前做

- **Working folder per bot** (bot editor → 進階 → 工作資料夾): engines and Alca's new file tools (`file_list` / `file_read` / `file_write` / `file_edit`, for every engine) work there; the folder is checked (no root, home, system or Alca data folder); edits outside it ask first, even under 自主.
- **復原:** a strip above the composer shows the newest turn that changed files; 復原 (after a confirm listing the files) puts them back and removes files the turn created. Refused, with the reason, when a later conversation changed the same files, the backup was pruned, or the turn still runs. `GET /api/undo/:thread`, `POST /api/undo/:thread/:turn`.
- **指令審查 (optional, off by default):** under 自主 a shell command is first shown to a model (the bot's own or one you pick); high risk, or no clear answer, asks you.
- **提前做:** a bot can prepare drafts in the background from meeting invites and mail (per-bot switch, 安靜時段, daily caps); it never asks or sends anything; 例行工作 shows what is queued, running, ready or failed, and which drafts came from it.
- Tests: ACP `locations` → paths; fake-engine tests for folders, undo, review and 提前做. Screenshots: `ALCA_SHOTS_ONLY=p13`.

### P13 — phone: forms, offline, WebRTC direct path

- **Bots and routines from the phone:** 團隊 → 新增 bot / 編輯 (name, avatar, colour, role, instructions, approval level; folders, shell review, 提前做 and engines stay on the computer) and 連接 → 例行工作 → 新增例行工作 (app and account, every N min / h, daily at a time in the phone's zone, or once; what to do; which bot). New ops `team.bots.create`, `team.bots.update`, `routines.create` (scope `approve`).
- **Offline:** the phone keeps an encrypted copy (AES-256-GCM under a non-extractable WebCrypto key, bound to the pairing) of the newest 30 conversations, re-saved after every answer, and shows it read-only while the computer is away, with how old it is. Messages typed offline wait in an encrypted outbox (排隊中 · 連上電腦後送出, 刪除 / 重試) and go out in order once the computer is back.
- **Exactly once:** each queued message has its own `clientKey`; the core reserves the key before sending and stores the result after (migrations 13–14, `link_client_ops`), so a retried flush — lost answer, dropped connection, restarted core, even a crash mid-send — never sends a message twice.
- **WebRTC direct path (off by default):** with STUN servers in settings `engineering.rtc.iceServers` the phone and computer try a DataChannel, signaled inside the sealed Link session; the full Link handshake and sealed frames run on it again; back to the relay at once when it drops. 診斷 shows 路徑 and the WebRTC state. Core side werift (optional dependency), now included in release bundles with its dependencies (`scripts/pack-deps.ts`).
- Docs: PROTOCOL.md § P13, SECURITY.md (WebRTC trust model and IP exposure, limits of the cache encryption), DEVICE-TEST.md § J. Screenshots: `ALCA_SHOTS_ONLY=p13` for the phone script.
- Not tested on a real iPhone yet: WebRTC with Safari over real networks, IndexedDB key persistence across iOS storage eviction.

### P13 (parallel track) — open source, evals, Telegram, crypto tests

- **Open-source groundwork:** CONTRIBUTING.md, SECURITY.md (private vulnerability reporting, response times, scope), CODE_OF_CONDUCT.md (Contributor Covenant 2.1), issue forms and a PR template with the safety checklist. LICENSE unchanged (still TBD).
- **`pnpm evals`:** 49 scripted scenarios against fake engines (router, approval gates, memory, routines, team, prompt injection) with a JSON + markdown report; a separate CI job.
- **Fix:** outside text can no longer close its `<alca:…>` fence with another spelling or forge an Alca tag; worker / teammate reports, trigger events and recalled text are escaped too (`defuseAlcaTags`).
- **Telegram reply channel:** your own bot token (local vault), long polling, an allow-list of private chats, replies from the chosen bot; approvals only on the computer or a paired device. Desktop 手機與裝置 → Telegram. Tested against a fake Bot API only.
- **Crypto tests:** known answers and OpenSSL cross-checks for the hand-written P-256 / SPAKE2; docs/CRYPTO.md (needs an external review).
- Deferred: a mail reply channel (Composio covers mail already).
- **Alca Browser — first-run Chromium:** with no Chromium on the machine the app downloads Chrome for Testing for this OS / CPU (resumable, retried, MD5 / CRC32C checked, unpacked by Alca's own zip reader) into the Alca data dir; progress in the browser panel; `--no-browser-download` to opt out.
- **Alca Browser — network-layer gate:** requests that pay, send, delete or publish (a button with an innocent label that POSTs to `/checkout`, a cross-site frame's `/messages/send`, a GraphQL `DeleteRepository` …) are paused in Chromium and need the step's approval or a new card; reads pass; a person driving is never gated.
- **Alca Browser — Chrome cookie import (macOS, opt-in):** copy the logins of sites you pick from your Chrome profile into one 「隔離並保留登入」 Space (Keychain prompt, decrypted in memory, audited without values); never into the shared profile, never automatic.

### P12 — 零設定連線：兩邊用 Google 登入，電腦上輸入一次驗證碼

- **No settings on the computer.** A release writes the official relay, phone site and Web client ID (public values) into a gitignored `apps/desktop/official-config.json` from the repository variables `ALCA_OFFICIAL_RELAY_URL`, `ALCA_OFFICIAL_SITE_URL`, `ALCA_OFFICIAL_GOOGLE_CLIENT_ID` (`scripts/gen-official-config.ts`, `pack-core`, `release.yml`); the same names work as environment variables; with only the site known the core reads the rest from the site's `config.json`; `install.sh --site <url>`. Source defaults stay empty (`check-deploy-values`); 連線 has 自架的 Alca 網站 to override.
- **The computer signs in with Google through the phone site — no Desktop client, no secret.** One button 「用 Google 登入」; the core opens `<site>/computer-signin?state=…&port=…` in the default browser; the site signs in with its Web client (nonce bound to the state) and sends the browser to `http://127.0.0.1:<port>/google-callback`; state, origin, nonce, audience and expiry are checked. The Desktop-client flow stays for self-hosters.
- **New phones: type the phone's code on the computer.** The phone shows a 6-digit code; the computer's sheet 「輸入手機上的驗證碼」 takes it; the code is a SPAKE2 password and both long-term keys sign the transcript, so both ends are authenticated and a relay can play neither (fixes the review's open P10 limit: the phone trusted the computer's answer). 5 tries, 5 minutes; then the phone reconnects with no prompt. With one computer on the account the phone picks it. Replaces P10's number comparison + 允許 (wire messages changed: update the site and the core together). Pairing codes remain.

### Fixes from the 2026-11-04 review

- ACP engine: a permission request is taken for a host tool (and so skips the gate) only for an exact tool-name shape and never for a native execute / edit / delete / move kind; `allow_always` is never chosen; ACP shell commands get the same escalation floor as Bash (`git push`, `rm`, `curl -X POST` …).
- A long thread shows its latest messages (it showed its first 500).
- Revoking another device from a phone needs the `approve` scope.
- A Composio Connect Link must be https; sign-in tabs get no opener.
- SECURITY.md: the phone side of P10 enrollment is an open limit (closed by P12).

### P11 — 更多供應商 (0.2.0-dev)

- Provider registry: Claude Code, Codex CLI, ACP agents (Gemini CLI, OpenCode, Grok CLI, Kimi CLI, Qwen Code, Cursor CLI, Factory Droid, Antigravity) and model APIs (OpenAI Responses + Chat, OpenRouter, Anthropic, Gemini, Mistral, MiniMax, Cerebras, Groq, DeepSeek, xAI, Together, Fireworks, Ollama, LM Studio); status 可用 / 需登入 / 需金鑰 / 未安裝 with a one-line fix; live / CLI / built-in model lists. [docs/PROVIDERS.md](docs/PROVIDERS.md).
- Generic ACP engine; OpenAI Responses and Anthropic Messages engines; reasoning effort on the chat engine.
- Desktop 模型與供應商 (six pinned, 更多供應商 folded), 新增自訂供應商 (ACP agent, OpenAI- or Anthropic-compatible), bot editor 選供應商 → 選模型; the phone shows a bot's provider and model. Migration 11.
- Tested against mocks only; several ACP presets are best guesses (see PROVIDERS.md).

### P10 — 用 Google 帳號連線

- Relay Google-account directory: ID token checks (JWKS, RS256, audience = the configured client IDs, issuer, expiry), `HMAC(secret, sub) → computers`, `computer.register` / `computers.list` / `connect`, rate limits; Node relay (`--google-client-id`, `--accounts-file`) and a Cloudflare Workers + Durable Objects relay (`services/relay-worker`).
- New devices found through the account enroll with a 6-digit number shown on both screens and 允許 on the computer; then they reconnect by key, like paired ones; pairing codes remain.
- Desktop 手機與裝置 → 用 Google 帳號啟用遠端 (loopback + PKCE) and the new-device sheet; phone site with Google sign-in, computer list and the number; `vercel.json` and `config.json` for a fixed URL; [docs/DEPLOY.md](docs/DEPLOY.md).

## 0.1.0 — 2026-11-03

The first version meant to be tried by hand on a real Mac and phone ([docs/DEVICE-TEST.md](docs/DEVICE-TEST.md)). Desktop release builds for macOS and Linux carry their own core + Node runtime (Windows still uses `scripts/install.sh`); they are signed and notarized only when the `APPLE_*` secrets are set. The release workflow has not run yet.

### P9 — stable address, reconnect, Codex, model extraction, smoke tests

- Stable relay mailbox derived from the install's Link key; relay `probe` and `ping` / `pong`; the core checks itself every 15 minutes and re-registers when it is not reachable; `ready` and a sealed `endpoints` event give phones every relay and direct address, so a relay move or restart never needs re-pairing; a pairing code survives up to 5 wrong tries.
- Desktop 連線 dialog (own stable relay URL, Tailscale / LAN direct addresses, self-check); phone reconnect banner and 診斷 rows per relay.
- Codex CLI engine (`codex exec --json`, resume, host tools over MCP behind the gateway, read-only sandbox), selectable per bot.
- Opt-in model-based memory extraction per bot (記憶整理), quote-checked, always inferred, rule extractor as the floor.
- `pnpm smoke`: opt-in tests against real Composio, OpenRouter, Gemini, Claude Code and Codex accounts (`ALCA_SMOKE_*`), never in CI.
- Release builds: the core tarball and a Node 22 runtime bundled into the macOS / Linux desktop app (`scripts/stage-shell-core.sh`; unpacked on first start), macOS signing + notarization wired to the `APPLE_*` secrets and skipped without them.
- CI hardening for the real-Chromium tests; P9 screenshots; version 0.1.0 across packages.

### P8 — always-on core, Web Push, desktop shell, installer

- Web Push straight from the core (VAPID key kept locally, RFC 8291 encryption, payload `{v, t, id}` only); phone notification prompt, iPhone Home Screen guide, 診斷 sheet, resume / reconnect hardening.
- `alca service install | uninstall | status` (launchd, systemd `--user`, Task Scheduler); Tauri 2 desktop shell (tray, 登入時開啟, `alca://` links, core supervisor); `scripts/install.sh` and `scripts/pack-core.ts`; release workflow for unsigned bundles; DEVICE-TEST checklist.

### P7 — team of bots + more engines

- Bot profiles (role, tone, instructions, engine + model, approval level, browser profile, memory mode), a lead, bot-to-bot ask / delegate in peer conversations that only ever narrow permissions, a collaboration trail, @mentions and bylines.
- HTTP engines that loop through the host: OpenAI-compatible chat completions (OpenRouter, Ollama, LM Studio) and the Gemini API; keys in the local vault.

### P6 — connected apps, routines, 提前做

- Connected apps through the person's own Composio account (local key vault, labelled accounts, per-bot access, fail-closed classifier, daily quotas); agent tools for mail, calendar and drafts.
- Routines (interval, cron, once, app trigger) that check before calling the model; drafts prepared ahead that are only used after a confirmed request; webhook mailboxes on the person's own relay.

### P5 — memory + learning

- Durable per-bot memory with provenance and supersede-only versions, 記住 / 忘記 with tombstones, a rule extractor with a secret filter, budgeted recall, CJK search.
- Skills proposed after a multi-step task and saved only on approval; a saved skill never relaxes the always-confirm classes. 記憶與技能 library on desktop and phone.

### P4 — Alca Link + phone PWA + hands daemon

- End-to-end encrypted Link: SPAKE2 pairing on a short code or QR, pinned identities, signed ephemeral sessions, sealed frames with strict counters; self-hostable rendezvous that only sees ciphertext; optional LAN path.
- Phone PWA (chat, approval sheets, workers, live Space + takeover, threads, devices) and the stateless hands daemon behind the policy gateway.

### P3 — super-agent core

- Per bot a resident router plus isolated, parallel workers; inline vs spilled results with `recall`; triggers with a two-stage filter; a watchdog; restart recovery; worker panel in the desktop UI.

### P2 / P2b — Alca Browser

- Our own Chromium over a pipe, bot-owned Spaces, `@N` accessibility snapshots across shadow DOM and iframes, script mode, takeover, a sensitive-action gate; the browser tools exposed to Claude Code over MCP, every call gated.

### P1 — core + first engine + desktop chat

- Turn pipeline and runner, stable / volatile prompt layers, loop guard; persistent Claude Code engine with permission prompts in the approval flow; jobs runtime; policy gateway with an append-only, hash-chained audit; loopback desktop server and Traditional Chinese UI.

### P0 — skeleton

- pnpm monorepo, TypeScript strict, Alca Event Protocol v0 + JSON Schema, SQLite store with append-only triggers, 5-page settings schema, startup safety check, CI.
