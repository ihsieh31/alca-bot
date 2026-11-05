// Phase E updater: stage, apply (backup first, old version kept, health or roll back), roll back
// (the pre-update backup when the schema moved on), the CLI's yes, and the daily check.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listBackups, openDatabase, openStore } from "@alca/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachUpdateCheck, UpdateChecker } from "../src/update-check.ts";
import { updateCli } from "../src/update-cli.ts";
import {
  applyUpdate,
  detectLayout,
  type Layout,
  readState,
  rollback,
  type ServiceControl,
  stage,
} from "../src/update-install.ts";
import type { ReleaseInfo, ReleaseSource } from "../src/update-release.ts";

let dir: string;
let prefix: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "alca-upd-i-"));
  prefix = join(dir, "alca");
  mkdirSync(join(prefix, "bin"), { recursive: true });
  writeFileSync(join(prefix, "bin/alca"), "#!/bin/sh\n");
  tree(join(prefix, "app"), "0.2.0");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function tree(root: string, version: string, cli = "process.exit(0);\n") {
  mkdirSync(join(root, "apps/desktop/src"), { recursive: true });
  writeFileSync(join(root, "apps/desktop/src/cli.ts"), cli);
  writeFileSync(join(root, "ALCA_VERSION"), JSON.stringify({ version }));
}

function tarball(version: string, o: { cli?: string; name?: string } = {}): string {
  const src = join(dir, `src-${version}-${Math.random().toString(36).slice(2)}`);
  tree(join(src, "alca"), version, o.cli);
  const out = join(dir, o.name ?? `alca-core-${version}.tar.gz`);
  execFileSync("tar", ["-czf", out, "-C", src, "alca"]);
  return out;
}

const layout = (): Layout => detectLayout(join(prefix, "app"));

function fakeService(installed = true) {
  const calls: string[] = [];
  const svc: ServiceControl = {
    installed: () => installed,
    stop: () => calls.push("stop"),
    start: () => calls.push("start"),
  };
  return { svc, calls };
}

const version = (root: string) =>
  (JSON.parse(readFileSync(join(root, "ALCA_VERSION"), "utf8")) as { version: string }).version;

describe("layout", () => {
  it("only an install.sh / install.ps1 install is replaced; the App's copy and a checkout are told", () => {
    expect(layout()).toMatchObject({ kind: "installed", prefix, version: "0.2.0" });
    tree(join(dir, "data/bundled/0.2.0"), "0.2.0");
    expect(detectLayout(join(dir, "data/bundled/0.2.0")).kind).toBe("bundled");
    mkdirSync(join(dir, "co/.git"), { recursive: true });
    expect(detectLayout(join(dir, "co")).kind).toBe("checkout");
  });
});

describe("stage", () => {
  it("refuses a tarball whose ALCA_VERSION is not the release asked for, and one that does not run", () => {
    expect(() => stage({ prefix, tarball: tarball("0.1.0"), expectVersion: "v0.3.0" })).toThrow(
      /不是要裝的 0.3.0/,
    );
    expect(() =>
      stage({ prefix, tarball: tarball("0.3.0", { cli: "process.exit(3);\n" }), expectVersion: "0.3.0" }),
    ).toThrow(/跑不起來/);
    expect(existsSync(join(prefix, "app.next"))).toBe(false);
    expect(version(join(prefix, "app"))).toBe("0.2.0");
  });
});

describe("apply and roll back", () => {
  it("stops the service, backs the database up first, keeps the old version, starts and checks health", async () => {
    openStore(join(prefix, "state.sqlite")).close();
    const { svc, calls } = fakeService();
    const staged = stage({ prefix, tarball: tarball("0.3.0"), expectVersion: "v0.3.0" });
    const r = await applyUpdate({
      layout: layout(),
      dataDir: prefix,
      staged,
      service: svc,
      healthy: async () => true,
      running: async () => true,
      verified: "test",
    });
    expect(calls).toEqual(["stop", "start"]);
    expect(r).toMatchObject({ from: "0.2.0", to: "0.3.0", started: true });
    expect(version(join(prefix, "app"))).toBe("0.3.0");
    expect(version(join(prefix, "app.prev"))).toBe("0.2.0");
    expect(r.backup && existsSync(r.backup)).toBe(true);
    expect(listBackups(join(prefix, "state.sqlite")).map((b) => b.file)).toContain(r.backup);
    expect(readState(prefix).installed).toMatchObject({ from: "0.2.0", to: "0.3.0", backup: r.backup });
  });

  it("no answer from the new version: rolls back by itself", async () => {
    const { svc, calls } = fakeService();
    const staged = stage({ prefix, tarball: tarball("0.3.0") });
    const r = await applyUpdate({
      layout: layout(),
      dataDir: prefix,
      staged,
      service: svc,
      healthy: async () => false,
      running: async () => false,
      verified: "test",
    });
    expect(r.rolledBack?.to).toBe("0.2.0");
    expect(version(join(prefix, "app"))).toBe("0.2.0");
    expect(readdirSync(prefix).some((n) => n.startsWith("app.failed-"))).toBe(true);
    expect(calls).toEqual(["stop", "start", "stop", "start"]);
    expect(readState(prefix).rolledBack).toMatchObject({ from: "0.3.0", to: "0.2.0", auto: true });
  });

  it("refuses an older version (unless --allow-downgrade) and a core started by hand", async () => {
    const base = { layout: layout(), dataDir: prefix, healthy: async () => true, verified: "t" };
    await expect(
      applyUpdate({
        ...base,
        staged: stage({ prefix, tarball: tarball("0.1.0") }),
        service: fakeService().svc,
        running: async () => false,
      }),
    ).rejects.toThrow(/allow-downgrade/);
    await expect(
      applyUpdate({
        ...base,
        staged: stage({ prefix, tarball: tarball("0.3.0") }),
        service: fakeService(false).svc,
        running: async () => true,
      }),
    ).rejects.toThrow(/alca start/);
    expect(version(join(prefix, "app"))).toBe("0.2.0");
  });

  it("rollback restores the pre-update backup when the new version migrated the database", async () => {
    const db = join(prefix, "state.sqlite");
    openStore(db).close();
    const { svc } = fakeService();
    await applyUpdate({
      layout: layout(),
      dataDir: prefix,
      staged: stage({ prefix, tarball: tarball("0.3.0") }),
      service: svc,
      healthy: async () => true,
      running: async () => true,
      verified: "t",
    });
    // The new version's migration (a schema the old core cannot open).
    const h = openDatabase({ path: db });
    const v = (h.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number }).v;
    h.prepare(
      "INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (?, 'future', '2026-11-05', 'x')",
    ).run(v + 1);
    h.close();
    const r = await rollback({
      layout: detectLayout(join(prefix, "app")),
      dataDir: prefix,
      service: svc,
      healthy: async () => true,
    });
    expect(r.to).toBe("0.2.0");
    expect(r.restored?.movedAside && existsSync(r.restored.movedAside)).toBe(true);
    const after = openDatabase({ path: db, readOnly: true });
    expect((after.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number }).v).toBe(
      v,
    );
    after.close();
    expect(version(join(prefix, "app"))).toBe("0.2.0");
  });
});

describe("alca update", () => {
  const sha = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");
  function source(releases: ReleaseInfo[], files: Record<string, string>): ReleaseSource {
    return {
      repo: "o/r",
      list: async () => releases,
      download: async (_r, name, dest) => {
        const f = files[name];
        if (!f) return false;
        writeFileSync(dest, readFileSync(f));
        return true;
      },
    };
  }
  const r030 = (o: Partial<ReleaseInfo> = {}): ReleaseInfo => ({
    tag: "v0.3.0",
    version: "0.3.0",
    draft: false,
    prerelease: false,
    htmlUrl: "https://example.invalid/v0.3.0",
    assets: [
      { name: "alca-core-0.3.0.tar.gz", url: "x" },
      { name: "SHA256SUMS", url: "y" },
    ],
    ...o,
  });

  it("install: downloads, checks, and changes nothing without a yes", async () => {
    const t = tarball("0.3.0");
    const sums = join(dir, "SHA256SUMS");
    writeFileSync(sums, `${sha(t)}  alca-core-0.3.0.tar.gz\n`);
    const out: string[] = [];
    const { svc, calls } = fakeService();
    const deps = {
      layout: layout(),
      source: source([r030()], { "alca-core-0.3.0.tar.gz": t, SHA256SUMS: sums }),
      service: svc,
      probe: async () => true,
      out: (l: string) => out.push(l),
      err: (l: string) => out.push(l),
    };
    const no = await updateCli(["install", "--data-dir", prefix], { ...deps, confirm: async () => false });
    expect(no).toBe(1);
    expect(out.join("\n")).toContain("只驗檢查碼");
    expect(calls).toEqual([]);
    expect(version(join(prefix, "app"))).toBe("0.2.0");
    expect(existsSync(join(prefix, "app.next"))).toBe(false);
    const yes = await updateCli(["install", "--data-dir", prefix], { ...deps, confirm: async () => true });
    expect(yes).toBe(0);
    expect(version(join(prefix, "app"))).toBe("0.3.0");
  });

  it("install: a draft is never installed; a damaged download is refused", async () => {
    const t = tarball("0.3.0");
    const sums = join(dir, "SHA256SUMS");
    writeFileSync(sums, `${"0".repeat(64)}  alca-core-0.3.0.tar.gz\n`);
    const out: string[] = [];
    const deps = {
      layout: layout(),
      service: fakeService().svc,
      probe: async () => true,
      confirm: async () => true,
      out: (l: string) => out.push(l),
      err: (l: string) => out.push(l),
    };
    const draft = await updateCli(["install", "--version", "v0.3.0", "--data-dir", prefix], {
      ...deps,
      source: source([r030({ draft: true })], {}),
    });
    expect(draft).toBe(1);
    expect(out.join("\n")).toContain("草稿");
    const bad = await updateCli(["install", "--data-dir", prefix], {
      ...deps,
      source: source([r030()], { "alca-core-0.3.0.tar.gz": t, SHA256SUMS: sums }),
    });
    expect(bad).toBe(1);
    expect(out.join("\n")).toContain("檢查碼不符");
    expect(version(join(prefix, "app"))).toBe("0.2.0");
  });

  it("check / install on the App's own core: points to the new App instead", async () => {
    tree(join(dir, "data/bundled/0.2.0"), "0.2.0");
    const out: string[] = [];
    const deps = {
      layout: detectLayout(join(dir, "data/bundled/0.2.0")),
      source: source([r030()], {}),
      out: (l: string) => out.push(l),
      err: (l: string) => out.push(l),
    };
    expect(await updateCli(["check", "--data-dir", prefix], deps)).toBe(0);
    expect(out.join("\n")).toContain("下載新版 App");
    expect(await updateCli(["install", "--data-dir", prefix], deps)).toBe(1);
  });
});

describe("the daily check", () => {
  it("at most once a day from the hourly slot, only notifies; off = no request", async () => {
    let n = 0;
    const src: ReleaseSource = {
      repo: "o/r",
      list: async () => {
        n++;
        return [
          {
            tag: "v0.3.0",
            version: "0.3.0",
            draft: false,
            prerelease: false,
            htmlUrl: "https://example.invalid/v0.3.0",
            assets: [],
          },
        ];
      },
      download: async () => false,
    };
    const settings = { check: "notify" as "notify" | "off", channel: "stable" as const };
    const log = vi.fn();
    const c = new UpdateChecker({
      dataDir: prefix,
      settings: () => settings,
      layout: layout(),
      source: src,
      log,
    });
    const upkeep = { hourly: (_now: Date) => ({ at: "", errors: {} }) };
    attachUpdateCheck(upkeep as never, c);
    const t0 = new Date("2026-11-05T00:00:00Z");
    upkeep.hourly(t0);
    await c.checkNow(t0);
    expect(n).toBe(1);
    expect(c.view()).toMatchObject({ lastCheck: { newer: true, latest: { tag: "v0.3.0" } } });
    expect(c.view().action).toContain("alca update install");
    expect(log).toHaveBeenCalledWith("info", expect.stringContaining("v0.3.0"));
    upkeep.hourly(new Date("2026-11-05T05:00:00Z"));
    expect(n).toBe(1);
    upkeep.hourly(new Date("2026-11-06T01:00:00Z"));
    await c.checkNow(new Date("2026-11-06T01:00:00Z")).catch(() => undefined);
    expect(n).toBeGreaterThanOrEqual(2);
    const before = n;
    settings.check = "off";
    upkeep.hourly(new Date("2026-11-09T00:00:00Z"));
    expect(n).toBe(before);
    expect(version(join(prefix, "app"))).toBe("0.2.0"); // never installs
  });
});
