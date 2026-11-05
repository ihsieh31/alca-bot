#!/usr/bin/env bash
# Stage the core and a Node runtime for a desktop-shell release build, so the
# app runs on its own (no install.sh needed):
#
#   apps/desktop-shell/src-tauri/bundle-core/alca-core.tar.gz   the packed core (scripts/pack-core.ts --tar)
#   apps/desktop-shell/src-tauri/bundle-core/node               the official Node 22 binary for the target
#
# and print the Tauri config overlay that maps them to <resources>/core/…,
# where the shell looks for them (src-tauri/src/paths.rs). Used by
# .github/workflows/release.yml; run from the repo root after `pnpm install`.
#
#   bash scripts/stage-shell-core.sh darwin-universal | linux-x64 | linux-arm64 | darwin-arm64 | darwin-x64
#
# Node comes from nodejs.org (latest 22.x, https only) and is checked against
# that release's SHASUMS256.txt. darwin-universal joins the arm64 and x64
# binaries with lipo.
set -euo pipefail

PLATFORM="${1:-}"
case "$PLATFORM" in
darwin-universal | darwin-arm64 | darwin-x64 | linux-x64 | linux-arm64) ;;
*)
  echo "usage: stage-shell-core.sh darwin-universal|darwin-arm64|darwin-x64|linux-x64|linux-arm64" >&2
  exit 2
  ;;
esac

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/apps/desktop-shell/src-tauri/bundle-core"
DIST="https://nodejs.org/dist/latest-v22.x"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

rm -rf "$OUT"
mkdir -p "$OUT"

node --disable-warning=ExperimentalWarning "$ROOT/scripts/pack-core.ts" --tar "$OUT/alca-core.tar.gz" >&2

curl --proto '=https' --tlsv1.2 -fsSL "$DIST/SHASUMS256.txt" -o "$WORK/SHASUMS256.txt"

# Download, check and unpack one Node build; prints the path of its `node` binary.
fetch_node() {
  local arch="$1" file sum
  file="$(grep -oE "node-v22\.[0-9]+\.[0-9]+-${arch}\.tar\.gz" "$WORK/SHASUMS256.txt" | head -n 1)"
  if [ -z "$file" ]; then
    echo "no Node 22 build for $arch in $DIST" >&2
    exit 1
  fi
  curl --proto '=https' --tlsv1.2 -fsSL "$DIST/$file" -o "$WORK/$file"
  sum="$(grep " ${file}\$" "$WORK/SHASUMS256.txt" | cut -d' ' -f1)"
  if command -v sha256sum >/dev/null 2>&1; then
    echo "$sum  $WORK/$file" | sha256sum -c - >&2
  else
    echo "$sum  $WORK/$file" | shasum -a 256 -c - >&2
  fi
  mkdir -p "$WORK/$arch"
  tar -xzf "$WORK/$file" -C "$WORK/$arch" --strip-components=1
  echo "$WORK/$arch/bin/node"
}

if [ "$PLATFORM" = darwin-universal ]; then
  arm="$(fetch_node darwin-arm64)"
  x64="$(fetch_node darwin-x64)"
  lipo -create "$arm" "$x64" -output "$OUT/node"
else
  cp "$(fetch_node "$PLATFORM")" "$OUT/node"
fi
chmod 755 "$OUT/node"
"$OUT/node" --version >&2 || true

# The overlay for `tauri build --config`: file-to-file, so nothing depends on how globs are copied.
printf '{"bundle":{"resources":{"bundle-core/alca-core.tar.gz":"core/alca-core.tar.gz","bundle-core/node":"core/node/bin/node"}}}\n'
