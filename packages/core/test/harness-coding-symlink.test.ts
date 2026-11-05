import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { CodingTools, findRipgrep, type HostTool } from "../src/index.ts";

/**
 * Mac test B1: a work folder reached through a symlink (macOS tmpdir() is
 * /var/folders/… → /private/var/folders/…). Linux CI has no such link, so
 * this test makes one: the worker's folder is a link, deeper than its
 * target, to a real folder. Shown paths must be relative to the folder,
 * ripgrep must find it, sub-folder AGENTS.md must load, and a link inside
 * the folder that leads out must still be refused (nothing is widened).
 * Fictional files only.
 */

const base = mkdtempSync(join(tmpdir(), "alca-coding-link-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const toolSets: CodingTools[] = [];
afterEach(() => {
  for (const t of toolSets.splice(0)) t.closeAll();
});

let n = 0;
/** A real folder with `files`, and the tools pointed at a link to it three levels deeper. */
function linked(files: Record<string, string>, rg: string | false) {
  const real = join(base, `real${n}`);
  const linkParent = join(base, `l${n}`, "a", "b");
  n++;
  mkdirSync(real, { recursive: true });
  mkdirSync(linkParent, { recursive: true });
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(real, p, ".."), { recursive: true });
    writeFileSync(join(real, p), body);
  }
  const link = join(linkParent, "work");
  symlinkSync(real, link, "dir");
  const t = new CodingTools({ dirFor: () => link, rg, spill: () => undefined });
  toolSets.push(t);
  const byName = new Map(t.tools().map((x) => [x.spec.name, x] as const));
  const run = (name: string, args: Record<string, unknown>) =>
    (byName.get(name) as HostTool).run(args, new AbortController().signal, {
      actionClass: "write",
      threadId: "thr_1",
      runId: "run_1",
      botId: "bot_1",
      workerId: "wkr_1",
    });
  return { real, link, t, run, file: (p: string) => readFileSync(join(real, p), "utf8") };
}

const patch = (body: string) => `*** Begin Patch\n${body}\n*** End Patch`;
const engines = [
  ["ripgrep", findRipgrep()],
  ["the built-in walk", false],
] as const;

describe("a work folder reached through a symlink", () => {
  it("read: the path is shown inside the folder and a sub-folder's AGENTS.md loads", async () => {
    const { run } = linked({ "pkg/AGENTS.md": "pkg 的規則", "pkg/a.ts": "x\n" }, false);
    const out = await run("read", { path: "pkg/a.ts" });
    expect(out).toContain('<file path="pkg/a.ts"');
    expect(out).toContain("pkg 的規則");
    expect(out).not.toContain("../");
  });

  it("apply_patch: adds, moves and updates with paths shown inside the folder", async () => {
    const { run, file } = linked({ "p.ts": "one\ntwo\n" }, false);
    const out = await run("apply_patch", {
      patch: patch(
        "*** Add File: added.ts\n+hello\n*** Update File: p.ts\n*** Move to: q.ts\n one\n-two\n+TWO",
      ),
    });
    expect(out).toContain("A added.ts");
    expect(out).toContain("R p.ts -> q.ts");
    expect(out).not.toContain("../");
    expect(file("q.ts")).toBe("one\nTWO\n");
  });

  for (const [label, rg] of engines) {
    it.skipIf(label === "ripgrep" && !rg)(
      `grep and glob (${label}) find the folder and show its paths`,
      async () => {
        const { run } = linked(
          { "src/find.ts": "const needle = 1;\n", "src/deep/more.ts": "needle again\n" },
          rg,
        );
        const lines = await run("grep", { pattern: "needle" });
        expect(lines).toContain("src/find.ts:1:const needle = 1;");
        expect(lines).toContain("src/deep/more.ts:1:");
        expect(await run("grep", { pattern: "needle", path: "src/deep" })).toContain("src/deep/more.ts:1:");
        expect(await run("glob", { pattern: "*.ts", path: "src/deep" })).toBe("src/deep/more.ts");
        expect(await run("glob", { pattern: "**/*.ts" })).not.toContain("../");
      },
    );
  }

  it("AGENTS.md layers from the repo root down to the linked folder, each file once", async () => {
    const { real, link, t, run } = linked(
      {
        "AGENTS.md": "根目錄的規則",
        "app/AGENTS.md": "app 的規則",
        "app/lib/AGENTS.md": "lib 的規則",
        "app/lib/x.ts": "x\n",
      },
      false,
    );
    mkdirSync(join(real, ".git"));
    const text = t.instructions("wkr_1", join(link, "app"));
    expect(text).toContain('source="AGENTS.md" scope="project"');
    expect(text).toContain('source="app/AGENTS.md" scope="directory"');
    expect(text.indexOf("根目錄的規則")).toBeLessThan(text.indexOf("app 的規則"));
    // The first read below brings only the deeper file: the ones in the task are not repeated.
    const out = await run("read", { path: "app/lib/x.ts" });
    expect(out).toContain("lib 的規則");
    expect(out).not.toContain("app 的規則");
  });

  it("nothing is widened: a link inside the folder that leads out is still refused", async () => {
    const { real, run } = linked({ "a.ts": "x\n" }, false);
    const outside = join(base, `outside${n}`);
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.txt"), "no\n");
    symlinkSync(outside, join(real, "escape"), "dir");
    await expect(run("read", { path: "escape/secret.txt" })).rejects.toThrow(/工作資料夾外/);
    await expect(run("read", { path: "../../../../outside/secret.txt" })).rejects.toThrow(/工作資料夾外/);
    await expect(run("apply_patch", { patch: patch("*** Add File: escape/new.txt\n+x") })).rejects.toThrow(
      /工作資料夾外/,
    );
  });
});
