# Alca Design System — 「素 Plain」

Status: adopted. It replaced the earlier 墨 Mono direction; tokens live in `packages/design/tokens.css`.
Scope: desktop app (`apps/desktop/ui`, Tauri shell) and iPhone PWA (`apps/phone-pwa`).
Evidence: §1 was written against screenshots of the earlier 墨 Mono UI (no longer in the repository); current screenshots are made with `apps/desktop/scripts/shots-plain.ts` and `apps/phone-pwa/scripts/shots-plain.ts` (see `docs/screenshots/README.md`).

> One sentence: **Alca should look like an app Apple ships, not a demo an AI generated.**
> Native structure (lists, toolbars, sidebars), one accent color, plain words, and
> technical detail kept one tap away instead of on every screen.

---

## 1. Diagnosis — why it "smells like AI"

"AI smell" is not one thing. It is the sum of default choices that LLM-written UIs reach for
because they are safe in isolation: pills, chips, dots, middle-dots, big bold titles, a
gradient-tinted card for anything important. Each is fine once; together they say "no one
decided". Below is what the 墨 Mono screenshots showed, worst first.

### 1.1 Shape: everything is a pill

| Symptom                                                                                                                                                          | Where                                                                                                                                                                  | Why it hurts                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Buttons, text fields, search boxes, tabs, tags, status chips and the composer are all fully rounded capsules (`--radius-pill` is used 109 times across app CSS). | `phone-bot-form-dark`, `phone-memory-dark`, `phone-routine-form-dark`, `desktop-bot-edit-dark`, `desktop-custom-provider-dark`                                         | When every element has the same shape, nothing reads as more important. Pill _inputs_ in particular look like buttons; iOS and macOS never draw text fields as capsules. |
| Radii are inconsistent: 6 / 10 / 14 / 20 / 28 / 9999 all appear on one screen; cards at 14–20 contain pills at 9999 and code blocks at 10.                       | `desktop-browser-dark` (approval card + kbd + id chip + buttons), `phone-workers-dark`                                                                                 | No radius logic (outer radius = inner radius + padding) → nested shapes fight.                                                                                           |
| Card-in-card: a status pill inside a card inside a card; a bordered box inside the approval card inside the timeline.                                            | `desktop-team-dark` (bot tiles with inset status pill), `phone-workers-dark` (inset box inside paging card), `desktop-skill-card-dark` (step list box inside red card) | Each border adds a level of hierarchy the content does not have.                                                                                                         |

### 1.2 Punctuation-as-design: middle dots and bullet dots

| Symptom                                                                                                                                                                                                                                           | Where                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Middle-dot chains as metadata: 「等你決定・一律確認・付款」, 「你說的・已編輯」, 「來自「…」・你改過・剛剛・用過 6 次・2 個版本」, 「聊天・批准・看畫面・控制電腦」, 「1 件進行中・1 件已結束」. 228 `·` and 15 `・` literals in UI strings/code. | `phone-browser-dark`, `phone-memory-dark`, `desktop-memory-dark`, `phone-devices-dark`, `phone-workers-dark` |
| Coloured status dots before almost every line: tool rows, worker results, "等你決定", "就緒", thread rows, routine logs (●●○ sparkline).                                                                                                          | `phone-chat-dark`, `desktop-dark` (top bar "• 就緒"), `desktop-routines-dark`, `desktop-team-activity-dark`  |
| Arrow/glyph shorthand: 「A → 研」, 「↳」, 「Alca › 工人「…」」 breadcrumbs inside cards.                                                                                                                                                          | `phone-team-trail-dark`, `desktop-team-activity-dark`, `phone-chat-approval-dark`                            |

Why: a dot or `・` is what you add when you have not decided what is primary. Native apps
show one primary line and _one_ secondary line; extra facts move to a detail view.

### 1.3 Colour used as decoration

- **Salmon/vermilion CTA and pink-gradient cards** for payment/delete approvals and learned
  skills (`phone-chat-approval-light`, `desktop-light`, `desktop-browser-light`,
  `desktop-skill-card-dark`, `desktop-skills-dark`, `phone-memory-forget-dark`). The salmon
  reads as "brand colour", not "danger", and a radial-gradient tint is the single most
  recognisable AI-template trope.
- **Coloured tag chips** everywhere: 已確認 (green), 推測 55% (amber), 所有 bot 共用 (outline),
  正常 / 提前做 / 草稿 / 排隊中 / 沒有完成 / 準備中 / 草稿好了 (4 colours), 可用 / 需登入 / 需金鑰 /
  未安裝 (`desktop-memory-dark`, `desktop-early-dark`, `desktop-providers-dark`,
  `phone-connectors-dark`). Users must learn a colour legend to read a list.
- **Six bot "ink" colours** with a CJK character in a tinted square (研 寫 行 事 人 專 整) as
  avatars for bots _and_ for memory types (`phone-team-dark`, `phone-memory-dark`,
  `desktop-skills-dark`). A single kanji in a tinted square is a placeholder, not an identity.

### 1.4 Typography

- **Giant bold sheet titles** (28px/600) on every sheet and form: 「新增 bot」「工人要付款」
  「選一台電腦」「忘記這件事？」「新增例行工作」(`phone-bot-form-dark`, `phone-chat-approval-dark`,
  `phone-pick-computer-dark`, `phone-memory-forget-dark`, `phone-routine-form-dark`). iOS
  sheets use a 17pt semibold centred nav title; size is not hierarchy when every screen shouts.
- **Centred hero wordmark** 「Alca」 + logo + tagline on the empty chat
  (`desktop-empty-dark`, `desktop-empty`, `desktop-threads-actions-dark`), a big left
  wordmark on phone (`phone-chat-empty-dark`, `phone-google-signin-dark`,
  `phone-pairing-dark`), and a letter-spaced 「A L C A」 eyebrow on dialogs
  (`desktop-enter-code-dark`). Landing-page theatre inside a tool.
- **Tiny grey text** (11–12px, `--c-ink-faint` #737373 on #0a0a0a ≈ 4.0:1) for explanations,
  footnotes and keyboard hints (`desktop-bot-edit-codex-dark`, `desktop-routines-dark`,
  the 「Enter 送出・Shift+Enter 換行・/ 回到輸入框・? 快捷鍵」 strip under every composer).
- Mono font used for user content (model ids, URLs, tool names) mixed into body text.

### 1.5 Controls chosen by habit, not by job

- **Segmented controls everywhere**: per-account 不能用 / 只讀 / 可操作 repeated on every row
  (`phone-connectors-dark`, `desktop-connectors-dark`); 權限 / 瀏覽器 / 記憶 in one dialog
  (`desktop-bot-edit-codex-dark`); page tabs with counts (記憶 7 / 技能・1 待定) at the top of
  every sheet; 每隔 / 每天 / 一次; 自動 / 交辦先問我 / 都先問我; 1 / 2 / 3; 深色 / 淺色 / 跟隨系統.
- **Horizontally scrolling chips**: suggestion cards cut off at the edge
  (`phone-chat-empty-dark`), filter chips 全部 7 / 偏好 1 / 人物 1 … (`phone-memory-dark`,
  `desktop-memory-dark`), pill tab row in settings (`desktop-settings-advanced-dark`).
- **Horizontally paging worker cards** with page dots (`phone-workers-dark`) — hides all but
  one worker.
- **Sheet on sheet**: forms open over a sheet over the chat (`phone-bot-form-dark`,
  `phone-routine-form-dark`, `phone-team-bot-dark`, `phone-memory-forget-dark`); the stack
  of grey edges at the top is visual noise and breaks "back".
- Desktop **settings is one long modal** with radio-cards, pill tab row and native
  `<select>`s (`desktop-settings-dark`, `desktop-settings-about-dark`) instead of a
  settings window with categories.
- **Keyboard hints inside buttons** (「允許一次 Ctrl↵」「拒絕 Ctrl⇧⌫」) (`desktop-browser-dark`).

### 1.6 Leaking the machine room

Raw implementation details are shown to the person using the app:

- Addresses: `127.0.0.1:43075/checkout`, `ws://127.0.0.1:41917/v0/link`, `wss://…`
  (`phone-browser-dark`, `phone-offline-queued-dark`, `desktop-link-dark`,
  `desktop-connection-dark`, `phone-diag-dark`, approval descriptions everywhere).
- Ids: `dev_01M6GN79`, `spl_…J1FE9N`, `…1AHP3R`, `bot_01M6HZ1J…`, 信箱 ID
  (`phone-chat-dark`, `desktop-browser-dark`, `desktop-bot-edit-p13-dark`,
  `desktop-connection-dark`).
- Tool names: `delete_note`, `GMAIL_SEND_EMAIL`, `browser_open`, `browser_click @8`
  (`desktop-dark`, `phone-send-approval-dark`, `desktop-worker-stream-dark`).
- Shell: `pnpm desktop:pair`, `npm install -g @anthropic-ai/claude-code`,
  `alca db restore <備份名稱>`, `/tmp/alca-shot-…/backups`, `config.json`, `Node 22.23.3 ·
  linux-arm64` (`phone-pairing-dark`, `desktop-settings-model-dark`,
  `desktop-settings-backups-dark`, `desktop-settings-about-dark`).
- Jargon: 總機, 工人, 看門狗, 示範引擎, 中繼站, 會合伺服器, ACP (Agent Client Protocol), OAuth
  token, 「不花 token」, Composio (`desktop-routines-dark`, `desktop-connectors-dark`,
  `desktop-custom-provider-dark`).

### 1.7 Structure and repetition

- The **same approval appears twice** (in chat _and_ in the browser/worker panel)
  (`desktop-browser-light`, `desktop-worker-stream-dark`), and resolved approvals keep their
  full card ("已允許一次" in a big box) (`desktop-workers-dark`).
- Assistant boilerplate repeated in every thread: 「收到：「…」。我是總機：負責…」
  (`desktop-dark`, `desktop-undo-*`). Even in a demo engine this teaches the wrong voice.
- Toolbar of **outlined pill buttons with count badges** (等你決定 / 工人 1 / 瀏覽器 2 / 中斷 Esc)
  (`desktop-dark`, `desktop-workers-light`).
- The phone has **no stable navigation**: chat is home, everything else is a sheet reached from
  a drawer whose bottom items are rows of text (`phone-threads-dark`).
- Every relative time says 「剛剛」 and is right-aligned on every sidebar row
  (`desktop-threads-more-dark`) — noise when it carries no information.

---

## 2. Direction — 素 Plain

**Principles (in order; when two conflict the earlier wins):**

1. **Native first.** Use the structure people already know: iOS inset grouped lists, nav bar
   with collapsing large title, tab bar, sheets with detents; macOS sidebar source list,
   unified toolbar, inspector, settings window. Do not invent a container when a list row works.
2. **One primary thing per screen.** Each screen has one title, one primary action, and one
   primary line per row. Secondary facts go to a second line, then to a detail view.
3. **Colour means state.** Greys for everything; one accent (blue) for "you can tap this /
   this is selected"; orange only for "Alca is waiting on you"; red only for destructive or
   failed; green only for a completed check. Never decorative tints, never gradients.
4. **Plain words, details on demand.** No ids, addresses, tool names or commands in primary
   UI. A 「技術細節」 disclosure or Settings › 進階 holds them.
5. **Quiet motion, instant feedback.** Press state within one frame; transitions explain where
   things go; nothing bounces for fun.

**Personality:** calm, precise, warm in wording, never cute. References and what we take:

| Reference                           | Take                                                                                                                                                                                         | Leave                               |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| apple.com / iOS Settings / Messages | inset grouped lists, SF type scale, large title collapse, restraint, one blue                                                                                                                | marketing hero scale inside the app |
| Instagram / X / Grok                | true-black dark mode, monochrome chrome, content-first, icon-only toolbars, bottom tab bar                                                                                                   | engagement badges, red dots         |
| Things 3                            | generous row spacing, checkmark moments, sheets that feel physical                                                                                                                           | custom colours per area             |
| Linear / Raycast                    | keyboard-first desktop, ⌘K, dense but aligned lists, subtle hairlines                                                                                                                        | purple brand glow                   |
| Arc                                 | sidebar as the home of everything                                                                                                                                                            | colourful spaces                    |
| Telegram / iMessage                 | bubble grammar (only the user bubbles), timestamp on demand, read state small                                                                                                                | stickers, chat backgrounds          |
| Muse / Duet / OpenMaus (agent apps) | approval as deterministic UI with the exact action on the button (「付款 NT$1,280」, not 「允許」); activity log behind the agent, not in the transcript; clear states: 準備中 / 等你 / 完成 | multicolour status systems          |

### 2.1 Information architecture (both platforms)

Four top-level areas, same names everywhere:

| Area     | zh-Hant-TW | en       | Holds                                                                            |
| -------- | ---------- | -------- | -------------------------------------------------------------------------------- |
| Chats    | 對話       | Chats    | threads; a thread is chat + its activity                                         |
| Activity | 進行中     | Activity | **需要你** (pending approvals, drafts to review) on top, running tasks, routines |
| Library  | 資料庫     | Library  | Team (bots), Memory, Skills, Connections                                         |
| Settings | 設定       | Settings | general, model & providers, devices, notifications, advanced (diagnostics)       |

- **Phone:** tab bar with these four tabs. Chat (a single thread) is pushed and hides the
  tab bar. The orange badge on 進行中 is the only global "waiting on you" indicator.
- **Desktop:** sidebar sections in the same order; 需要你 is the first sidebar row with a
  count. Inspector on the right shows the selected thread's tasks / browser / details.

### 2.2 Typography

System fonts only (CSP `font-src 'self'`, and native is the point). Latin first, then TC:

```css
--font-text: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang TC",
  "Segoe UI Variable Text", "Segoe UI", "Noto Sans TC", "Microsoft JhengHei", system-ui, sans-serif;
--font-display: -apple-system, BlinkMacSystemFont, "SF Pro Display", "PingFang TC",
  "Segoe UI Variable Display", "Segoe UI", "Noto Sans TC", "Microsoft JhengHei", system-ui, sans-serif;
--font-mono: ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace;
```

Rules:
- Weights: 400, 500, 600; 700 only for the phone large title. Never 300.
- Tracking: 0 for CJK. Latin display sizes ≥ 20px use `-0.01em`; never positive tracking or
  uppercase letter-spaced eyebrows.
- CJK needs more leading than Latin: paragraphs ≥ 1.6; single-line labels 1.3.
- Mono is for code blocks and the 技術細節 disclosure only, never inline in sentences.
- Numbers in tables/times: `font-variant-numeric: tabular-nums`.
- Half-width space between CJK and Latin/digits (「3 個檔案」「NT$1,280」「iPhone 上」), as Apple TW does.

**Phone scale** (iOS Large Dynamic Type, px = pt):

| Token             | Size / line | Weight | Use                                                               |
| ----------------- | ----------- | ------ | ----------------------------------------------------------------- |
| `--t-large-title` | 34 / 41     | 700    | root screens (對話, 進行中, 資料庫, 設定); collapses to nav title |
| `--t-title2`      | 22 / 28     | 600    | approval action line, pairing step title                          |
| `--t-title3`      | 20 / 25     | 600    | empty-state line                                                  |
| `--t-headline`    | 17 / 22     | 600    | nav title, row title emphasis                                     |
| `--t-body`        | 17 / 24     | 400    | rows, chat text (chat paragraphs use line 26)                     |
| `--t-callout`     | 16 / 22     | 400    | buttons inside cards, composer                                    |
| `--t-subhead`     | 15 / 20     | 400    | row subtitle                                                      |
| `--t-footnote`    | 13 / 18     | 400    | section footers, help text                                        |
| `--t-caption`     | 12 / 16     | 400    | timestamps, badges (minimum)                                      |

**Desktop scale** (macOS with CJK bump; macOS body is 13pt, CJK reads badly below 14px):

| Token          | Size / line | Weight | Use                                                  |
| -------------- | ----------- | ------ | ---------------------------------------------------- |
| `--t-title`    | 22 / 28     | 600    | page title in content (Library pages, Settings pane) |
| `--t-headline` | 15 / 20     | 600    | section heading, card title, toolbar title           |
| `--t-body`     | 14 / 20     | 400    | UI text, rows, sidebar                               |
| `--t-reading`  | 15 / 24     | 400    | chat messages, drafts, memory text                   |
| `--t-small`    | 12 / 16     | 400    | secondary row line, help text                        |
| `--t-caption`  | 11 / 14     | 500    | section labels in sidebar, kbd (minimum)             |

Dynamic Type on phone: set the root from iOS text size and express every size in `rem`:

```css
html {
  font-size: 106.25%;
} /* 17px fallback */
@supports (font: -apple-system-body) {
  html {
    font: -apple-system-body;
  }
}
/* then all --t-* in rem: 17px = 1rem, 34px = 2rem, 13px = .7647rem … */
```

Layouts must survive 1.6× text (AX sizes): rows wrap, never truncate titles to one line in
approval, trailing values move under the title when the row would overflow.

### 2.3 Colour

Neutrals follow Apple's system greys so the PWA sits naturally on iOS. One accent: **Alca
Blue**. All text pairs below were checked ≥ 4.5:1 (computed with WCAG relative luminance).

**Light**

| Token             | Value                    | Use                                                                    | Contrast                      |
| ----------------- | ------------------------ | ---------------------------------------------------------------------- | ----------------------------- |
| `--bg`            | `#FFFFFF`                | plain screens, chat, desktop content                                   | —                             |
| `--bg-grouped`    | `#F2F2F7`                | phone grouped screens, desktop sidebar base                            | —                             |
| `--bg-cell`       | `#FFFFFF`                | grouped cells, cards                                                   | —                             |
| `--bg-elevated`   | `#FFFFFF` + shadow       | popover, menu, sheet                                                   | —                             |
| `--fill`          | `rgb(120 120 128 / .12)` | tinted buttons, user bubble, search field                              | —                             |
| `--fill-hover`    | `rgb(120 120 128 / .08)` | desktop hover                                                          | —                             |
| `--fill-selected` | `rgb(0 102 204 / .12)`   | selected sidebar row (focused window)                                  | —                             |
| `--separator`     | `rgb(60 60 67 / .29)`    | 0.5px hairlines                                                        | —                             |
| `--label`         | `#1D1D1F`                | primary text                                                           | 16.8 on #FFF                  |
| `--label-2`       | `#6E6E73`                | secondary text                                                         | 5.07 on #FFF, 4.54 on #F2F2F7 |
| `--label-3`       | `#86868B`                | placeholders, disabled, decorative icons only (not text you must read) | 3.6                           |
| `--accent`        | `#0066CC`                | links, selected state, tinted icons                                    | 5.57 on #FFF                  |
| `--accent-fill`   | `#0071E3`                | filled primary button bg (white label)                                 | 4.70                          |
| `--waiting`       | `#A35200`                | "等你" text/icon, badge bg (white text)                                | 5.58                          |
| `--danger`        | `#C4161C`                | destructive text, error text                                           | 6.04                          |
| `--danger-fill`   | `#D70015`                | destructive filled button (white label)                                | 5.38                          |
| `--success`       | `#1F7A34`                | completion check, "已連線"                                             | 5.40                          |

**Dark** (true black canvas like iOS/Instagram/X; cells lift by lightness, not shadow)

| Token             | Value                                       | Use                                              | Contrast        |
| ----------------- | ------------------------------------------- | ------------------------------------------------ | --------------- |
| `--bg`            | `#000000` phone / `#1C1C1E` desktop content |                                                  |                 |
| `--bg-grouped`    | `#000000` phone / `#161618` desktop sidebar |                                                  |                 |
| `--bg-cell`       | `#1C1C1E`                                   | cells, cards                                     |                 |
| `--bg-elevated`   | `#2C2C2E`                                   | popover, menu, sheet                             |                 |
| `--fill`          | `rgb(120 120 128 / .24)`                    | tinted buttons, user bubble                      |                 |
| `--fill-hover`    | `rgb(120 120 128 / .16)`                    |                                                  |                 |
| `--fill-selected` | `rgb(77 163 255 / .20)`                     |                                                  |                 |
| `--separator`     | `rgb(84 84 88 / .60)`                       |                                                  |                 |
| `--label`         | `#F5F5F7`                                   |                                                  | 19.3 on #000    |
| `--label-2`       | `#98989D`                                   |                                                  | 5.93 on #1C1C1E |
| `--label-3`       | `#636366`                                   | placeholders/disabled only                       |                 |
| `--accent`        | `#4DA3FF`                                   |                                                  | 6.48 on #1C1C1E |
| `--accent-fill`   | `#0071E3`                                   | same as light; `#0A84FF` fails with white (3.65) | 4.70            |
| `--waiting`       | `#FFB340`                                   |                                                  | 9.54 on #1C1C1E |
| `--danger`        | `#FF6961`                                   |                                                  | 6.03 on #1C1C1E |
| `--danger-fill`   | `#D70015`                                   | same as light (`#E5332A` fails at 4.34)          | 5.38            |
| `--success`       | `#32D74B`                                   |                                                  | 8.88 on #1C1C1E |

Rules:
- No tinted backgrounds for semantic states (`*-soft` tokens go away). State = icon + text
  colour. Exception: the offline banner uses `--fill` (neutral).
- Bot identity: drop the six ink tones. A bot avatar is a **monochrome glyph on `--fill`**
  (initial in Latin or the bot's chosen SF-style symbol), or a user-picked photo/emoji later.
  Colour does not distinguish bots; the name does.
- Theme default: **follow system** on both platforms (today dark is forced as base).
- Live page frame captions keep a fixed dark overlay (`rgb(0 0 0 / .72)` + white text) in
  both themes.

### 2.4 Spacing, layout, density

4px grid; tokens `--s-1:4 --s-2:8 --s-3:12 --s-4:16 --s-5:20 --s-6:24 --s-8:32 --s-10:40 --s-14:56`.

|                      | Phone                                       | Desktop                                               |
| -------------------- | ------------------------------------------- | ----------------------------------------------------- |
| Screen gutter        | 16 (grouped list inset 16; cell padding 16) | content max-width 720 for chat, 880 for Library pages |
| Row min height       | 44 single line, 60 with subtitle            | sidebar 28; list 32 single / 48 with subtitle         |
| Touch / click target | ≥ 44×44                                     | ≥ 24×24 hit area, 28 for toolbar buttons              |
| Section gap          | 32 between grouped sections; 8 header→cells | 24 between sections                                   |
| Nav bar              | 44 + large title 52 (collapses)             | unified toolbar 52 (traffic lights inset)             |
| Tab bar              | 49 + safe area                              | —                                                     |
| Sidebar              | —                                           | 240 (min 200, max 320, resizable)                     |
| Inspector            | —                                           | 340 (min 300)                                         |

Density rule: at most **two lines of text per row** and **one trailing element** (value,
switch, chevron, or time). If a row needs more, it needs a detail view.

### 2.5 Radius

Concentric: inner radius = outer radius − padding. Capsules are allowed for exactly three
things: **count badges, the chat composer, and the phone's segmented-control thumb**.

| Token        | px   | Use                                                                           |
| ------------ | ---- | ----------------------------------------------------------------------------- |
| `--r-xs`     | 4    | kbd, inline code, tiny tags in 技術細節                                       |
| `--r-sm`     | 6    | desktop push buttons, inputs, sidebar selection, menu items                   |
| `--r-md`     | 10   | phone text fields, phone inline buttons, desktop cards, popovers' inner items |
| `--r-lg`     | 12   | phone grouped sections / cards, phone full-width buttons, desktop popovers    |
| `--r-xl`     | 16   | desktop modal windows/sheets, inspector cards                                 |
| `--r-sheet`  | 14   | phone sheet top corners (fits iOS 17/18; iOS 26 devices still look right)     |
| `--r-bubble` | 18   | user bubble (tail-less, iMessage-like)                                        |
| `--r-full`   | 9999 | the three capsule cases above only                                            |

### 2.6 Elevation

Flat by default; separation by `--bg-grouped` vs `--bg-cell` and 0.5px hairlines.

| Level | Light                                                  | Dark                                                        | Use                                |
| ----- | ------------------------------------------------------ | ----------------------------------------------------------- | ---------------------------------- |
| 0     | none                                                   | none                                                        | everything in-flow                 |
| 1     | `0 1px 2px rgb(0 0 0/.06), 0 0 0 .5px rgb(0 0 0/.06)`  | `0 0 0 .5px rgb(255 255 255/.08)`                           | desktop cards in content, composer |
| 2     | `0 8px 28px rgb(0 0 0/.14), 0 0 0 .5px rgb(0 0 0/.08)` | `0 8px 28px rgb(0 0 0/.6), 0 0 0 .5px rgb(255 255 255/.10)` | popover, menu, toast               |
| 3     | `0 24px 64px rgb(0 0 0/.22)`                           | `0 24px 64px rgb(0 0 0/.7)`                                 | sheet, modal window                |

Translucency: toolbar, nav bar and tab bar use `backdrop-filter: saturate(180%) blur(20px)`
over `color-mix(in srgb, var(--bg) 78%, transparent)` with a hairline that appears only when
content scrolls under it. Provide an opaque fallback under `@supports not (backdrop-filter…)`
and when `prefers-reduced-transparency: reduce`.

### 2.7 Motion

| Token          | Value                       | Use                                           |
| -------------- | --------------------------- | --------------------------------------------- |
| `--d-instant`  | 80ms                        | press highlight in/out                        |
| `--d-fast`     | 150ms                       | hover, toggle, chevron rotate, fade of badges |
| `--d-base`     | 250ms                       | push/pop, disclosure expand, toast in         |
| `--d-sheet`    | 420ms                       | sheet present (spring)                        |
| `--e-standard` | `cubic-bezier(.2,0,0,1)`    | most transitions                              |
| `--e-exit`     | `cubic-bezier(.4,0,1,1)`    | dismiss                                       |
| `--e-spring`   | `cubic-bezier(.32,.72,0,1)` | sheets, drawer (keep existing)                |

- Press feedback: background goes to `--fill` (rows) or the fill darkens 8% (buttons) in
  ≤ 80ms. **No `scale(0.97)` bounce** on buttons (current `.btn:active`).
- Streaming text appears without per-token fade; a single caret blink at the end is enough.
- Running state: a 12px system-style spinner (8 ticks), never pulsing dots.
- `prefers-reduced-motion: reduce`: durations → 0 except crossfades at 150ms; sheets fade.

### 2.8 Iconography

- One outline set (current inline SVGs are Lucide-like; keep the set, normalise it):
  stroke **1.5** at 20px (phone) and **1.5 at 16px** (desktop); round caps/joins;
  `currentColor` only.
- Sizes: 16 (desktop rows, inline), 20 (phone rows, desktop toolbar), 24 (phone nav/tab bar),
  28 (approval leading icon in a 44px circle).
- Tab bar: filled variant for selected tab, outline for others.
- Banned: ✦ sparkle for "learned/AI", emoji as UI, coloured icon tiles, kanji-in-square avatars.
- Icons pair with text in navigation; icon-only is allowed in toolbars with a tooltip and
  `aria-label`.

### 2.9 Feedback ("haptics")

- iOS Safari has no Vibration API (`navigator.vibrate` in `app/dom.ts` is a no-op on iPhone).
  Use a native `<input type="checkbox" switch>` for toggles: recent Safari on iOS renders it as
  a system switch with a system haptic (verify on device; fall back to the styled switch).
- Every decision gets a visible outcome within 100ms: approve → button turns into a spinner
  then the sheet collapses into a one-line "已付款" receipt row in the chat; deny → sheet
  dismisses, row reads 「你拒絕了付款」.
- Success moments: a checkmark that draws in 250ms (Things-style). Only for: approval done,
  pairing done, task finished while the user is watching.
- Errors: inline under the control, red text with an icon, never a shake.

---

## 3. Component specs

Phone values first, desktop in brackets when different.

### 3.1 Navigation bar (phone) / toolbar (desktop)

Phone:
- Root tabs: large title (34/700) left-aligned at 16px gutter under a 44px bar; on scroll it
  collapses into a centred 17/600 nav title over a translucent bar. Trailing: ≤ 2 icon buttons
  (24px icons, 44px hit).
- Pushed screens: back chevron + previous title (truncate to 「返回」 when long), centred title
  17/600, trailing text button in accent (「編輯」「完成」) or one icon.
- Chat screen: title = thread name (17/600, one line), subtitle = connection status only when
  not healthy (「電腦離線」 in `--label-2`), never 「Alca・已連線」 when all is fine.

Desktop (Tauri `titleBarStyle: Overlay`, hidden title):
- 52px unified toolbar spanning content+inspector; traffic lights sit over the sidebar.
- Left: sidebar toggle. Centre-left: thread title 15/600 + nothing else.
- Right: icon buttons, no borders, no pills: `Inspector` (⌥⌘I), `New chat` (⌘N). A task
  count or waiting count is a small capsule badge on the inspector icon (orange when waiting).
- 「中斷 Esc」 becomes a **Stop** icon button that appears only while a reply streams.

### 3.2 Sidebar (desktop) / tabs + thread list (phone)

Desktop sidebar (source list):
- Background `--bg-grouped`, no border; a hairline separates it from content.
- Rows 28px, 16px icon, 14px text, `--r-sm` selection in `--fill-selected` (accent text when
  window is focused; grey when not).
- Order: 需要你 (count badge orange) · 進行中 · section label 「對話」 then threads grouped
  by 今天 / 昨天 / 過去 7 天 / 更早 (section labels 11/500 `--label-2`, no uppercase).
- Thread row: title only. A trailing orange dot-less **count** if it waits on you; no
  「剛剛」 on every row (time shows on hover as tooltip).
- Bottom: 資料庫 group (團隊, 記憶, 技能, 連接) and Settings gear. Remove the
  「權限：每步確認」 footer and the phone/theme/keyboard icon row (they live in Settings).
- 「載入更多」 → infinite scroll; 「已封存的對話」 → a row at the end of the list.

Phone:
- 對話 tab = threads list, inset grouped is wrong here; use a **plain list** like Messages:
  row 72px: bot avatar 40, title 17/600, preview 15 `--label-2` 1–2 lines, trailing time
  13 `--label-2`. Waiting threads show trailing orange 「等你」 text instead of time.
- Swipe actions: left = 封存, right-full = 刪除 (red, with confirm in action sheet).
- New chat: compose icon in nav bar trailing.
- The drawer goes away.

### 3.3 Chat messages

- **User**: right-aligned bubble, `--fill` background, `--label` text, `--r-bubble` 18,
  padding 8×14, max-width 78% [desktop 70% of 720]. No tail.
- **Assistant**: no bubble, no avatar in 1:1 chats; full-width text 17/26 [15/24], paragraphs
  12px apart. In team threads, a 20px avatar + bot name (13/600) appears above the first
  message of each run of that bot.
- Timestamps: hidden; a centred 12px `--label-2` time separator when ≥ 15 min passed.
- Queued (offline) user message: bubble at 60% opacity + trailing 「等待傳送」 caption below
  it; tapping shows 「重試 / 刪除」 action sheet. No dashed borders.
- Failed: red exclamation icon left of the bubble, tap for actions.
- Copy / retry / share on long-press (phone) or hover toolbar (desktop: 3 icon buttons,
  16px, appear at message end on hover).
- Composer: capsule (`--r-full` while single-line, `--r-lg` 20 when multi-line), `--fill`
  background, placeholder 「傳訊息給 Alca」, leading `+` (attach / skills / @mention), trailing
  send arrow in a 32px accent-filled circle that is hidden until text exists (mic icon slot
  otherwise). Remove the 「示範引擎」 label and the shortcut strip; shortcuts live in ⌘/ help.

### 3.4 Activity rows (tool / trace / worker steps) — no bullet dots

An assistant turn that used tools shows **one collapsed row** above its text
(`--label-2`, duration right-aligned, no separator):

```
[◷]  做了 4 件事                               12 秒  ›
```

Expanded (disclosure, 250ms):

```
[🌐]  打開「山嵐選物」結帳頁                         2 秒
[📄]  讀取頁面內容                                   1 秒
[🖱]  按下「確認付款」                         等你決定    ← orange text, no dot
[✓ ]  完成                                                ← success icon
```

- Icon by kind (globe = web, doc = read, magnifier = search, pencil = edit file, envelope =
  mail, person = hand-off to teammate); running → spinner in the icon slot; failed → red
  exclamation icon + red verb.
- Verb phrase in plain language, generated from a mapping table (tool → 「動詞 + 對象」), never the
  tool id. Unknown tool → 「使用 {connector}」.
- Trailing: duration (tabular, `--label-2`) or state word.
- Indentation 0; rows 32px [28px]; no vertical timeline line, no dots.
- Tap a row → 技術細節 sheet [inspector]: tool id, arguments (pretty JSON, mono), result
  excerpt, worker id, timing. This is where `browser_click @8` belongs.
- Recall/memory lookups (「回想・spl_…」) are not shown in the transcript at all; they are in
  技術細節 of the turn.

### 3.5 Approval card / sheet — the most important screen

Purpose: let a person decide in under five seconds, with no doubt about **what** will happen,
**who** asked, **how risky** it is, and **what each button does**.

Phone: a sheet at medium detent (never stacked), presented when the approval arrives if the
chat is open, otherwise from the notification or the 需要你 list.

```
┌───────────────────────────────────────────────┐
│                    ───                        │  grabber
│  ( 💳 )                                       │  44px circle, --fill, icon 28 tinted by risk
│  付款 NT$1,280                                │  --t-title2, the action + object
│  在「山嵐選物」結帳                               │  --t-subhead --label-2 (where)
│                                               │
│  ┌ 誰要做 ──────────── Alca › 示範商店結帳 ┐     │  inset grouped rows, 44px each,
│  │ 金額 ──────────────────── NT$1,280 │     │  label left --label-2, value right --label
│  │ 付款方式 ──────────────── 卡號末四碼 4242 │     │  (only rows we actually know)
│  └ 網站 ──────────────────── 山嵐選物 ┘     │
│                                               │
│  🔒 付款、寄信、刪除、公開發布一定會先問你。          │  --t-footnote --label-2, lock icon
│                                               │
│  [        付款 NT$1,280        ]              │  primary filled, 50px, --r-lg
│  [            不要              ]              │  tinted (--fill), 50px
│                                               │
│  技術細節  ›                                    │  text row → push 技術細節
└───────────────────────────────────────────────┘
```

Rules:
- **Title = verb + object** in the user's terms: 「寄出 給 王小明 的信」「刪除 筆記「購物清單」」
  「付款 NT$1,280」「公開發布 到 X」「連上網路：example.com」. Never 「工人要付款」.
- **Primary button repeats the title verb** (Muse/Duet pattern): 「付款 NT$1,280」「寄出」
  「刪除」「允許連線」. Deny is always 「不要」 [en: "Don't"]. No 「允許一次」 jargon; if a
  "always allow for this site" option exists it is a third text button under 技術細節, never
  for the always-confirm classes.
- **Risk tiers** (icon tint + button style; no salmon, no gradients, no chips):
  - Routine (connect to a site, read a file): icon `--label-2`, primary `--accent-fill`.
  - Always-confirm money/send/publish: icon `--waiting`, primary `--accent-fill`, lock
    footnote shown.
  - Destructive delete: icon `--danger`, primary `--danger-fill` with label 「刪除…」.
- **Content preview** when it matters: for send → recipient, subject, first 3 lines of body
  in a `--bg-cell` block (`--r-md`), 「看全文」 pushes the full draft; for delete → the item
  name and 「無法復原」 in the subtitle when true.
- Who: `requester › task` in the 誰要做 row. Team bot → bot avatar 20 + name.
- **Guard against tap-through**: primary disabled for 500ms after the sheet settles; no
  default focus on primary on desktop for destructive tiers.
- After decision: sheet dismisses; the chat shows a one-line receipt row:
  `[✓] 已付款 NT$1,280                21:40` / `[✕] 你拒絕了付款`. Expired:
  `[!] 這個請求已過期` with 「再試一次」 only if supported.
- Pending approvals never appear twice: chat shows a compact row 「等你決定：付款 NT$1,280 ›」
  that opens the sheet [desktop: the inline card lives in the chat only; the inspector shows
  the same compact row].
- From notification: no amber explanation banner 「從通知打開・詳情剛經加密連線…」. If details
  are still loading, show the sheet skeleton with the title from the push payload.

Desktop: same content as an inline card in the timeline (`--bg-cell`, `--r-xl`, level 1,
padding 20, max-width 560). Buttons right-aligned: 〔不要〕〔付款 NT$1,280〕, 28px tall,
`--r-sm`. Shortcuts ⌘↩ approve / ⌘⌫ deny shown in the button **tooltip**, not inside it.
The 需要你 sidebar row lists all pending approvals across threads.

### 3.6 Task (worker) row, list and detail

Rename in UI: 工人 → **任務** (en "task"); see §5.

Row (phone inset grouped / desktop inspector list):

```
[⟳]  示範商店結帳                                   6 秒  ›
     等你決定付款                                          ← orange when waiting
```

- Leading 20px status icon: spinner (running), orange `hand.raised` (waiting), green check
  (done), grey stop (stopped), red exclamation (failed).
- Title 17 [14] = task name; subtitle 15 [12] = current step in plain words or the result's
  first sentence.
- Trailing elapsed time (running) or finish time (done).
- Sections: 需要你 / 進行中 / 已完成 (today) — a vertical list, never horizontal pages.

Detail (push on phone, inspector on desktop):
- Header: title 22/600, status line, toolbar trailing 「停止」 in red text (confirm via action
  sheet).
- 「畫面」 section (only for browser tasks): live frame thumbnail 16:10, `--r-lg`, tap to open
  full screen with 接手 / 交還.
- 「進度」: activity rows (§3.4).
- 「結果」: result text (reading size), with 「在對話中查看」.
- 技術細節 at the bottom.

### 3.7 List rows and settings

- Phone: iOS inset grouped. Section header 13/400 `--label-2`, sentence case, 16px inset,
  8px above cells; footer 13 `--label-2`. Cells `--bg-cell`, `--r-lg` per section, 0.5px
  separators inset from the text start.
- Row anatomy: [icon 20 in 28px rounded `--r-sm` `--fill` square — optional] title 17 ·
  subtitle 15 · trailing (value `--label-2` / switch / chevron / time). Destructive row: red
  centred text in its own section (「忘記這台電腦」).
- Desktop settings: a **Settings window** (separate view, ⌘,) with a left category list
  (一般 · 模型 · 裝置 · 通知 · Telegram · 備份 · 進階) and a right pane using grouped-form
  layout: label left (right-aligned, 180px), control right; sections with 15/600 headings.
  No radio _cards_; use radio buttons or a popup menu.

### 3.8 Choosing a control

| Need                                                          | Use                                                                                                     | Never                              |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| On/off                                                        | Switch (native `switch` checkbox)                                                                       | segmented 開/關, checkbox on phone |
| 2–3 **views** of the same content, peers                      | Segmented control (phone in nav area; desktop in toolbar)                                               | per-row segmented                  |
| One value from 3+ options (permission level, theme, interval) | Row with trailing value → menu (desktop popup button; phone pull-down menu or push list with checkmark) | segmented controls in forms        |
| Per-item permission (不能用 / 只讀 / 可操作 per account)      | Row value 「只讀 ›」 opening a menu                                                                     | a segmented control on every row   |
| Filter a list                                                 | Search field + a menu button 「全部 ⌄」                                                                 | horizontally scrolling chips       |
| Number 1–3                                                    | Stepper                                                                                                 | segmented 1/2/3                    |
| Time window                                                   | two time pickers in one row                                                                             | free text                          |
| Many actions on an item                                       | swipe + context menu (phone) / right-click + `…` menu (desktop)                                         | three pill buttons per row         |

### 3.9 Buttons

| Kind               | Phone                                                                                   | Desktop                                           | Use                                |
| ------------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------- | ---------------------------------- |
| Primary (filled)   | `--accent-fill`, white 17/600, 50px, full width, `--r-lg`                               | 28px, 14/500, padding 0 14, `--r-sm`              | the one main action per view       |
| Secondary (tinted) | `--fill`, `--label`                                                                     | same with `--fill`                                | the alternative (「不要」「取消」) |
| Destructive        | `--danger-fill` filled only in delete approval / confirm; otherwise red **text** button | same                                              | delete, revoke, forget             |
| Text / plain       | accent text 17, no background, 44px hit                                                 | accent text 14                                    | nav bar actions, 「重新整理」      |
| Icon               | 24 icon, 44 hit                                                                         | 16–20 icon, 28 hit, hover `--fill-hover` `--r-sm` | toolbars                           |

- Labels are verbs: 「配對」「開啟通知」「存成技能」. No trailing 「…」 except when a dialog follows
  (macOS convention), e.g. 「設定 Telegram…」.
- Disabled: 40% opacity, no colour change.
- At most one filled button visible per screen region.

### 3.10 Empty states

- No logo, no wordmark. Phone empty chat: 20/600 line 「今天要交給 Alca 什麼？」 at the
  vertical 40% mark, left-aligned to the gutter, then **three suggestion rows** (inset grouped,
  icon + text, e.g. 「整理今天的信」「幫我比價」「記住一件事」) — vertical, all visible. Composer at
  bottom.
- Desktop empty chat: same line 22/600 left-aligned in the 720 column above the composer
  placed at 38% height; suggestions as three plain rows (no chips) under it.
- Empty lists (no tasks, no memory): 17/600 title + 15 `--label-2` one sentence + one text
  button. Centred vertically in the list area. No illustrations except pairing (§3.13).

### 3.11 Banners and toasts

- **Connection banner** (offline / reconnecting / showing cached): a single row pinned under
  the nav bar, `--fill` background, 13/500, leading icon (wifi.slash), text 「電腦離線，訊息會在
  連上後送出」, trailing text button 「重試」. Auto-hides on reconnect with a 1.5s
  「已重新連線」 then collapse. No attempt counts, no addresses (those go to 診斷).
- **Toast** (desktop & phone): level-2 elevated capsule-less rect `--r-lg`, bottom-centre
  above composer, 3s, one sentence + optional action (「復原」). Used for undo:
  「已修改 3 個檔案」〔復原〕. The current undo strip (`desktop-undo-strip-dark`) becomes this.
- Never stack more than one toast; newer replaces older.

### 3.12 Badges and tags

- **Count badge**: capsule, min-width 18, 12/600, white on `--waiting` (needs you) or on
  `--label-3` (neutral counts). Only on tab bar, sidebar rows, toolbar icons.
- **Tags/chips are removed** from rows. State moves to: the subtitle text (「推測，尚未確認」),
  an icon (lock for always-confirm), or the trailing value. If a short label is unavoidable
  (e.g. 「預設」 next to a model in a menu), use plain `--label-2` text, no border, no fill.

### 3.13 Pairing

Phone pairing is the first impression; it should feel like AirPods/Apple Watch pairing.
1. **Welcome**: system illustration (existing phone–laptop line art is fine, 1.5 stroke,
   `--label-2`), title 28/700 「連上你的 Mac」, one sentence, primary 「用 Google 登入」 (Google
   button follows Google's brand rules but in our 50px `--r-lg` shape), secondary text button
   「改用配對碼」. Footer lock 13: 「端對端加密，伺服器看不到你的對話。」
2. **Code entry**: six separate digit boxes (`--r-md`, 48×56, 28/600 tabular), auto-advance,
   paste-aware, `autocomplete="one-time-code"`. Primary 「配對」. 「掃描 QR code」 text button.
   No 「pnpm desktop:pair」: say 「在 Mac 上打開 Alca › 設定 › 裝置 › 新增手機」.
3. **Waiting**: 「在 Mac 上輸入這個驗證碼」 + big code 34/600 tabular, spinner + 「等待 Mac 確認」.
4. **Done**: check draw animation, 「已連上 小明的 MacBook Pro」, safety number in a grouped row
   behind 「安全碼」 › (not on the main screen), primary 「開始使用」.
   Desktop counterpart (`desktop-link-dark`, `desktop-enter-code-*`): a sheet window 「新增手機」
   with QR + 9-digit code on the left, steps on the right; paired devices list lives in
   Settings › 裝置.

### 3.14 Forms

- Phone: form sheet with nav bar 〔取消〕 title 〔新增〕 (accent, 600, disabled until valid).
  Fields are inset grouped rows: label left (`--label`), value/placeholder right, or full-width
  text field rows. Multi-line text: a cell with 4-line min textarea. No pill inputs, no
  borders around individual inputs.
- Desktop: modal sheet window `--r-xl`, title 15/600 left, form grid label-right/control-left,
  inputs 28px `--r-sm` with 1px `--separator` border and accent focus ring 3px
  `color-mix(var(--accent) 35%)`. Footer buttons right: 〔取消〕〔儲存〕.
- Validation inline under the field, red 13, appears on blur or submit.
- Secrets: show 「已儲存」 + 「更換…」 instead of dots in a field.

### 3.15 Focus and keyboard (desktop)

- Focus ring: 3px accent at 35% outside the control, `--r` matched; never the current
  double-ring with canvas gap in grey.
- ⌘K command palette (Raycast-style list, 600px, level 2) for: new chat, jump to thread,
  open Library pages, settings, toggle inspector.
- ⌘/ shows shortcuts sheet; remove the per-composer hint strip.

---

## 4. Per-screen redesign notes

Priority: **Keep** (only token changes), **Adjust** (same structure, component swaps),
**Redo** (new structure).

### 4.1 Phone

| Screenshot                                | Priority | Notes                                                                                                                                                                                                                                   |
| ----------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `phone-chat-dark` / `phone-chat-light`    | Adjust   | Nav title = thread name only; trace rows → one collapsed activity row (§3.4); worker result → task row with chevron; 「等你決定・1 件」 floating pill → compact pending row in transcript + tab badge; composer per §3.3.               |
| `phone-chat-empty-dark`                   | Redo     | Remove wordmark and h-scroll cards; §3.10 empty state with 3 vertical suggestions.                                                                                                                                                      |
| `phone-chat-approval-dark` / `-light`     | Redo     | §3.5 sheet: 「付款 NT$1,280」 title, grouped facts, lock footnote, primary repeats verb, 「不要」; no salmon, no chip, no breadcrumb, no 127.0.0.1.                                                                                     |
| `phone-send-approval-dark`                | Redo     | Send variant: recipient/subject/body preview; 「寄出」 primary; `GMAIL_SEND_EMAIL` only in 技術細節.                                                                                                                                    |
| `phone-notification-approval-dark`        | Redo     | Same sheet; drop amber explanation banner; skeleton while loading.                                                                                                                                                                      |
| `phone-chat-learned-dark`                 | Adjust   | Dashed card + sparkle → plain row 「Alca 學會了「示範商店結帳」」 with 「查看」 chevron; opens skill proposal.                                                                                                                          |
| `phone-skill-proposal-dark`               | Adjust   | Pushed screen (not sheet-on-sheet): title 22/600, steps as numbered grouped rows with plain verbs (no URLs), always-confirm step marked by lock icon; buttons 〔存成技能〕 primary, 〔不要〕 tinted.                                    |
| `phone-skills-dark`                       | Adjust   | Library › 技能: grouped list; pending at top under 「等你確認」 header; rows with switch; remove red chips; footer text one sentence.                                                                                                   |
| `phone-memory-dark`                       | Redo     | Library › 記憶: search field in nav bar; filter via 「全部 ⌄」 menu; rows = memory sentence (17) + subtitle 「推測，尚未確認」 or source (15); no kanji tiles, no chips. Tap → detail.                                                  |
| `phone-memory-item-dark`                  | Redo     | Detail screen instead of inline expansion: text, source, 「這是對的」 primary when 推測, 編輯, red 「忘記」 row.                                                                                                                        |
| `phone-memory-forget-dark`                | Redo     | iOS action sheet: 「忘記這件事」 (red) / 取消; no stacked sheet, no giant title.                                                                                                                                                        |
| `phone-threads-dark`                      | Redo     | Drawer removed; becomes the 對話 tab (Messages-style list, §3.2).                                                                                                                                                                       |
| `phone-workers-dark`                      | Redo     | 進行中 tab: 需要你 / 進行中 / 已完成 vertical list of task rows (§3.6); no paging, no inset box, no URLs.                                                                                                                               |
| `phone-browser-dark`                      | Adjust   | Task detail › 畫面 full-screen: nav title = site name (no URL), status caption overlay 「Alca 正在操作」; pending approval as compact row; 「接手」 as bottom toolbar button (not giant white pill); 分頁 list behind a toolbar button. |
| `phone-browser-takeover-dark`             | Adjust   | Bottom toolbar: 〔鍵盤〕〔捲動〕 icons + 〔交還〕 primary; caption 「你正在操作」. Enter/刪除 keys → native keyboard.                                                                                                                   |
| `phone-team-dark`                         | Adjust   | Library › 團隊: members grouped list (avatar glyph, name, role subtitle, trailing state); 「領頭」 as subtitle text; collaboration rules rows → menus (§3.8); activity as separate pushed screen, not segmented.                        |
| `phone-team-bot-dark`                     | Adjust   | Push (not sheet-on-sheet); grouped rows; status as subtitle; 「對話」 primary.                                                                                                                                                          |
| `phone-team-chat-dark`                    | Keep     | Mention picker is already list-like; restyle tokens; avatar glyphs monochrome.                                                                                                                                                          |
| `phone-team-trail-dark`                   | Redo     | Hand-off detail: title 「Alca 交給研究員」, activity rows (§3.4) — no timeline dots, no ↳, no A→研 glyph pairs.                                                                                                                         |
| `phone-bot-form-dark`                     | Redo     | Form sheet (§3.14): 取消 / 新增 bot / 新增; name, role rows; colour swatches removed (avatar picker later); 權限 → menu row; footnote one line.                                                                                         |
| `phone-routines-dark`                     | Adjust   | 進行中 › 例行工作: rows with switch; draft review moves to 需要你; log lines behind detail; remove chips 正常/提前做.                                                                                                                   |
| `phone-routine-form-dark`                 | Redo     | Form sheet: 「什麼時候」 row → picker (每天 09:00 / 每 1 小時); 「要做什麼」 textarea; 「誰來做」 menu row. No segmented.                                                                                                               |
| `phone-connectors-dark`                   | Redo     | Library › 連接: service sections (Gmail…) with account rows; per-bot access becomes a detail screen with menu rows (不能用/只讀/可操作); quotas in a 「每日上限」 section as value rows; Composio named only in 技術細節.               |
| `phone-devices-dark`                      | Adjust   | Settings › 裝置: grouped rows; 「這支手機」 as subtitle; permissions as rows with checkmarks; 外觀 moves to Settings › 一般 as menu row; 「忘記這台電腦」 red row.                                                                      |
| `phone-diag-dark` / `phone-diag-rtc-dark` | Keep     | Already grouped-list-like; move under Settings › 進階 › 診斷; mono values OK here (technical screen); 2×2 pill buttons → rows.                                                                                                          |
| `phone-enroll-code-dark`                  | Adjust   | §3.13 step 3: code 34/600; device name as subtitle not a pill; 「取消」 text button in nav bar.                                                                                                                                         |
| `phone-enroll-wrong-dark`                 | Adjust   | Error inline red 13 under the code with icon.                                                                                                                                                                                           |
| `phone-google-signin-dark`                | Adjust   | §3.13 step 1; remove wordmark; one primary, one text button; 「沒有跳出登入視窗？」 shown only after 5s or failure.                                                                                                                     |
| `phone-pairing-dark`                      | Redo     | §3.13 step 2; remove `pnpm desktop:pair`; digit boxes; 會合伺服器 field moves to 「進階」 disclosure.                                                                                                                                   |
| `phone-paired-dark`                       | Adjust   | §3.13 step 4; safety number behind a row.                                                                                                                                                                                               |
| `phone-pick-computer-dark`                | Adjust   | Grouped list of Macs (icon, name, 「在線上」 subtitle in green text or 「離線」 grey); account in nav bar trailing avatar menu; remove giant title → large title 「選擇電腦」 that collapses.                                           |
| `phone-push-prompt-dark`                  | Keep     | Good pattern (notification mock + checklist). Tokens; title 22/600; primary 「開啟通知」, text 「以後再說」.                                                                                                                            |
| `phone-reconnect-dark`                    | Adjust   | Connection banner (§3.11) instead of a card over the hero.                                                                                                                                                                              |
| `phone-offline-queued-dark`               | Adjust   | Banner + queued bubble style (§3.3); remove attempt count and address.                                                                                                                                                                  |
| `phone-offline-saved-dark`                | Adjust   | Banner 「離線中，顯示上次同步的內容」.                                                                                                                                                                                                  |
| `site-computer-signin-dark`               | Adjust   | Same as Google sign-in step; remove centred wordmark; left-aligned title.                                                                                                                                                               |

### 4.2 Desktop

| Screenshot                                                                                            | Priority | Notes                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `desktop-dark` / `desktop-light`                                                                      | Adjust   | Unified toolbar (§3.1) replaces pill buttons; approval inline card §3.5 desktop; no 「收到：…我是總機」 boilerplate; composer §3.3; remove hint strip and sidebar footer.                                                                                                                           |
| `desktop-empty-dark` / `desktop-empty` / `desktop-threads-actions-dark` / `desktop-threads-more-dark` | Redo     | §3.10 desktop empty state; sidebar per §3.2 (no 「剛剛」 column, date groups, archived row at end).                                                                                                                                                                                                 |
| `desktop-early-dark`                                                                                  | Adjust   | Loading state: skeleton rows in sidebar and content (static bars, `--fill`), no spinner hero. _(Screenshot shows routines under a 連接 header; route it to 進行中 › 例行工作.)_                                                                                                                     |
| `desktop-browser-dark` / `-light`                                                                     | Redo     | Inspector-hosted browser: tab title + site name in inspector header, URL only in a read-only field on hover/click; one approval (in chat), inspector shows compact pending row; 「接手」 as toolbar button; footer caption 「Alca 正在操作」 without middots.                                       |
| `desktop-browser-takeover-dark`                                                                       | Adjust   | Caption overlay top-centre 「你正在操作 — 按 Esc 交還」; 〔交還〕 button in inspector toolbar.                                                                                                                                                                                                      |
| `desktop-worker-stream-dark`                                                                          | Redo     | Inspector › task detail (§3.6): activity rows replace `browser_open` chips; approvals not duplicated; resolved approvals are receipt rows.                                                                                                                                                          |
| `desktop-workers-dark` / `-light`                                                                     | Adjust   | Inspector task list: sections 需要你/進行中/已完成, rows §3.6, no kanji tiles.                                                                                                                                                                                                                      |
| `desktop-memory-dark`                                                                                 | Redo     | Content page 「記憶」 (title 22/600): search + 「全部 ⌄」 menu in toolbar; table-like list (sentence, source, last used) with hover actions in a `…` menu; 推測 shown as subtitle text + 「確認」 hover button; no chips, no glyph tiles; add field becomes 「新增…」 button opening a small sheet. |
| `desktop-skills-dark` / `desktop-skill-card-dark`                                                     | Adjust   | Remove red gradient; proposal = inline card (§3.5 visual language, routine tier) with numbered steps in plain words; saved skills = list rows with switch and `…` menu.                                                                                                                             |
| `desktop-team-dark`                                                                                   | Redo     | List, not card grid: rows (avatar, name, role, state) with 「對話」 hover button; 新增 bot via toolbar `+`; rules as grouped form with popup menus & stepper (§3.8).                                                                                                                                |
| `desktop-team-card-dark` / `desktop-team-chat-dark`                                                   | Adjust   | Team thread: bot name + 20px avatar above runs; approval per §3.5; mention popover restyled as menu (level 2).                                                                                                                                                                                      |
| `desktop-team-activity-dark`                                                                          | Redo     | Hand-off list: rows 「Alca 交給 行程：刪除購物清單」 with state trailing; detail in inspector with activity rows; no seconds-precision timestamps, no ↳.                                                                                                                                            |
| `desktop-bot-edit-dark` / `-codex-dark` / `-p13-dark`                                                 | Redo     | Bot settings as a sheet window with grouped form: 名稱, 角色, 模型 (popup), 權限 (popup), 瀏覽器 (popup), 記憶 (popup); 進階 disclosure holds sandbox, working hours, CLI path; no raw paths unless in 進階.                                                                                        |
| `desktop-model-picker-dark`                                                                           | Adjust   | Popover list: friendly model name (「Claude Sonnet 4.5」) + provider subtitle; price/context in a trailing `--label-2` column only when 「顯示價格」 is on; id visible in tooltip.                                                                                                                  |
| `desktop-providers-dark` / `desktop-settings-model-dark` / `desktop-custom-provider-dark`             | Adjust   | Settings › 模型: grouped list of providers with state as trailing text 「已連線」/「需要登入」; install command behind 「怎麼安裝？」 disclosure; custom provider form keeps ACP fields under 「進階」.                                                                                             |
| `desktop-connectors-dark` / `desktop-routines-dark`                                                   | Redo     | Split into Library › 連接 and 進行中 › 例行工作 (sidebar items, no segmented header with counts). Per-account access via popup menus; stats line removed; routine rows with switch + detail.                                                                                                        |
| `desktop-settings-dark` / `-light`                                                                    | Redo     | Settings window (§3.7) with categories; radio cards → radio group; amber banner → lock footnote.                                                                                                                                                                                                    |
| `desktop-settings-connection-dark` / `desktop-connection-dark`                                        | Redo     | Settings › 進階 › 連線: status as one row 「已連線」; relay URL, mailbox id, LAN port, Tailscale behind 「技術細節」; paired devices move to Settings › 裝置.                                                                                                                                       |
| `desktop-settings-advanced-dark`                                                                      | Redo     | Pill tab row removed (categories in window sidebar).                                                                                                                                                                                                                                                |
| `desktop-settings-backups-dark` / `-about-dark` / `-browser-dark`                                     | Adjust   | Settings › 備份: last backup row + 「立即備份」; restore as a button with a file picker, not a CLI instruction; paths and file names in 技術細節. Settings › 關於: version only + 「顯示記錄檔」; Node/arch in 技術細節. Browser: one switch row 「需要時自動下載瀏覽器」.                          |
| `desktop-telegram-dark`                                                                               | Adjust   | Settings › Telegram pane; warning becomes footnote with info icon; 啟用 as switch at top.                                                                                                                                                                                                           |
| `desktop-link-dark`                                                                                   | Redo     | 「新增手機」 sheet (§3.13 desktop); device list → Settings › 裝置; no ws:// URL, fingerprint behind 安全碼 row.                                                                                                                                                                                     |
| `desktop-enter-code-dark` / `-done-dark` / `-wrong-dark`                                              | Adjust   | Sheet window, no 「A L C A」 eyebrow; six digit boxes; done state = check animation + 「已連上 iPhone」.                                                                                                                                                                                            |
| `desktop-thread-delete-dark`                                                                          | Adjust   | Native-style alert: title 「刪除這段對話？」, body one sentence, 〔取消〕〔刪除〕 (red filled), centred on window.                                                                                                                                                                                  |
| `desktop-undo-confirm-dark` / `-error-dark`                                                           | Adjust   | Alert centred on window (currently offset top-left); file list as plain rows with doc icon; error as red footnote.                                                                                                                                                                                  |
| `desktop-undo-strip-dark` / `-done-dark`                                                              | Adjust   | Becomes toast (§3.11).                                                                                                                                                                                                                                                                              |

---

## 5. Copy guidelines

### 5.1 Voice

- zh-Hant-TW: 用「你」，短句，動詞在前，台灣用語（「設定」「檔案」「伺服器」「登入」）。全形標點
  「」，。？；數字與英文半形並與中文間加一個半形空格。不用「您」、不用驚嘆號、不用「哦/喔」。
- en: sentence case everywhere, contractions OK, no exclamation marks, no "Oops".
- Say what happened and what the person can do: 「Mac 離線了，訊息會在連上後送出。」 not
  「電腦離線・訊息會先排隊」.
- No self-introductions in replies (「我是總機…」). The UI explains roles; the agent just answers.
- One idea per line; if a line needs `・` to join facts, split it or drop the weaker fact.

### 5.2 Terminology (user-facing)

| Today                            | Use instead (zh / en)                                                 | Why                                                                                                                                                             |
| -------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 工人 / worker                    | 任務 / task                                                           | People care about the job, not a "laborer"; 工人 reads oddly in TW. Keep `worker` in code. _(Glossary change — update `packages/design/src/i18n/GLOSSARY.md`.)_ |
| 總機 / router                    | Alca（或 bot 名稱）                                                   | Internal role.                                                                                                                                                  |
| 批准卡 / approval card           | 確認 / confirmation                                                   | The card is UI, not a concept.                                                                                                                                  |
| 允許一次 / 拒絕                  | 〔動作動詞〕 / 不要 · Don't                                           | Button says the consequence.                                                                                                                                    |
| 一律確認 (chip)                  | 「付款、寄信、刪除、公開發布一定會先問你。」                          | Sentence, not label.                                                                                                                                            |
| 等你決定                         | 需要你 / Needs you                                                    | Shorter, used as section + badge.                                                                                                                               |
| 看門狗                           | (hidden) 「這個任務一直重複同一個動作，已經停下來。」                 | Explain the effect.                                                                                                                                             |
| 示範引擎                         | 示範模式 / Demo mode                                                  |                                                                                                                                                                 |
| 中繼站 / 會合伺服器              | 連線服務 (only in 進階)                                               |                                                                                                                                                                 |
| 金鑰指紋 / safety number         | 安全碼 / Security code                                                | Apple's term.                                                                                                                                                   |
| 推測 55%                         | 推測，尚未確認 (percentage in 技術細節)                               | Percentages imply false precision.                                                                                                                              |
| token, OAuth, ACP, Composio, CLI | avoid in primary UI; allowed in 進階 / 技術細節                       |                                                                                                                                                                 |
| 剛剛 (everywhere)                | omit unless it's the only time info; otherwise 「3 分鐘前」/「21:40」 |                                                                                                                                                                 |

### 5.3 Technical details pattern

- Every object that has internals (approval, task, activity row, device, provider, backup)
  gets a **技術細節 / Technical details** disclosure at the end: label 15 `--label-2` with
  chevron. Inside: mono text, copy button per value, 「拷貝全部」 for bug reports.
- Never put addresses (`127.0.0.1`, `ws://`), ids (`dev_`, `bot_`, `spl_`), tool ids,
  file paths, shell commands or config file names outside that disclosure or Settings › 進階.
  Exception: a URL the _user_ typed or a public site name (show the hostname, e.g.
  「shop.example.com」, never a loopback address — for local demo sites say 「本機測試網站」).
- Errors: plain sentence first (「沒辦法連上 Mac。」), then 「重試」, then 技術細節 with the code.

### 5.4 Examples

| Before                                                                | After (zh)                                    | After (en)                                              |
| --------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------- |
| 工人要付款                                                            | 付款 NT$1,280                                 | Pay NT$1,280                                            |
| 等你決定・一律確認・付款                                              | (title + lock footnote)                       |                                                         |
| 允許一次 Ctrl↵                                                        | 付款 NT$1,280 (tooltip ⌘↩)                    | Pay NT$1,280                                            |
| 電腦離線，會自動重連 已試 2 次・2 秒後再試 經 127.0.0.1:42345         | Mac 離線了，連上後會自動送出。〔重試〕        | Your Mac is offline. Messages will send when it's back. |
| 回想・第 1 份結果・從第 1500 字                                       | (hidden in 技術細節)                          |                                                         |
| 在終端機執行 pnpm desktop:pair                                        | 在 Mac 的 Alca 打開「設定 › 裝置 › 新增手機」 | On your Mac, open Alca › Settings › Devices › Add phone |
| 工人「盯信箱」停下了 看門狗停下：最近 8 次呼叫裡同一個呼叫重複了 8 次 | 「盯信箱」停下來了：一直在重複同一個動作。    | "Watch inbox" stopped: it kept repeating the same step. |

---

## 6. Implementation map

### 6.1 Files

| Part                                        | File(s)                                                                                                                                                                                                            | Action                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tokens (both platforms)                     | `packages/design/tokens.css` (served by `apps/desktop/src/server.ts` at `/ui/tokens.css`; copied by `apps/phone-pwa/scripts/build.ts` → `tokens.css`)                                                              | **Replace** with §2 tokens. Split into shared core + `@media`/`[data-theme]` sets. Keep old names as aliases for one release (`--c-ink: var(--label)` …) so screens migrate incrementally; delete `--c-bot-*`, `*-soft`, `--radius-pill` usage. Update `packages/design/README.md` and `docs/ARCHITECTURE.md` (both describe 墨 Mono). |
| Platform scale                              | new `packages/design/tokens-phone.css` + `tokens-desktop.css` (or sections in tokens.css scoped by `:root[data-platform]`)                                                                                         | Phone and desktop type scales differ (§2.2). Build script must copy the new file(s); desktop server must serve them (update the `/ui/tokens.css` route).                                                                                                                                                                               |
| Phone base / buttons / icons                | `apps/phone-pwa/styles/base.css`                                                                                                                                                                                   | Buttons §3.9 (remove `scale(.97)`, pill radius), focus ring, icon stroke 1.5, Dynamic Type root.                                                                                                                                                                                                                                       |
| Phone chat, composer, trace rows, wait pill | `apps/phone-pwa/styles/chat.css`; `app/chat.ts`, `app/timeline.ts`, `app/cards.ts`                                                                                                                                 | §3.3, §3.4 (replace `.tool-dot`, `.report-dot`, `.wait-pill`).                                                                                                                                                                                                                                                                         |
| Phone sheets, approval                      | `apps/phone-pwa/styles/sheet.css`; `app/sheet.ts`, `app/cards.ts`                                                                                                                                                  | §3.5; forbid stacking (sheet.ts pushes inside the top sheet instead of opening another).                                                                                                                                                                                                                                               |
| Phone navigation (new tab bar, nav bar)     | `apps/phone-pwa/styles/screens.css`, `app/main.ts`, `app/drawer.ts` (remove), new `app/tabs.ts`                                                                                                                    | §2.1, §3.1, §3.2.                                                                                                                                                                                                                                                                                                                      |
| Phone tasks                                 | `styles/workers.css`; `app/workers.ts`, `app/worker-view.ts`, `app/worker-harness.ts`                                                                                                                              | §3.6.                                                                                                                                                                                                                                                                                                                                  |
| Phone browser                               | `styles/browser.css`; `app/browser.ts`                                                                                                                                                                             | §4.1 rows.                                                                                                                                                                                                                                                                                                                             |
| Phone memory / skills                       | `styles/memory.css`; `app/memory.ts`, `app/skills.ts`, `app/learn-view.ts`                                                                                                                                         | §4.1 rows.                                                                                                                                                                                                                                                                                                                             |
| Phone connections / routines                | `styles/connect.css`, `styles/forms.css`; `app/connect-view.ts`, `app/connect.ts`, `app/routine-form.ts`, `app/forms-view.ts`                                                                                      | §3.8, §3.14.                                                                                                                                                                                                                                                                                                                           |
| Phone team                                  | `styles/team.css`; `app/team-view.ts`, `app/team.ts`, `app/bot-form.ts`                                                                                                                                            |                                                                                                                                                                                                                                                                                                                                        |
| Phone pairing / account / devices           | `styles/account.css`, `styles/device.css`; `app/pairing.ts`, `app/account.ts`, `app/computer-signin.ts`, `app/computer-view.ts`, `app/devices.ts`, `app/device.ts`, `app/google-button.ts`, `app/diag.ts`          | §3.13.                                                                                                                                                                                                                                                                                                                                 |
| Phone offline                               | `styles/offline.css`; `app/offline.ts`, `app/outbox-view.ts`, `app/reconnect.ts`, `app/session-offline.ts`                                                                                                         | §3.11.                                                                                                                                                                                                                                                                                                                                 |
| Phone add-ons                               | `styles/addons.css`; `app/addons.ts`                                                                                                                                                                               |                                                                                                                                                                                                                                                                                                                                        |
| Desktop shell, sidebar, toolbar, timeline   | `apps/desktop/ui/app.css`; `app-chrome.ts`, `thread-list.ts`, `timeline.ts`, `panes.ts`, `app.ts`                                                                                                                  | §3.1, §3.2, §3.3. Tauri: set `titleBarStyle: "Overlay"`, `hiddenTitle: true` in `apps/desktop-shell/src-tauri/tauri.conf.json` (macOS) and pad sidebar for traffic lights.                                                                                                                                                             |
| Desktop shared components                   | `apps/desktop/ui/components.css`                                                                                                                                                                                   | buttons, inputs, menus, toasts, badges, focus.                                                                                                                                                                                                                                                                                         |
| Desktop composer                            | `apps/desktop/ui/composer.css`; `mention.ts`, `model-picker.ts`                                                                                                                                                    | §3.3.                                                                                                                                                                                                                                                                                                                                  |
| Desktop approval cards                      | `components.css` / `timeline.ts`, `approval-stale.ts`                                                                                                                                                              | §3.5 desktop; dedupe in `browser.ts` / `worker-view.ts`.                                                                                                                                                                                                                                                                               |
| Desktop tasks / inspector                   | `workers.css`, `worker-harness.css`; `workers.ts`, `worker-view.ts`, `worker-harness.ts`, `perf-line.ts`                                                                                                           | §3.6.                                                                                                                                                                                                                                                                                                                                  |
| Desktop browser                             | `browser.css`, `browser-stage.css`; `browser.ts`, `browser-parts.ts`, `browser-import.ts`                                                                                                                          |                                                                                                                                                                                                                                                                                                                                        |
| Desktop library                             | `library.css`, `skills.css`, `connect.css`, `team.css`, `bot-edit.css`, `providers.css`; `library.ts`, `skill-card.ts`, `connect*.ts`, `routines-view.ts`, `early-view.ts`, `team*.ts`, `bot-*.ts`, `providers.ts` | §4.2.                                                                                                                                                                                                                                                                                                                                  |
| Desktop settings                            | `settings.css`; `settings-*.ts`, `telegram.ts`, `data-transfer.ts`, `site-logins-*.ts`                                                                                                                             | Settings window §3.7.                                                                                                                                                                                                                                                                                                                  |
| Desktop pairing                             | `link.css`, `remote.css`; `link.ts`, `link-pake-note.ts`, `remote.ts`, `connection.ts`                                                                                                                             | §3.13 desktop.                                                                                                                                                                                                                                                                                                                         |
| Desktop undo / toasts                       | `undo-strip.ts` (+ `addons.css`)                                                                                                                                                                                   | §3.11.                                                                                                                                                                                                                                                                                                                                 |
| Splash                                      | `apps/desktop-shell/ui/splash.css`                                                                                                                                                                                 | tokens only; no wordmark animation.                                                                                                                                                                                                                                                                                                    |
| Strings                                     | `packages/design/src/i18n/zh/*.ts`, `.../en/*.ts`, `GLOSSARY.md`, `dynamic-keys.ts`                                                                                                                                | §5; rename 工人→任務 in zh values only (keys stay).                                                                                                                                                                                                                                                                                    |

### 6.2 Constraints discovered

- **CSP** — desktop (`apps/desktop/src/http.ts`, Tauri `tauri.conf.json`) and phone
  (`vercel.json`, `services/rendezvous/src/server.ts`) allow `style-src 'self'` only: no
  `<style>` blocks, no `style=""` attributes in HTML strings, no web fonts (`font-src 'self'`).
  Setting `el.style.prop` from JS (CSSOM) is fine. Inline SVG icons are fine. All new CSS goes
  in the existing stylesheet files (or new files linked from `index.html` +
  added to the phone build's precache list).
- **No bundler on phone** — `apps/phone-pwa/scripts/build.ts` strips types and copies files;
  the service-worker precache list is generated from built files, so new CSS files must be
  linked in `apps/phone-pwa/index.html` to be picked up.
- **File-size cap** — `pnpm check:size` fails any TS/JS file over 800 lines (CSS is not
  checked, but several CSS files are at 650–725 lines: `connect.css`, `app.css`, `team.css`,
  `sheet.css`, `memory.css`). Keep CSS under 800 by convention; splitting tab-bar/nav code into
  new modules avoids pushing `main.ts`/`chat.ts` over the cap.
- **i18n guard** — `pnpm check:i18n` (`scripts/check-i18n.ts`): no new hard-coded CJK in
  `apps/desktop/ui`, `apps/phone-pwa/app` or the two `index.html` (baseline in
  `scripts/i18n-baseline.json` may only go down); every key in both `zh-Hant-TW` and `en`
  with the same `{params}`; no unused keys; the desktop-shell splash has no CJK of its own.
  All copy changes in §5 go through the string tables.
- **Contrast** — every text token pair in §2.3 is ≥ 4.5:1; `--label-3` is for placeholders,
  disabled and decorative icons only. White on `#0A84FF` and on `#E5332A` fail — that is why
  filled buttons use `#0071E3` / `#D70015` in both themes. Re-check if any token changes.
- **Reduced motion / transparency** — tokens.css already zeroes durations under
  `prefers-reduced-motion`; extend to the new tokens and add
  `prefers-reduced-transparency` fallback for blurred bars.
- **Dynamic Type** — phone sizes must be `rem` off an `-apple-system-body` root (§2.2); audit
  `px` font sizes in `apps/phone-pwa/styles/*.css`. macOS has no Dynamic Type; desktop
  stays px.
- **Webview engines** — macOS WKWebView (Tauri), Windows WebView2, Linux WebKitGTK. Avoid
  `light-dark()` and other very new CSS for now; keep explicit theme blocks. Use
  `-webkit-backdrop-filter` alongside `backdrop-filter`.
- **Native switch** — `<input type="checkbox" switch>` is Safari-only; other engines render a
  checkbox, so keep the styled switch as the fallback appearance.
- **Screenshots** — the `shots-plain.ts` scripts (desktop and phone) are the visual review set;
  see `docs/screenshots/README.md`.

### 6.3 Suggested order

1. Tokens + base components (buttons, rows, inputs, badges, focus) on both platforms, with
   aliases — biggest visible change, lowest risk.
2. Approval sheet/card (§3.5) + activity rows (§3.4) + copy for both — the trust surfaces.
3. Phone IA: tab bar, threads list, 進行中 tab, kill drawer and sheet stacking.
4. Desktop toolbar/sidebar/inspector + settings window.
5. Library pages (memory, skills, team, connections, routines), pairing polish.
6. Remove aliases and dead tokens; update README/ARCHITECTURE wording.
