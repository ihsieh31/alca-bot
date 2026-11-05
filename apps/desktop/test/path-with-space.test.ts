// Mac test 2026-11-04: in a checkout whose path has a space ("~/Downloads/claude
// code/alca-agent") six scripts compared import.meta.url (spaces as %20) with
// `file://${argv[1]}`, did nothing and exited 0 — `pnpm alca` printed nothing
// and `pnpm check:deploy-values` passed without scanning. Every entry point now
// compares real paths; these run them from a path with a space and expect output.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const base = mkdtempSync(join(tmpdir(), "alca path test-"));
const spaced = join(base, "claude code", "alca-agent");
mkdirSync(join(base, "claude code"));
symlinkSync(ROOT, spaced, "dir");
afterAll(() => rmSync(base, { recursive: true, force: true }));

const clean = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith("ALCA_OFFICIAL_")),
);
/** Run a script by its path under the spaced folder, keeping that path as the main module's URL. */
const run = (rel: string, args: string[] = []) =>
  spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", "--preserve-symlinks-main", join(spaced, rel), ...args],
    { cwd: ROOT, encoding: "utf8", env: clean, timeout: 60_000 },
  );

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (["node_modules", "dist", "target", ".git"].includes(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* sources(p);
    else if (/\.(ts|mjs|js)$/.test(name)) yield p;
  }
}

describe("entry points in a folder whose path has a space", () => {
  it("no script compares import.meta.url with a hand-built file:// URL", () => {
    const bad = /import\.meta\.url\s*===\s*`file:\/\//;
    const hits: string[] = [];
    for (const top of ["apps", "packages", "scripts", "services"])
      for (const f of sources(join(ROOT, top))) if (bad.test(readFileSync(f, "utf8"))) hits.push(f);
    expect(hits).toEqual([]);
  });

  it("the folder really has a space in it", () => {
    expect(spaced).toContain(" ");
  });

  it("check:deploy-values scans and says so", () => {
    const r = run("scripts/check-deploy-values.ts");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/deploy values: clean \(\d+ files\)/);
  });

  it("the alca CLI prints its usage", () => {
    const r = run("apps/desktop/src/cli.ts");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("alca service install");
    const bad = run("apps/desktop/src/cli.ts", ["frobnicate"]);
    expect(bad.status).toBe(2);
  });

  it("gen-official-config, pack-core and the phone build run", () => {
    const g = run("scripts/gen-official-config.ts", [join(base, "official.json")]);
    expect(g.status, g.stderr).toBe(0);
    expect(g.stdout).toContain("nothing written");
    const p = run("scripts/pack-core.ts");
    expect(p.status).toBe(2);
    expect(p.stderr).toContain("usage: pack-core.ts");
    const b = run("apps/phone-pwa/scripts/build.ts", [join(base, "pwa")]);
    expect(b.status, b.stderr).toBe(0);
    expect(b.stdout).toContain("phone PWA built");
  }, 60_000);
});
