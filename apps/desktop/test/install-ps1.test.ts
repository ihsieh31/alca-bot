// scripts/install.ps1 (Phase E), run with pwsh on Linux through its test hooks:
// ALCA_INSTALL_OS=Windows takes the Windows paths, ALCA_INSTALL_FETCH replaces
// Invoke-WebRequest. Junctions become symlinks off Windows; the real Windows run is
// .github/workflows/install-windows.yml. Skipped when pwsh is not installed (GitHub's
// ubuntu runners have it).
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../../../scripts/install.ps1", import.meta.url));
const PWSH = (() => {
  for (const c of [process.env.ALCA_TEST_PWSH, "pwsh"]) {
    if (!c) continue;
    const r = spawnSync(c, ["-NoProfile", "-Command", "exit 0"], { encoding: "utf8" });
    if (r.status === 0) return c;
  }
  return undefined;
})();

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "alca-ps1-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const sha = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");

/** A tiny packed core: cli.ts imports a workspace package through a symlinked node_modules entry. */
function tarball(name = "alca-core.tar.gz", o: { manifest?: boolean; version?: string } = {}): string {
  const src = join(dir, `src-${Math.random().toString(36).slice(2)}`);
  const root = join(src, "alca");
  mkdirSync(join(root, "apps/desktop/src"), { recursive: true });
  mkdirSync(join(root, "packages/core"), { recursive: true });
  writeFileSync(
    join(root, "packages/core/package.json"),
    JSON.stringify({ name: "@alca/core", main: "index.js" }),
  );
  writeFileSync(join(root, "packages/core/index.js"), "module.exports = 'core-ok';\n");
  writeFileSync(
    join(root, "apps/desktop/package.json"),
    JSON.stringify({ name: "@alca/desktop", type: "module", dependencies: { "@alca/core": "workspace:*" } }),
  );
  writeFileSync(
    join(root, "apps/desktop/src/cli.ts"),
    "import core from '@alca/core';\nif (core !== 'core-ok') process.exit(9);\nif (process.argv.includes('service')) console.log('SERVICE ' + process.argv.slice(2).join(' '));\n",
  );
  mkdirSync(join(root, "apps/desktop/node_modules/@alca"), { recursive: true });
  symlinkSync("../../../../packages/core", join(root, "apps/desktop/node_modules/@alca/core"), "dir");
  if (o.manifest !== false)
    writeFileSync(
      join(root, "ALCA_LINKS.json"),
      JSON.stringify({
        links: [{ path: "apps/desktop/node_modules/@alca/core", target: "../../../../packages/core" }],
      }),
    );
  writeFileSync(join(root, "ALCA_VERSION"), JSON.stringify({ version: o.version ?? "9.9.9" }));
  const out = join(dir, name);
  execFileSync("tar", ["-czf", out, "-C", src, "alca"]);
  return out;
}

/** ALCA_INSTALL_FETCH: serves files from `served` by base name, logs every URL. */
function fakeFetch(served: string): string {
  mkdirSync(served, { recursive: true });
  const f = join(dir, "fetch.sh");
  writeFileSync(
    f,
    `#!/bin/sh\necho "$1" >> "${join(dir, "fetch.log")}"\nb=$(basename "$1")\n[ -f "${served}/$b" ] || exit 1\ncp "${served}/$b" "$2"\n`,
  );
  chmodSync(f, 0o755);
  return f;
}

function bin(name: string, body: string): string {
  const b = join(dir, "bin");
  mkdirSync(b, { recursive: true });
  writeFileSync(join(b, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(b, name), 0o755);
  return b;
}

function run(args: string[], env: Record<string, string> = {}, path?: string) {
  const r = spawnSync(PWSH as string, ["-NoProfile", "-NonInteractive", "-File", SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      HOME: dir,
      USERPROFILE: dir,
      TMPDIR: dir,
      ALCA_INSTALL_OS: "Windows",
      PATH: [path, dirname(process.execPath), "/usr/bin", "/bin"].filter(Boolean).join(":"),
      ...env,
    },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

// Each case starts pwsh (about a second) and unpacks a tarball.
describe.skipIf(!PWSH)("install.ps1", { timeout: 30_000 }, () => {
  it("installs a tarball checked against the .sha256 next to it; the symlink becomes a link the core resolves", () => {
    const t = tarball();
    writeFileSync(`${t}.sha256`, `${sha(t)}  alca-core.tar.gz\n`);
    const prefix = join(dir, "A");
    const r = run(["--tarball", t, "--prefix", prefix, "--no-service"]);
    expect(r.out).toContain("檢查碼正確");
    expect(r.out).toContain("已安裝 Alca 9.9.9");
    expect(r.code).toBe(0);
    const link = join(prefix, "app/apps/desktop/node_modules/@alca/core");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(link, "index.js"), "utf8")).toContain("core-ok");
    const cmd = readFileSync(join(prefix, "bin/alca.cmd"), "utf8");
    expect(cmd).toContain("@echo off");
    expect(cmd).toContain(`set "ALCA_DATA_DIR=${prefix}"`);
    expect(cmd).toContain(process.execPath);
    expect(existsSync(join(prefix, "app.prev"))).toBe(false);
    expect(r.out).toContain("略過背景服務");
  });

  it("refuses a checksum that does not match, and removes the prefix it made", () => {
    const t = tarball();
    writeFileSync(`${t}.sha256`, `${"0".repeat(64)}  alca-core.tar.gz\n`);
    const prefix = join(dir, "B");
    const r = run(["--tarball", t, "--prefix", prefix, "--no-service"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("檢查碼不符");
    expect(existsSync(prefix)).toBe(false);
  });

  it("refuses a tarball with no checksum unless --insecure", () => {
    const t = tarball();
    const r = run(["--tarball", t, "--prefix", join(dir, "C"), "--no-service"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("找不到");
    expect(r.out).toContain("--insecure");
    const ok = run(["--tarball", t, "--prefix", join(dir, "C"), "--no-service", "--insecure"]);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain("沒有檢查碼");
  });

  it("without --version and no release: says a draft is not latest and to add --version", () => {
    const fetch = fakeFetch(join(dir, "empty"));
    const r = run(["--prefix", join(dir, "D"), "--no-service"], { ALCA_INSTALL_FETCH: fetch });
    expect(r.code).toBe(1);
    expect(r.out).toContain("releases/latest/download/alca-core.tar.gz");
    expect(r.out).toContain("草稿");
    expect(r.out).toContain("--version <tag>");
  });

  it("--version downloads that tag's files and checks them (also as -Version)", () => {
    const served = join(dir, "served");
    mkdirSync(served);
    const t = tarball("x.tar.gz");
    execFileSync("cp", [t, join(served, "alca-core.tar.gz")]);
    writeFileSync(join(served, "alca-core.tar.gz.sha256"), `${sha(t)}  alca-core.tar.gz\n`);
    const fetch = fakeFetch(served);
    for (const flag of ["--version", "-Version"]) {
      const r = run([flag, "v1.2.3", "--prefix", join(dir, `E${flag}`), "--no-service"], {
        ALCA_INSTALL_FETCH: fetch,
      });
      expect(r.code).toBe(0);
    }
    const log = readFileSync(join(dir, "fetch.log"), "utf8");
    expect(log).toContain("https://github.com/ihsieh31/alca-bot/releases/download/v1.2.3/alca-core.tar.gz");
    expect(log).toContain("v1.2.3/alca-core.tar.gz.sha256");
    expect(log).not.toContain("latest");
  });

  it("a private repository: falls back to the signed-in GitHub CLI with the tag", () => {
    const t = tarball("y.tar.gz");
    const store = join(dir, "gh-files");
    mkdirSync(store);
    execFileSync("cp", [t, join(store, "alca-core.tar.gz")]);
    writeFileSync(join(store, "alca-core.tar.gz.sha256"), `${sha(t)}  alca-core.tar.gz\n`);
    const b = bin(
      "gh",
      `echo "$@" >> "${join(dir, "gh.log")}"\n[ "$1" = auth ] && exit 0\nwhile [ $# -gt 0 ]; do [ "$1" = --dir ] && d="$2"; shift; done\ncp "${store}"/* "$d"/`,
    );
    const r = run(
      ["--version", "v0.2.0", "--prefix", join(dir, "F"), "--no-service"],
      {
        ALCA_INSTALL_FETCH: fakeFetch(join(dir, "none")),
      },
      b,
    );
    expect(r.out).toContain("用 GitHub CLI 下載");
    expect(r.code).toBe(0);
    expect(readFileSync(join(dir, "gh.log"), "utf8")).toContain(
      "release download v0.2.0 --repo ihsieh31/alca-bot",
    );
  });

  it("stops on a Node older than 22.18", () => {
    const b = bin("node", "echo 22.17.0");
    const r = run(["--tarball", tarball(), "--prefix", join(dir, "G"), "--no-service", "--insecure"], {}, b);
    expect(r.code).toBe(1);
    expect(r.out).toContain("太舊");
    expect(r.out).toContain("winget");
  });

  it("an older tarball without ALCA_LINKS.json: the workspace links come from package.json", () => {
    const t = tarball("old.tar.gz", { manifest: false });
    const prefix = join(dir, "H");
    const r = run(["--tarball", t, "--prefix", prefix, "--no-service", "--insecure"]);
    expect(r.code).toBe(0);
    expect(readFileSync(join(prefix, "app/apps/desktop/node_modules/@alca/core/index.js"), "utf8")).toContain(
      "core-ok",
    );
  });

  it("replaces an earlier install and runs `service install` with the engine and the core flags", () => {
    const prefix = join(dir, "I");
    const first = tarball("a.tar.gz", { version: "1.0.0" });
    expect(run(["--tarball", first, "--prefix", prefix, "--no-service", "--insecure"]).code).toBe(0);
    const second = tarball("b.tar.gz", { version: "1.1.0" });
    const r = run([
      "--tarball",
      second,
      "--prefix",
      prefix,
      "--insecure",
      "--engine",
      "demo",
      "--",
      "--browser",
      "off",
    ]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("已安裝 Alca 1.1.0");
    expect(r.out).toContain(`SERVICE service install --engine demo --data-dir ${prefix} -- --browser off`);
    expect(existsSync(join(prefix, "app.prev"))).toBe(false);
  });

  it("is the Windows installer only", () => {
    const r = run(["--tarball", tarball(), "--no-service", "--insecure"], { ALCA_INSTALL_OS: "Linux" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("install.sh");
  });
});
