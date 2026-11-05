#!/usr/bin/env bash
# Before the repository is made public (docs/RELEASE.md § 改成 public 前): the checks that look at
# the whole history, not just the current tree. Read-only; changes nothing in the repository.
#
#   bash scripts/pre-public-check.sh            # this checkout (all refs it has)
#   bash scripts/pre-public-check.sh --mirror   # a fresh `git clone --mirror` of origin (every branch)
#
# 1. check:names and check:deploy-values on the current tree (CLEANROOM rule 2, P12 values).
# 2. gitleaks over every commit of every ref, with the reviewed findings in .gitleaksignore
#    (a pinned release, checked against its SHA-256 before it runs).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GITLEAKS_VERSION="8.21.2"
MIRROR=0
[ "${1:-}" = "--mirror" ] && MIRROR=1

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) plat=linux_x64 sum=5bc41815076e6ed6ef8fbecc9d9b75bcae31f39029ceb55da08086315316e3ba ;;
  Linux-aarch64 | Linux-arm64) plat=linux_arm64 sum=654c935542c89f565aabe7bf7c6c500830f116c114f0aeb509d2460c1ac2e6da ;;
  Darwin-x86_64) plat=darwin_x64 sum=5b42c6e4b1fd693eaeb2b5b7faa5f17a1434299d4deb2de63d4b2efd7c753128 ;;
  Darwin-arm64) plat=darwin_arm64 sum=cad3de5dc9a4d5447d967a70a4d49499c557f04db028274cc324f9ff983f6502 ;;
  *) echo "這個系統沒有對應的 gitleaks 版本" >&2; exit 2 ;;
esac

WORK="$(mktemp -d "${TMPDIR:-/tmp}/alca-prepublic.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

echo "== 1/2 名稱與部署值（目前的檔案）"
(cd "$ROOT" && node --disable-warning=ExperimentalWarning scripts/check-names.ts && node --disable-warning=ExperimentalWarning scripts/check-deploy-values.ts)

echo "== 2/2 gitleaks（全部歷史）"
tgz="$WORK/gitleaks.tar.gz"
curl --proto '=https' --tlsv1.2 -fsSL -o "$tgz" \
  "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_${plat}.tar.gz"
got="$(if command -v sha256sum >/dev/null; then sha256sum "$tgz"; else shasum -a 256 "$tgz"; fi | cut -d' ' -f1)"
[ "$got" = "$sum" ] || { echo "gitleaks 的檢查碼不符，已停止" >&2; exit 1; }
tar -xzf "$tgz" -C "$WORK" gitleaks

repo="$ROOT"
if [ "$MIRROR" = 1 ]; then
  git clone -q --mirror "$(git -C "$ROOT" remote get-url origin)" "$WORK/repo.git"
  repo="$WORK/repo.git"
fi
if "$WORK/gitleaks" git "$repo" --log-opts="--all" --redact --gitleaks-ignore-path "$ROOT/.gitleaksignore" \
  --report-path "$WORK/report.json" --no-banner; then
  echo "沒有新的發現（已審過的在 .gitleaksignore）"
else
  echo "" >&2
  echo "有新的發現（值已遮蔽）：" >&2
  # shellcheck disable=SC2016 # JavaScript template literals, not shell expansions
  node -e 'for (const f of JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))) console.error(`  ${f.RuleID}  ${f.File}:${f.StartLine}  ${f.Commit.slice(0, 7)}  ${f.Fingerprint}`)' "$WORK/report.json"
  echo "一一確認：真的金鑰要先撤銷再處理歷史；測試假資料可加進 .gitleaksignore（附原因）" >&2
  exit 1
fi
