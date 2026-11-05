# Manual test checklist (real devices)

What to check by hand on a real iPhone, Mac or Android phone — the parts no headless browser can prove. Contributors: run the sections your change touches and paste the results (with OS, device and browser versions) into the pull request. Each step says what you should see. Open **診斷** on the phone (裝置 → 診斷, or `https://<your-host>:8787/diag`) whenever something looks off and copy its text (複製診斷資訊) into the bug report.

Setup used below: the Mac runs the core, the rendezvous serves the PWA over **https** (Web Push and the service worker need a secure origin; `localhost` is not reachable from the phone).

```sh
# on the Mac (or any host you control with a TLS certificate)
node --disable-warning=ExperimentalWarning apps/phone-pwa/scripts/build.ts
pnpm rendezvous --pwa apps/phone-pwa/dist --host 0.0.0.0 --tls-cert cert.pem --tls-key key.pem   # see RUNNING.md § 7
pnpm desktop --engine demo --agents direct --rendezvous https://<your-host>:8787 --data-dir ~/.alca-test
```

Tick a box only when the result matches. Note iOS version, iPhone model and Safari / Home Screen.

## A. Install to the Home Screen (iPhone, iOS 16.4 or later)

- [ ] A1. Open `https://<your-host>:8787/` in **Safari**. The pairing screen shows; below the buttons there is the row 「要在 iPhone 收到通知？先加到主畫面，再從那裡配對。」. Tap it: a sheet with three steps (分享 → 加入主畫面 → 從主畫面打開).
- [ ] A2. Share → 加入主畫面 → 加入. The icon is the white “a” mark on near-black (not a blank square or a screenshot of the page).
- [ ] A3. Open Alca from the Home Screen: no Safari bars, status bar text readable over the dark top, nothing hidden under the notch or the home indicator.
- [ ] A4. Pair from the Home Screen app (code from 手機 on the Mac, or scan the QR). The safety number on the phone matches the one on the Mac. (Pairing done in the Safari tab does **not** carry over: iOS keeps Home Screen apps' storage separate.)

## B. Notifications (Web Push)

- [ ] B1. Shortly after pairing, or from 裝置 → 通知, the prompt 「有事等你決定時，提醒你」 appears, with a preview that says only 等你決定. Tap 開啟通知 → iOS asks for permission → 允許. The 通知 switch in 裝置 is on.
- [ ] B2. 診斷 → 傳一則測試通知. Within a few seconds a notification 「通知已開啟」 arrives (lock the phone first to see it on the lock screen too).
- [ ] B3. Lock the phone. On the Mac, type 「刪除購物清單」 (demo). The phone shows **等你決定 — 有一件事要你點頭。打開 Alca 看詳情。** and nothing else: no amount, no names, no file.
- [ ] B4. Tap the notification. Alca opens on the right conversation with the card's sheet up, and a small amber chip 「從通知打開 · 詳情剛經加密連線從電腦取得」. Approve or deny; the Mac sees the result at once.
- [ ] B5. With Alca **open and in front** on the phone, make another card on the Mac (in another conversation). No system notification; instead a banner 「另一個對話在等你決定 · 查看」 under the top bar. 查看 opens it.
- [ ] B6. Answer a card on the Mac while the notification is still on the phone, then tap it: the app says 「這件事已經處理好了」.
- [ ] B7. 裝置 → turn 通知 off. Make a card: no notification. Turn it back on: notifications come again.
- [ ] B8. On the Mac, revoke the phone (手機 → 撤銷). Make a card: no notification reaches the phone (its subscription went with the revoke).
- [ ] B9. Settings → 通知 → Alca → off; then 裝置 shows 「已被關閉」 and the prompt explains where to turn it back on.

## C. Background, resume, network

- [ ] C1. Leave Alca in the background for 2+ minutes (lock the phone). Come back: the top line goes from 連線中 to 已連線 within ~2 s; no stale 「離線」.
- [ ] C2. While a reply is streaming on the Mac, switch apps for 30 s, come back: the conversation catches up (no missing or doubled text).
- [ ] C3. Airplane mode on for 20 s, then off: reconnects by itself; 診斷 → 本次連上 counts one more session.
- [ ] C4. Switch Wi-Fi → cellular in the middle of a conversation: reconnects; a card that arrived meanwhile is shown.
- [ ] C5. 診斷 → 往返延遲 shows a number (ms) and 重新連線 says 「連線正常」.

## D. Layout and keyboard

- [ ] D1. Tap the composer: the keyboard opens and the composer sits right above it (not hidden, no white gap, page not scrolled up so the top bar disappears).
- [ ] D2. Type three lines: the composer grows; the last message stays visible above it.
- [ ] D3. Rotate to landscape and back: no content under the notch side; sheets still fit.
- [ ] D4. Open every sheet (工人, 瀏覽器畫面, 記憶與技能, 連接, 團隊, 裝置, 診斷): each fits between the notch and the home indicator; drag-down closes it.
- [ ] D5. Light mode (裝置 → 外觀 → 淺色): text readable everywhere, the status bar still readable.

## E. Storage

- [ ] E1. 診斷 → 持久儲存 says 已保留 (Home Screen apps usually get it without asking; else tap 保留儲存空間).
- [ ] E2. 身分金鑰: 「在這支手機上 · 不可匯出」. IndexedDB: 正常.
- [ ] E3. Force-quit Alca (swipe it away), reopen: still paired, last conversation opens.
- [ ] E4. Leave the phone for a day without opening Alca; open it: still paired (iOS evicts storage of sites not used for a while unless it is a Home Screen app — this is why A matters).

## F. Mac: always-on core

Notes: a checkout path with a space works; `install` waits a few seconds for launchd, so F1 prints 執行中; since `KeepAlive` is true, F3 holds for a plain `kill` as well as `kill -9` — `uninstall` is the way to stop it.

- [ ] F1. `pnpm alca service install --engine demo -- --rendezvous https://<your-host>:8787` prints 執行中 and the plist / log paths.
- [ ] F2. Close the terminal; the phone still connects. `pnpm alca service status` shows the pid and the last log lines.
- [ ] F3. `kill <pid>` (and `kill -9 <pid>`): within ~10 s `status` shows a new pid (launchd restarted it). The phone reconnects by itself. `status` while it is down reads 「已安裝，未執行（spawn scheduled）」 on macOS (launchd is waiting to restart it; KeepAlive).
- [ ] F4. Log out and back in: the core is running again without doing anything.
- [ ] F4b. Switch Node with nvm (`nvm install 24 && nvm alias default 24`) and remove the version the service was installed with (`nvm uninstall <old>`), then `kill <pid>`: the core comes back, `core.log` says 「安裝時的 Node（…）不能用了，改用 …」 and `status` shows the 注意 line. `alca service install` again: the warning is gone.
- [ ] F4c. First start on a fresh data folder (no `vault.key`): Keychain Access shows `alca-agent` / `vault-key` for `~/.alca`, `vault-key-<12 hex>` for any other folder, and `ps` during the start never shows a `security … -w` line with the key (the key goes over stdin).
- [ ] F5. `pnpm alca service uninstall`: stopped, plist gone; `~/.alca` (or your data dir) and its logs are still there.

## G. Mac: desktop shell (when a build is available, see RUNNING.md § 11)

- [ ] G1. Open Alca.app: a dark splash 「Alca 正在啟動…」, then the usual Alca window. The menu bar shows the Alca mark.
- [ ] G2. Menu bar menu: 「Alca 正在執行」, 打開 Alca, 配對手機…, 登入時開啟, 重新啟動核心, 打開紀錄檔資料夾, 結束 Alca.
- [ ] G3. Make a card: within ~2 s the menu bar icon gets an amber dot and a count, the first line reads 「等你決定：1 件」, 打開 Alca becomes 查看等你決定的事.
- [ ] G4. Close the window: Alca stays in the menu bar; clicking the Dock icon brings the window back.
- [ ] G5. Open Alca.app a second time: no second window or second core; the existing window comes forward.
- [ ] G6. In Safari, open `alca://pair`: the window comes forward with the 手機 dialog and a fresh code.
- [ ] G7. 登入時開啟 on → log out / in: Alca is in the menu bar, window hidden. Off → it does not start.
- [ ] G8. With the service from F running, open the app: it attaches (first line 「Alca 正在執行（背景服務）」) and starts no second core; quitting the app leaves the service running.
- [ ] G9. Without the service: `kill` the core the app started → the menu shows 「核心停止了，1 秒後重新啟動」 and it comes back. 結束 Alca → `lsof -i :4317` shows nothing (port released).
- [ ] G10. `kill <shell pid>` (SIGTERM), then separately `kill -9 <shell pid>`: each time the core the app started (also one it restarted in G9) is gone within ~5 s and `lsof -i :4317` shows nothing. With `ALCA_CORE_CMD="… main.ts --data-dir /tmp/alca-shell"` the core uses that folder, not `~/.alca`.
- [ ] G11. A local `.dmg`: `CI=true pnpm exec tauri build --bundles dmg` succeeds without giving the terminal Automation access to Finder.
- [ ] G12. App install from a release: on a Mac where Alca.app has never been opened, `curl -fsSL https://github.com/ihsieh31/alca-bot/releases/latest/download/install.sh | bash -s -- --app-only` (add `--version <tag>` while the release is a draft) → 「檢查碼正確」, 「App 簽章正確」, `~/Applications/Alca.app`; `xattr -l ~/Applications/Alca.app` shows no `com.apple.quarantine`; `open ~/Applications/Alca.app` starts it with no Gatekeeper dialog. Run it again → it asks before replacing and keeps `Alca.app.bak-<time>`. The `.dmg` downloaded in Safari: the first open of an unnotarized build is blocked until 系統設定 → 隱私權與安全性 → 「仍要打開」.

## I. 用 Google 登入 on a real Mac + iPhone (P12)

Setup: a release build (or `ALCA_OFFICIAL_SITE_URL=https://<site> pnpm desktop --engine demo`) with **no** `--rendezvous`, no client ID, no secret.

- [ ] I1. 手機與裝置 shows one button 「用 Google 登入」 (no relay or client fields). Press it: the **default browser** opens `<site>/computer-signin` and goes on to Google by itself.
- [ ] I2. Pick the account → the browser lands on 「已登入，可以關掉這個分頁」 (via `127.0.0.1:<port>/google-callback`); Alca shows 已啟用 with the email within a few seconds.
- [ ] I3. Press 用 Google 登入 again, then use the first (stale) Google tab's back button to replay it: Alca refuses (「這不是這次的登入」 / nonce) and the new sign-in still works.
- [ ] I4. iPhone, Safari and the Home Screen app: open the site → 使用 Google 帳戶繼續 (same account). With one computer on the account it goes straight to 「在電腦上輸入這組驗證碼」 with a 6-digit code and a 5:00 countdown.
- [ ] I5. On the Mac the sheet 「輸入手機上的驗證碼」 appears over whatever is open. Type a wrong code: the sheet says 驗證碼不對（還可以試 4 次）, the phone says the same within a second.
- [ ] I6. Type the right code → the sheet says 已連上「iPhone · Safari」; the phone says 已連上 → 開始使用 → chat works.
- [ ] I7. Close and reopen the Home Screen app, reboot the Mac: the phone reconnects by itself — no code, no Google, no sheet.
- [ ] I8. Five wrong codes: both sides stop (錯太多次了); 重新產生驗證碼 on the phone gives a new code that works. Wait 5 minutes without typing: both say 已過期.
- [ ] I9. 撤銷 the phone in 手機與裝置: the phone shows 這支手機已被撤銷 at once.

## J. WebRTC direct path and offline (P13)

Setup: on the Mac, settings `engineering.rtc.iceServers` set to one STUN server you trust (e.g. `["stun:<your-stun-host>:3478"]`), core restarted. Without it nothing in J1–J4 happens (relay only, by design).

- [ ] J1. iPhone Home Screen app on the same Wi-Fi as the Mac: within ~15 s of 已連線, 診斷 → 路徑 says 「WebRTC 直連（加密層照舊）」 and the WebRTC row 已直連. Chat, a card and the browser view work as before; 往返延遲 is no worse than on the relay.
- [ ] J2. iPhone on cellular, Mac on Wi-Fi behind its router: 診斷 shows either 已直連 or 「直連沒成功，改走中繼站」 with a reason — and chat keeps working either way (note which, with the network types; symmetric NATs are expected to fail without TURN).
- [ ] J3. While on 直連, turn Wi-Fi off on the phone (cellular takes over): the conversation keeps going over the relay within a few seconds, no message lost or doubled; after ~2 minutes 診斷 tries again.
- [ ] J4. Empty `iceServers` again and restart the core: 診斷 has no WebRTC row and 路徑 is 中繼站.
- [ ] J5. Open a conversation, wait for the answer, then quit the core (or turn on airplane mode). Close and reopen the Home Screen app: the conversation shows from the phone's saved copy with 「離線中 · 顯示 … 的內容（加密存在這支手機）」, including the last answer; no approve / stop buttons.
- [ ] J6. Still offline, type two messages and start a 新對話 with one more: each shows 排隊中 · 連上電腦後送出 with 刪除. Bring the core back: they go out in the order typed, once each (check the Mac: no doubles), and the new conversation appears once.
- [ ] J7. Offline again, type a message, then force-quit the app before it reconnects; reopen with the core back: the message is sent once.
- [ ] J8. Storage: after a day without opening the app (J5 setup), the saved copy is still there in the Home Screen app. In a plain Safari tab, expect iOS to evict it after a while — that is a lost cache, not an error (the app reloads from the computer).
- [ ] J9. 撤銷 the phone on the Mac, or 忘記這台電腦 on the phone: reopening offline shows no saved conversations (keys destroyed first).

## K. Conversation list on the phone (P13)

Setup: a paired iPhone (Home Screen app) with scope `approve`, and more than 50 conversations on the Mac (e.g. after `ALCA_SHOTS_ONLY=settings`, or by hand).

- [ ] K1. Open the drawer: the newest 50 show, then 載入更多; tapping it adds the next page with no conversation missing or doubled.
- [ ] K2. Tap ⋯ on a conversation → 封存: it leaves the drawer at once; on the Mac it is under 已封存的對話 and opens read-only as before.
- [ ] K3. ⋯ → 刪除: the button turns into 「確定刪除？內容找不回來」; a second tap deletes it. It is gone from the drawer and from the Mac, and does not come back after reopening the app or reconnecting.
- [ ] K4. Delete the conversation that is open on the phone: the phone moves to the newest remaining conversation (or the empty state), and the Mac does not show it either.
- [ ] K5. A conversation a routine or a running worker uses: 刪除 shows 「沒有完成：這個對話還有…」 naming what still uses it; nothing is deleted.
- [ ] K6. A device paired with `chat` only: ⋯ shows 封存 but no 刪除.
- [ ] K7. Delete a conversation on the Mac while the phone is offline (J5 setup), then bring the phone back: expected, the drawer reloads from the computer and the conversation is gone (only the encrypted saved copy had it). Note it if the saved copy still shows it after 已連線.

## N. Add-ons, 主動留意 and 回覆檢查 (P14)

Setup: a Mac with `claude` signed in (haiku is enough), this commit, a throwaway data folder, the phone paired with `chat` + `approve`, and router mode (`--agents router`). For N3–N5, connect a calendar app to the bot (or use a deadline in conversation: 「我 3 天後要交報告」).

- [ ] N1. Desktop: open a bot's editor → 擴充. Four rows: 主動留意 (vermilion 「會自己消耗額度」), 回覆檢查, 提前做, 小模型審 shell — all off. Turn 主動留意 on; 設定 shows its defaults (2 per day, 22:00-08:00, 3 h, 30 min, sources, caps). Save a bad quiet-hours value → refused with a sentence.
- [ ] N2. Phone: the bot's sheet shows the same list with today's usage; the switch works with `approve` and is greyed with `chat` only. Turning 主動留意 off on the phone shows off on the desktop after a reload.
- [ ] N3. With 主動留意 on and nothing new: wait one scan → no card, today's usage stays 0 tokens.
- [ ] N4. With a deadline 3 days out: within a scan or two a card 「[事實＋時間]。要我 … 嗎？」 appears in the bot's 主動留意 conversation, in the desktop card strip and in the phone's 待處理, and the phone gets one notification (a fixed sentence). Outside quiet hours only; a second card waits for the minimum gap. On a Claude Code bot, 主動留意's usage for the day stays close to its 每日 token 上限 (default 30000): its homework worker gets at most what is left (≤ 20000) and stops when its booked tokens reach that, without the report-only pass when nothing is left.
- [ ] N5. Answer three cards: 好 → a worker starts and anything that would send / pay / delete / post still asks; 先不用 → the card leaves 待處理; 別再提這類 → it leaves and the same kind is not offered again (a suppress preference appears in 記憶).
- [ ] N6. 回覆檢查 on: 設定 → 檢查用的模型 lists 「跟這個 bot 的總機模型一樣（預設）」 first, then your configured services' models; pick a small one (e.g. Haiku) on the desktop, then change it on the phone → both show the same pick. Ask something that tempts two questions (「幫我規劃週末」) → if the reply is rewritten, desktop and phone swap the text and mark it 已修改.
- [ ] N7. Set 回覆檢查's 每日次數上限 to 1 and send two messages → the second is not checked; the row says 「今天的額度用完了」. Raising the cap the same day keeps it capped until tomorrow. The usage's `tokens` is above 0 after the first check. Note whether checks on a Claude Code bot finish within the 4 s default `timeoutSec` (a cold CLI start can take most of it).

## O. Worker harness on a real Mac (haiku)

Setup: a Mac with `claude` signed in (haiku is enough), this commit, a throwaway data folder, router mode (the default, `--agents router`), and the phone paired with `chat` + `approve` for O3. For O1 and O4, make a small throwaway git repo (for example a two-file TypeScript package whose `npm test` fails on one function) and set it as the bot's 工作資料夾. Use a bot on the Claude Code engine with the haiku model.

- [ ] O1. Coding dispatch + host verification + reviewer. Bot editor → 進階: 預設 harness 「程式」, turn 獨立審查 on, save. Ask the bot 「修好這個 repo 裡失敗的測試，`npm test` 要全過」 → the router starts a worker whose panel (工作狀態) shows harness 程式, its 完成條件 and 預算用量 counting steps. Native edits and commands go through Alca's gate and raise cards as the bot's level requires (at 每步確認 every edit and command asks; approve them); after the worker says it is done, the panel shows a verification round with the check red → green (通過). With the reviewer on, a finished worker either ends done or shows 審查者認為還沒做到 with its gaps and carries on (at most twice). If the check stays red for three rounds, the worker ends `unverified` with the failing output — it never reports done on a red check.
- [ ] O2. General `web_fetch`. Ask 「讀一下 https://example.com 的內容，告訴我標題」 → a general worker (harness 一般) fetches the page and the answer quotes its title. Then ask it to fetch `http://127.0.0.1:8787/` or `http://169.254.169.254/` → refused (not a public address); nothing on the Mac is read.
- [ ] O3. NEEDS_INPUT answered from the panel. Ask for something only you can decide (「幫我挑一個週末的時段，先問我要哪一天」) → the worker stops with 工人在等你回答: at most 3 questions, each shown once with its number (no 「1. 1.」), the recommended option first (建議) even when the model marked another option 「（推薦，…）」, a question about a sign-in or payment marked 只有你能回答. Answer on the desktop (送出回答) → a continuation worker carries on with the same task. Repeat and answer on the phone's worker sheet → same result; the phone needs `approve` for this.
- [ ] O4. 完全授權. Bot editor → 進階 → 完全授權: turning it on shows the warning and 確定要開啟完全授權？ with 先不要 / 我了解，開啟完全授權; 先不要 leaves it off. Turn it on and save. On the phone's bot sheet it shows 完全授權已開啟 with only a 關閉完全授權 button (no way to turn it on there). In the repo with a remote you can push to, ask the coding worker to commit and `git push` → no card; the worker panel's 完全授權 list shows the push. Ask a worker to send an email (or `curl -X POST` somewhere) → a card still appears. Turn 完全授權 off on the phone → off on the desktop after a reload.
- [ ] O5. Snapshots. With 完全授權 on, after a coding worker changed files (any engine — Claude Code, ACP, an API key or Codex; at 完全授權 every coding turn starts from a snapshot): worker panel → 顯示快照 lists 「第 n 輪之前」 entries (`git for-each-ref refs/alca/snapshots` in the repo shows the same refs). 還原 asks once more, then the files are back to that point and a new snapshot of what was there is listed; `git log` and the branch did not move. 清除 / 清除全部 ask once more and remove the refs; the files do not change. In a folder that is not a git repo (decision of 11-05), coding at 完全授權 still dispatches and runs, and the files do change; there is no snapshot: the worker panel's 完全授權 list says 「這個資料夾不是 git，沒有快照可還原」, 顯示快照 lists nothing, and the dispatch ledger has one `snapshot.skipped` (`not_git`) for the worker however many turns it ran. In a git repo whose snapshot fails (e.g. a git error), the turn still runs, the ledger has `snapshot.skipped` (`snapshot_failed`) and the list says 「本輪快照失敗」. The bot editor's 完全授權 warning says git folders keep a snapshot before every coding turn and non-git folders have none, so their changes cannot be undone. Payment and outward sends still ask at 完全授權. At 自主 / 每步確認 no snapshot is kept (unchanged).
- [ ] O5b. In the non-git folder of O5, give two tasks at once where one coding worker ends unverified (no check to run) → the router's reply says that one is 未驗證 / unverified (changed but not checked) and never 「都做了」「做好了」 or 「完成了」 for it; if it does, the 「Alca 註記」 follows the reply.
- [ ] O6. `pnpm screenshots:p6` (see `docs/screenshots/README.md`, with Google Chrome) → writes `worker-panel-desktop.png`, `snapshots.png`, `bot-editor-advanced.png` and, with Chrome, the two phone shots into `docs/screenshots/`; open them and check nothing is cut off in dark mode.
- [ ] O7. `ALCA_EVALS_LIVE=1 pnpm evals:live --harness` → runs the 6 worker-harness cases on haiku through the real CLI and writes a markdown report into `evals-report/live/`; each case shows pass or fail with the model's report. Without `ALCA_EVALS_LIVE=1` it refuses to run.
- [ ] O8. Claude Code `--max-turns`. `claude -p "list three files, one tool call at a time" --model haiku --max-turns 1 --output-format stream-json --verbose` → the flag is accepted and a `result` line has `subtype: "error_max_turns"` (not necessarily the last line: claude 2.1.316 prints a `system` / `task_summary` line after it; Alca reads every line) (Alca reads that as a max-turns stop). Alca launches coding workers with `--max-turns 240` and general workers with `--max-turns 120` (`core/src/agents/claude.ts`), so O1 and O2 running normally also show the flag is accepted in a worker launch.
- [ ] Codex (app-server, coding at `untrusted`, on-request at 完全授權): **not verified yet** — if you have Codex, repeat O1 and O4 with a Codex bot and report the CLI version.

## P. Keychain and the core's keys

Setup: a Mac, this commit, and two throwaway data folders: one last used by an older build (copy one, e.g. `cp -R ~/.alca ~/alca-d1-upgrade`), one new (`~/alca-d1-new`). Note `KC=$(cd apps/desktop && node -e 'import("@alca/os").then(m=>console.log(m.keychainAccount(process.argv[1])))' ~/alca-d1-upgrade)` — the item's account for that folder.

- [ ] P1. Upgrade: start on `~/alca-d1-upgrade` → the log says the Link identity and push key moved into the vault (`vault:keychain-macos`) and `保管庫金鑰：macOS 鑰匙圈`. Write down whether macOS showed **any prompt** (it should not). `cat ~/alca-d1-upgrade/secrets.json ~/alca-d1-upgrade/secrets.json.bak` → only `core.localToken` and `core.secretsIn`. A phone paired before the upgrade still connects (no re-pair) and still gets a test push (診斷 → 傳一則測試通知).
- [ ] P2. Same user, another terminal: `security find-generic-password -s alca-agent -a "$KC" -w` → write down whether it prints the key **without a prompt** and whether Keychain Access shows the item as `alca-agent` / `$KC`.
- [ ] P3. `security find-generic-password -s alca-agent -a no-such-item -w; echo $?` → `44`. Lock the login keychain (`security lock-keychain ~/Library/Keychains/login.keychain-db`), start the core on `~/alca-d1-upgrade` → it either prompts to unlock or stops with 「保管庫打不開…」 and the `security` exit code / message; write down which, and that **no** new identity was made (`alca secrets status` still shows the keys in the vault). Unlock again.
- [ ] P4. New folder: start on `~/alca-d1-new` → one item `alca-agent` / `vault-key-<12 hex>` created on the first start (before any secret is saved) — never the shared `vault-key`, even when that item exists, `vault.key` does **not** exist, `pnpm alca secrets status --data-dir ~/alca-d1-new` → keys in the vault, key in the macOS Keychain, not degraded.
- [ ] P5. Delete the item (`security delete-generic-password -s alca-agent -a "$KC"`), start on `~/alca-d1-upgrade` → startup stops with the 「保管庫打不開或少了 Alca 的身分」 message naming `alca secrets export` / `reset`; `secrets.json` unchanged; no new identity.
- [ ] P6. Export / import / downgrade: stop the core; `pnpm alca secrets export --to-file ~/alca-d1.json --confirm --data-dir ~/alca-d1-new` → 0600 file; check out an older commit, copy it over `~/alca-d1-new/secrets.json`, start → the phone paired with `~/alca-d1-new` connects without re-pairing. Back on this commit: `pnpm alca secrets import ~/alca-d1.json --confirm --data-dir ~/alca-d1-other` (a folder that does not exist yet) → it is created `drwx------` and starts with the same identity. Delete `~/alca-d1.json`.
- [ ] P7. `ALCA_VAULT_BACKEND=file pnpm alca secrets status --data-dir ~/alca-d1-new` on a fresh folder after one start → 「降級：設定為只用檔案」. Time Machine (or `cp -R`) the folder into another macOS account and start there → stops with the vault message (that account's keychain does not have the key), no new identity.

## Q. Web search, MCP servers

(Gmail and Google Calendar come only through Composio (連接 › app 與帳號). `engineering.google` in `config.json` is only 用 Google 帳號啟用遠端's client.)

1. 設定 › 網路搜尋 → Brave with your key → ask a worker to search; the answer cites real hits. Same with a SearXNG on the LAN (`http://<host>:8888`), then a `web_fetch` of a hit on that host is refused.
2. Add a local stdio MCP server (for example a filesystem or notes server via `npx`) from the window Alca opened (another window says it cannot); 檢查 shows its tool count; a bot finds its tools labelled 我的 MCP; a sending tool asks first. With a Claude Code bot, ask 「用我連接的 MCP 檔案伺服器讀 note.txt，再建 new.txt」: the worker is general (not coding), `connector_accounts` shows `app=mcp-<id>`, `connector_find_tool` works with `app` set to the server id, its label or `mcp-<id>`, and `tool_search` lists the server's tools under `apps`.
3. Add a remote Streamable HTTP MCP server with an `Authorization` secret; 檢查 works; the secret value never appears in the UI.
4. On the phone: the MCP accounts are listed; 只讀 → 不能用 works, 可操作 is greyed out.
5. Upgrade from a build that had Google direct with a Google account connected there: after the first start of this build the account is gone from 連接 and its 收件匣有新信 trigger no longer fires (`sqlite3 ~/.alca/state.sqlite "select provider, status from connector_accounts where provider='google'"` → `google|removed`). (The grant at Google stays until you remove Alca at https://myaccount.google.com/permissions.)

## R. OS sandbox and browser channels

Setup: a Mac on macOS 26 (Tahoe) whose login shell is zsh, this commit, a throwaway data folder (`--data-dir ~/alca-c-test`), a bot whose engine is an API model (Alca's own loop) set to 自主 with sandbox 自動 and 可連網, and its work folder a small git repo with a `package.json`. Copy the worker panel's text and the command output into the report for every step.

- [ ] R1. Probe: the bot editor (進階 → 沙箱) says Seatbelt is available, and a coding worker's panel shows 「沙箱：Seatbelt」. Switch the bot to 逐步確認 → the next worker shows 「沙箱：關」 (自動 is on only at 自主 / 完全授權).
- [ ] R2. zsh on Tahoe: ask the worker to run `echo $0; uname -a; touch ok.txt; touch ~/alca-c-outside.txt`. The first three work (no zsh `hw.*` sysctl error); the last fails with "Operation not permitted" and the tool result's hint (「這個指令在沙箱內執行：只允許寫入工作資料夾與暫存資料夾…」); `ls ~/alca-c-outside.txt` → no such file.
- [ ] R3. Secrets: `cat ~/.ssh/known_hosts`, `ls ~/alca-c-test`, `security find-generic-password -s alca-agent -w` from the worker → all refused; `git config core.fsmonitor 'touch /tmp/pwn'` → refused (`.git/config` not writable); then 完全授權 a turn (snapshot runs) → `/tmp/pwn` does not exist.
- [ ] R4. Package managers inside: `npm install left-pad`, `pnpm add is-odd`, and in a Rust folder `cargo build` → succeed (caches writable); write down any that fail and the path they wanted.
- [ ] R5. `git push` over HTTPS with the osxkeychain helper: write down the exact error (the keychain services are refused inside). Ask the worker to retry with `unsandboxed: true` → a card says it runs outside the sandbox with your rights, **also at 完全授權**; approve → the push goes through.
- [ ] R6. Nested Seatbelt: from the worker run `sandbox-exec -p '(version 1)(allow default)' /usr/bin/true; echo $?` → write down the error text and exit code .
- [ ] R7. Network: set the bot to 不連網 (needs no approve key: tightening) → `curl -sS https://example.com` fails. Back to 可連網 (asks for the approve key) → it works; `curl -sS http://127.0.0.1:4317/` is refused even then (Alca's own port).
- [ ] R8. Claude Code (subscription bot, same settings): a coding turn starts (the `--settings` sandbox block is accepted by the real CLI — write down its version); its Bash `touch ~/x` fails while its Write tool to `~/x` asks (the file tools are outside the sandbox: expected); with 可連網 its Bash `curl -sS https://example.com` works (`allowedDomains: ["*"]` means every domain) and with 不連網 it fails. Write down Claude Code's exact message if its sandbox cannot start (with `failIfUnavailable` the turn must fail, never run unsandboxed).
- [ ] R9. Browser channels in a Space (agent driving): open `https://webrtc.github.io/samples/src/content/peerconnection/pc1/` and press Start/Call → refused (`NotAllowedError` in the page), while the same page works in your own Chrome; 稽核 has no WebRTC row (expected: the refusal is not reported while Alca keeps CDP `Runtime` off). Gmail and Slack web still load and work in a Space (service workers bypassed). Add a sensitive-site rule marking a chat site you use as `send`, have the agent type one message there → the tab goes to `about:blank`, the run shows the notice 「…可能已經生效…」, 稽核 has a `browser.channel.stopped` row; write down whether that one message arrived (it is expected to: the first frame cannot be stopped).

## S. Column encryption

Setup: a Mac, this commit, a copy of a real data folder that has been used for a while (`cp -R ~/.alca ~/alca-f2-test`, ideally around 1 GB), and the vault key in the macOS Keychain (`pnpm alca secrets status --data-dir ~/alca-f2-test` → not degraded). Copy the numbers and messages into the report.

- [ ] S1. Benchmark : `node --disable-warning=ExperimentalWarning scripts/bench-seal.ts` (defaults: 20000 events, 3 rounds) → write down plain / sealed write (events/s) and read (ms), and the Mac model.
- [ ] S2. Seal pass on ~1 GB: start on `~/alca-f2-test`; a minute later the background pass starts. Write down how long until 設定 → 資料 → 加密 says everything is sealed, and whether the UI stutters meanwhile (open conversations, scroll, send a message; note the worst delay you notice, and the p99 if you measure it). Restart in the middle → it resumes where it was.
- [ ] S3. Key gone: stop the core, delete the vault key from the keychain (as in P5), start → startup stops with the message that no new data key was made; nothing new is written (`ls -l ~/alca-f2-test/state.sqlite*` times unchanged); restore the key (or `alca secrets import`) → starts and reads the conversations.
- [ ] S4. Time Machine: after the pass finished and the old plaintext backups were deleted (設定 → 資料 → 加密, needs the approve key), let Time Machine back up the folder (or `cp -R`), then `strings -a <copy>/state.sqlite* <copy>/backups/* | grep -c '<a word from a conversation>'` → 0. Write down any hit and which file.
- [ ] S5. Upgrade a folder from before migration 28 that has a few conversations and a worker: send 「請記住這個暗號：獨特標記ZZQ77。只回答 好。」 first on the old build. After the first start of this build and the seal pass, `sqlite3 state.sqlite "select kind, title, substr(input,1,40) from jobs"` shows `turn` titles, no worker goal, and the rest in the sealed form; `grep -a 'ZZQ77' state.sqlite* backups/*` hits only backups taken before the pass finished, which 設定 → 資料 lists as plaintext.

## T. Interface language

Setup: a Mac, this commit, the desktop app (shell) and a paired phone. Default is `auto`; take one screenshot per item where the text matters and copy any Chinese left in an English screen (or the reverse) into the report with where it appeared.

- [ ] T1. macOS language English (System Settings → General → Language & Region, English first), `advanced.locale` unset: start the shell → the splash, the tray menu and its tooltip are English; open Alca → the whole window is English. Switch back to 繁體中文 first, restart → everything is 繁中 again.
- [ ] T2. 設定 → 進階 → 介面語言 → English (system still 繁中): the window reloads in English; quit and start the shell → the tray and splash follow the setting (English) even though the system is 繁中. Set it back to 跟隨系統 → 繁中 after the reload and after a shell restart.
- [ ] T3. Terminal with `LANG=C` (or `LC_ALL=POSIX`), setting on 跟隨系統: start the shell from it (`Alca.app/Contents/MacOS/alca-desktop-shell`) → the splash and tray are 繁中 (C/POSIX stay 繁中 by design; the shell reads `LC_ALL` / `LC_MESSAGES` / `LANG`, `paths.rs`). With `LANG=en_US.UTF-8` the shell is English. The `pnpm alca` command line is not part of the interface language: its messages are 繁中 whatever `LANG` says.
- [ ] T4. English UI, provoke core errors: add a bot whose name is already used; save a provider key over `http://` to a remote address; import a file that is not an Alca export → each message is English (they come from the core as Chinese plus a code). On the phone (English), the same name clash from the bot form → English.
- [ ] T5. Phone: 裝置 › 介面語言 → English while the computer stays 繁中 → only the phone changes, survives closing and reopening the PWA; offline banner and the notification words (service worker, follows the phone's system language) read sensibly.
- [ ] T7. English bot with a real model: in the bot editor set 進階 › 規則語言 → English, ask it in Chinese to look something up and in English to draft an email → it still dispatches a worker, the approval card for sending appears, and it replies in the language of each message — including the reply that relays an English request's worker result after earlier Chinese turns; a memory it should use (a preference you told it) still reaches the worker. Write down anything it does differently from the same bot set to 繁體中文.
- [ ] T6. English screens for layout: settings, the worker panel, the approval card, the bot editor and the phone's chat at the narrowest width → no text cut off or overlapping (English is longer). `ALCA_SHOTS_LOCALE=en pnpm screenshots docs/screenshots-en` takes the same screenshots in English to compare.

## H. Android (Chrome), if you have one

- [ ] H1. Open the PWA in Chrome: 診斷 shows an 安裝到主畫面 button; it installs.
- [ ] H2. B1–B8 behave the same (Android allows push from a browser tab too).
