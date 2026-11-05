import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * Next-round design §2: a draft release is never GitHub's "latest", so a plain
 * install (no --version) cannot download anything until a release is
 * published. install.sh must say so and name the fix (--version <tag>)
 * instead of a vague failure. curl and gh are faked; nothing is downloaded.
 */
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "alca-install-latest-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function fakeBin(gh: "none" | "fails"): string {
  const dir = join(tmp, `bin-${gh}`);
  mkdirSync(dir, { recursive: true });
  // Every download fails the way GitHub answers a missing "latest" (HTTP 404 → curl exit 22).
  writeFileSync(join(dir, "curl"), "#!/bin/sh\nexit 22\n", { mode: 0o755 });
  writeFileSync(join(dir, "wget"), "#!/bin/sh\nexit 8\n", { mode: 0o755 });
  writeFileSync(
    join(dir, "gh"),
    gh === "none"
      ? "#!/bin/sh\nexit 127\n"
      : '#!/bin/sh\ncase "$1 $2" in "auth status") exit 0 ;; esac\necho "release not found" >&2\nexit 1\n',
    { mode: 0o755 },
  );
  return dir;
}

const run = (args: string[], gh: "none" | "fails") =>
  spawnSync("bash", [join(ROOT, "scripts/install.sh"), ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      ALCA_INSTALL_OS: "Darwin",
      ALCA_HOME: join(tmp, "prefix"),
      PATH: `${fakeBin(gh)}:${process.env.PATH}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

describe("install.sh without --version while the only release is a draft", () => {
  it("the App: says drafts are not latest and to pass --version", () => {
    const r = run(["--app-only", "--app-dir", join(tmp, "Apps")], "fails");
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).toContain("不算 latest");
    expect(r.stderr + r.stdout).toContain("--version <tag>");
  });

  it("the same hint when the GitHub CLI is not signed in", () => {
    const r = run(["--app-only", "--app-dir", join(tmp, "Apps2")], "none");
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).toContain("--version <tag>");
  });

  it("with --version, the hint names that tag instead", () => {
    const r = run(["--app-only", "--version", "v9.9.9", "--app-dir", join(tmp, "Apps3")], "fails");
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).toContain("v9.9.9");
    expect(r.stderr + r.stdout).not.toContain("不算 latest");
  });
});
