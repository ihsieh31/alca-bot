import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ALCA_VERSION } from "../../../packages/engines/src/version.ts";
import { versionFields, versionLiterals, versionProblems } from "../../../scripts/check-versions.ts";

describe("one version everywhere (review M7)", () => {
  it("every package.json, tauri.conf.json, Cargo.toml and Cargo.lock entry carries 0.2.0", () => {
    const fields = versionFields();
    expect(fields.length).toBeGreaterThan(20);
    expect(fields.map((f) => f.file)).toEqual(
      expect.arrayContaining([
        "package.json",
        "apps/desktop-shell/src-tauri/tauri.conf.json",
        "apps/desktop-shell/src-tauri/Cargo.toml",
        "apps/desktop-shell/src-tauri/Cargo.lock",
      ]),
    );
    expect(versionProblems(fields)).toEqual([]);
    expect(new Set(fields.map((f) => f.version))).toEqual(new Set(["0.2.0"]));
  });

  it("names the files that disagree, and a tag that is not the version", () => {
    const fields = [
      { file: "a/package.json", version: "0.2.0" },
      { file: "b/package.json", version: "0.1.0" },
    ];
    expect(versionProblems(fields)).toEqual(["0.2.0: a/package.json", "0.1.0: b/package.json"]);
    expect(versionProblems([fields[0] as (typeof fields)[0]], "v0.2.0")).toEqual([]);
    expect(versionProblems([fields[0] as (typeof fields)[0]], "v0.3.0")).toEqual([
      "tag v0.3.0 but the version is 0.2.0",
    ]);
  });

  it("no source writes the version as a literal; the engines read the one version", () => {
    expect(versionLiterals()).toEqual([]);
    expect(ALCA_VERSION).toBe("0.2.0");
  });

  it("finds a literal like the old ACP clientInfo", () => {
    const root = mkdtempSync(join(tmpdir(), "alca-versions-"));
    try {
      mkdirSync(join(root, "packages/x/src"), { recursive: true });
      mkdirSync(join(root, "packages/x/test"), { recursive: true });
      writeFileSync(
        join(root, "packages/x/src/a.ts"),
        'const i = {\n  clientInfo: { name: "alca", version: "0.1.0" },\n};\n',
      );
      writeFileSync(join(root, "packages/x/test/a.test.ts"), 'const v = { version: "9.9.9" };\n');
      execFileSync("git", ["init", "-q"], { cwd: root });
      execFileSync("git", ["add", "."], { cwd: root });
      expect(versionLiterals(root)).toEqual([
        'packages/x/src/a.ts:2: version literal "0.1.0" (read ALCA_VERSION / package.json instead)',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
