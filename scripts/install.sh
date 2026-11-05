#!/usr/bin/env bash
# Install the Alca core for this user (macOS / Linux) and keep it running.
#
#   curl -fsSL <release>/install.sh | bash                       # latest release tarball
#   bash scripts/install.sh --local .                            # from this checkout
#   bash scripts/install.sh --tarball ./alca-core-0.8.0.tar.gz   # from a downloaded tarball (+ its .sha256)
#   bash scripts/install.sh --version v0.8.0                     # a given release
#   bash scripts/install.sh --app-only                           # macOS: only the desktop App
#
# Options:
#   --local <dir>       pack a checkout (needs git and its installed node_modules)
#   --tarball <file|url> checked against --sha256, else <file|url>.sha256 next to it; without
#                       either it refuses (a tarball with no checksum is not installed)
#   --sha256 <hex>      the expected SHA-256 of the tarball (from the release page)
#   --attestation       also check the tarball's GitHub build provenance (gh attestation verify;
#                       needs a signed-in GitHub CLI and a release that has one)
#   --insecure          install a --tarball that has no checksum anyway (you vouch for it)
#   --version <tag>     release tag to download (default: latest). A draft release is never
#                       "latest" on GitHub: until one is published, name the tag (--version v0.2.0)
#   --prefix <dir>      where Alca lives (default $ALCA_HOME or ~/.alca); the app goes in <prefix>/app
#   --engine <name>     claude-code (default) or demo
#   --site <https url>  the Alca phone site to use when this build carries none (it names the relay
#                       and the Google client in its public config.json; nothing else to fill in)
#   --no-service        do not run `alca service install`
#   --app / --no-app    macOS: also install the desktop App (default when installing a release on
#                       macOS) / do not; --app-only installs the App and nothing else (no Node needed)
#   --app-tarball <file|url>  the App's Alca-macos.app.tar.gz (default: the release's), checked
#                       against --app-sha256 or <file|url>.sha256 like --tarball
#   --app-sha256 <hex>  the expected SHA-256 of the App tarball
#   --app-dir <dir>     where the App goes (default $ALCA_APP_DIR or ~/Applications)
#   --yes               replace an existing Alca.app without asking (the old one is kept as a backup)
#   -- <flags>          more flags for the core (e.g. --rendezvous https://relay.example:8787)
#
# What it does: checks Node ≥ 22.18, unpacks the core into <prefix>/app (the
# previous copy is kept as app.prev until the new one is in place), writes a
# launcher at <prefix>/bin/alca, runs `alca service install` (launchd on macOS,
# systemd --user on Linux) and prints how to pair a phone. Your data in
# <prefix> (state.sqlite, secrets.json, config.json, logs/) is never touched.
#
# The App (macOS): the release's Alca.app, ad-hoc signed, downloaded with curl,
# checked against its SHA-256 and its code signature, and unpacked into
# ~/Applications. curl does not mark the download as quarantined, so the App
# opens without a Gatekeeper prompt (a .dmg from a browser is marked and needs
# 「仍要打開」 once). A tarball you downloaded with a browser keeps its mark.
set -euo pipefail

REPO="${ALCA_REPO:-ihsieh31/alca-bot}"
PREFIX="${ALCA_HOME:-$HOME/.alca}"
ENGINE="claude-code"
SOURCE=""
MODE="release"
VERSION="latest"
SERVICE=1
SITE=""
SHA256=""
INSECURE=0
ATTEST=0
CORE_ARGS=()
APP_MODE="auto" # auto | yes | no | only
APP_SOURCE=""
APP_SHA256=""
APP_DIR="${ALCA_APP_DIR:-$HOME/Applications}"
ASSUME_YES=0
APP_ASSET="Alca-macos.app.tar.gz"
# The OS this installs for; ALCA_INSTALL_OS exists for the tests (the App path on a Linux runner).
OS="${ALCA_INSTALL_OS:-$(uname -s)}"

say() { printf '%s\n' "$*"; }
die() {
  printf '安裝失敗：%s\n' "$*" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --local)
      MODE="local"
      SOURCE="${2:?--local 需要一個資料夾}"
      shift 2
      ;;
    --tarball)
      MODE="tarball"
      SOURCE="${2:?--tarball 需要檔案或網址}"
      shift 2
      ;;
    --version)
      VERSION="${2:?--version 需要版本，例如 v0.8.0}"
      shift 2
      ;;
    --prefix)
      PREFIX="${2:?--prefix 需要一個資料夾}"
      shift 2
      ;;
    --engine)
      ENGINE="${2:?--engine 需要 claude-code 或 demo}"
      shift 2
      ;;
    --no-service)
      SERVICE=0
      shift
      ;;
    --sha256)
      SHA256="${2:?--sha256 需要 64 位十六進位的檢查碼}"
      case "$SHA256" in *[!0-9a-fA-F]*) die "--sha256 不是十六進位" ;; esac
      [ "${#SHA256}" -eq 64 ] || die "--sha256 要 64 個字元"
      SHA256="$(printf '%s' "$SHA256" | tr 'A-F' 'a-f')"
      shift 2
      ;;
    --insecure)
      INSECURE=1
      shift
      ;;
    --attestation)
      ATTEST=1
      shift
      ;;
    --app)
      APP_MODE="yes"
      shift
      ;;
    --no-app)
      APP_MODE="no"
      shift
      ;;
    --app-only)
      APP_MODE="only"
      shift
      ;;
    --app-tarball)
      APP_SOURCE="${2:?--app-tarball 需要檔案或網址}"
      [ "$APP_MODE" != auto ] || APP_MODE="yes"
      shift 2
      ;;
    --app-sha256)
      APP_SHA256="${2:?--app-sha256 需要 64 位十六進位的檢查碼}"
      case "$APP_SHA256" in *[!0-9a-fA-F]*) die "--app-sha256 不是十六進位" ;; esac
      [ "${#APP_SHA256}" -eq 64 ] || die "--app-sha256 要 64 個字元"
      shift 2
      ;;
    --app-dir)
      APP_DIR="${2:?--app-dir 需要一個資料夾}"
      shift 2
      ;;
    --yes | -y)
      ASSUME_YES=1
      shift
      ;;
    --site)
      SITE="${2:?--site 需要網址，例如 https://alca.example.com}"
      case "$SITE" in https://*) ;; *) die "--site 只接受 https:// 網址" ;; esac
      SITE="${SITE%/}"
      shift 2
      ;;
    --)
      shift
      CORE_ARGS=("$@")
      break
      ;;
    -h | --help)
      awk 'NR > 1 && /^set -euo/ { exit } NR > 1' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "不認得的選項：$1（--help 看用法）" ;;
  esac
done

case "$OS" in
  Darwin | Linux) ;;
  *) die "這個腳本只支援 macOS 與 Linux（Windows 請見 docs/RUNNING.md）" ;;
esac

# --- Downloads ---------------------------------------------------------------
fetch() { # url dest
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --proto '=https' --tlsv1.2 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q --https-only -O "$2" "$1"
  else
    die "需要 curl 或 wget 來下載"
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# A tarball is installed only when its SHA-256 matches a checksum we were given (or, with
# --insecure, when the person says so); an empty expected value is a refusal, not a pass.
verify_sum() { # expected-hex file source
  local want got
  want="$(printf '%s' "$1" | tr 'A-F' 'a-f')"
  if [ -z "$want" ]; then
    if [ "$INSECURE" = 1 ]; then
      say "⚠️  沒有檢查碼，照 --insecure 安裝 $3（請確定來源可信）"
      return 0
    fi
    die "找不到 $3 的檢查碼（.sha256）。用 --sha256 / --app-sha256 <檢查碼> 指定，或確定來源可信後加 --insecure"
  fi
  got="$(sha256_of "$2")"
  [ "$want" = "$got" ] || die "檢查碼不符，已停止"
  say "檢查碼正確"
}


# --- The desktop App (macOS) ---------------------------------------------------
WANT_APP=0
case "$APP_MODE" in
  yes | only)
    [ "$OS" = Darwin ] || die "桌面 App 只有 macOS 版（--app / --app-only / --app-tarball）"
    WANT_APP=1
    ;;
  auto)
    # A release install on macOS brings the App too; --local / --tarball install only the core.
    if [ "$OS" = Darwin ] && [ "$MODE" = release ]; then WANT_APP=1; fi
    ;;
esac

# Why a download failed: with no --version, often because the only release is still a draft
# (GitHub's "latest" skips drafts and pre-releases); a named tag works through the GitHub CLI.
no_release_hint() {
  if [ "$VERSION" = "latest" ]; then
    printf '%s\n' "找不到「最新版」：草稿（尚未發布）或預先發行的 release 不算 latest。請用 --version <tag> 指定版本（例如 --version v0.2.0，私人 repo 需先 gh auth login），或改用 --local／--tarball"
  else
    printf '%s\n' "這個 repo 沒有 $VERSION 這個 release，或它沒有這個檔案"
  fi
}

release_base() {
  if [ "$VERSION" = "latest" ]; then
    printf '%s\n' "https://github.com/$REPO/releases/latest/download"
  else
    printf '%s\n' "https://github.com/$REPO/releases/download/$VERSION"
  fi
}

# Ask on the terminal (also under `curl … | bash`, whose stdin is the script). No terminal = no.
confirm() { # question
  if [ "$ASSUME_YES" = 1 ]; then return 0; fi
  if ! { exec 3</dev/tty; } 2>/dev/null; then return 1; fi
  printf '%s [y/N] ' "$1" >/dev/tty
  local answer=""
  read -r answer <&3 || answer=""
  exec 3<&-
  case "$answer" in y | Y | yes | YES) return 0 ;; *) return 1 ;; esac
}

# Only the file this script downloaded: a quarantine mark there is dropped, none is ever added.
unmark_download() { # file
  if command -v xattr >/dev/null 2>&1 && xattr -p com.apple.quarantine "$1" >/dev/null 2>&1; then
    xattr -d com.apple.quarantine "$1" 2>/dev/null || true
  fi
}

install_app() {
  local tgz="$WORK/app.tar.gz" want="$APP_SHA256" base
  say ""
  case "$APP_SOURCE" in
    "")
      base="$(release_base)"
      say "下載 App：$base/$APP_ASSET"
      if fetch "$base/$APP_ASSET" "$tgz" 2>/dev/null && { [ -n "$want" ] || fetch "$base/$APP_ASSET.sha256" "$WORK/app.sum" 2>/dev/null; }; then
        :
      else
        if ! command -v gh >/dev/null 2>&1 || ! gh auth status >/dev/null 2>&1; then
          die "App 下載失敗。私人 repo 要先登入 GitHub CLI（gh auth login），或用 --app-tarball 指定檔案。$(no_release_hint)"
        fi
        say "用 GitHub CLI 下載 App（私人 repo）"
        local tag=()
        [ "$VERSION" = "latest" ] || tag=("$VERSION")
        gh release download ${tag[@]+"${tag[@]}"} --repo "$REPO" --pattern "$APP_ASSET" --pattern "$APP_ASSET.sha256" --dir "$WORK" --clobber ||
          die "GitHub CLI 也下載不到 App（$APP_ASSET）。$(no_release_hint)"
        mv "$WORK/$APP_ASSET" "$tgz"
        mv "$WORK/$APP_ASSET.sha256" "$WORK/app.sum"
      fi
      unmark_download "$tgz"
      ;;
    https://*)
      say "下載 App：$APP_SOURCE"
      fetch "$APP_SOURCE" "$tgz"
      if [ -z "$want" ] && fetch "$APP_SOURCE.sha256" "$WORK/app.sum" 2>/dev/null; then :; fi
      unmark_download "$tgz"
      ;;
    http://*) die "只接受 https 下載" ;;
    *)
      [ -f "$APP_SOURCE" ] || die "找不到 $APP_SOURCE"
      cp "$APP_SOURCE" "$tgz"
      if [ -z "$want" ] && [ -f "$APP_SOURCE.sha256" ]; then cp "$APP_SOURCE.sha256" "$WORK/app.sum"; fi
      if command -v xattr >/dev/null 2>&1 && xattr -p com.apple.quarantine "$APP_SOURCE" >/dev/null 2>&1; then
        say "⚠️  $APP_SOURCE 有瀏覽器加的隔離標記，裝好的 App 第一次打開時 macOS 會要你確認；不加 --app-tarball 讓這個腳本下載就不會"
      fi
      ;;
  esac
  if [ -z "$want" ] && [ -f "$WORK/app.sum" ]; then want="$(cut -d' ' -f1 <"$WORK/app.sum")"; fi
  verify_sum "$want" "$tgz" "${APP_SOURCE:-$APP_ASSET}"

  mkdir -p "$WORK/appx"
  tar -xzf "$tgz" -C "$WORK/appx"
  local new="$WORK/appx/Alca.app"
  [ -d "$new/Contents/MacOS" ] || die "App 壓縮檔內容不對（找不到 Alca.app/Contents/MacOS）"
  if command -v codesign >/dev/null 2>&1; then
    # Apple Silicon runs only signed code; an ad-hoc signature is enough on this Mac.
    codesign --verify --deep --strict "$new" 2>/dev/null || die "App 的程式碼簽章不完整，已停止"
    say "App 簽章正確（$(codesign -dv "$new" 2>&1 | sed -n 's/^Signature=//p' | head -n 1)）"
  else
    say "這台沒有 codesign，略過 App 的簽章檢查"
  fi

  mkdir -p "$APP_DIR"
  local dest="$APP_DIR/Alca.app"
  if [ -e "$dest" ]; then
    local backup
    backup="$APP_DIR/Alca.app.bak-$(date +%Y%m%d-%H%M%S)"
    if ! confirm "已經有 $dest，要換成新版嗎？舊的會改名為 $(basename "$backup")"; then
      say "沒有更動 $dest（要取代請加 --yes）"
      return 0
    fi
    mv "$dest" "$backup"
    say "舊的 App 留在 $backup（確認新版沒問題後可以刪掉）"
  fi
  mv "$new" "$dest"
  say "已安裝 App 到 $dest"
  say "  打開：open \"$dest\"（用這個腳本裝的不會跳出 Gatekeeper 警告）"
}

if [ "$APP_MODE" = only ]; then
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/alca-install.XXXXXX")"
  trap 'rm -rf "$WORK"' EXIT
  install_app
  exit 0
fi

# --- Node ≥ 22.18 (runs our TypeScript directly) -----------------------------
find_node() {
  if [ -x "$PREFIX/node/bin/node" ]; then
    printf '%s\n' "$PREFIX/node/bin/node"
  elif command -v node >/dev/null 2>&1; then
    command -v node
  fi
}
NODE="$(find_node)"
[ -n "$NODE" ] || die "找不到 Node.js。請先安裝 Node 22.18 以上（https://nodejs.org），再執行一次。"
NODE_VERSION="$("$NODE" -p 'process.versions.node')"
node_ok() {
  local major minor
  major="${1%%.*}"
  minor="${1#*.}"
  minor="${minor%%.*}"
  [ "$major" -gt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -ge 18 ]; }
}
node_ok "$NODE_VERSION" || die "Node $NODE_VERSION 太舊（$NODE）。需要 22.18 以上。"
say "Node $NODE_VERSION（$NODE）"

# A prefix this run creates is removed again if the install fails before anything
# lands in it (mac test 2026-11-04b A6: a refused checksum left an empty 0700 folder).
# rmdir only removes an empty folder, so nothing that was there is ever touched.
MADE_PREFIX=0
[ -d "$PREFIX" ] || MADE_PREFIX=1
mkdir -p "$PREFIX"
chmod 700 "$PREFIX"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/alca-install.XXXXXX")"
cleanup() {
  local rc=$?
  rm -rf "$WORK"
  if [ "$rc" -ne 0 ] && [ "$MADE_PREFIX" -eq 1 ]; then rmdir "$PREFIX" 2>/dev/null || true; fi
  return "$rc"
}
trap cleanup EXIT

# --- Get the core ------------------------------------------------------------
TARBALL="$WORK/alca-core.tar.gz"
case "$MODE" in
  local)
    [ -f "$SOURCE/scripts/pack-core.ts" ] || die "$SOURCE 不像 Alca 的原始碼資料夾"
    say "從本機原始碼打包：$SOURCE"
    "$NODE" --disable-warning=ExperimentalWarning "$SOURCE/scripts/pack-core.ts" --tar "$TARBALL" >/dev/null
    ;;
  tarball)
    case "$SOURCE" in
      https://*)
        say "下載 $SOURCE"
        fetch "$SOURCE" "$TARBALL"
        if [ -z "$SHA256" ] && fetch "$SOURCE.sha256" "$WORK/sum" 2>/dev/null; then
          SHA256="$(cut -d' ' -f1 <"$WORK/sum")"
        fi
        ;;
      http://*) die "只接受 https 下載" ;;
      *)
        [ -f "$SOURCE" ] || die "找不到 $SOURCE"
        cp "$SOURCE" "$TARBALL"
        if [ -z "$SHA256" ] && [ -f "$SOURCE.sha256" ]; then
          SHA256="$(cut -d' ' -f1 <"$SOURCE.sha256")"
        fi
        ;;
    esac
    verify_sum "$SHA256" "$TARBALL" "$SOURCE"
    ;;
  release)
    if [ "$VERSION" = "latest" ]; then
      BASE="https://github.com/$REPO/releases/latest/download"
    else
      BASE="https://github.com/$REPO/releases/download/$VERSION"
    fi
    say "下載 $BASE/alca-core.tar.gz"
    if ! fetch "$BASE/alca-core.tar.gz" "$TARBALL" 2>/dev/null || ! fetch "$BASE/alca-core.tar.gz.sha256" "$WORK/sum" 2>/dev/null; then
      # A private repository: its release files need a signed-in GitHub CLI.
      if ! command -v gh >/dev/null 2>&1 || ! gh auth status >/dev/null 2>&1; then
        die "下載失敗。私人 repo 要先安裝並登入 GitHub CLI（brew install gh && gh auth login），或改用 --tarball / --local。$(no_release_hint)"
      fi
      say "用 GitHub CLI 下載（私人 repo）"
      TAG_ARGS=()
      [ "$VERSION" = "latest" ] || TAG_ARGS=("$VERSION")
      gh release download ${TAG_ARGS[@]+"${TAG_ARGS[@]}"} --repo "$REPO" --pattern 'alca-core.tar.gz' --pattern 'alca-core.tar.gz.sha256' --dir "$WORK" --clobber ||
        die "GitHub CLI 也下載不到 alca-core.tar.gz。$(no_release_hint)"
      mv "$WORK/alca-core.tar.gz.sha256" "$WORK/sum"
    fi
    verify_sum "$(cut -d' ' -f1 <"$WORK/sum")" "$TARBALL" "$BASE/alca-core.tar.gz"
    ;;
esac

# Build provenance (release.yml attests every file when GitHub offers it for the repository).
if [ "$ATTEST" = 1 ]; then
  [ "$MODE" != local ] || die "--attestation 只用在下載或現成的壓縮檔"
  command -v gh >/dev/null 2>&1 || die "--attestation 需要 GitHub CLI（gh）"
  gh attestation verify "$TARBALL" --repo "$REPO" >/dev/null || die "出處證明（attestation）不符或不存在，已停止"
  say "出處證明正確（$REPO 的 release 流程建置）"
fi

# --- Unpack into <prefix>/app --------------------------------------------------
mkdir -p "$WORK/x"
tar -xzf "$TARBALL" -C "$WORK/x"
NEW="$(find "$WORK/x" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
if [ -z "$NEW" ] || [ ! -f "$NEW/apps/desktop/src/cli.ts" ]; then
  die "壓縮檔內容不對（找不到 apps/desktop/src/cli.ts）"
fi
"$NODE" --disable-warning=ExperimentalWarning "$NEW/apps/desktop/src/cli.ts" >/dev/null ||
  die "新版核心在這台電腦上跑不起來"

# The official endpoints (P12): a release carries them; --site names (or replaces) the site.
OFFICIAL="$NEW/apps/desktop/official-config.json"
if [ -n "$SITE" ]; then
  printf '{\n  "siteUrl": "%s"\n}\n' "$SITE" >"$OFFICIAL"
fi

APP="$PREFIX/app"
rm -rf "$PREFIX/app.new" "$PREFIX/app.prev"
mv "$NEW" "$PREFIX/app.new"
[ -d "$APP" ] && mv "$APP" "$PREFIX/app.prev"
mv "$PREFIX/app.new" "$APP"
rm -rf "$PREFIX/app.prev"
VERSION_LINE="$(sed -n 's/.*"version":"\([^"]*\)".*/\1/p' "$APP/ALCA_VERSION" 2>/dev/null || true)"
say "已安裝 Alca ${VERSION_LINE:-?} 到 $APP"

# --- Launcher ----------------------------------------------------------------
mkdir -p "$PREFIX/bin"
LAUNCHER="$PREFIX/bin/alca"
cat >"$LAUNCHER" <<EOF
#!/bin/sh
# Written by scripts/install.sh. Runs the installed Alca core's command line.
ALCA_DATA_DIR="\${ALCA_DATA_DIR:-$PREFIX}"
export ALCA_DATA_DIR
exec "$NODE" --disable-warning=ExperimentalWarning "$APP/apps/desktop/src/cli.ts" "\$@"
EOF
chmod 755 "$LAUNCHER"

# --- Service -----------------------------------------------------------------
if [ "$SERVICE" -eq 1 ]; then
  say ""
  if ! "$LAUNCHER" service install --engine "$ENGINE" --data-dir "$PREFIX" -- ${CORE_ARGS[@]+"${CORE_ARGS[@]}"}; then
    say "背景服務沒有裝好。可以先在終端機執行：$LAUNCHER start --engine $ENGINE --data-dir $PREFIX"
  fi
else
  say "略過背景服務。手動啟動：$LAUNCHER start --engine $ENGINE --data-dir $PREFIX ${CORE_ARGS[*]+${CORE_ARGS[*]}}"
fi

# --- The App, after the core ----------------------------------------------------
if [ "$WANT_APP" -eq 1 ]; then
  if [ "$APP_MODE" = auto ]; then
    # Asked for implicitly: a release without the App (or no network) leaves the core installed.
    (install_app) || say "⚠️  App 沒有裝好（核心已裝好）。之後可以單獨裝：bash install.sh --app-only"
  else
    install_app
  fi
elif [ "$OS" = Darwin ] && [ "$APP_MODE" = auto ]; then
  say ""
  say "這次只裝了核心。要裝桌面 App：bash install.sh --app-only（或加 --app-tarball <檔案>）"
fi

# --- Next steps --------------------------------------------------------------
case ":$PATH:" in
  *":$PREFIX/bin:"*) ON_PATH=1 ;;
  *) ON_PATH=0 ;;
esac
say ""
if [ -f "$APP/apps/desktop/official-config.json" ]; then
  say "下一步：連上手機"
  say "  1. 打開 http://127.0.0.1:4317 → 手機與裝置 → 按「用 Google 登入」"
  say "  2. 手機打開 Alca 網站、用同一個 Google 帳號登入"
  say "  3. 在電腦上輸入手機顯示的 6 位數驗證碼；之後會自動連線"
  say "  （也可以配對手機：$LAUNCHER pair）"
else
  say "下一步：配對手機"
  say "  1. 在電腦上執行：$LAUNCHER pair（或打開 http://127.0.0.1:4317 按「手機」）"
  say "  2. 用手機相機掃 QR，或在手機的 Alca 頁面輸入那組配對碼"
  say "  3. 兩邊顯示的安全碼一致才按確認"
  say "  （要讓手機連得到，核心需要 --rendezvous <你的中繼網址>，或安裝時加 --site <Alca 網站>，見 docs/RUNNING.md）"
fi
if [ "$ON_PATH" -eq 0 ]; then
  say ""
  say "想直接打 alca：把這行加到 ~/.zshrc 或 ~/.bashrc"
  say "  export PATH=\"$PREFIX/bin:\$PATH\""
fi
