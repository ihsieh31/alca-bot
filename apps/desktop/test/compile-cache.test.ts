import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dataDirFromArgv } from "../src/compile-cache.ts";

/** PERF-2026-11: main.ts turns Node's compile cache on before the core loads. */
describe("desktop core compile cache", () => {
  const run = (args: string[], env: Record<string, string>) =>
    execFileSync(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", "apps/desktop/src/main.ts", "--engine", "nope", ...args],
      {
        env: { ...process.env, ...env },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

  it("review #16: writes the code cache into <data>/cache/compile (0700), not the shared temp dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "alca-cc-"));
    try {
      const tmp = join(dir, "tmp");
      mkdirSync(tmp);
      const data = join(dir, "data");
      // An unknown engine exits with 2 after the whole command line has loaded.
      expect(() => run(["--data-dir", data], { TMPDIR: tmp, NODE_COMPILE_CACHE: "" })).toThrow(/未知的引擎/);
      expect(readdirSync(tmp)).not.toContain("node-compile-cache");
      const cache = join(data, "cache", "compile");
      expect(readdirSync(cache, { recursive: true }).length).toBeGreaterThan(1);
      if (process.platform !== "win32")
        for (const p of [data, join(data, "cache"), cache]) expect(statSync(p).mode & 0o777).toBe(0o700);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("NODE_DISABLE_COMPILE_CACHE=1 starts without it", () => {
    const dir = mkdtempSync(join(tmpdir(), "alca-cc-"));
    try {
      const data = join(dir, "data");
      expect(() =>
        run([`--data-dir=${data}`], { TMPDIR: dir, NODE_DISABLE_COMPILE_CACHE: "1", NODE_COMPILE_CACHE: "" }),
      ).toThrow(/未知的引擎/);
      expect(readdirSync(dir)).not.toContain("node-compile-cache");
      expect(() => statSync(join(data, "cache"))).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("the data folder comes from --data-dir (either form), then $ALCA_DATA_DIR", () => {
    expect(dataDirFromArgv(["--data-dir", "/x/a"], {})).toBe("/x/a");
    expect(dataDirFromArgv(["--engine", "demo", "--data-dir=/x/b"], {})).toBe("/x/b");
    expect(dataDirFromArgv([], { ALCA_DATA_DIR: "/x/c" })).toBe("/x/c");
    expect(dataDirFromArgv([], {})).toMatch(/\.alca$/u);
  });
});
