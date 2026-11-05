import { execFileSync, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { packCore } from "../../../scripts/pack-core.ts";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "alca-install-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const RELEASE_KEY = generateKeyPairSync("ed25519")
  .publicKey.export({ format: "der", type: "spki" })
  .toString("base64");

const has = (bin: string) => spawnSync("sh", ["-c", `command -v ${bin}`]).status === 0;

describe("pack-core", () => {
  it("packs a tree that runs with plain node: workspace links, one hoisted zod, the built PWA, no shell", async () => {
    // P12: the release's build variables become the generated official config (desktop + phone site).
    const r = await packCore(join(tmp, "pack"), ROOT, {
      ALCA_OFFICIAL_RELAY_URL: "https://relay.example.com",
      ALCA_OFFICIAL_SITE_URL: "https://alca.example.com",
      ALCA_OFFICIAL_GOOGLE_CLIENT_ID: "test-web.apps.googleusercontent.com",
      // Phase E: the release signing public key is packed for the updater (update-verify.ts).
      ALCA_RELEASE_PUBLIC_KEY: RELEASE_KEY,
    });
    expect(JSON.parse(readFileSync(join(r.dir, "apps/desktop/release-keys.json"), "utf8"))).toEqual({
      keys: [RELEASE_KEY],
    });
    expect(JSON.parse(readFileSync(join(r.dir, "apps/desktop/official-config.json"), "utf8"))).toEqual({
      relayUrl: "https://relay.example.com",
      siteUrl: "https://alca.example.com",
      googleClientId: "test-web.apps.googleusercontent.com",
    });
    expect(JSON.parse(readFileSync(join(r.dir, "apps/phone-pwa/dist/config.json"), "utf8"))).toEqual({
      relayUrl: "https://relay.example.com",
      googleClientId: "test-web.apps.googleusercontent.com",
    });
    // Phase E: ALCA_LINKS.json lists exactly the tree's symlinks (install.ps1 / alca update on Windows).
    const links: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isSymbolicLink()) links.push(relative(r.dir, p).split(sep).join("/"));
        else if (e.isDirectory()) walk(p);
      }
    };
    walk(r.dir);
    const listed = JSON.parse(readFileSync(join(r.dir, "ALCA_LINKS.json"), "utf8")) as {
      links: Array<{ path: string; target: string }>;
    };
    expect(listed.links.map((l) => l.path).sort()).toEqual(links.sort());
    for (const l of listed.links)
      expect(readlinkSync(join(r.dir, l.path)).split(sep).join("/")).toBe(l.target);
    expect(links).toContain("apps/desktop/node_modules/@alca/core");
    expect(r.external).toEqual([
      "@jitl/quickjs-wasmfile-release-sync",
      // G1: the PAKE's curve library (exact pins, THIRD_PARTY_NOTICES.md).
      "@noble/curves",
      "@noble/hashes",
      "quickjs-emscripten-core",
      "werift",
      "zod",
    ]);
    // Plan §5: the general harness's script sandbox (QuickJS wasm) is packed with its wasm file.
    for (const dep of [
      "@jitl/quickjs-wasmfile-release-sync",
      "quickjs-emscripten-core",
      "@jitl/quickjs-ffi-types",
    ])
      expect(
        r.packages.some((p) => p.startsWith(`${dep}@`)),
        dep,
      ).toBe(true);
    // P13: werift (optional, WebRTC) comes with everything it depends on, transitively.
    for (const dep of ["werift", "buffer", "base64-js", "ieee754", "multicast-dns", "dns-packet", "thunky"])
      expect(
        r.packages.some((p) => p.startsWith(`${dep}@`)),
        dep,
      ).toBe(true);
    // Phase F1: the database worker's entry is in the tree and starts from it (a real worker thread).
    expect(existsSync(join(r.dir, "packages/store/src/db-worker-main.ts"))).toBe(true);
    const db = join(tmp, "packed-worker.sqlite");
    const worker = execFileSync(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        "-e",
        `import(${JSON.stringify(join(r.dir, "packages/store/src/index.ts"))}).then(async (m) => {
          const s = m.openStore(${JSON.stringify(db)});
          const f = await s.jobs.run("backup", new Date().toISOString(), "manual", 7);
          console.log(s.jobs.mode, typeof f);
          await s.stop();
        })`,
      ],
      { encoding: "utf8", env: { ...process.env, ALCA_DB_WORKER: "" } },
    );
    expect(worker.trim()).toBe("worker string");
    expect(existsSync(join(r.dir, "apps/desktop-shell"))).toBe(false);
    expect(existsSync(join(r.dir, ".github"))).toBe(false);
    expect(existsSync(join(r.dir, "apps/phone-pwa/dist/index.html"))).toBe(true);
    expect(existsSync(join(r.dir, "apps/phone-pwa/dist/sw.js"))).toBe(true);
    expect(lstatSync(join(r.dir, "apps/desktop/node_modules/@alca/core")).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(join(r.dir, "node_modules/zod/package.json"), "utf8")).name).toBe("zod");
    // The CLI loads its whole import graph (zod included) from the packed tree.
    const out = execFileSync(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        "-e",
        `import(${JSON.stringify(join(r.dir, "apps/desktop/src/index.ts"))}).then(() => console.log("ok"))`,
      ],
      { cwd: tmp, encoding: "utf8" },
    );
    expect(out.trim()).toBe("ok");
    // The core finds werift in the packed tree and can make a peer connection with it.
    const rtc = execFileSync(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        "--input-type=module",
        "-e",
        `const { loadNodeRtc } = await import(${JSON.stringify(join(r.dir, "packages/link/src/index.ts"))});
         const f = await loadNodeRtc((m) => { console.log("warn " + m); });
         const pc = f && f({ iceServers: [], gatherMs: 300 });
         const sdp = pc ? await pc.offer() : "";
         console.log(sdp.includes("m=application") ? "rtc" : "none");
         pc?.close();
         process.exit(0);`,
      ],
      { cwd: tmp, encoding: "utf8" },
    );
    expect(rtc.trim()).toBe("rtc");
  }, 90_000);
});

describe("scripts/install.sh", () => {
  it("is shellcheck clean", () => {
    const sc = ["shellcheck", join(process.env.HOME ?? "", ".local/bin/shellcheck")].find(
      (b) => has(b) || existsSync(b),
    );
    if (!sc) return; // CI installs it; locally it is optional
    const r = spawnSync(sc, [join(ROOT, "scripts/install.sh")], { encoding: "utf8" });
    expect(r.stdout + r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it("runs on macOS's bash 3.2: no bash 4 features, empty arrays guarded under set -u (mac test)", () => {
    // /bin/bash on macOS is 3.2: under `set -u` an empty array's ${A[*]} / ${A[@]} is "unbound"
    // (bash ≥ 4.4 allows it, so Linux CI never saw it): install.sh --no-service stopped at the last line.
    const lines = readFileSync(join(ROOT, "scripts/install.sh"), "utf8").split("\n");
    const found: string[] = [];
    lines.forEach((raw, i) => {
      const line = raw.replace(/^\s*#.*$/, "");
      // The guarded form ${A[@]+"${A[@]}"} is fine; anything left is not.
      const rest = line.replace(/\$\{(\w+)\[([@*])\]\+"?\$\{\1\[\2\]\}"?\}/g, "");
      if (/\$\{\w+\[[@*]\]\}/.test(rest)) found.push(`${i + 1}: unguarded array: ${raw.trim()}`);
      const bash4 = [
        /\$\{\w+(,,?|\^\^?)\}/, // case conversion
        /\b(mapfile|readarray|coproc)\b/,
        /\b(declare|local|typeset)\s+-[a-zA-Z]*[An]/, // associative arrays, namerefs
        /&>>|\|&|;;&|;&/,
      ];
      for (const re of bash4) if (re.test(line)) found.push(`${i + 1}: bash 4: ${raw.trim()}`);
    });
    expect(found).toEqual([]);
  });

  it("installs a local checkout into <prefix>/app with a launcher, keeps data, prints pairing steps", () => {
    const prefix = join(tmp, "home");
    const run = () =>
      spawnSync(
        "bash",
        [join(ROOT, "scripts/install.sh"), "--local", ROOT, "--prefix", prefix, "--no-service"],
        {
          encoding: "utf8",
        },
      );
    const first = run();
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain("配對手機");
    expect(first.stdout).toContain(`${prefix}/bin/alca pair`);
    const launcher = join(prefix, "bin/alca");
    expect(statSync(launcher).mode & 0o111).toBeTruthy();
    expect((statSync(prefix).mode & 0o777).toString(8)).toBe("700");
    const usage = spawnSync(launcher, [], { encoding: "utf8" });
    expect(usage.status).toBe(0);
    expect(usage.stdout).toContain("alca service install");

    // A second install replaces the app and leaves data files alone.
    execFileSync("sh", ["-c", `printf keep > ${JSON.stringify(join(prefix, "config.json"))}`]);
    const again = run();
    expect(again.status, again.stderr).toBe(0);
    expect(readFileSync(join(prefix, "config.json"), "utf8")).toBe("keep");
    expect(existsSync(join(prefix, "app.prev"))).toBe(false);
  }, 90_000);

  it("refuses an http download and an unknown option", () => {
    const r1 = spawnSync(
      "bash",
      [join(ROOT, "scripts/install.sh"), "--tarball", "http://example.com/a.tgz"],
      {
        encoding: "utf8",
        env: { ...process.env, ALCA_HOME: join(tmp, "nope") },
      },
    );
    expect(r1.status).toBe(1);
    expect(r1.stderr).toContain("只接受 https");
    const r2 = spawnSync("bash", [join(ROOT, "scripts/install.sh"), "--frobnicate"], { encoding: "utf8" });
    expect(r2.status).toBe(1);
  });

  it("refuses a tarball without a checksum it can verify, unless --insecure (review H4)", () => {
    const tgz = join(tmp, "not-a-core.tar.gz");
    writeFileSync(tgz, "not really a tarball");
    const sum = createHash("sha256").update("not really a tarball").digest("hex");
    const run = (...args: string[]) =>
      spawnSync("bash", [join(ROOT, "scripts/install.sh"), "--tarball", tgz, "--no-service", ...args], {
        encoding: "utf8",
        env: { ...process.env, ALCA_HOME: join(tmp, "sum-test") },
      });
    const none = run();
    expect(none.status).toBe(1);
    expect(none.stderr).toContain("檢查碼");
    expect(none.stderr).toContain("--insecure");
    const wrong = run("--sha256", "0".repeat(64));
    expect(wrong.status).toBe(1);
    expect(wrong.stderr).toContain("檢查碼不符");
    expect(run("--sha256", "abc").stderr).toContain("64");
    // The right checksum (given, or in <file>.sha256 next to it) passes; the dummy then fails to unpack.
    const given = run("--sha256", sum.toUpperCase());
    expect(given.stdout).toContain("檢查碼正確");
    writeFileSync(`${tgz}.sha256`, `${sum}  not-a-core.tar.gz\n`);
    const sibling = run();
    expect(sibling.stdout).toContain("檢查碼正確");
    rmSync(`${tgz}.sha256`);
    const insecure = run("--insecure");
    expect(insecure.stdout).toContain("--insecure");
    expect(insecure.stderr).not.toContain("找不到");
  });

  it("a failed install removes the empty prefix it created, and never a prefix that was there (mac test 2026-11-04b A6)", () => {
    const tgz = join(tmp, "a6.tar.gz");
    writeFileSync(tgz, "not really a tarball");
    const run = (home: string, ...args: string[]) =>
      spawnSync("bash", [join(ROOT, "scripts/install.sh"), "--tarball", tgz, "--no-service", ...args], {
        encoding: "utf8",
        env: { ...process.env, ALCA_HOME: home },
      });
    const fresh = join(tmp, "a6-fresh");
    expect(run(fresh).status).toBe(1); // no checksum
    expect(existsSync(fresh)).toBe(false);
    expect(run(fresh, "--sha256", "0".repeat(64)).status).toBe(1); // wrong checksum
    expect(existsSync(fresh)).toBe(false);
    // A prefix that already existed stays, even empty, and so does what is in it.
    const kept = join(tmp, "a6-kept");
    mkdirSync(kept);
    expect(run(kept).status).toBe(1);
    expect(existsSync(kept)).toBe(true);
    writeFileSync(join(kept, "config.json"), "keep");
    expect(run(kept, "--sha256", "0".repeat(64)).status).toBe(1);
    expect(readFileSync(join(kept, "config.json"), "utf8")).toBe("keep");
  });
});

/**
 * The desktop App from the terminal (no Developer ID): install.sh --app / --app-only puts the
 * release's ad-hoc signed Alca.app in ~/Applications after checking its SHA-256 and signature.
 * The tests fake macOS (ALCA_INSTALL_OS=Darwin) and, where it matters, codesign / xattr.
 */
describe("scripts/install.sh --app (macOS App from a tarball)", () => {
  const appTar = (name: string, opts: { macos?: boolean } = {}) => {
    const src = join(tmp, `${name}-src`);
    const bin = join(src, "Alca.app/Contents", opts.macos === false ? "Other" : "MacOS");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "Alca"), "#!/bin/sh\n", { mode: 0o755 });
    execFileSync("ln", ["-s", "MacOS/Alca", join(src, "Alca.app/Contents/alca-link")]);
    const tgz = join(tmp, `${name}.tar.gz`);
    execFileSync("tar", ["-czf", tgz, "-C", src, "Alca.app"]);
    const sum = createHash("sha256").update(readFileSync(tgz)).digest("hex");
    return { tgz, sum };
  };
  /** A bin folder with fake codesign / xattr that log their arguments. */
  const fakeBin = (name: string, codesignOk: boolean, quarantined: boolean) => {
    const dir = join(tmp, `${name}-bin`);
    mkdirSync(dir, { recursive: true });
    const log = join(dir, "calls.log");
    writeFileSync(
      join(dir, "codesign"),
      `#!/bin/sh\necho "codesign $*" >> ${JSON.stringify(log)}\ncase "$1" in -dv) echo "Signature=adhoc" >&2; exit 0 ;; esac\nexit ${codesignOk ? 0 : 1}\n`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(dir, "xattr"),
      `#!/bin/sh\necho "xattr $*" >> ${JSON.stringify(log)}\ncase "$1" in -p) exit ${quarantined ? 0 : 1} ;; esac\nexit 0\n`,
      { mode: 0o755 },
    );
    return { dir, log: () => (existsSync(log) ? readFileSync(log, "utf8") : "") };
  };
  // A passing codesign and an unmarked xattr unless a test says otherwise (so a real Mac's
  // codesign never judges these unsigned test bundles).
  const plain = fakeBin("plain", true, false);
  const run = (args: string[], env: Record<string, string> = {}) =>
    spawnSync("bash", [join(ROOT, "scripts/install.sh"), ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        ALCA_INSTALL_OS: "Darwin",
        PATH: `${plain.dir}:${process.env.PATH}`,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

  it("--app-only: checks the SHA-256, keeps symlinks, installs into the App folder; no Node or prefix needed", () => {
    const { tgz, sum } = appTar("ok");
    const apps = join(tmp, "Apps-ok");
    const prefix = join(tmp, "app-only-prefix");
    const r = run(["--app-only", "--app-tarball", tgz, "--app-sha256", sum, "--app-dir", apps], {
      ALCA_HOME: prefix,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("檢查碼正確");
    expect(r.stdout).toContain(`已安裝 App 到 ${apps}/Alca.app`);
    expect(r.stdout).toContain("不會跳出 Gatekeeper");
    expect(lstatSync(join(apps, "Alca.app/Contents/alca-link")).isSymbolicLink()).toBe(true);
    expect(statSync(join(apps, "Alca.app/Contents/MacOS/Alca")).mode & 0o111).toBeTruthy();
    expect(existsSync(prefix)).toBe(false);
  });

  it("refuses a tarball without a checksum (unless --insecure), a wrong checksum, and one with no Alca.app inside", () => {
    const { tgz, sum } = appTar("sum");
    const apps = join(tmp, "Apps-sum");
    const none = run(["--app-only", "--app-tarball", tgz, "--app-dir", apps]);
    expect(none.status).toBe(1);
    expect(none.stderr).toContain("檢查碼");
    const wrong = run([
      "--app-only",
      "--app-tarball",
      tgz,
      "--app-sha256",
      "0".repeat(64),
      "--app-dir",
      apps,
    ]);
    expect(wrong.status).toBe(1);
    expect(wrong.stderr).toContain("檢查碼不符");
    expect(existsSync(join(apps, "Alca.app"))).toBe(false);
    writeFileSync(`${tgz}.sha256`, `${sum}  sum.tar.gz\n`);
    expect(run(["--app-only", "--app-tarball", tgz, "--app-dir", apps]).status).toBe(0);
    const bad = appTar("bad", { macos: false });
    const r = run([
      "--app-only",
      "--app-tarball",
      bad.tgz,
      "--app-sha256",
      bad.sum,
      "--app-dir",
      join(tmp, "Apps-bad"),
    ]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Alca.app/Contents/MacOS");
    expect(run(["--app-only", "--app-tarball", "http://example.com/a.tgz"]).stderr).toContain("只接受 https");
  });

  it("an existing Alca.app is replaced only when confirmed (--yes), and kept as a backup", () => {
    const { tgz, sum } = appTar("replace");
    const apps = join(tmp, "Apps-replace");
    mkdirSync(join(apps, "Alca.app"), { recursive: true });
    writeFileSync(join(apps, "Alca.app/old"), "old");
    const asked = run(["--app-only", "--app-tarball", tgz, "--app-sha256", sum, "--app-dir", apps]);
    expect(asked.status, asked.stderr).toBe(0);
    expect(asked.stdout).toContain("沒有更動");
    expect(readFileSync(join(apps, "Alca.app/old"), "utf8")).toBe("old");
    const yes = run(["--app-only", "--app-tarball", tgz, "--app-sha256", sum, "--app-dir", apps, "--yes"]);
    expect(yes.status, yes.stderr).toBe(0);
    expect(existsSync(join(apps, "Alca.app/Contents/MacOS/Alca"))).toBe(true);
    const backups = execFileSync("ls", [apps], { encoding: "utf8" })
      .split("\n")
      .filter((f) => f.startsWith("Alca.app.bak-"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(apps, backups[0] as string, "old"), "utf8")).toBe("old");
  });

  it("checks the code signature with codesign; a broken signature stops the install", () => {
    const { tgz, sum } = appTar("sig");
    const good = fakeBin("sig-good", true, false);
    const ok = run(
      ["--app-only", "--app-tarball", tgz, "--app-sha256", sum, "--app-dir", join(tmp, "Apps-sig")],
      {
        PATH: `${good.dir}:${process.env.PATH}`,
      },
    );
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toContain("App 簽章正確（adhoc）");
    expect(good.log()).toMatch(/codesign --verify --deep --strict .*Alca\.app/);
    const broken = fakeBin("sig-bad", false, false);
    const r = run(
      ["--app-only", "--app-tarball", tgz, "--app-sha256", sum, "--app-dir", join(tmp, "Apps-sig2")],
      {
        PATH: `${broken.dir}:${process.env.PATH}`,
      },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("簽章");
    expect(existsSync(join(tmp, "Apps-sig2/Alca.app"))).toBe(false);
  });

  it("never removes a quarantine mark from a file it did not download; it warns instead", () => {
    const { tgz, sum } = appTar("q");
    const bin = fakeBin("q", true, true);
    const r = run(
      ["--app-only", "--app-tarball", tgz, "--app-sha256", sum, "--app-dir", join(tmp, "Apps-q")],
      {
        PATH: `${bin.dir}:${process.env.PATH}`,
      },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("隔離標記");
    expect(bin.log()).not.toMatch(/xattr -d/);
  });

  it("macOS only: --app on Linux is refused; a Linux install never tries the App", () => {
    const { tgz, sum } = appTar("linux");
    const r = run(["--app-only", "--app-tarball", tgz, "--app-sha256", sum], { ALCA_INSTALL_OS: "Linux" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("只有 macOS");
  });
});
