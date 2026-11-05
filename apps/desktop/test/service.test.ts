import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BASE_PATH,
  defaultSpec,
  install,
  LABEL,
  launchdPlist,
  launcherPath,
  launcherScript,
  legacyAgents,
  missingNode,
  type Runner,
  serviceArgs,
  serviceLabel,
  servicePath,
  status,
  systemdUnit,
  uninstall,
  unitPath,
  windowsTask,
} from "../src/service.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "alca-svc-"));
  dirs.push(d);
  return d;
};

function spec(platform: "darwin" | "linux" | "win32", home = tmp()) {
  return defaultSpec({
    platform,
    home,
    dataDir: join(home, ".alca data"),
    node: "/opt/node/bin/node",
    main: "/opt/alca/app/apps/desktop/src/main.ts",
    engine: "claude-code",
    extraArgs: ["--rendezvous", "https://relay.example/?a=1&b=100%"],
    path: "/opt/node/bin:/usr/bin:/bin",
  });
}

const fakeRunner = () => {
  const calls: string[] = [];
  const run: Runner = (cmd, args) => {
    calls.push([cmd, ...args].join(" "));
    if (cmd === "launchctl" && args[0] === "print") return { code: 0, out: "state = running\n\tpid = 4242" };
    if (cmd === "systemctl" && args.includes("is-active")) return { code: 0, out: "active" };
    if (cmd === "systemctl" && args.includes("MainPID")) return { code: 0, out: "777" };
    return { code: 0, out: "" };
  };
  return { calls, run };
};

describe("alca service: generated units", () => {
  it("launchd plist: start at login, always brought back (a plain kill too), logs in the data dir, escaped", () => {
    const s = spec("darwin");
    const p = launchdPlist(s);
    expect(p).toContain(`<string>${LABEL}</string>`);
    expect(p).toContain("<key>RunAtLoad</key>\n  <true/>");
    // mac test 2026-11-04: with SuccessfulExit=false a SIGTERM (exit 0) was not restarted (DEVICE-TEST F3).
    expect(p).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(p).not.toContain("SuccessfulExit");
    expect(p).toContain(`<string>${s.dataDir}/logs/core.log</string>`);
    expect(p).toContain("<string>https://relay.example/?a=1&amp;b=100%</string>");
    expect(launcherScript(s)).toContain("--disable-warning=ExperimentalWarning");
    expect(p).toContain("<string>Aqua</string>"); // a GUI session, so the browser window can open
    // Well-formed XML, every argument in order.
    const args = [...p.matchAll(/<array>([\s\S]*?)<\/array>/g)][0]?.[1] ?? "";
    expect([...args.matchAll(/<string>(.*?)<\/string>/g)].map((m) => m[1]?.replace(/&amp;/g, "&"))).toEqual(
      serviceArgs(s),
    );
    // mac test 2026-11-04: the plist pinned an nvm Node; it runs the launcher, which picks one that exists.
    expect(serviceArgs(s).slice(0, 2)).toEqual(["/bin/sh", launcherPath(s)]);
    expect(p).not.toContain("<string>/opt/node/bin/node</string>");
    if (spawnSync("xmllint", ["--version"]).status === 0) {
      const r = spawnSync("xmllint", ["--noout", "-"], { input: p });
      expect(r.status, String(r.stderr)).toBe(0);
    }
    expect(unitPath(s)).toBe(join(s.home, "Library/LaunchAgents/local.alca.core.plist"));
  });

  it("systemd --user unit: always restarts, SIGTERM with a stop timeout, quoting, append logs", () => {
    const s = spec("linux");
    const u = systemdUnit(s);
    expect(u).toContain("Restart=always"); // a plain kill (exit 0) comes back too; systemctl stop does not
    expect(u).not.toContain("Restart=on-failure");
    expect(u).toContain("KillSignal=SIGTERM");
    expect(u).toContain("WantedBy=default.target");
    expect(u).toContain(`StandardOutput=append:${s.dataDir}/logs/core.log`);
    expect(u).toContain('"https://relay.example/?a=1&b=100%%"'); // % is a specifier in systemd
    expect(u).toContain(`WorkingDirectory=${s.dataDir}\n`); // a path with a space, unquoted (systemd wants it bare)
    expect(unitPath(s)).toBe(join(s.home, ".config/systemd/user/alca-core.service"));
  });

  it("systemd-analyze accepts the unit (when available)", () => {
    if (spawnSync("systemd-analyze", ["--version"]).status !== 0) return;
    const home = tmp();
    const s = { ...spec("linux", home), node: process.execPath, main: join(home, "main.ts") };
    install(s, fakeRunner().run);
    // System-mode verify checks the same syntax and needs no user manager (CI containers have none).
    const r = spawnSync("systemd-analyze", ["verify", unitPath(s)], { encoding: "utf8" });
    const own = `${r.stdout}${r.stderr}`
      .split("\n")
      .filter(
        (l) => /alca-core\.service/.test(l) && /unknown|invalid|bad|fatal|not absolute|failed/i.test(l),
      );
    expect(own).toEqual([]);
  });

  it("Windows task: at logon, restart on failure, no time limit, output to core.log", () => {
    const t = windowsTask(spec("win32"));
    expect(t).toContain("<LogonTrigger>");
    expect(t).toContain("<RestartOnFailure>");
    expect(t).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
    expect(t).toContain("core.log&quot; 2&gt;&amp;1");
    expect(t).toContain("<Command>cmd.exe</Command>");
  });
});

describe("alca service: install / status / uninstall", () => {
  it("macOS: bootstraps the LaunchAgent into the GUI domain and reads its pid", () => {
    const s = spec("darwin");
    const { calls, run } = fakeRunner();
    const st = install(s, run);
    expect(existsSync(unitPath(s))).toBe(true);
    expect(existsSync(join(s.dataDir, "logs"))).toBe(true);
    expect(calls.some((c) => /^launchctl bootstrap gui\/\d+ .*local\.alca\.core\.plist$/.test(c))).toBe(true);
    expect(calls.some((c) => c.startsWith("launchctl kickstart -k gui/"))).toBe(true);
    expect(st).toMatchObject({ installed: true, running: true, pid: 4242 });
    const after = uninstall(s, run);
    expect(calls.at(-2)).toMatch(/^launchctl bootout gui\/\d+\/local\.alca\.core$/);
    expect(after.installed).toBe(false);
  });

  it("macOS: install waits for launchd to finish starting the core before it reports (mac test)", () => {
    const s = spec("darwin");
    const states = ["spawn scheduled", "xpcproxy", "running"];
    let prints = 0;
    const run: Runner = (cmd, args) => {
      if (cmd === "launchctl" && args[0] === "print") {
        const st = states[Math.min(prints++, states.length - 1)];
        return {
          code: 0,
          out: `gui/501/${LABEL} = {\n\tactive count = 1\n\tstate = ${st}\n${st === "running" ? "\tpid = 99\n" : ""}}`,
        };
      }
      return { code: 0, out: "" };
    };
    const slept: number[] = [];
    const st = install(s, run, { timeoutMs: 5000, stepMs: 250, sleep: (ms) => slept.push(ms) });
    expect(st).toMatchObject({ installed: true, running: true, pid: 99, detail: "running" });
    expect(slept).toEqual([250, 250]);
    // Never up: it gives up after the timeout and says what launchd says, whole.
    const down: Runner = (cmd, args) =>
      cmd === "launchctl" && args[0] === "print"
        ? { code: 0, out: "\tstate = not running\n" }
        : { code: 0, out: "" };
    const slept2: number[] = [];
    const st2 = install(s, down, { timeoutMs: 1000, stepMs: 250, sleep: (ms) => slept2.push(ms) });
    expect(st2).toMatchObject({ installed: true, running: false, detail: "not running" });
    expect(slept2).toHaveLength(4);
  });

  it("macOS status reads launchd's whole state line (it showed 「未執行（not）」)", () => {
    const s = spec("darwin");
    const run: Runner = (cmd, args) =>
      cmd === "launchctl" && args[0] === "print"
        ? { code: 0, out: `gui/501/${LABEL} = {\n\tstate = not running\n\tlast exit code = 0\n}` }
        : { code: 0, out: "" };
    expect(status(s, run)).toMatchObject({ running: false, pid: null, detail: "not running" });
  });

  it("Linux: enables the user unit now and at login; uninstall leaves the data dir", () => {
    const s = spec("linux");
    const { calls, run } = fakeRunner();
    const st = install(s, run);
    expect(readFileSync(unitPath(s), "utf8")).toContain("ExecStart=");
    expect(calls).toContain("systemctl --user daemon-reload");
    expect(calls).toContain("systemctl --user enable --now alca-core.service");
    expect(st).toMatchObject({ installed: true, running: true, pid: 777 });
    expect(status(s, run).logFile).toBe(join(s.dataDir, "logs", "core.log"));
    uninstall(s, run);
    expect(calls).toContain("systemctl --user disable --now alca-core.service");
    expect(existsSync(unitPath(s))).toBe(false);
    expect(existsSync(s.dataDir)).toBe(true);
  });
});

describe("the LaunchAgent label is neutral and configurable (review H3)", () => {
  it("defaults to local.alca.core; $ALCA_SERVICE_LABEL names another reverse-DNS id", () => {
    expect(serviceLabel({})).toBe("local.alca.core");
    expect(serviceLabel({ ALCA_SERVICE_LABEL: "org.example.alca.core" })).toBe("org.example.alca.core");
    expect(serviceLabel({ ALCA_SERVICE_LABEL: "no spaces/../x" })).toBe("local.alca.core");
  });

  it("install and uninstall stop and remove an agent an older Alca wrote under another label", () => {
    const s = spec("darwin");
    const dir = join(s.home, "Library", "LaunchAgents");
    mkdirSync(dir, { recursive: true });
    const old = launchdPlist(s).replace(`<string>${LABEL}</string>`, "<string>org.example.old.core</string>");
    writeFileSync(join(dir, "org.example.old.core.plist"), old);
    // Someone else's agent with a similar name is left alone.
    writeFileSync(
      join(dir, "com.other.core.plist"),
      "<plist><key>Label</key><string>com.other.core</string></plist>",
    );
    expect(legacyAgents(s).map((a) => a.label)).toEqual(["org.example.old.core"]);
    const { calls, run } = fakeRunner();
    install(s, run);
    expect(calls).toContain(`launchctl bootout gui/${process.getuid?.() ?? 0}/org.example.old.core`);
    expect(existsSync(join(dir, "org.example.old.core.plist"))).toBe(false);
    expect(existsSync(join(dir, "com.other.core.plist"))).toBe(true);
    expect(legacyAgents(s)).toEqual([]);
  });
});

describe("alca service: the launcher picks a Node that still exists (mac test: nvm path pinned)", () => {
  // A stand-in node: answers `-p process.versions.node` with its version, otherwise prints what it ran.
  const fakeNode = (dir: string, version: string) => {
    mkdirSync(dir, { recursive: true });
    const p = join(dir, "node");
    writeFileSync(p, `#!/bin/sh\nif [ "$1" = "-p" ]; then echo ${version}; exit 0; fi\necho "ran $0 $*"\n`);
    chmodSync(p, 0o755);
    return p;
  };
  const runLauncher = (script: string, path: string) => {
    const home = tmp();
    const file = join(home, "run-core.sh");
    writeFileSync(file, script);
    return spawnSync("/bin/sh", [file, "--engine", "demo"], {
      encoding: "utf8",
      env: { PATH: path, ALCA_NO_NODE_WAIT: "0" },
    });
  };
  const withMain = (s: ReturnType<typeof spec>) => {
    const main = join(s.home, "app", "main.ts");
    mkdirSync(join(s.home, "app"), { recursive: true });
    writeFileSync(main, "");
    return { ...s, main };
  };

  it("runs the recorded Node while it is there", () => {
    const home = tmp();
    const s = withMain({ ...spec("darwin", home), node: fakeNode(join(home, "v22.20.0"), "22.20.0") });
    const r = runLauncher(launcherScript(s, []), join(home, "empty"));
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(
      `ran ${s.node} --disable-warning=ExperimentalWarning ${s.main} --engine demo`,
    );
    expect(r.stderr).toBe("");
  });

  it("falls back to a Node on the PATH or in the usual places, skips one that is too old, and says so", () => {
    const home = tmp();
    const s = withMain({ ...spec("linux", home), node: join(home, ".nvm/versions/node/v22.18.0/bin/node") });
    const old = join(home, "old");
    fakeNode(old, "20.11.1");
    const fresh = fakeNode(join(home, ".nvm/versions/node/v24.1.0/bin"), "24.1.0");
    const r = runLauncher(launcherScript(s, [`${home}/.nvm/versions/node/*/bin/node`]), old);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`ran ${fresh} --disable-warning=ExperimentalWarning ${s.main}`);
    expect(r.stderr).toContain(`安裝時的 Node（${s.node}）不能用了，改用 ${fresh}`);
  });

  it("no usable Node: a line in the log and exit 78 (no busy restart loop)", () => {
    const home = tmp();
    const s = withMain({ ...spec("darwin", home), node: join(home, "gone/node") });
    const r = runLauncher(launcherScript(s, []), join(home, "empty"));
    expect(r.status).toBe(78);
    expect(r.stderr).toContain("找不到 Node 22.18 以上");
    expect(r.stdout).toBe("");
  });

  it("status warns when the Node the service was installed with is gone, old plists included", () => {
    const s = spec("darwin");
    const { run } = fakeRunner();
    install(s, run);
    expect(missingNode(s, () => true)).toBeUndefined();
    expect(missingNode(s, () => false)).toBe("/opt/node/bin/node");
    expect(status(s, run).warning).toContain("服務會改用 PATH 上");
    // A plist written before the launcher existed, pointing at a removed nvm Node.
    rmSync(launcherPath(s));
    writeFileSync(
      unitPath(s),
      "<key>ProgramArguments</key>\n  <array>\n    <string>/Users/x/.nvm/versions/node/v22.18.0/bin/node</string>",
    );
    expect(status(s, run).warning).toContain("服務起不來。執行 alca service install");
  });
});

describe("alca service: the PATH in the unit (mac test 2026-11-04b E6)", () => {
  const live = new Set([
    "/Users/me/.nvm/versions/node/v24.22.1/bin",
    "/opt/homebrew/bin",
    "/Users/me/.local/bin",
    "/usr/bin",
  ]);
  const exists = (p: string) => live.has(p);
  it("drops pnpm's temporary folders, a literal ~, folders that are gone and repeats; adds the base", () => {
    const raw = [
      "/Users/me/Library/pnpm/12.14.0/abc123/bin/../node_modules/pnpm/dist/node-gyp-bin",
      "/Users/me/src/alca/node_modules/.bin",
      "/Users/me/.nvm/versions/node/v24.22.1/bin",
      "~/.dotnet/tools",
      "/Users/me/.nvm/versions/node/v24.18.0/bin",
      "/private/var/folders/xy/T/pnpm-run/bin",
      "/Users/me/.local/bin/",
      "/opt/homebrew/bin",
      "/usr/bin",
      "",
    ].join(":");
    expect(servicePath(raw, { exists, tmp: "/var/tmp/x" }).split(":")).toEqual([
      "/Users/me/.nvm/versions/node/v24.22.1/bin",
      "/Users/me/.local/bin",
      "/opt/homebrew/bin",
      "/usr/bin",
      ...BASE_PATH.filter((d) => d !== "/opt/homebrew/bin" && d !== "/usr/bin"),
    ]);
  });
  it("an empty PATH still finds the usual places", () => {
    expect(servicePath("", { exists })).toBe(BASE_PATH.join(":"));
  });
});
