import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "@alca/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { codingMaterial } from "../src/agents/harness-run/review.ts";
import { GitSnapshots } from "../src/harness/git-snapshots.ts";

/**
 * Next-round §5.6: the git Alca runs itself never runs a program the
 * repository's own config names (fsmonitor, hooks, an external diff, a
 * textconv filter, a pager). The repo below plants each one; every one
 * would leave a marker file if git ran it.
 */
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.test",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.test",
    },
  }).trim();

let dir: string;
let marks: string;
let store: Store;

const planted = (name: string) => existsSync(join(marks, name));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "alca-harden-"));
  marks = mkdtempSync(join(tmpdir(), "alca-harden-marks-"));
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "one\n");
  writeFileSync(join(dir, "b.bin"), "bin\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "first");
  const script = (name: string) => {
    const p = join(marks, `${name}.sh`);
    writeFileSync(p, `#!/bin/sh\ntouch "${join(marks, name)}"\ncat >/dev/null 2>&1\nexit 0\n`, {
      mode: 0o755,
    });
    return p;
  };
  // What a bot (or a cloned repo) could leave in .git/config and .git/hooks.
  git(dir, "config", "core.fsmonitor", script("fsmonitor"));
  git(dir, "config", "diff.external", script("extdiff"));
  git(dir, "config", "core.pager", script("pager"));
  git(dir, "config", "diff.evil.textconv", script("textconv"));
  writeFileSync(join(dir, ".gitattributes"), "*.bin diff=evil\n");
  mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
  for (const h of [
    "pre-commit",
    "post-commit",
    "reference-transaction",
    "post-checkout",
    "post-index-change",
  ])
    writeFileSync(join(dir, ".git", "hooks", h), `#!/bin/sh\ntouch "${join(marks, h)}"\n`, { mode: 0o755 });
  // The planted fsmonitor fires on the test's own setup git; start counting from here.
  rmSync(marks, { recursive: true, force: true });
  mkdirSync(marks);
  for (const n of ["fsmonitor", "extdiff", "pager", "textconv"])
    writeFileSync(
      join(marks, `${n}.sh`),
      `#!/bin/sh\ntouch "${join(marks, n)}"\ncat >/dev/null 2>&1\nexit 0\n`,
      {
        mode: 0o755,
      },
    );
  store = openStore(":memory:");
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(marks, { recursive: true, force: true });
});

describe("Alca's own git is hardened", () => {
  it("a snapshot and a restore run no fsmonitor and no hook", () => {
    writeFileSync(join(dir, "a.txt"), "two\n");
    const snaps = new GitSnapshots({ store });
    const s = snaps.take(dir, "d1");
    expect(s).toBeDefined();
    writeFileSync(join(dir, "a.txt"), "three\n");
    snaps.restore(s?.repo as string, s?.ref as string);
    expect(planted("fsmonitor")).toBe(false);
    for (const h of [
      "pre-commit",
      "post-commit",
      "reference-transaction",
      "post-checkout",
      "post-index-change",
    ])
      expect(planted(h)).toBe(false);
  });

  it("the reviewer's status and diff run no fsmonitor, external diff, textconv or pager", async () => {
    writeFileSync(join(dir, "a.txt"), "two\n");
    writeFileSync(join(dir, "b.bin"), "changed\n");
    const m = await codingMaterial(dir, [], undefined);
    expect(m).toContain("a.txt");
    expect(m).toContain("+two");
    for (const n of ["fsmonitor", "extdiff", "textconv", "pager"]) expect(planted(n)).toBe(false);
  });

  it("control: plain git in the same repo does run the planted programs", () => {
    writeFileSync(join(dir, "b.bin"), "changed\n");
    git(dir, "diff");
    expect(planted("extdiff") || planted("textconv")).toBe(true);
    expect(planted("fsmonitor")).toBe(true);
  });
});
