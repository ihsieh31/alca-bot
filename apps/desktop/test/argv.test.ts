import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { describe, expect, it } from "vitest";
import { scriptArgs } from "../src/argv.ts";

describe("pnpm desktop:demo -- … (mac test 2026-11-04b C3)", () => {
  it("drops one leading --, and only a leading one", () => {
    expect(scriptArgs(["--", "--data-dir", "x"])).toEqual(["--data-dir", "x"]);
    expect(scriptArgs(["--data-dir", "x"])).toEqual(["--data-dir", "x"]);
    expect(scriptArgs(["--data-dir", "x", "--", "y"])).toEqual(["--data-dir", "x", "--", "y"]);
    expect(scriptArgs(["--", "--"])).toEqual(["--"]);
    expect(scriptArgs([])).toEqual([]);
  });

  it("parseArgs then reads the flags instead of refusing them as positionals", () => {
    const options = { "data-dir": { type: "string" as const }, browser: { type: "string" as const } };
    expect(() => parseArgs({ args: ["--", "--data-dir", "x"], options })).toThrow();
    const { values } = parseArgs({
      args: scriptArgs(["--", "--data-dir", "x", "--browser", "headless"]),
      options,
    });
    expect(values).toEqual({ "data-dir": "x", browser: "headless" });
  });

  it("main.ts (its command line lives in core-main.ts), pair.ts and the alca command go through it", () => {
    expect(readFileSync("apps/desktop/src/main.ts", "utf8")).toContain('await import("./core-main.ts")');
    for (const f of ["core-main.ts", "pair.ts"])
      expect(readFileSync(`apps/desktop/src/${f}`, "utf8"), f).toMatch(
        /parseArgs\(\{\s*args: scriptArgs\(\)/,
      );
    expect(readFileSync("apps/desktop/src/cli.ts", "utf8")).toContain("cli(scriptArgs())");
  });
});
