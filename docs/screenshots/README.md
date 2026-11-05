# Screenshots

The images here are the ones the README links to. They show the current 「素 Plain」 UI with fictional demo data
from the offline demo engine. Other screenshots the scripts can make are for local review and are not committed.

| File                              | What it shows                                                      | Made by                                                     |
| --------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------- |
| `desktop-chat-light.png`          | Desktop: a conversation with an approval card for a delete (light) | `apps/desktop/scripts/shots-plain.ts` (`chat`)              |
| `desktop-chat-dark.png`           | The same, dark                                                     | `apps/desktop/scripts/shots-plain.ts` (`chat`)              |
| `desktop-team-light.png`          | Desktop: the team of bots and their rules                          | `apps/desktop/scripts/shots-plain.ts` (`team`)              |
| `desktop-settings-model-dark.png` | Desktop: 設定 › 模型 (provider, model, web search)                 | `apps/desktop/scripts/shots-plain.ts` (`settings`)          |
| `phone-chats-light.png`           | Phone: the conversation list                                       | `apps/phone-pwa/scripts/shots-plain.ts` (`chats`)           |
| `phone-approval-light.png`        | Phone: an approval sheet for a delete (light)                      | `apps/phone-pwa/scripts/shots-plain.ts` (`approval-delete`) |
| `phone-approval-dark.png`         | The same, dark                                                     | `apps/phone-pwa/scripts/shots-plain.ts` (`approval-delete`) |

Desktop shots are 1440×900; phone shots are 393×852 at 2x with a stand-in for the notch and home indicator.

## Regenerating

Playwright is not a repository dependency: install it anywhere and point `PLAYWRIGHT_MODULE` at it. The scripts
reuse a Chromium you already have (`ALCA_CHROMIUM`), so Playwright's own browser download is not needed. On Linux,
install a CJK font (`fonts-noto-cjk`).

```sh
# desktop: writes <name>-light.png / <name>-dark.png into the folder you give
PLAYWRIGHT_MODULE=/path/to/node_modules/playwright ALCA_CHROMIUM=/usr/bin/chromium \
  ALCA_PLAIN=chat,team,settings \
  node --disable-warning=ExperimentalWarning apps/desktop/scripts/shots-plain.ts /tmp/alca-shots

# phone: writes plain-<name>-<portrait|landscape>-<theme>.png
PLAYWRIGHT_MODULE=/path/to/node_modules/playwright ALCA_CHROMIUM=/usr/bin/chromium \
  ALCA_SHOTS_ONLY=chats,chat-empty,approval-delete ALCA_THEMES=light,dark \
  node --disable-warning=ExperimentalWarning apps/phone-pwa/scripts/shots-plain.ts /tmp/alca-shots
```

Copy the files you need here under the names above. On a Mac with Google Chrome, use
`ALCA_CHROMIUM="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"`.

The older, wider screenshot sets (`pnpm screenshots`, `pnpm screenshots:p6`, `ALCA_SHOTS_ONLY=…`) are described in
[RUNNING.md § Screenshots](../RUNNING.md#screenshots).
