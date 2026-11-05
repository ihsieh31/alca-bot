# Releasing Alca

What a release is made of, what the owner has to set up for signed builds, the checklist for
turning a draft into a published release, the checks before the repository becomes public, and
how an installed core updates itself.

**Current state:** `v0.2.0` is a **draft** pre-release (ad-hoc signed on macOS, not
notarized, Windows unsigned); no release has been published yet.
Nothing in this file publishes anything or changes the repository's visibility: those are the
owner's decisions, made by hand.

## 1. What a tag builds

Pushing a `v*` tag runs `.github/workflows/release.yml`:

| Job                    | Output                                                                                                                                                                                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| core + PWA tarball     | `alca-core.tar.gz`, `alca-core-<ver>.tar.gz`, `install.sh`, `install.ps1` (each with `.sha256`); the packed core carries `official-config.json` and, when set, `release-keys.json`                                         |
| desktop shell × 3      | macOS universal `.dmg` + `Alca-macos.app.tar.gz`, Windows NSIS `.exe`, Linux `.deb` / `.AppImage`; each job writes its signing state                                                                                       |
| install.ps1 on Windows | runs `install.ps1 --tarball` with the job's core tarball on `windows-latest`                                                                                                                                               |
| draft release          | `SHA256SUMS` over every file, `SHA256SUMS.sig` when the release key is set, `.sha256` per installer, build provenance when the repo is public; **always `--draft --prerelease`**, notes list each platform's signing state |

A missing secret never fails the run: macOS falls back to an ad-hoc signature, Windows stays
unsigned, `SHA256SUMS` goes unsigned — and the release notes and the job summary say so.

## 2. What the owner prepares (signing)

Set these in GitHub → the repository → Settings → Secrets and variables → Actions (or
`gh secret set NAME < file`, `gh variable set NAME --body …`). Secrets are only in the env of the
step that uses them; the workflow tests (`apps/desktop/test/release-workflow.test.ts`) keep it so.

### 2.1 macOS: Developer ID + notarization

You need: an **Apple Developer Program** membership (paid, yearly; individual or organization),
a **Developer ID Application** certificate, and an **app-specific password** for your Apple ID.

1. In Xcode → Settings → Accounts, or at developer.apple.com → Certificates, create a
   _Developer ID Application_ certificate; in Keychain Access export it with its private key as
   `cert.p12` and choose an export password.
2. At account.apple.com → Sign-In and Security → App-Specific Passwords, make one for "Alca CI".
3. Your Team ID is on developer.apple.com → Membership.

| Name                         | Kind                | Value                                                                                                   |
| ---------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------- |
| `APPLE_CERTIFICATE`          | secret              | `base64 -i cert.p12` (one line)                                                                         |
| `APPLE_CERTIFICATE_PASSWORD` | secret              | the .p12 export password                                                                                |
| `APPLE_SIGNING_IDENTITY`     | secret              | `Developer ID Application: Your Name (TEAMID)` (exact, from `security find-identity -v -p codesigning`) |
| `APPLE_ID`                   | secret              | the Apple ID email (notarization)                                                                       |
| `APPLE_PASSWORD`             | secret              | the app-specific password (not your Apple ID password)                                                  |
| `APPLE_TEAM_ID`              | secret              | the 10-character Team ID                                                                                |
| `ALCA_BUNDLE_ID`             | variable (optional) | your reverse-DNS id, e.g. `com.example.alca` (default `local.alca.desktop`)                             |

With the first three, the bundled Node and the App are signed with the hardened runtime; with all
six, `tauri build` notarizes and staples the App, then the workflow notarizes the `.dmg` with
`xcrun notarytool submit --wait`, staples it, and checks App and `.dmg` with `stapler validate`
and `spctl --assess`. After the first signed run, on a clean Mac: `spctl -a -vv /Applications/Alca.app`
says `source=Notarized Developer ID`; `install.sh --app-only --version <tag>` still passes its
`codesign --verify`.

### 2.2 Windows: Authenticode

You need a **code-signing certificate** (OV or EV) from a CA. The workflow signs with a `.pfx`:

| Name                           | Kind                | Value                                                                                                           |
| ------------------------------ | ------------------- | --------------------------------------------------------------------------------------------------------------- |
| `WINDOWS_CERTIFICATE`          | secret              | `base64` of the `.pfx` (one line; PowerShell: `[Convert]::ToBase64String([IO.File]::ReadAllBytes('cert.pfx'))`) |
| `WINDOWS_CERTIFICATE_PASSWORD` | secret              | the `.pfx` password                                                                                             |
| `WINDOWS_TIMESTAMP_URL`        | variable (optional) | an RFC 3161 server (default `http://timestamp.digicert.com`)                                                    |

The certificate is imported into the runner's CurrentUser store, `tauri build` signs the app and
the installer with `signtool` (SHA-256, timestamped), and the job fails only if a signature it
made is not `Valid`. **Caveat:** since June 2023 CAs issue new code-signing keys only on
hardware tokens or cloud HSMs, so many new certificates cannot be exported as a `.pfx`. Those
need Tauri's `bundle.windows.signCommand` with the provider's signing tool (e.g. a cloud signing
service's CLI) — not wired yet; tell us which provider and it is one step in `release.yml`.
SmartScreen reputation builds up over time even for signed files (EV starts higher).

### 2.3 Release signature (for `alca update`)

An Ed25519 key that signs `SHA256SUMS`. The installed core carries the public half, so it only
installs an update that this key signed (§6). Make it once, offline:

```sh
openssl genpkey -algorithm ed25519 -out alca-release.pem          # keep this file safe and backed up
openssl pkey -in alca-release.pem -pubout -outform DER | base64   # → ALCA_RELEASE_PUBLIC_KEY
```

| Name                       | Kind     | Value                                                     |
| -------------------------- | -------- | --------------------------------------------------------- |
| `ALCA_RELEASE_SIGNING_KEY` | secret   | the whole `alca-release.pem`                              |
| `ALCA_RELEASE_PUBLIC_KEY`  | variable | the base64 line above (several keys: separated by commas) |

Set both before the first published release: a core packed without the variable only ever checks
checksums. **Rotation:** put the old and the new public key in the variable (comma-separated) for
at least one release signed with the old key, then sign with the new one; a lost private key
means every installed core has to be reinstalled by hand with `install.sh` / `install.ps1`.

### 2.4 Already in use (unchanged)

`ALCA_OFFICIAL_RELAY_URL`, `ALCA_OFFICIAL_SITE_URL`, `ALCA_OFFICIAL_GOOGLE_CLIENT_ID` (variables,
P12; written into the packed core). Not used yet: `TAURI_SIGNING_PRIVATE_KEY` /
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (the Tauri updater, §7).

## 3. Draft → published: checklist

Do these in order; the last step is the owner's click.

1. **Code**: the release commit is on `main`, CI green (`ci`, `install-windows`), `CHANGELOG.md`
   has the version's section (move `## Unreleased` under the new heading), `pnpm check:versions`
   says every file carries the tag's version.
2. **Pairing protocol** (design-2 E row): the build carries PAKE v2 (G1) only; PAKE v1 is removed
   (§5, decided). Do not publish `v0.2.0` as it is: it predates G1 and speaks only v1. The
   release notes say: this version pairs with PAKE v2 only; devices set up with `v0.2.0` must update
   and pair again.
3. **Secrets**: §2 set as far as you want this release signed; the release key (§2.3) set before
   the first published release.
4. **Tag** a new version (the existing `v0.2.0` draft stays a draft or is deleted; never re-tag a
   published version). Wait for the release run; read its job summary: every platform's signing line.
5. **Assets**: the draft has `alca-core*.tar.gz`, `install.sh`, `install.ps1`, the shells,
   `SHA256SUMS` (and `.sig`), each `.sha256`. `sha256sum -c SHA256SUMS` on a download passes.
6. **Clean machines** (DEVICE-TEST § G): macOS — `.dmg` opens without 「仍要打開」 when
   notarized, `install.sh --version <tag> --app-only`; Linux — `.AppImage` starts, `install.sh`;
   Windows — `powershell -ExecutionPolicy Bypass -File install.ps1 --version <tag>`, the `.exe`
   installs and finds the core, SmartScreen shows the publisher when signed. Pair a phone once.
7. **Updater**: on a machine with the previous version installed, `alca update check
   --channel prerelease` sees the draft? It must not (drafts are never offered); after publishing,
   `alca update install` asks, backs up, updates, and `alca update rollback` brings it back.
8. **Docs that say "draft"**: README install lines (drop the `--version` requirement once a
   release is published), root `SECURITY.md` § Supported versions, `docs/ROADMAP.md` § After v0.2.
9. **Publish** (owner): on the release page, untick "pre-release" if it is a stable version, then
   "Publish release". Only now does `releases/latest` resolve and `install.sh` / `install.ps1`
   work without `--version`.

## 4. Before the repository becomes public

`bash scripts/pre-public-check.sh --mirror` runs the history-wide checks on a fresh mirror of
every branch (read-only):

- `check:names` and `check:deploy-values` on the current tree (CLEANROOM rule 2; no deployment
  values outside docs).
- **gitleaks over every commit of every ref** (pinned release, checksum-checked). The findings
  reviewed on 2026-11-05 are all test fixtures and are listed with the reason in
  `.gitleaksignore`; anything new fails the script. A real key found in history: revoke it
  first, then decide whether to rewrite history (rewriting does not un-leak a key someone copied).

Also, by hand:

- **LICENSE** — Apache-2.0 (`LICENSE`, `NOTICE`, `THIRD_PARTY_NOTICES.md`); re-check third-party
  licenses after dependency updates.
- Branches and drafts: delete stale branches (they become public too, with their history); look
  over open PRs and the draft release notes.
- Settings → Actions → General: "Require approval for all outside collaborators" for fork PRs;
  workflow permissions stay read-only by default (every workflow here asks for what it needs).
- Settings → Code security: turn on secret scanning and push protection (free for public repos)
  and Dependabot alerts (Dependabot version updates for actions are already configured).
- After the flip, `release.yml` attaches build provenance (`gh attestation verify <file> --repo
  <owner>/alca-bot`; `install.sh --attestation`), and the Tauri updater becomes possible (§7).

## 5. The `pakeV1` transition (G1): v1 removed

The first published release accepts PAKE v2 only, with no switch to turn v1 back on. No public release
ever spoke v1: only the unpublished `v0.2.0` draft and phone pages cached before G1.

**v1 is removed.** The v1 code (`packages/link/src/pake.ts`, `p256.ts`, `hashToPoint`, the v1 branches
of `handshake.ts` / `enroll.ts`, the phone page's v1 share and 相容模式 note) is gone from every shipped
part; `engineering.link.pakeV1` and the library's `allowPakeV1` are removed, so there is no escape hatch.
An old `config.json` that still has `engineering.link` opens with a warning and the key is dropped
(`REMOVED_KEYS`). A frozen copy of v1 stays under `packages/link/test/fixtures/v1/` for the refusal tests;
`packages/link/test/v1-removed.test.ts` fails if v1 code, its labels or the setting reappear in shipped code.

What happens now:

- A phone page, Home Screen app or computer that offers only v1 (anything from `v0.2.0`) is answered
  `upgrade_required` with "this computer accepts pairing v2 only: update … and pair again", before any
  PAKE. Nothing is stored and the code it typed is burned. The current phone page says 「請更新後重新配對」
  (reload; close and reopen a Home Screen app; make a new code on the computer). An old cached page only
  knows the bare code, so the computer's 手機與裝置 dialog says the same in full: an old phone was
  refused, update it and pair again.
- Every refusal is in the audit log (`link.pair` / `link.enroll`, decision `deny`,
  `detail.error = "upgrade_required"`, `detail.refused = "pake_v1"`) and the core log warns.
- A current phone that meets a `v0.2.0` core stops with `downgrade` (「請先更新電腦上的 Alca」).
- **Devices already paired stay paired**, also those paired with v1: no stored key came from the v1
  PAKE (it only authenticated the exchange of the identity keys each side generated itself), and every
  connection runs the unchanged session handshake (`LINK_VERSION` 1, same sealed frame format). Revoke
  one in 手機與裝置 and pair again if you prefer.
- **Devices set up with `v0.2.0` must update and pair again** (a phone: reload the page, then pair
  with a new code; a `v0.2.0` core: replace it with the new release).
- The QR keeps `pk=2` and the wire keeps the `pk` version list for a later version.

## 6. Updates: `alca update`

For a core installed by `install.sh` / `install.ps1` (`<prefix>/app` with `<prefix>/bin/alca`):

```sh
alca update check                 # newer published release? (drafts never; --channel prerelease for rc's)
alca update install               # download, verify, ask, back up, swap, restart, health check
alca update install --version v0.3.0 | --tarball ./alca-core-0.3.0.tar.gz
alca update rollback              # back to the previous version (and its database when needed)
alca update status
```

- **Notify, never install by itself.** Once a day (from the core's hourly maintenance slot) the
  core asks GitHub for the release list — one anonymous GET, nothing about you is sent; a private
  repo goes through your own `gh` login. A newer version shows in 設定 → 關於 and the log.
  `engineering.updates.check: "off"` makes no request at all; `channel: "prerelease"` also offers
  pre-releases.
- **Verification** — decided by the installed core, not by the download: a core that carries
  `release-keys.json` (§2.3) needs `SHA256SUMS` + a valid `SHA256SUMS.sig`; otherwise it checks the
  checksum only and says so (that catches a damaged download, not a replaced release). Either way
  the tarball's `ALCA_VERSION` must be the version asked for, and an older version needs
  `--allow-downgrade`.
- **Install**: unpack into `app.next` and run it once → your **yes** → stop the background service →
  **back up `state.sqlite`** (the same backups as before a migration, `alca db backups`) →
  `app` → `app.prev`, `app.next` → `app` → start → wait for `/api/health` (30 s). No answer:
  automatic rollback.
- **Rollback**: if the new version migrated the database, the pre-update backup is restored and
  the newer file is moved aside (never deleted; data written after the update is in it). The
  failed version stays as `app.failed-<time>` until the next rollback.
- The core inside the desktop App and a git checkout are only told where the new version is
  (a new App download / `git pull`).

## 7. Not wired yet: the Tauri updater

The desktop App updating itself needs: the repository public and the release published (the
updater endpoint must be downloadable anonymously), a Tauri updater key pair
(`pnpm exec tauri signer generate` → `TAURI_SIGNING_PRIVATE_KEY` secret, the public key in
`tauri.conf.json` → `plugins.updater.pubkey`), `tauri-plugin-updater` in `Cargo.toml`,
`createUpdaterArtifacts: true` and a `latest.json` built by `release.yml`, and the App asking
before it installs (same rule as `alca update`). Until then the App's core shows "new version"
with the download link.
