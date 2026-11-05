# Deploy: 用 Google 登入 (P10, P12)

What the operator sets up once so that a person only does this: open Alca on the computer → **用 Google 登入**; open the site on the phone → sign in with the same Google account → type the phone's 6-digit code on the computer once. No relay URL, client ID or secret on the computer. Three pieces:

| Piece                         | Where                                                                                       | What it needs                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Phone site (`apps/phone-pwa`) | Vercel, static                                                                              | the relay URL + the **Web** OAuth client ID                                     |
| Relay                         | Cloudflare Workers (`services/relay-worker`) **or** your own server (`services/rendezvous`) | the Web client ID (+ a Desktop one if you use it) + a relay secret              |
| Computer (the Alca core)      | your Mac / PC                                                                               | nothing — a release carries the official endpoints (below); 連線 overrides them |

## Official service: build variables (P12)

The source carries no deployment value. A release writes the official endpoints — all public — into the gitignored `apps/desktop/official-config.json` (`scripts/gen-official-config.ts`, called by `scripts/pack-core.ts`) from these **GitHub Actions repository variables** (Settings → Secrets and variables → Actions → **Variables**, not secrets):

| Variable                         | Value                                                      |
| -------------------------------- | ---------------------------------------------------------- |
| `ALCA_OFFICIAL_RELAY_URL`        | the relay (`https://relay.example.com`, its custom domain) |
| `ALCA_OFFICIAL_SITE_URL`         | the phone site (`https://<project>.vercel.app`)            |
| `ALCA_OFFICIAL_GOOGLE_CLIENT_ID` | the site's Web client ID (`…apps.googleusercontent.com`)   |

With the GitHub CLI: `gh variable set ALCA_OFFICIAL_SITE_URL --repo <owner>/alca-bot --body https://<project>.vercel.app` (and the other two). The values live there, not in this repository. `release.yml` passes them to the pack and shell-bundle steps; the phone site's build falls back to them when `ALCA_RELAY_URL` / `ALCA_GOOGLE_CLIENT_ID` are unset. The same names as **environment variables** override the file at run time (`ALCA_OFFICIAL_SITE_URL=… pnpm desktop`). With only the site URL known (`install.sh --site <url>`), the core reads the relay and the client ID from the site's public `config.json` at start. Order of precedence on the computer: 連線 (link.json) › `--rendezvous` / `--pwa-url` / config.json › official.

Nothing below is done by Alca's code or CI; these are steps for you in the Google Cloud, Vercel and Cloudflare consoles. Replace the example names (`alca.example.com`, `relay.example.com`) with yours.

## Official service vs self-host

The code ships with **no** deployment-specific values: no relay URL, phone-site URL, domain, Google client ID, VAPID contact, API key or account id is compiled in or committed. Every hosted endpoint comes from config, environment or build-time variables whose defaults are empty or `example.com`, so the official service and a self-hoster set the same knobs:

| Value                                        | Where it is set                                                                                                                           | Default                                       |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Relay URL (computer)                         | 連線, settings `advanced.rendezvousUrl` or `--rendezvous`; else official `ALCA_OFFICIAL_RELAY_URL`                                        | empty = Link off                              |
| Relay URL (phone site)                       | build env `ALCA_RELAY_URL` → `config.json`                                                                                                | empty = the page's own origin                 |
| Web client ID (phone site)                   | build env `ALCA_GOOGLE_CLIENT_ID`                                                                                                         | empty = pairing codes only                    |
| Phone site + its Web client ID (computer)    | 連線 → 自架的 Alca 網站, or `--pwa-url`; else official `ALCA_OFFICIAL_SITE_URL` / `_GOOGLE_CLIENT_ID`                                     | empty = Google sign-in off                    |
| Desktop client ID / secret (self-host only)  | settings `engineering.google.clientId` / `clientSecret`, or `$ALCA_GOOGLE_CLIENT_ID` / `$ALCA_GOOGLE_CLIENT_SECRET`                       | empty = sign in through the site              |
| Relay's accepted client IDs, allowed origins | Worker vars `GOOGLE_CLIENT_IDS`, `ALLOWED_ORIGINS` (dashboard or `wrangler.toml` in your fork), or `--google-client-id` on the Node relay | empty                                         |
| Relay secret                                 | `wrangler secret put ALCA_RELAY_SECRET` / `$ALCA_RELAY_SECRET`                                                                            | required (Node relay: created on first start) |
| VAPID contact (web push)                     | settings `engineering.push.contact` or `$ALCA_PUSH_CONTACT`                                                                               | `mailto:admin@example.com`                    |
| Model provider keys                          | the local encrypted vault (設定 → 模型與供應商)                                                                                           | none                                          |

- **Official service**: the project's own relay and phone site are just one deployment of the above; their values live in the hosting dashboards (Vercel project env, Cloudflare vars/secrets), never in this repository.
- **Self-host**: deploy the same relay (§ 2) and phone site (§ 3) under your own names and point the computer at them; nothing in the code prefers the official endpoints.
- `pnpm check` (and CI) runs `scripts/check-deploy-values.ts` over every tracked text file, Markdown and `docs/` included: our own domain (and the same domain reversed, as a bundle id or service label), `*.workers.dev` / `*.vercel.app` / `*.pages.dev` hosts, Google OAuth client IDs and `GOCSPX-` secrets, and key / token shapes (OpenAI, Anthropic, OpenRouter, Google, GitHub, Slack, AWS, Telegram, Vercel `prj_` / `team_`, Composio, Cloudflare account ids, PEM private keys). The allowlist is narrow: a host passes only with an `example` label (`relay.example.com`, `alca-relay.example.workers.dev`), `<you>.workers.dev` / `<project>.vercel.app` / `…apps.googleusercontent.com` never match, the test client IDs (`test-web…`, `test-desktop…`) and keys that say they are fixtures (`sk-test-…`, one repeated character) pass; a host with `my-`, `test` or `you` in it does not. Add a new domain with `ALCA_DEPLOY_DOMAINS=…`.
- Bundle ids are neutral: the desktop shell is `local.alca.desktop` (`tauri.conf.json`), the LaunchAgent `local.alca.core` (`apps/desktop/src/service.ts`; `$ALCA_SERVICE_LABEL` names another). A release sets its own shell id with the repository variable `ALCA_BUNDLE_ID` (`release.yml` passes it to `tauri build --config`). `alca service install` / `uninstall` stop and remove an agent an older build wrote under another label.

## 1. Google Cloud Console — the Web client ID (and, optionally, a Desktop one)

1. Open <https://console.cloud.google.com/>, top bar → project picker → **New project** (e.g. `alca`) → **Create**, then select it.
2. **APIs & Services → OAuth consent screen** (shown as **Google Auth Platform → Branding** in the newer console):
   - **Get started** → App name `Alca`, user support email = your Gmail → **Next**.
   - Audience: **External** → **Next** → contact email → **Next** → agree → **Create**.
   - **Data access → Add or remove scopes**: tick `openid` and `.../auth/userinfo.email` only → **Update** → **Save**. (These are non-sensitive scopes: no Google verification review is needed.)
   - **Audience → Test users → Add users**: add every Google account that will use Alca (yourself). While the app is in _Testing_, only these accounts can sign in. Later you may press **Publish app**; with only `openid` / `email` that needs no review.
3. **Clients → Create client** (or **Credentials → Create credentials → OAuth client ID**):
   - **Web application** — name `Alca phone site`.
     - **Authorized JavaScript origins**: `https://alca.example.com` (your Vercel URL, e.g. `https://<project>.vercel.app`; add both if you use a custom domain). Add `http://localhost:8787` too if you want to try it against a local relay.
     - **Authorized redirect URIs**: `https://alca.example.com/` (exact, with the trailing slash) — used only by the 「改用整頁登入」 fallback.
     - **Create** → copy the **Client ID** (`…apps.googleusercontent.com`). There is no secret to keep for this one.
     - Since P12 the computer signs in through this client too: the site's `/computer-signin` sends Google back to the same `https://alca.example.com/`, so no other redirect URI is needed.
   - _Optional, self-host only:_ **Create client** again → **Desktop app** — name `Alca computer` → **Create** → copy the **Client ID** and the **Client secret**. Google's installed-app guide treats a Desktop client's secret as **not confidential** (it ships inside apps); Alca keeps it in `config.json`. PKCE and the loopback redirect are what protect the sign-in. No redirect URI is configured for Desktop clients: Alca uses `http://127.0.0.1:<random port>/`, which Google allows for this client type.

You now have: `WEB_ID` (and, if you made one, `DESKTOP_ID`, `DESKTOP_SECRET`).

## 2. The relay

Pick **one**.

### 2a. Cloudflare Workers + Durable Objects (managed)

```sh
cd services/relay-worker
npx wrangler login
npx wrangler secret put ALCA_RELAY_SECRET     # paste 32+ random characters, e.g. from: openssl rand -base64 33
```

Set the variables under **Workers & Pages → alca-relay → Settings → Variables** (plain text). `wrangler.toml` has no `[vars]` table on purpose and sets `keep_vars = true`, so `wrangler deploy` keeps what the dashboard holds:

| Variable            | Value                                                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `GOOGLE_CLIENT_IDS` | `WEB_ID,DESKTOP_ID`                                                                                                                  |
| `ALLOWED_ORIGINS`   | `https://alca.example.com` — the phone site. **Required** for an official deployment: empty = any website can open relay sockets     |
| `RELAY_MODE`        | `production` for the official deployment: with an empty `ALLOWED_ORIGINS` browser sockets are refused and `/healthz` says `ok:false` |
| `MAX_SOCKETS`       | optional; sockets the relay object accepts (default 5000)                                                                            |

Or pass them once on the command line: `npx wrangler deploy --var GOOGLE_CLIENT_IDS:WEB_ID,DESKTOP_ID --var ALLOWED_ORIGINS:https://alca.example.com --var RELAY_MODE:production`.

Then `npx wrangler deploy` (from the repo root's workspace: `pnpm install` first, so `@alca/link` and `@alca/rendezvous` resolve). The first deploy after review M3 applies migration `v2` (a new `HookObject` class for webhook mailboxes, binding `HOOKS`); nothing else changes, the relay object and its account registry stay. **One endpoint.** The relay is its custom domain (`https://relay.example.com`: **Settings → Domains & Routes**, or the commented `routes` line in your fork) and nothing else: `wrangler.toml` sets `workers_dev = false` and `preview_urls = false`, so a deploy does not turn the `*.workers.dev` route or Preview URLs back on, and the official service has no `workers.dev` fallback (computers and phones know one relay URL). A self-hoster may choose `workers_dev = true` instead (then the relay is `https://alca-relay.<you>.workers.dev`) — pick one and give that URL everywhere. Check `https://…/healthz` → `{"ok":true,"google":true,"hooks":true,"mode":"production",…}` with no `warnings`; `ok:false` names what is missing (for example `ALCA_RELAY_SECRET` while `GOOGLE_CLIENT_IDS` is set — Google sign-in is then off). Durable Objects with SQLite storage are on the Workers free plan. Keep the secret: changing it makes every registered computer unknown (register again).

**Limits of the Workers relay.** Every relay socket lives in one Durable Object (pairing codes and the Google directory must meet in one place): it caps itself at `MAX_SOCKETS` and 32 sockets per address, closes a socket that does not say who it is within 10 s or is silent for 30 min, and budgets each connection to 1 MiB/s (8 MiB burst). That is fine for a personal or small-team relay; past a few thousand concurrent devices it needs sharding by mailbox with a separate directory object — not built. Webhook mailboxes (`/v0/hooks`) are one object each and do not count against it.

### 2b. Your own server (Node 22.18+)

```sh
ALCA_RELAY_GOOGLE_CLIENT_IDS="WEB_ID,DESKTOP_ID" \
pnpm rendezvous --host 0.0.0.0 --port 8787 --trust-proxy \
  --origin https://alca.example.com \
  --accounts-file /var/lib/alca/accounts.json
```

Put it behind TLS (Caddy / nginx: `relay.example.com` → `127.0.0.1:8787`, WebSocket upgrade on `/v0/link`). `--trust-proxy` takes the client address from `X-Forwarded-For` as the entry your proxy appended — the rightmost one — so a client cannot pick its own rate-limit key by sending the header; with two proxies of yours in a row (a CDN, then nginx) use `--trust-proxy-hops 2`. Only use either when the relay is reachable through your proxy alone. The relay secret is `$ALCA_RELAY_SECRET` or, if unset, a 0600 `/var/lib/alca/accounts.json.key` created on first start — back up both files together.

## 3. The phone site on Vercel

1. <https://vercel.com/new> → **Import** the `ihsieh31/alca-bot` repository.
2. **Root Directory**: `apps/phone-pwa` (tick _Include files outside the root directory_, the default for monorepos). **Framework preset**: Other. Build settings come from `apps/phone-pwa/vercel.json` (install from the workspace root, `node scripts/build.ts dist`, output `dist`).
3. **Environment Variables** (Production and Preview):
   - `ALCA_RELAY_URL` = the relay's one URL, e.g. `https://relay.example.com` (a self-hoster who kept `workers_dev = true`: `https://alca-relay.<you>.workers.dev`)
   - `ALCA_GOOGLE_CLIENT_ID` = `WEB_ID`
   - `ENABLE_EXPERIMENTAL_COREPACK` = `1` (so Vercel uses the repo's pnpm version)
   - _Optional:_ `ALCA_CSP_CONNECT_EXTRA` = more origins phones may connect to (comma list). With `ALCA_RELAY_URL` set, the built `index.html` carries a `<meta>` CSP whose `connect-src` is only the site, that relay, `wss://*.ts.net` (Tailscale serve direct addresses) and Google Identity Services, on top of `vercel.json`'s header (which allows any `wss:` host, as the source names no deployment). A relay typed by hand on the pairing screen, or a direct `wss://` address outside `*.ts.net`, must be listed here; `ALCA_CSP_CONNECT=open` turns the narrowing off.
   - Node.js version (Settings → Build and Deployment): **22.x**.
4. **Deploy**. Open the URL on a phone: 「用 Google 帳號連線上你的電腦」 with Google's button. If you add a custom domain (Settings → Domains), add it to the Web client's JavaScript origins and redirect URIs (step 1.3) and to `ALLOWED_ORIGINS` / `--origin` (step 2), then redeploy.

The site is static: `config.json` is written at build time from the two variables (both public values). Web Push keeps working (the service worker is at the site root); notification permission and the Home Screen app are per origin, so install it from this fixed URL.

## 4. The computer

Nothing to set with a release build (it carries the official endpoints). Open Alca → **手機與裝置 → 用 Google 登入** → the default browser opens `<site>/computer-signin`, then Google → pick the account → 「已登入」 → back in Alca it says 已啟用.

Self-host: 連線 → **自架的 Alca 網站** (your site URL + its Web client ID) and **自己的穩定網址** (your relay); or `--pwa-url` / `--rendezvous` / the `ALCA_OFFICIAL_*` environment variables. A Desktop OAuth client still works instead of the site, in `<data-dir>/config.json`:

```json
{ "engineering": { "google": { "clientId": "DESKTOP_ID", "clientSecret": "DESKTOP_SECRET" } } }
```

## 5. First phone

Phone → the site → **使用 Google 帳戶繼續** (same account) → the computer (picked for you when there is only one) → the phone shows a **6-digit code** → the computer shows 「輸入手機上的驗證碼」 → type it → 連線. 5 tries, 5 minutes; 重新產生驗證碼 on the phone for a new one. From then on the phone reconnects by itself with its own key, no prompt. To remove it: **手機與裝置 → 撤銷**. To stop new phones finding this computer: **停用** in the Google section (trusted phones keep working until revoked).

## Troubleshooting

- _會合伺服器不接受這個 Google 登入_: the token's client ID is not in `GOOGLE_CLIENT_IDS` / `--google-client-id`, or the account is not a test user while the consent screen is in _Testing_.
- _這個會合伺服器沒有開啟 Google 登入_: the relay was started without client IDs (Worker: `GOOGLE_CLIENT_IDS` empty or `ALCA_RELAY_SECRET` missing).
- Google says `origin_mismatch` / `redirect_uri_mismatch`: the site's exact origin (scheme + host, no path) must be in the Web client's JavaScript origins; for the fallback, `https://<site>/` in its redirect URIs.
- The pop-up never comes back in the Home Screen app: use 「沒有跳出登入視窗？改用整頁登入」.
- The browser shows 「這不是這次的登入」 or Alca says the nonce did not match: the sign-in was started again or the tab is stale — press 用 Google 登入 once more.
- The computer's browser stays on 「正在回到 Alca…」: the core is not running or the sign-in timed out (5 min); press 用 Google 登入 again.
- Pairing codes still work everywhere (「用配對碼連線」), with or without Google.
