// Always-on core (P8): register the core as a per-user service, so it runs
// without a terminal and comes back after a crash or a login.
//
//   macOS   launchd LaunchAgent  ~/Library/LaunchAgents/<label>.plist (local.alca.core;
//           $ALCA_SERVICE_LABEL names another, e.g. your own reverse-DNS id)
//   Linux   systemd --user unit  ~/.config/systemd/user/alca-core.service
//   Windows Task Scheduler task  \Alca\Core (at logon, restart on failure)
//
// Logs go to <data-dir>/logs/core.log (stdout + stderr). The service runs the
// same headless core as `pnpm desktop`; the desktop shell, when opened, finds
// it on the port and attaches instead of starting a second one.
//
// On macOS and Linux the unit runs <data-dir>/service/run-core.sh, which tries
// the Node used at install time and, when that one is gone (nvm / fnm / volta
// switched or removed it — mac test 2026-11-04), a Node >= 22.18 on the PATH
// or in the usual places, and says so in core.log; `status` warns too.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** A neutral default: `.local` is no one's domain, so the source names no deployment. */
export const DEFAULT_LABEL = "local.alca.core";

/** The LaunchAgent label: $ALCA_SERVICE_LABEL when it is a reverse-DNS id, else the default. */
export function serviceLabel(env: Record<string, string | undefined> = process.env): string {
  const v = env.ALCA_SERVICE_LABEL?.trim();
  return v && /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(v) ? v : DEFAULT_LABEL;
}

export const LABEL = serviceLabel();
export const SYSTEMD_UNIT = "alca-core.service";
export const WINDOWS_TASK = "\\Alca\\Core";

export type Platform = "darwin" | "linux" | "win32";

export interface ServiceSpec {
  platform: Platform;
  home: string;
  /** The Node binary that runs the core (default: this one). */
  node: string;
  /** apps/desktop/src/main.ts, absolute. */
  main: string;
  dataDir: string;
  engine: string;
  /** More flags for main.ts (`--rendezvous …`, `--browser headless` …). */
  extraArgs: string[];
  /** PATH for the service (launchd and systemd start with a bare one; the engine CLI must be found). */
  path: string;
}

export const logDir = (s: Pick<ServiceSpec, "dataDir">): string => join(s.dataDir, "logs");
export const logFile = (s: Pick<ServiceSpec, "dataDir">): string => join(logDir(s), "core.log");

export function defaultSpec(o: Partial<ServiceSpec> & { dataDir: string }): ServiceSpec {
  const platform = (o.platform ?? process.platform) as Platform;
  return {
    platform,
    home: o.home ?? homedir(),
    node: o.node ?? process.execPath,
    main: o.main ?? resolve(dirname(fileURLToPath(import.meta.url)), "main.ts"),
    dataDir: resolve(o.dataDir),
    engine: o.engine ?? "claude-code",
    extraArgs: o.extraArgs ?? [],
    path: o.path ?? (platform === "win32" ? (process.env.PATH ?? "") : servicePath(process.env.PATH ?? "")),
  };
}

/** Always on the service's PATH, after the user's own folders. */
export const BASE_PATH = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];

/**
 * The PATH written into the unit (mac test 2026-11-04b E6). The install used to freeze the
 * whole PATH of the shell it ran in, including pnpm's temporary `node_modules/.bin` and
 * `node-gyp-bin` folders, a literal `~/…` that launchd never expands, and folders gone since.
 * Kept: absolute folders that exist and are not inside node_modules or the temp folder (where
 * the engine CLIs — claude, codex — live, e.g. a Node's global bin), then BASE_PATH; no repeats.
 */
export function servicePath(
  raw: string,
  o: { exists?: (p: string) => boolean; tmp?: string; sep?: string } = {},
): string {
  const exists = o.exists ?? existsSync;
  const tmp = (o.tmp ?? process.env.TMPDIR ?? "/tmp").replace(/\/+$/, "");
  const sep = o.sep ?? ":";
  const out: string[] = [];
  for (const d0 of raw.split(sep)) {
    const d = d0.trim().replace(/(.)\/+$/, "$1");
    if (!d.startsWith("/") || out.includes(d)) continue;
    if (/\/node_modules(\/|$)/.test(d) || (tmp && (d === tmp || d.startsWith(`${tmp}/`)))) continue;
    if (d.startsWith("/tmp/") || d.startsWith("/private/tmp/") || d.startsWith("/private/var/folders/"))
      continue;
    if (!exists(d)) continue;
    out.push(d);
  }
  for (const d of BASE_PATH) if (!out.includes(d)) out.push(d);
  return out.join(sep);
}

export function programArgs(s: ServiceSpec): string[] {
  return [
    s.node,
    "--disable-warning=ExperimentalWarning",
    s.main,
    "--engine",
    s.engine,
    "--data-dir",
    s.dataDir,
    ...s.extraArgs,
  ];
}

/** The small sh launcher the macOS / Linux unit runs (it picks a Node that still exists). */
export const launcherPath = (s: Pick<ServiceSpec, "dataDir">): string =>
  join(s.dataDir, "service", "run-core.sh");

/** Where a Node usually lives when the one recorded at install is gone. Globs stay literal when nothing matches. */
export function defaultNodeCandidates(home: string): string[] {
  return [
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    "/usr/bin/node",
    `${home}/.volta/bin/node`,
    `${home}/.nvm/versions/node/*/bin/node`,
    `${home}/.local/share/fnm/node-versions/*/installation/bin/node`,
    `${home}/.asdf/shims/node`,
  ];
}

const shq = (v: string) => `'${v.replace(/'/g, "'\\''")}'`;
// A glob is left unquoted so sh expands it; everything else is quoted.
const shWord = (v: string) => (/[*?]/.test(v) ? v.split("*").map(shq).join("*") : shq(v));

/**
 * The launcher: the Node recorded at install first, then `node` on the service's PATH, then the
 * usual places; the first that runs and is >= 22.18 runs the core. None → a line in core.log
 * that says what to do, a pause (so launchd / systemd do not spin), exit 78 (EX_CONFIG).
 */
export function launcherScript(s: ServiceSpec, candidates: string[] = defaultNodeCandidates(s.home)): string {
  return `#!/bin/sh
# Written by \`alca service install\`; rewritten on every install. Picks a Node that still exists.
recorded=${shq(s.node)}
main=${shq(s.main)}
usable() {
  [ -n "$1" ] && [ -x "$1" ] || return 1
  v=$("$1" -p 'process.versions.node' 2>/dev/null) || return 1
  major=\${v%%.*}
  rest=\${v#*.}
  minor=\${rest%%.*}
  case "$major.$minor" in *[!0-9.]* | .* | *.) return 1 ;; esac
  [ "$major" -gt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -ge 18 ]; }
}
if [ ! -f "$main" ]; then
  echo "alca service: 找不到 Alca 核心（$main）。重新安裝 Alca，或執行 alca service install。" >&2
  [ "\${ALCA_NO_NODE_WAIT:-60}" -gt 0 ] && sleep "\${ALCA_NO_NODE_WAIT:-60}"
  exit 78
fi
for n in "$recorded" "$(command -v node 2>/dev/null)" ${candidates.map(shWord).join(" ")}; do
  if usable "$n"; then
    if [ "$n" != "$recorded" ]; then
      echo "alca service: 安裝時的 Node（$recorded）不能用了，改用 $n。想固定這個路徑：alca service install。" >&2
    fi
    exec "$n" --disable-warning=ExperimentalWarning "$main" "$@"
  fi
done
echo "alca service: 找不到 Node 22.18 以上（安裝時是 $recorded）。裝好 Node 後執行 alca service install。" >&2
[ "\${ALCA_NO_NODE_WAIT:-60}" -gt 0 ] && sleep "\${ALCA_NO_NODE_WAIT:-60}"
exit 78
`;
}

/** What the unit runs: the launcher on macOS / Linux, Node itself on Windows. */
export function serviceArgs(s: ServiceSpec): string[] {
  if (s.platform === "win32") return programArgs(s);
  return ["/bin/sh", launcherPath(s), ...programArgs(s).slice(3)];
}

/**
 * The Node the installed service would start, when it is gone: the launcher's recorded one, or
 * the first program of a unit written before the launcher existed. Undefined when it exists.
 */
export function missingNode(s: ServiceSpec, exists: (p: string) => boolean = existsSync): string | undefined {
  let recorded: string | undefined;
  try {
    recorded = /^recorded='((?:[^']|'\\'')*)'$/m.exec(readFileSync(launcherPath(s), "utf8"))?.[1];
    recorded = recorded?.replace(/'\\''/g, "'");
  } catch {
    try {
      const unit = readFileSync(unitPath(s), "utf8");
      const first =
        s.platform === "darwin"
          ? /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/.exec(unit)?.[1]
          : /^ExecStart="([^"]*)"/m.exec(unit)?.[1];
      if (first && /node(\.exe)?$/.test(first)) recorded = first.replace(/&amp;/g, "&");
    } catch {
      return undefined;
    }
  }
  return recorded && !exists(recorded) ? recorded : undefined;
}

export function unitPath(s: ServiceSpec): string {
  if (s.platform === "darwin") return join(s.home, "Library", "LaunchAgents", `${LABEL}.plist`);
  if (s.platform === "linux") return join(s.home, ".config", "systemd", "user", SYSTEMD_UNIT);
  return join(s.dataDir, "service", "alca-core-task.xml");
}

const xml = (v: string) =>
  v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** launchd: start at login, restart when it dies (not after a clean stop), logs to core.log. */
export function launchdPlist(s: ServiceSpec): string {
  const str = (v: string) => `<string>${xml(v)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${str(LABEL)}
  <key>ProgramArguments</key>
  <array>
${serviceArgs(s)
  .map((a) => `    ${str(a)}`)
  .join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    ${str(s.path)}
    <key>ALCA_DATA_DIR</key>
    ${str(s.dataDir)}
    <key>ALCA_SUPERVISED</key>
    ${str("launchd")}
  </dict>
  <key>WorkingDirectory</key>
  ${str(s.dataDir)}
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ExitTimeOut</key>
  <integer>15</integer>
  <key>ProcessType</key>
  ${str("Interactive")}
  <key>LimitLoadToSessionType</key>
  ${str("Aqua")}
  <key>StandardOutPath</key>
  ${str(logFile(s))}
  <key>StandardErrorPath</key>
  ${str(logFile(s))}
</dict>
</plist>
`;
}

/** systemd quoting for ExecStart / Environment: double quotes, backslash escapes, % doubled. */
const sq = (v: string) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;

export function systemdUnit(s: ServiceSpec): string {
  return `[Unit]
Description=Alca core (local-first agent; loopback only)
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=120
StartLimitBurst=5

[Service]
Type=simple
ExecStart=${serviceArgs(s).map(sq).join(" ")}
WorkingDirectory=${s.dataDir.replace(/%/g, "%%")}
Environment=${sq(`PATH=${s.path}`)} ${sq(`ALCA_DATA_DIR=${s.dataDir}`)} ${sq("ALCA_SUPERVISED=systemd")}
Restart=always
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=15
StandardOutput=append:${logFile(s)}
StandardError=append:${logFile(s)}
NoNewPrivileges=true

[Install]
WantedBy=default.target
`;
}

/** Task Scheduler (schtasks /XML): at logon, restart on failure, no time limit; output to core.log. */
export function windowsTask(s: ServiceSpec): string {
  const args = programArgs(s).slice(1);
  const quote = (a: string) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
  const cmd = `/d /c ""${s.node}" ${args.map(quote).join(" ")} >> "${logFile(s)}" 2>&1"`;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Alca core (local-first agent; loopback only)</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xml(userInfo().username)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>10</Count>
    </RestartOnFailure>
    <Hidden>true</Hidden>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>cmd.exe</Command>
      <Arguments>${xml(cmd)}</Arguments>
      <WorkingDirectory>${xml(s.dataDir)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

export function unitText(s: ServiceSpec): string {
  return s.platform === "darwin" ? launchdPlist(s) : s.platform === "linux" ? systemdUnit(s) : windowsTask(s);
}

export type Runner = (cmd: string, args: string[]) => { code: number; out: string };

export const realRunner: Runner = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return { code: r.status ?? (r.error ? 127 : 1), out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
};

const uid = () => (typeof process.getuid === "function" ? process.getuid() : 0);

export interface ServiceStatus {
  platform: Platform;
  installed: boolean;
  running: boolean;
  pid: number | null;
  unitPath: string;
  logFile: string;
  detail: string;
  /** Set when the Node the service was installed with is gone (it falls back, or cannot start). */
  warning?: string;
}

/** How long `install` waits for the core to come up before it reports (tests: no real sleep). */
export interface StartWait {
  timeoutMs: number;
  stepMs: number;
  sleep: (ms: number) => void;
}

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export const defaultStartWait: StartWait = { timeoutMs: 6000, stepMs: 250, sleep: sleepSync };

/**
 * The status once it is running, or after `timeoutMs` (mac test 2026-11-04: install read the
 * status while launchd was still spawning the core and reported 「已安裝，未執行」).
 */
function statusWhenUp(s: ServiceSpec, run: Runner, wait: StartWait): ServiceStatus {
  let st = status(s, run);
  for (let waited = 0; !st.running && st.installed && waited < wait.timeoutMs; waited += wait.stepMs) {
    wait.sleep(wait.stepMs);
    st = status(s, run);
  }
  return st;
}

/**
 * Write the unit and start it now (and at every login from now on). launchd / systemd bring it
 * back whenever it exits (KeepAlive true, Restart=always: a plain `kill <pid>` restarts it too, as
 * DEVICE-TEST F3 says); `uninstall` is how it stops for good.
 */
export function install(
  s: ServiceSpec,
  run: Runner = realRunner,
  wait: StartWait = defaultStartWait,
): ServiceStatus {
  mkdirSync(logDir(s), { recursive: true, mode: 0o700 });
  // M5: the log exists, owner-only, before launchd / systemd opens it with their own umask.
  chmodSync(logDir(s), 0o700);
  if (!existsSync(logFile(s))) writeFileSync(logFile(s), "", { mode: 0o600 });
  chmodSync(logFile(s), 0o600);
  const file = unitPath(s);
  mkdirSync(dirname(file), { recursive: true });
  if (s.platform === "win32") {
    // schtasks wants UTF-16 for an XML that says so.
    writeFileSync(file, `\ufeff${unitText(s)}`, { encoding: "utf16le" });
    run("schtasks", ["/Create", "/TN", WINDOWS_TASK, "/XML", file, "/F"]);
    run("schtasks", ["/Run", "/TN", WINDOWS_TASK]);
    return statusWhenUp(s, run, wait);
  }
  mkdirSync(dirname(launcherPath(s)), { recursive: true, mode: 0o700 });
  writeFileSync(launcherPath(s), launcherScript(s), { mode: 0o755 });
  chmodSync(launcherPath(s), 0o755);
  writeFileSync(file, unitText(s), { mode: 0o644 });
  if (s.platform === "darwin") {
    const domain = `gui/${uid()}`;
    removeLegacy(s, run); // the same core under an older label
    run("launchctl", ["bootout", `${domain}/${LABEL}`]); // an older copy, if any
    run("launchctl", ["bootstrap", domain, file]);
    run("launchctl", ["enable", `${domain}/${LABEL}`]);
    run("launchctl", ["kickstart", "-k", `${domain}/${LABEL}`]);
  } else {
    run("systemctl", ["--user", "daemon-reload"]);
    run("systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT]);
    run("systemctl", ["--user", "restart", SYSTEMD_UNIT]);
  }
  return statusWhenUp(s, run, wait);
}

/**
 * LaunchAgents an older Alca wrote under another label (the label was once derived from the
 * project's domain): a plist next to ours that carries the core's own environment keys.
 */
export function legacyAgents(s: ServiceSpec): Array<{ label: string; file: string }> {
  if (s.platform !== "darwin") return [];
  const dir = join(s.home, "Library", "LaunchAgents");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: Array<{ label: string; file: string }> = [];
  for (const n of names) {
    if (!n.endsWith(".core.plist") || n === `${LABEL}.plist`) continue;
    const file = join(dir, n);
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const label = /<key>Label<\/key>\s*<string>([^<]+)<\/string>/.exec(text)?.[1];
    if (!label || label !== n.slice(0, -".plist".length)) continue;
    if (!text.includes("<key>ALCA_SUPERVISED</key>") || !text.includes("<key>ALCA_DATA_DIR</key>")) continue;
    out.push({ label, file });
  }
  return out;
}

/** Stop and remove the agents of `legacyAgents` (so an upgrade does not leave two cores). */
function removeLegacy(s: ServiceSpec, run: Runner): void {
  for (const a of legacyAgents(s)) {
    run("launchctl", ["bootout", `gui/${uid()}/${a.label}`]);
    rmSync(a.file, { force: true });
  }
}

/** Stop it, and remove the unit (the data directory and its logs stay). */
export function uninstall(s: ServiceSpec, run: Runner = realRunner): ServiceStatus {
  const file = unitPath(s);
  if (s.platform === "darwin") {
    removeLegacy(s, run);
    run("launchctl", ["bootout", `gui/${uid()}/${LABEL}`]);
  } else if (s.platform === "linux") {
    run("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT]);
  } else {
    run("schtasks", ["/End", "/TN", WINDOWS_TASK]);
    run("schtasks", ["/Delete", "/TN", WINDOWS_TASK, "/F"]);
  }
  rmSync(file, { force: true });
  rmSync(launcherPath(s), { force: true });
  if (s.platform === "linux") run("systemctl", ["--user", "daemon-reload"]);
  return status(s, run);
}

export function status(s: ServiceSpec, run: Runner = realRunner): ServiceStatus {
  const st = unitStatus(s, run);
  const gone = st.installed ? missingNode(s) : undefined;
  if (!gone) return st;
  const warning = existsSync(launcherPath(s))
    ? `安裝時的 Node（${gone}）已經不在了；服務會改用 PATH 上或常見位置的 Node 22.18 以上（找不到就起不來，原因寫在紀錄檔）。想固定新的路徑：alca service install。`
    : `服務指向的 Node（${gone}）已經不在了，服務起不來。執行 alca service install 重新安裝（會改用自動找 Node 的啟動器）。`;
  return { ...st, warning };
}

function unitStatus(s: ServiceSpec, run: Runner): ServiceStatus {
  const file = unitPath(s);
  const base = { platform: s.platform, unitPath: file, logFile: logFile(s) };
  const installed = existsSync(file);
  if (s.platform === "darwin") {
    const r = run("launchctl", ["print", `gui/${uid()}/${LABEL}`]);
    const pid = Number(/\bpid = (\d+)/.exec(r.out)?.[1] ?? Number.NaN);
    // The job's own state line, whole: "running", "not running", "spawn scheduled", … (it used to
    // stop at the first word, so the status read 「未執行（not）」).
    const state = /^\s*state = (.+)$/m.exec(r.out)?.[1]?.trim() ?? (r.code === 0 ? "loaded" : "not loaded");
    return { ...base, installed, running: state === "running", pid: pid || null, detail: state };
  }
  if (s.platform === "linux") {
    const active = run("systemctl", ["--user", "is-active", SYSTEMD_UNIT]).out.split("\n")[0] ?? "";
    const pid = Number(run("systemctl", ["--user", "show", "-p", "MainPID", "--value", SYSTEMD_UNIT]).out);
    return {
      ...base,
      installed,
      running: active === "active",
      pid: pid || null,
      detail: active || "unknown",
    };
  }
  const r = run("schtasks", ["/Query", "/TN", WINDOWS_TASK, "/FO", "LIST"]);
  const st = /Status:\s*(.+)/i.exec(r.out)?.[1]?.trim() ?? (r.code === 0 ? "Ready" : "not registered");
  return {
    ...base,
    installed: installed || r.code === 0,
    running: /running/i.test(st),
    pid: null,
    detail: st,
  };
}

/** The tail of the log (for `alca service status`). */
export function logTail(s: Pick<ServiceSpec, "dataDir">, lines = 8): string[] {
  try {
    return readFileSync(logFile(s), "utf8").trimEnd().split("\n").slice(-lines);
  } catch {
    return [];
  }
}
