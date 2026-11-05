# Install the Alca core for this user (Windows) and keep it running. The Windows twin of
# scripts/install.sh: the same release files, the same checksum rule, the same "latest" rule.
#
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 --version v0.2.0   # a given release
#   (Windows does not run a downloaded script by default; -ExecutionPolicy Bypass is for this run only)
#   powershell -ExecutionPolicy Bypass -File .\install.ps1             # the latest published release
#   .\install.ps1 --tarball .\alca-core-0.2.0.tar.gz                  # a downloaded tarball (+ its .sha256)
#   & ([scriptblock]::Create((irm <release>/install.ps1))) --version v0.2.0   # straight from the release
#
# Options (GNU style as in install.sh; -Version, -Tarball … work too):
#   --version <tag>     release tag to download (default: latest). A draft release is never
#                       "latest" on GitHub: until one is published, name the tag (--version v0.2.0)
#   --tarball <file|url> checked against --sha256, else <file|url>.sha256 next to it; without
#                       either it refuses (a tarball with no checksum is not installed)
#   --sha256 <hex>      the expected SHA-256 of the tarball (from the release page)
#   --insecure          install a --tarball that has no checksum anyway (you vouch for it)
#   --prefix <dir>      where Alca lives (default $env:ALCA_HOME or ~\.alca); the app goes in <prefix>\app
#   --engine <name>     claude-code (default) or demo
#   --site <https url>  the Alca phone site to use when this build carries none
#   --no-service        do not run `alca service install` (Task Scheduler)
#   -- <flags>          more flags for the core (e.g. --rendezvous https://relay.example:8787)
#                       (calling the script inside PowerShell eats a bare --: write '--' in quotes)
#
# What it does: checks Node >= 22.18, downloads alca-core.tar.gz and its .sha256 over https
# (a private repository: through a signed-in GitHub CLI), checks the SHA-256, unpacks the core
# into <prefix>\app (the previous copy stays as app.prev until the new one is in place), writes
# a launcher at <prefix>\bin\alca.cmd, runs `alca service install` (Task Scheduler, at logon)
# and prints how to pair a phone. Your data in <prefix> (state.sqlite, secrets.json,
# config.json, logs\) is never touched. Later versions: `alca update` (docs/RUNNING.md).
#
# Symlinks: the packed core links its workspace packages with relative symlinks, which tar.exe
# cannot create without Developer Mode. The tarball lists them in ALCA_LINKS.json; they are left
# out of the unpack and laid as directory junctions (no administrator rights needed) instead.
#
# Saved as UTF-8 with a BOM: Windows PowerShell 5.1 reads a file without one as the ANSI code page.
#
# Test hooks (this script is tested with pwsh on Linux): ALCA_INSTALL_OS=Windows takes the
# Windows paths on another OS; ALCA_INSTALL_FETCH=<command> downloads instead of
# Invoke-WebRequest (called as: <command> <url> <dest>, exit 0 = ok).

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$Repo = if ($env:ALCA_REPO) { $env:ALCA_REPO } else { 'ihsieh31/alca-bot' }
$HomeDir = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
$Prefix = if ($env:ALCA_HOME) { $env:ALCA_HOME } else { Join-Path $HomeDir '.alca' }
$Engine = 'claude-code'
$Mode = 'release'
$Source = ''
$Version = 'latest'
$Service = $true
$Site = ''
$Sha256 = ''
$Insecure = $false
$CoreArgs = @()
$RealWindows = [System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT
$OnWindows = if ($env:ALCA_INSTALL_OS) { $env:ALCA_INSTALL_OS -eq 'Windows' } else { $RealWindows }

function Say([string]$Text) { [Console]::Out.WriteLine($Text) }
function Die([string]$Text) {
  [Console]::Error.WriteLine("安裝失敗：$Text")
  exit 1
}

# --- Options (no param() block: --version and -Version both reach $args) ----------------
$argv = @($args)
$i = 0
function Next-Value([string]$Name, [string]$Hint) {
  if ($script:i + 1 -ge $script:argv.Count) { Die "$Name 需要$Hint" }
  $script:i++
  return [string]$script:argv[$script:i]
}
while ($i -lt $argv.Count) {
  $a = [string]$argv[$i]
  switch -Regex ($a) {
    '^--?version$' { $Version = Next-Value '--version' '版本，例如 v0.8.0'; break }
    '^--?tarball$' { $Mode = 'tarball'; $Source = Next-Value '--tarball' '檔案或網址'; break }
    '^--?sha256$' {
      $Sha256 = (Next-Value '--sha256' ' 64 位十六進位的檢查碼').ToLowerInvariant()
      if ($Sha256 -notmatch '^[0-9a-f]{64}$') { Die '--sha256 要 64 個十六進位字元' }
      break
    }
    '^--?insecure$' { $Insecure = $true; break }
    '^--?prefix$' { $Prefix = Next-Value '--prefix' '一個資料夾'; break }
    '^--?engine$' { $Engine = Next-Value '--engine' ' claude-code 或 demo'; break }
    '^--?site$' {
      $Site = (Next-Value '--site' '網址，例如 https://alca.example.com').TrimEnd('/')
      if ($Site -notmatch '^https://') { Die '--site 只接受 https:// 網址' }
      break
    }
    '^--?no-?service$' { $Service = $false; break }
    '^--$' { $CoreArgs = @($argv | Select-Object -Skip ($i + 1)); $i = $argv.Count; break }
    '^(-h|--help|-\?)$' {
      $lines = @(); if ($PSCommandPath) { $lines = @(Get-Content -LiteralPath $PSCommandPath) }
      for ($k = 1; $k -lt $lines.Count -and $lines[$k] -like '#*'; $k++) { Say ($lines[$k] -replace '^# ?', '') }
      exit 0
    }
    default { Die "不認得的選項：$a（--help 看用法）" }
  }
  $i++
}

if (-not $OnWindows) { Die '這個腳本是 Windows 版；macOS 與 Linux 請用 install.sh' }

# --- Downloads ----------------------------------------------------------------------------
# Windows PowerShell 5.1 still offers TLS 1.0 first; GitHub needs 1.2.
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

function Fetch([string]$Url, [string]$Dest) {
  if ($Url -notmatch '^https://') { Die "只接受 https 下載：$Url" }
  if ($env:ALCA_INSTALL_FETCH) {
    & $env:ALCA_INSTALL_FETCH $Url $Dest 2>$null | Out-Null
    return ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $Dest))
  }
  try {
    $old = $ProgressPreference
    $ProgressPreference = 'SilentlyContinue' # the progress bar makes 5.1 downloads crawl
    Invoke-WebRequest -Uri $Url -OutFile $Dest -UseBasicParsing -MaximumRedirection 10
    $ProgressPreference = $old
    return $true
  } catch {
    return $false
  }
}

function Sha256-Of([string]$File) { (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant() }

function First-Word([string]$File) { ([string](Get-Content -LiteralPath $File -Raw)).Trim().Split()[0] }

# Installed only when the SHA-256 matches a checksum we were given (or, with --insecure, when
# the person says so); an empty expected value is a refusal, not a pass.
function Verify-Sum([string]$Want, [string]$File, [string]$From) {
  $Want = $Want.ToLowerInvariant()
  if (-not $Want) {
    if ($Insecure) { Say "⚠️  沒有檢查碼，照 --insecure 安裝 $From（請確定來源可信）"; return }
    Die "找不到 $From 的檢查碼（.sha256）。用 --sha256 <檢查碼> 指定，或確定來源可信後加 --insecure"
  }
  if ($Want -notmatch '^[0-9a-f]{64}$') { Die "$From 的檢查碼格式不對" }
  if ((Sha256-Of $File) -ne $Want) { Die '檢查碼不符，已停止' }
  Say '檢查碼正確'
}

# Why a download failed: with no --version, often because the only release is still a draft
# (GitHub's "latest" skips drafts and pre-releases); a named tag works through the GitHub CLI.
function No-Release-Hint {
  if ($Version -eq 'latest') {
    return '找不到「最新版」：草稿（尚未發布）或預先發行的 release 不算 latest。請加 --version <tag> 指定版本（例如 --version v0.2.0，私人 repo 需先 gh auth login），或改用 --tarball'
  }
  return "這個 repo 沒有 $Version 這個 release，或它沒有這個檔案"
}

function Have-Gh {
  if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { return $false }
  & gh auth status *> $null
  return ($LASTEXITCODE -eq 0)
}

# --- Node >= 22.18 (runs our TypeScript directly) ------------------------------------------
function Find-Node {
  foreach ($p in @((Join-Path $Prefix 'node\node.exe'), (Join-Path $Prefix 'node/bin/node'))) {
    if (Test-Path -LiteralPath $p -PathType Leaf) { return $p }
  }
  $c = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { return $c.Source }
  return $null
}
$Node = Find-Node
if (-not $Node) { Die '找不到 Node.js。請先安裝 Node 22.18 以上（winget install OpenJS.NodeJS.LTS，或 https://nodejs.org），開一個新的視窗再執行一次。' }
$NodeVersion = [string](& $Node -p 'process.versions.node' 2>$null)
if ($LASTEXITCODE -ne 0 -or $NodeVersion -notmatch '^(\d+)\.(\d+)') { Die "這個 Node 跑不起來（$Node）" }
$maj = [int]$Matches[1]; $min = [int]$Matches[2]
if (-not ($maj -gt 22 -or ($maj -eq 22 -and $min -ge 18))) { Die "Node $NodeVersion 太舊（$Node）。需要 22.18 以上（winget upgrade OpenJS.NodeJS.LTS）。" }
Say "Node $NodeVersion（$Node）"

# --- The prefix: this user only (install.sh's chmod 700) -------------------------------------
$MadePrefix = -not (Test-Path -LiteralPath $Prefix)
New-Item -ItemType Directory -Force -Path $Prefix | Out-Null
$Prefix = (Resolve-Path -LiteralPath $Prefix).Path
if ($RealWindows) {
  $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  & icacls $Prefix /inheritance:r /grant:r "${me}:(OI)(CI)F" *> $null
  if ($LASTEXITCODE -ne 0) { Say "⚠️  沒能把 $Prefix 的權限改成只有你能讀（icacls）" }
}
# Inside the prefix (same volume: the unpacked tree is moved, not copied, into place).
$Work = Join-Path $Prefix ('.install-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $Work | Out-Null
$Links = $null

function Derive-Links([string]$Root) {
  $byName = @{}
  $pkgs = @()
  foreach ($top in 'apps', 'packages', 'services') {
    $d = Join-Path $Root $top
    if (-not (Test-Path -LiteralPath $d)) { continue }
    foreach ($p in Get-ChildItem -LiteralPath $d -Directory) {
      $pj = Join-Path $p.FullName 'package.json'
      if (-not (Test-Path -LiteralPath $pj)) { continue }
      $j = Get-Content -LiteralPath $pj -Raw | ConvertFrom-Json
      $rel = "$top/$($p.Name)"
      if ($j.PSObject.Properties['name']) { $byName[[string]$j.name] = $rel }
      $pkgs += , @($rel, $j)
    }
  }
  $out = @()
  foreach ($pair in $pkgs) {
    $rel = $pair[0]; $j = $pair[1]
    if (-not $j.PSObject.Properties['dependencies']) { continue }
    foreach ($dep in $j.dependencies.PSObject.Properties) {
      if ([string]$dep.Value -notlike 'workspace:*' -or -not $byName.ContainsKey($dep.Name)) { continue }
      $out += [pscustomobject]@{ path = "$rel/node_modules/$($dep.Name)"; abs = $byName[$dep.Name] }
    }
  }
  return $out
}

# Lay each link as a junction (a symlink on another OS, for the tests). Junctions hold absolute
# paths, so this runs again once the tree is in its final place.
function Lay-Links([string]$Root) {
  $list = if ($null -ne $script:Links) {
    @($script:Links | ForEach-Object {
        $from = Join-Path $Root $_.path
        [pscustomobject]@{ from = $from; to = [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $from) $_.target)) }
      })
  } else {
    @(Derive-Links $Root | ForEach-Object { [pscustomobject]@{ from = (Join-Path $Root $_.path); to = (Join-Path $Root $_.abs) } })
  }
  foreach ($l in $list) {
    $item = Get-Item -LiteralPath $l.from -Force -ErrorAction SilentlyContinue
    if ($item) {
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { $item.Delete() }
      elseif ($null -eq $script:Links) { continue } # a real folder from an old tarball's unpack
      else { Die "$($l.from) 應該是連結" }
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $l.from) | Out-Null
    $type = if ($RealWindows) { 'Junction' } else { 'SymbolicLink' }
    New-Item -ItemType $type -Path $l.from -Target $l.to | Out-Null
  }
}

$ok = $false
try {
  # --- Get the core --------------------------------------------------------------------------
  $Tarball = Join-Path $Work 'alca-core.tar.gz'
  if ($Mode -eq 'tarball') {
    if ($Source -match '^https://') {
      Say "下載 $Source"
      if (-not (Fetch $Source $Tarball)) { Die "下載失敗：$Source" }
      if (-not $Sha256 -and (Fetch "$Source.sha256" (Join-Path $Work 'sum'))) { $Sha256 = First-Word (Join-Path $Work 'sum') }
    } elseif ($Source -match '^http://') {
      Die '只接受 https 下載'
    } else {
      if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) { Die "找不到 $Source" }
      Copy-Item -LiteralPath $Source -Destination $Tarball
      if (-not $Sha256 -and (Test-Path -LiteralPath "$Source.sha256")) { $Sha256 = First-Word "$Source.sha256" }
    }
    Verify-Sum $Sha256 $Tarball $Source
  } else {
    $Base = if ($Version -eq 'latest') { "https://github.com/$Repo/releases/latest/download" } else { "https://github.com/$Repo/releases/download/$Version" }
    Say "下載 $Base/alca-core.tar.gz"
    $sum = Join-Path $Work 'sum'
    if (-not ((Fetch "$Base/alca-core.tar.gz" $Tarball) -and (Fetch "$Base/alca-core.tar.gz.sha256" $sum))) {
      # A private repository: its release files need a signed-in GitHub CLI.
      if (-not (Have-Gh)) { Die "下載失敗。私人 repo 要先安裝並登入 GitHub CLI（winget install GitHub.cli，再 gh auth login），或改用 --tarball。$(No-Release-Hint)" }
      Say '用 GitHub CLI 下載（私人 repo）'
      $tag = @(); if ($Version -ne 'latest') { $tag = @($Version) }
      & gh release download @tag --repo $Repo --pattern 'alca-core.tar.gz' --pattern 'alca-core.tar.gz.sha256' --dir $Work --clobber
      if ($LASTEXITCODE -ne 0) { Die "GitHub CLI 也下載不到 alca-core.tar.gz。$(No-Release-Hint)" }
      Move-Item -Force -LiteralPath (Join-Path $Work 'alca-core.tar.gz.sha256') -Destination $sum
    }
    Verify-Sum (First-Word $sum) $Tarball "$Base/alca-core.tar.gz"
  }

  # --- Unpack, symlinks as junctions -----------------------------------------------------------
  $Tar = if ($RealWindows -and (Test-Path -LiteralPath "$env:SystemRoot\System32\tar.exe")) { "$env:SystemRoot\System32\tar.exe" } else { 'tar' }
  $X = Join-Path $Work 'x'
  New-Item -ItemType Directory -Force -Path $X | Out-Null
  & $Tar -xzf $Tarball -C $X 'alca/ALCA_LINKS.json' *> $null
  $manifest = Join-Path $X 'alca/ALCA_LINKS.json'
  if ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $manifest)) {
    $Links = @((Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json).links)
    $exclude = Join-Path $Work 'exclude.txt'
    [IO.File]::WriteAllLines($exclude, [string[]]@($Links | ForEach-Object { 'alca/' + $_.path }))
    & $Tar -xzf $Tarball -C $X -X $exclude
    if ($LASTEXITCODE -ne 0) { Die '解壓縮失敗' }
  } else {
    # An older tarball without the list: tar may fail on its symlinks; the links are derived
    # from the packages' workspace dependencies and the trial run below decides.
    & $Tar -xzf $Tarball -C $X 2>$null
  }
  $New = Join-Path $X 'alca'
  if (-not (Test-Path -LiteralPath (Join-Path $New 'apps/desktop/src/cli.ts'))) { Die '壓縮檔內容不對（找不到 apps/desktop/src/cli.ts）' }
  Lay-Links $New
  & $Node --disable-warning=ExperimentalWarning (Join-Path $New 'apps/desktop/src/cli.ts') *> $null
  if ($LASTEXITCODE -ne 0) { Die '新版核心在這台電腦上跑不起來' }

  # The official endpoints (P12): a release carries them; --site names (or replaces) the site.
  if ($Site) { [IO.File]::WriteAllText((Join-Path $New 'apps/desktop/official-config.json'), "{`n  `"siteUrl`": `"$Site`"`n}`n") }

  $App = Join-Path $Prefix 'app'
  $Prev = Join-Path $Prefix 'app.prev'
  Remove-Item -LiteralPath $Prev -Recurse -Force -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $App) { Move-Item -LiteralPath $App -Destination $Prev }
  try {
    Move-Item -LiteralPath $New -Destination $App
    Lay-Links $App
  } catch {
    if (Test-Path -LiteralPath $Prev) {
      Remove-Item -LiteralPath $App -Recurse -Force -ErrorAction SilentlyContinue
      Move-Item -LiteralPath $Prev -Destination $App
    }
    Die "放不進 $App：$($_.Exception.Message)"
  }
  Remove-Item -LiteralPath $Prev -Recurse -Force -ErrorAction SilentlyContinue
  $ver = '?'
  try { $ver = (Get-Content -LiteralPath (Join-Path $App 'ALCA_VERSION') -Raw | ConvertFrom-Json).version } catch { }
  Say "已安裝 Alca $ver 到 $App"

  # --- Launcher --------------------------------------------------------------------------------
  $Bin = Join-Path $Prefix 'bin'
  New-Item -ItemType Directory -Force -Path $Bin | Out-Null
  $Cli = Join-Path $App 'apps\desktop\src\cli.ts'
  $Launcher = Join-Path $Bin 'alca.cmd'
  $cmd = @(
    '@echo off',
    'rem Written by scripts/install.ps1. Runs the installed Alca core''s command line.',
    "if not defined ALCA_DATA_DIR set `"ALCA_DATA_DIR=$Prefix`"",
    "`"$Node`" --disable-warning=ExperimentalWarning `"$Cli`" %*"
  )
  [IO.File]::WriteAllLines($Launcher, [string[]]$cmd)

  # --- Service (Task Scheduler) ------------------------------------------------------------------
  $CliArgs = @('--disable-warning=ExperimentalWarning', (Join-Path $App 'apps/desktop/src/cli.ts'))
  if ($Service) {
    Say ''
    & $Node @CliArgs service install --engine $Engine --data-dir $Prefix -- @CoreArgs
    if ($LASTEXITCODE -ne 0) { Say "背景服務沒有裝好。可以先在這個視窗執行：$Launcher start --engine $Engine --data-dir $Prefix" }
  } else {
    Say "略過背景服務。手動啟動：$Launcher start --engine $Engine --data-dir $Prefix $($CoreArgs -join ' ')"
  }

  # --- Next steps --------------------------------------------------------------------------------
  Say ''
  if (Test-Path -LiteralPath (Join-Path $App 'apps/desktop/official-config.json')) {
    Say '下一步：連上手機'
    Say '  1. 打開 http://127.0.0.1:4317 → 手機與裝置 → 按「用 Google 登入」'
    Say '  2. 手機打開 Alca 網站、用同一個 Google 帳號登入'
    Say '  3. 在電腦上輸入手機顯示的 6 位數驗證碼；之後會自動連線'
    Say "  （也可以配對手機：$Launcher pair）"
  } else {
    Say '下一步：配對手機'
    Say "  1. 在電腦上執行：$Launcher pair（或打開 http://127.0.0.1:4317 按「手機」）"
    Say '  2. 用手機相機掃 QR，或在手機的 Alca 頁面輸入那組配對碼'
    Say '  3. 兩邊顯示的安全碼一致才按確認'
    Say '  （要讓手機連得到，核心需要 --rendezvous <你的中繼網址>，或安裝時加 --site <Alca 網站>，見 docs/RUNNING.md）'
  }
  $onPath = @(($env:PATH -split [IO.Path]::PathSeparator) | Where-Object { $_ -and ($_.TrimEnd('\', '/') -eq $Bin) }).Count -gt 0
  if (-not $onPath) {
    Say ''
    Say '想直接打 alca：把這個資料夾加到使用者的 PATH（開新視窗後生效）'
    Say "  [Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path', 'User') + ';$Bin', 'User')"
  }
  $ok = $true
} finally {
  Remove-Item -LiteralPath $Work -Recurse -Force -ErrorAction SilentlyContinue
  # A prefix this run made is removed again when the install fails before anything lands in it.
  if (-not $ok -and $MadePrefix -and -not (Get-ChildItem -LiteralPath $Prefix -Force -ErrorAction SilentlyContinue)) {
    Remove-Item -LiteralPath $Prefix -Force -ErrorAction SilentlyContinue
  }
}
