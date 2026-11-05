import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bwrapArgs,
  type ConfineSpec,
  configDenyWrite,
  confinedCommand,
  DATA_ENTRIES,
  dataDenyRead,
  GIT_DIFF_SAFE_ARGS,
  GIT_HARDEN_ARGS,
  hardenedGitEnv,
  hardenedGitPrefix,
  homeDenyRead,
  PROTECTED_CONFIG_MARKS,
  probeConfiner,
  realOrResolved,
  sbplString,
  seatbeltProfile,
} from "../src/index.ts";

const dirs: string[] = [];
const fresh = () => {
  const d = realOrResolved(mkdtempSync(join(tmpdir(), "alca-confine-")));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const spec = (o: Partial<ConfineSpec> = {}): ConfineSpec => ({
  kind: "seatbelt",
  workDir: "/Users/me/.alca/bots/b1/work",
  tmpDir: "/Users/me/.alca/tmp/b1/1",
  extraWritable: ["/Users/me/.npm"],
  denyRead: ["/Users/me/.alca/secrets.json", "/Users/me/.ssh"],
  denyWriteInside: ["/Users/me/.alca/bots/b1/work/.git/config"],
  network: "open",
  corePort: 4317,
  ...o,
});

describe("seatbelt profile", () => {
  it("allows by default, denies writes outside the writable set, denies secret reads", () => {
    const p = seatbeltProfile(spec());
    expect(p).toMatchInlineSnapshot(`
      "(version 1)
      (allow default)
      (deny file-write* (subpath "/"))
      (allow file-write* (subpath "/Users/me/.alca/bots/b1/work") (subpath "/Users/me/.alca/tmp/b1/1") (subpath "/Users/me/.npm")
        (literal "/dev/null") (literal "/dev/zero") (literal "/dev/stdout") (literal "/dev/stderr")
        (literal "/dev/dtracehelper") (regex #"^/dev/tty") (regex #"^/dev/fd/"))
      (deny file-write* (subpath "/Users/me/.alca/bots/b1/work/.git/config"))
      (deny file-read* (subpath "/Users/me/.alca/secrets.json") (subpath "/Users/me/.ssh"))
      (deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd"))
      (deny network-outbound (remote ip "localhost:4317"))
      "
    `);
  });

  it("the deny rules come after the allow (a later SBPL rule wins)", () => {
    const p = seatbeltProfile(spec());
    expect(p.indexOf("(allow file-write*")).toBeLessThan(p.indexOf('(deny file-write* (subpath "/Users'));
  });

  it("network none denies IP traffic (unix sockets stay)", () => {
    const p = seatbeltProfile(spec({ network: "none" }));
    expect(p).toContain('(deny network-outbound (remote ip "*:*"))');
    expect(p).not.toContain("unix");
  });

  it("escapes spaces, quotes, backslashes and CJK in paths", () => {
    expect(sbplString('/Users/me/我的 專案/a"b\\c')).toBe('"/Users/me/我的 專案/a\\"b\\\\c"');
    const p = seatbeltProfile(spec({ workDir: '/Users/me/我的 "專案"' }));
    expect(p).toContain('(subpath "/Users/me/我的 \\"專案\\"")');
    expect(() => sbplString("a\0b")).toThrow();
  });

  it("confinedCommand runs sandbox-exec with the profile and sets TMPDIR", () => {
    const c = confinedCommand(spec(), "/bin/bash", ["-o", "pipefail", "-c", "echo hi"]);
    expect(c.file).toBe("/usr/bin/sandbox-exec");
    expect(c.args[0]).toBe("-p");
    expect(c.args.slice(2)).toEqual(["/bin/bash", "-o", "pipefail", "-c", "echo hi"]);
    expect(c.env.TMPDIR).toBe("/Users/me/.alca/tmp/b1/1");
  });
});

describe("bubblewrap arguments", () => {
  it("binds the work folder writable over a read-only root, covers denied paths, dies with the parent", () => {
    const root = fresh();
    const work = join(root, "work 工作");
    const tmp = join(root, "tmp");
    const secretDir = join(root, "ssh");
    const secretFile = join(root, "secrets.json");
    mkdirSync(join(work, ".git"), { recursive: true });
    writeFileSync(join(work, ".git", "config"), "");
    mkdirSync(tmp);
    mkdirSync(secretDir);
    writeFileSync(secretFile, "{}");
    const a = bwrapArgs({
      kind: "bwrap",
      workDir: work,
      tmpDir: tmp,
      extraWritable: [join(root, "missing-cache")],
      denyRead: [secretDir, secretFile, join(root, "not-there")],
      denyWriteInside: [join(work, ".git", "config"), join(work, ".mcp.json")],
      network: "none",
    });
    expect(a).toEqual([
      "--ro-bind",
      "/",
      "/",
      "--dev",
      "/dev",
      "--proc",
      "/proc",
      "--bind",
      work,
      work,
      "--bind",
      tmp,
      tmp,
      "--ro-bind",
      join(work, ".git", "config"),
      join(work, ".git", "config"),
      "--tmpfs",
      secretDir,
      "--ro-bind",
      "/dev/null",
      secretFile,
      "--unshare-net",
      "--die-with-parent",
    ]);
    expect(a).not.toContain("--new-session");
  });

  it("never covers a denied folder that holds the work folder", () => {
    const root = fresh();
    const work = join(root, "data", "bots", "b1", "work");
    mkdirSync(work, { recursive: true });
    const a = bwrapArgs({
      kind: "bwrap",
      workDir: work,
      tmpDir: work,
      extraWritable: [],
      denyRead: [join(root, "data")],
      denyWriteInside: [],
      network: "open",
    });
    expect(a).not.toContain("--tmpfs");
    expect(a).not.toContain("--unshare-net");
  });

  it("confinedCommand puts the command after --", () => {
    const root = fresh();
    const c = confinedCommand(
      {
        kind: "bwrap",
        workDir: root,
        tmpDir: root,
        extraWritable: [],
        denyRead: [],
        denyWriteInside: [],
        network: "open",
      },
      "/bin/sh",
      ["-c", "true"],
    );
    expect(c.file).toBe("bwrap");
    expect(c.args.slice(-4)).toEqual(["--", "/bin/sh", "-c", "true"]);
  });
});

describe("path lists", () => {
  it("data folder: every entry beside the way to the kept folders, plus the literal DATA_ENTRIES", () => {
    const data = fresh();
    for (const d of ["bots/b1/work", "bots/b1/notes", "bots/b2/work", "logs", "tmp/b1/7", "tmp/b2"])
      mkdirSync(join(data, d), { recursive: true });
    writeFileSync(join(data, "secrets.json"), "{}");
    writeFileSync(join(data, "state.sqlite"), "");
    const deny = dataDenyRead(data, [join(data, "bots/b1/work"), join(data, "tmp/b1/7")]);
    const rel = deny.map((p) => p.slice(data.length + 1));
    expect(rel).toEqual(
      expect.arrayContaining([
        "bots/b1/notes",
        "bots/b2",
        "logs",
        "secrets.json",
        "state.sqlite",
        "tmp/b2",
        "vault.key",
        "secrets.json.bak",
        "backups",
      ]),
    );
    expect(rel).not.toContain("bots/b1/work");
    expect(rel).not.toContain("bots");
    expect(rel).not.toContain("tmp/b1/7");
    expect(rel).not.toContain("tmp");
  });

  it("a work folder outside the data folder: the whole data folder is denied", () => {
    const data = fresh();
    const work = fresh();
    expect(dataDenyRead(data, [work])).toContain(data);
  });

  it("DATA_ENTRIES and the config marks are the shared lists", () => {
    expect(DATA_ENTRIES).toContain("secrets.json");
    expect(DATA_ENTRIES).toContain("vault.key");
    expect(PROTECTED_CONFIG_MARKS).toEqual(
      expect.arrayContaining([".git/config", ".git/hooks", ".claude", ".mcp.json", ".envrc"]),
    );
    expect(configDenyWrite("/w")).toContain("/w/.git/hooks");
    expect(homeDenyRead("/h")).toEqual(
      expect.arrayContaining(["/h/.ssh", "/h/.aws", "/h/.gnupg", "/h/.netrc"]),
    );
  });
});

describe("git hardening", () => {
  it("turns off fsmonitor, hooks, ssh command, external diff and the pager", () => {
    const a = GIT_HARDEN_ARGS.join(" ");
    for (const s of [
      "core.fsmonitor=false",
      "core.hooksPath=/dev/null",
      "core.sshCommand=",
      "core.pager=cat",
    ])
      expect(a).toContain(`-c ${s}`);
    expect(a).not.toContain("diff.external");
    expect(GIT_DIFF_SAFE_ARGS).toEqual(["--no-ext-diff", "--no-textconv"]);
    const env = hardenedGitEnv({
      PATH: "/bin",
      GIT_EXTERNAL_DIFF: "/x",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.fsmonitor",
      GIT_SSH_COMMAND: "evil",
    });
    expect(env).toEqual({
      PATH: "/bin",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_PAGER: "cat",
    });
    expect(hardenedGitPrefix().startsWith("GIT_CONFIG_NOSYSTEM=1 git -c core.fsmonitor=false")).toBe(true);
  });
});

describe("probe", () => {
  it("windows has no confiner", async () => {
    expect(await probeConfiner({ platform: "win32" })).toMatchObject({ kind: "none", ok: false });
  });

  it("linux without bwrap on PATH is unavailable with a reason", async () => {
    const p = await probeConfiner({ platform: "linux", path: "/nonexistent" });
    expect(p).toMatchObject({ kind: "bwrap", ok: false });
    expect(p.reason).toContain("bubblewrap");
  });

  it("linux: a bwrap that cannot start under the AppArmor switch says so", async () => {
    const bin = fresh();
    writeFileSync(join(bin, "bwrap"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const aa = join(bin, "aa");
    writeFileSync(aa, "1\n");
    const p = await probeConfiner({
      platform: "linux",
      path: bin,
      apparmorFile: aa,
      run: async (_f, args) =>
        args[0] === "--version"
          ? { code: 0, out: "bubblewrap 0.9.0" }
          : { code: 1, out: "setting up uid map: Permission denied" },
    });
    expect(p).toMatchObject({ kind: "bwrap", ok: false, version: "0.9.0" });
    expect(p.reason).toContain("apparmor userns");
  });

  it("a sandbox that lets the outside write through is not ok", async () => {
    const bin = fresh();
    writeFileSync(join(bin, "bwrap"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const p = await probeConfiner({
      platform: "linux",
      path: bin,
      run: async (_f, args) =>
        args.includes("-c") ? { code: 0, out: "LEAK\n" } : { code: 0, out: "bubblewrap 0.12.0" },
    });
    expect(p.ok).toBe(false);
    expect(p.reason).toContain("沒有擋住");
  });

  let real = false;
  try {
    execFileSync("bwrap", ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "/bin/true"], {
      stdio: "ignore",
    });
    real = process.platform === "linux";
  } catch {
    real = false;
  }
  it.skipIf(!real)("linux with a working bwrap: the real write test passes", async () => {
    const p = await probeConfiner({ platform: "linux" });
    expect(p).toMatchObject({ kind: "bwrap", ok: true });
  });
});
