# Alca desktop shell (Tauri 2)

One window around the local core's own UI, plus a tray / menu-bar icon, 登入時開啟, `alca://` links and a single instance. The shell owns no state: the core (Node, loopback only) keeps everything in its data directory (`$ALCA_DATA_DIR`, default `~/.alca`) and runs fine without the shell, headless or as `alca service`.

## What it does

- **Finds or starts the core.** If something already answers on `127.0.0.1:<port>` (the `alca service` background service, or a core started by hand), the shell attaches and starts nothing (`Alca 正在執行（背景服務）`). Otherwise it runs, first match wins: `$ALCA_CORE_CMD`; a copy bundled in the app's resources (`core/node` + `core/app`, not bundled yet, see below); the copy `scripts/install.sh` put in `~/.alca/app` (with `~/.alca/node/bin/node` or `node` on `PATH`). Engine from `$ALCA_ENGINE` (default `claude-code`), extra flags from `$ALCA_CORE_ARGS` (both split like a shell does: quote a path with spaces, `node '/Users/me/claude code/alca/apps/desktop/src/main.ts'`, or escape the space with `\`; an unterminated quote is refused with a line on stderr, never guessed), port from `$ALCA_PORT` or `engineering.port` in `config.json` (default 4317).
- **Keeps it running.** A core that exits is restarted with backoff (1 s, 2 s, 4 s … 30 s, reset after a minute up); five crashes in two minutes stop the retries until 重新啟動核心. Quitting sends SIGTERM, waits up to 8 s, then kills, so the port is released.
- **Window.** A local splash (`ui/`, no network, `core:default` capability only) until the core answers, then the core's UI at `http://127.0.0.1:<port>/#token=…` — the token travels in the fragment, never in a request. The core's page gets no Tauri IPC at all. Closing the window keeps Alca in the tray.
- **Tray / menu bar.** First line says what is going on (`等你決定：N 件` from `/api/status`, with an amber icon and a count); 打開 Alca / 查看等你決定的事, 配對手機…, 登入時開啟, 重新啟動核心, 打開紀錄檔資料夾, 結束 Alca. The tooltip adds how many phones are online.
- **Links.** `alca://pair` opens the 手機 dialog with a fresh code; `alca://open` just brings the window forward. A second launch focuses the existing window.

## Build and test

```sh
# Linux needs WebKitGTK 4.1 and an appindicator:
#   sudo apt-get install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf
cd apps/desktop-shell/src-tauri
cargo check --all-targets      # compile everything, tests included
cargo test                     # unit tests (paths, deep links, probe parsing, backoff, tray text)
cargo fmt --check && cargo clippy --all-targets -- -D warnings

# A bundle (the Tauri CLI is a devDependency here, pinned in pnpm-lock.yaml: `pnpm install` at the root)
cd apps/desktop-shell
pnpm exec tauri build                                   # this OS
CI=true pnpm exec tauri build --target universal-apple-darwin   # macOS universal .dmg (both Rust targets installed)
# On macOS set CI=true for a .dmg: otherwise bundle_dmg.sh drives Finder with AppleScript and,
# without Automation permission for the terminal, fails with "AppleEvent timed out (-1712)".

# Run it against a core from this checkout
ALCA_CORE_CMD="node --disable-warning=ExperimentalWarning '$(pwd)/../desktop/src/main.ts'" ALCA_ENGINE=demo \
  pnpm exec tauri dev
```

CI (`.github/workflows/ci.yml`, job `desktop-shell`) runs fmt, check, clippy and the unit tests on Linux. A `v*` tag runs `.github/workflows/release.yml`: unsigned macOS universal `.dmg`, Windows NSIS `.exe`, Linux `.deb` / `.AppImage`, next to the core tarball and `install.sh`, in a draft release.

## Verification status (2026-11-03)

- ✅ `cargo check --tests` on Linux aarch64 (Rust stable, Tauri 2.12, WebKitGTK 4.1) — verified in the sandbox.
- ✅ `cargo test` on Linux aarch64: 7 unit tests (paths, deep links, probe parsing, waiting count, backoff, tray headline and tooltip) — verified in the sandbox.
- ✅ `cargo fmt --check` and `cargo clippy --all-targets -D warnings` on Linux — verified in the sandbox.
- ✅ `tauri build` on macOS (universal), Linux x64 and Windows x64 in the `v0.2.0` release run (run 41793826816; the `.dmg` / `.exe` / `.deb` / `.AppImage` are in the draft release); ❌ none of the bundles launched on a desktop yet.
- ❌ Running the app (window, tray, autostart, `alca://`, single instance, the supervisor against a real core) — not run: no display in the sandbox. The manual checks are in [docs/DEVICE-TEST.md § G](../../docs/DEVICE-TEST.md).
- ❌ macOS- and Windows-only code paths (LaunchAgent autostart, menu-bar template icon, Windows process handling) — compiled in the `v0.2.0` release run (macOS / Windows); never run.

One build fix came out of the first compile: `tauri_plugin_autostart::Builder::macos_launcher` exists only on macOS, so the LaunchAgent option is now set under `#[cfg(target_os = "macos")]`.

## Not done yet

- **Signing (wired, needs the owner's accounts; [docs/RELEASE.md § 2](../../docs/RELEASE.md#2-what-the-owner-prepares-signing)).** macOS: with `APPLE_CERTIFICATE` (base64 .p12), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY` the bundled Node (hardened runtime, `src-tauri/node.entitlements`: JIT) and the App are Developer ID signed; with `APPLE_ID`, `APPLE_PASSWORD` (app-specific), `APPLE_TEAM_ID` the App is notarized by the Tauri CLI and the `.dmg` by `notarytool`, both stapled and checked with `spctl`. Without them: ad-hoc signed. Windows (Phase E): with `WINDOWS_CERTIFICATE` (base64 .pfx) and `WINDOWS_CERTIFICATE_PASSWORD` the Tauri CLI signs with `signtool` (SHA-256, timestamped) and the job checks the installer is `Valid`; without them unsigned (SmartScreen warns); a cloud-HSM certificate needs `signCommand` (not wired). None of it has run with real secrets yet; the release notes state each build's signing state.
- **Updates.** The core installed by `install.sh` / `install.ps1` updates with `alca update` (Phase E). The App itself does not: the Tauri updater needs a public repository and a published release (its endpoint must be anonymous), its own key pair and `tauri-plugin-updater` — steps in [docs/RELEASE.md § 7](../../docs/RELEASE.md#7-not-wired-yet-the-tauri-updater). Until then the App's core shows a newer version with the download link.
- **Bundled core (macOS, Linux release builds).** `scripts/stage-shell-core.sh <platform>` packs the core (`scripts/pack-core.ts --tar`) and fetches the official Node 22 binary (checksum-checked; `lipo` makes a universal one for macOS) into `src-tauri/bundle-core/`, and prints a `tauri build --config` overlay that maps them to `<resources>/core/alca-core.tar.gz` and `<resources>/core/node/bin/node`. On first start the shell unpacks the tarball with the system `tar` into `<data-dir>/bundled/<app version>` (via a `.partial` folder; once per version) and runs it with that Node — a tarball, because the packed tree keeps relative symlinks for the workspace packages that a bundler would not. Unit-tested (unpack, symlinks kept, a broken tarball is not used) and the staged tree was run with its Node on Linux; the `.dmg` / `.AppImage` were built by the `v0.2.0` release run (not yet installed on a clean machine). Windows installs the core with `scripts/install.ps1` (Phase E); the Windows shell finds it in `~\.alca\app`. Chromium is not bundled (the core finds an installed Chrome / Chromium).
