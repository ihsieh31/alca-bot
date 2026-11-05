import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { CodingTools, findRipgrep, type HostTool } from "../src/index.ts";

/**
 * Plan §4: every coding tool on its own — read, edit, write, apply_patch,
 * grep, glob (with ripgrep and with the built-in walk), bash, bash_poll,
 * bash_input, bash_kill, todo. Fictional files only.
 */

const root = mkdtempSync(join(tmpdir(), "alca-coding-tools-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
// Every tool set a test makes has its shells ended after it, so no group outlives the test.
const toolSets: CodingTools[] = [];
afterEach(() => {
  for (const t of toolSets.splice(0)) t.closeAll();
});

let n = 0;
/** A fresh folder and the tools as one worker sees them (`worker` picks the read state / shells). */
function setup(files: Record<string, string> = {}, o: { rg?: string | false } = {}) {
  const dir = join(root, `p${n++}`);
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), body);
  }
  mkdirSync(dir, { recursive: true });
  const spills: string[] = [];
  const t = new CodingTools({
    dirFor: () => dir,
    ...(o.rg !== undefined ? { rg: o.rg } : {}),
    spill: (s) => {
      spills.push(s.body);
      return `spill_${spills.length}`;
    },
  });
  toolSets.push(t);
  const byName = new Map(t.tools().map((x) => [x.spec.name, x] as const));
  const run = (name: string, args: Record<string, unknown>, worker = "wkr_1", signal?: AbortSignal) =>
    (byName.get(name) as HostTool).run(args, signal ?? new AbortController().signal, {
      actionClass: "write",
      threadId: "thr_1",
      runId: "run_1",
      botId: "bot_1",
      workerId: worker,
    });
  const file = (p: string) => readFileSync(join(dir, p), "utf8");
  return { dir, t, run, file, spills, byName };
}

describe("read", () => {
  it("numbers lines, pages with offset / limit, lists folders, refuses binaries and escapes", async () => {
    const { run } = setup({ "a.txt": "one\ntwo\nthree\n", "bin.dat": "\0\0\0x", "sub/x.txt": "" });
    const r = await run("read", { path: "a.txt" });
    expect(r).toContain("1│one");
    expect(r).toContain("檔案結束（共 3 行）");
    expect(await run("read", { path: "a.txt", offset: 2, limit: 1 })).toContain("用 offset=3 繼續");
    expect(await run("read", { path: "." })).toContain("sub/");
    await expect(run("read", { path: "bin.dat" })).rejects.toThrow(/二進位/);
    await expect(run("read", { path: "../escape.txt" })).rejects.toThrow(/工作資料夾外/);
    await expect(run("read", { path: "a.tx" })).rejects.toThrow(/找不到檔案/);
  });
  it("brings a sub-folder's AGENTS.md the first time something there is read", async () => {
    const { run } = setup({ "pkg/AGENTS.md": "pkg 的規則", "pkg/a.ts": "x\n", "pkg/b.ts": "y\n" });
    expect(await run("read", { path: "pkg/a.ts" })).toContain("pkg 的規則");
    expect(await run("read", { path: "pkg/b.ts" })).not.toContain("pkg 的規則");
  });
});

describe("edit", () => {
  it("needs a read first, keeps CRLF, reads back", async () => {
    const { run, file } = setup({ "a.ts": "export const a = 1;\r\nexport const b = 2;\r\n" });
    await expect(run("edit", { path: "a.ts", edits: [{ old: "a = 1", new: "a = 10" }] })).rejects.toThrow(
      /先用 read/,
    );
    await run("read", { path: "a.ts" });
    expect(await run("edit", { path: "a.ts", edits: [{ old: "a = 1", new: "a = 10" }] })).toContain(
      "已回讀確認",
    );
    expect(file("a.ts")).toBe("export const a = 10;\r\nexport const b = 2;\r\n");
  });
  it("an edit already in the file is reported as applied, not an error, and writes nothing", async () => {
    const { run, file } = setup({ "a.ts": "const limit = 10;\n" });
    const r = await run("edit", {
      path: "a.ts",
      edits: [{ old: "const limit = 5;", new: "const limit = 10;" }],
    });
    expect(r).toMatch(/^已套用/);
    expect(file("a.ts")).toBe("const limit = 10;\n");
  });
  it("a file changed since the read is refused", async () => {
    const { run, dir } = setup({ "a.ts": "one\n" });
    await run("read", { path: "a.ts" });
    writeFileSync(join(dir, "a.ts"), "changed\n");
    await expect(run("edit", { path: "a.ts", edits: [{ old: "changed", new: "x" }] })).rejects.toThrow(
      /已被修改/,
    );
  });
  it("two workers editing one file: the lock queues them and the second sees the first's change", async () => {
    const { run, file } = setup({ "shared.ts": "a = 1;\nb = 1;\n" });
    await run("read", { path: "shared.ts" }, "wkr_a");
    await run("read", { path: "shared.ts" }, "wkr_b");
    const [x, y] = await Promise.allSettled([
      run("edit", { path: "shared.ts", edits: [{ old: "a = 1;", new: "a = 2;" }] }, "wkr_a"),
      run("edit", { path: "shared.ts", edits: [{ old: "b = 1;", new: "b = 2;" }] }, "wkr_b"),
    ]);
    expect(x.status).toBe("fulfilled");
    expect(y.status).toBe("rejected");
    expect(String((y as PromiseRejectedResult).reason)).toMatch(/已被修改/);
    expect(file("shared.ts")).toBe("a = 2;\nb = 1;\n");
  });
});

describe("write", () => {
  it("creates, refuses to overwrite an unread file, reports an identical write as applied", async () => {
    const { run, file, dir } = setup();
    expect(await run("write", { path: "src/new.ts", content: "x\n" })).toMatch(/已建立/);
    writeFileSync(join(dir, "other.ts"), "y\n");
    await expect(run("write", { path: "other.ts", content: "z" })).rejects.toThrow(/先 read/);
    expect(await run("write", { path: "other.ts", content: "y\n" })).toMatch(/^已套用/);
    await run("read", { path: "other.ts" });
    expect(await run("write", { path: "other.ts", content: "z\n" })).toMatch(/已覆寫/);
    expect(file("other.ts")).toBe("z\n");
  });
});

describe("apply_patch", () => {
  const patch = (body: string) => `*** Begin Patch\n${body}\n*** End Patch`;
  it("adds, updates, moves and deletes in one go", async () => {
    const { run, file } = setup({ "p.ts": "one\ntwo\n", "gone.ts": "bye\n" });
    const out = await run("apply_patch", {
      patch: patch(
        "*** Add File: added.ts\n+hello\n*** Update File: p.ts\n*** Move to: q.ts\n one\n-two\n+TWO\n*** Delete File: gone.ts",
      ),
    });
    expect(out).toContain("A added.ts");
    expect(out).toContain("R p.ts -> q.ts");
    expect(file("q.ts")).toBe("one\nTWO\n");
    await expect(run("read", { path: "gone.ts" })).rejects.toThrow(/找不到/);
  });
  it("the same patch twice: the second time it is already applied", async () => {
    const { run, file } = setup({ "c.ts": "keep\nold\n" });
    const p = patch("*** Update File: c.ts\n keep\n-old\n+new\n*** Add File: n.ts\n+n");
    expect(await run("apply_patch", { patch: p })).toContain("M c.ts");
    expect(await run("apply_patch", { patch: p })).toMatch(/^已套用/);
    expect(file("c.ts")).toBe("keep\nnew\n");
  });
  it("an Update of a file changed since the worker read it is refused (nothing written)", async () => {
    const { run, file, dir } = setup({ "s.ts": "a\nb\n", "t.ts": "x\n" });
    await run("read", { path: "s.ts" });
    writeFileSync(join(dir, "s.ts"), "a\nb\nc\n");
    await expect(
      run("apply_patch", {
        patch: patch("*** Update File: t.ts\n-x\n+y\n*** Update File: s.ts\n a\n-b\n+B"),
      }),
    ).rejects.toThrow(/已被修改/);
    expect(file("t.ts")).toBe("x\n");
  });
  it("a failing part leaves every file as it was", async () => {
    const { run, file } = setup({ "u.ts": "1\n" });
    await expect(
      run("apply_patch", {
        patch: patch("*** Update File: u.ts\n-1\n+2\n*** Update File: missing.ts\n-a\n+b"),
      }),
    ).rejects.toThrow(/找不到檔案/);
    expect(file("u.ts")).toBe("1\n");
  });
});

const engines = [
  ["ripgrep", findRipgrep()],
  ["the built-in walk", false],
] as const;

for (const [label, rg] of engines) {
  describe.skipIf(label === "ripgrep" && !rg)(`grep and glob (${label})`, () => {
    const files = {
      ".gitignore": "dist/\n*.log\n",
      "src/find.ts": "const needle = 1;\nconst other = 2;\n",
      "src/deep/more.ts": "needle again\n",
      "dist/find.js": "needle in build output\n",
      "debug.log": "needle in a log\n",
      "notes.md": "Needle in prose\n",
    };
    it("grep: lines, files, count, ignoreCase; .gitignore is honoured", async () => {
      const { run } = setup(files, { rg });
      const lines = await run("grep", { pattern: "needle" });
      expect(lines).toContain("src/find.ts:1:const needle = 1;");
      expect(lines).toContain("src/deep/more.ts:1:");
      expect(lines).not.toContain("dist/");
      expect(lines).not.toContain("debug.log");
      expect(lines).not.toContain("notes.md");
      expect(await run("grep", { pattern: "needle", ignoreCase: true, outputMode: "files" })).toContain(
        "notes.md",
      );
      expect(await run("grep", { pattern: "const", outputMode: "count", glob: "*.ts" })).toContain(
        "src/find.ts:2",
      );
      expect(await run("grep", { pattern: "nothing-here-xyz" })).toBe("沒有符合的結果。");
    });
    it("grep: results are capped and say so", async () => {
      const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`m/f${i}.txt`, "hit\n"]));
      const { run } = setup(many, { rg });
      const out = await run("grep", { pattern: "hit", limit: 5 });
      expect(out.split("\n").filter((l) => l.includes(":1:hit"))).toHaveLength(5);
      expect(out).toContain("已達 5 筆上限");
    });
    it("glob: by pattern, inside a path, .gitignore honoured, capped", async () => {
      const { run } = setup(files, { rg });
      const ts = await run("glob", { pattern: "**/*.ts" });
      expect(ts).toContain("src/find.ts");
      expect(ts).toContain("src/deep/more.ts");
      expect(await run("glob", { pattern: "*.js" })).toBe("沒有符合的檔案。");
      expect(await run("glob", { pattern: "*.ts", path: "src/deep" })).toBe("src/deep/more.ts");
      expect(await run("glob", { pattern: "**/*.ts", limit: 1 })).toContain("顯示前 1 筆");
      await expect(run("glob", { pattern: "*", path: "src/find.ts" })).rejects.toThrow(/必須是目錄/);
    });
  });
}

describe("bash, bash_poll, bash_input, bash_kill", () => {
  it("bash: a non-zero exit is a structured result, not a tool error", async () => {
    const { run } = setup();
    const ok = await run("bash", { command: "echo hi" });
    expect(ok).toContain("status: exited");
    expect(ok).toContain("exit_code: 0");
    const red = await run("bash", { command: "echo failing >&2; exit 3" });
    expect(red).toContain("exit_code: 3");
    expect(red).toContain("failing");
    expect(red).toContain("不是工具錯誤");
  });
  it("bash: runs in the folder (workdir inside it), never outside", async () => {
    const { run, dir } = setup({ "sub/x.txt": "" });
    expect(await run("bash", { command: "pwd" })).toContain(dir);
    expect(await run("bash", { command: "ls", workdir: "sub" })).toContain("x.txt");
    await expect(run("bash", { command: "ls", workdir: "../.." })).rejects.toThrow(/工作資料夾外/);
  });
  it("bash: the timeout ends it; output over 50 KB is spilled", async () => {
    const { run, spills } = setup();
    expect(await run("bash", { command: "sleep 5", timeoutMs: 200 })).toContain("status: timeout");
    const big = await run("bash", {
      command: "i=0; while [ $i -lt 3000 ]; do echo row-$i-abcdefghijabcdefghijabcdefghij; i=$((i+1)); done",
    });
    expect(big).toContain("全文：spill_1");
    expect(spills[0]).toContain("row-2999-");
  });
  it("bash: a stop (abort) ends the tree", async () => {
    const { run } = setup();
    const c = new AbortController();
    const p = run("bash", { command: "sleep 30" }, "wkr_1", c.signal);
    setTimeout(() => c.abort(), 150);
    expect(await p).toContain("status: stopped");
  });
  it("background + bash_poll; bash_input feeds stdin; bash_kill ends the tree", async () => {
    const { run, t } = setup();
    const bg = await run("bash", { command: "sleep 0.3; echo later", background: true });
    const id = Number(/session: (\d+)/.exec(bg)?.[1]);
    expect(id).toBeGreaterThan(9999);
    expect(await run("bash_poll", { sessionId: id, yieldMs: 5000 })).toContain("later");
    const cat = await run("bash", { command: "cat", background: true });
    const catId = Number(/session: (\d+)/.exec(cat)?.[1]);
    expect(await run("bash_input", { sessionId: catId, input: "echoed back\n" })).toContain("echoed back");
    expect(await run("bash_kill", { sessionId: catId })).toContain("整個程序樹");
    expect(await run("bash_poll", { sessionId: catId, yieldMs: 3000 })).toMatch(/status: killed/);
    await expect(run("bash_poll", { sessionId: 1 })).rejects.toThrow(/找不到 session/);
    const sleeper = await run("bash", { command: "sleep 30", background: true });
    expect(/session: (\d+)/.test(sleeper)).toBe(true);
    expect(t.running("wkr_1")).toBe(1);
    t.release("wkr_1");
    expect(t.running("wkr_1")).toBe(0);
  });
  it("the gate sees the command: inspect classifies it", async () => {
    const { byName } = setup();
    const bash = byName.get("bash") as HostTool;
    const signal = new AbortController().signal;
    const cls = async (command: string) =>
      (await bash.inspect?.({ command }, { signal, threadId: "t", botId: "b" }))?.actionClass;
    expect(await cls("git push origin main")).toBe("publish");
    expect(await cls("rm -rf /tmp/elsewhere")).toBe("delete");
    expect(await cls("curl -X POST https://example.com")).toBe("send");
    expect(await cls("npm test")).toBe("write");
    const input = byName.get("bash_input") as HostTool;
    expect(
      (await input.inspect?.({ input: "git push\n" }, { signal, threadId: "t", botId: "b" }))?.actionClass,
    ).toBe("publish");
  });
});

describe("todo", () => {
  it("keeps one in progress; the host can read the snapshot for the compaction flush", async () => {
    const { run, t } = setup();
    await expect(
      run("todo", {
        todos: [
          { content: "a", status: "in_progress" },
          { content: "b", status: "in_progress" },
        ],
      }),
    ).rejects.toThrow(/只能有一個/);
    expect(
      await run("todo", {
        todos: [
          { content: "重現錯誤", status: "completed" },
          { content: "修正", status: "in_progress" },
          { content: "跑測試", status: "pending" },
        ],
      }),
    ).toContain("完成 1 / 共 3");
    expect(t.todos("wkr_1")).toHaveLength(3);
    expect(t.todoSnapshot("wkr_1")).toContain("[>] 修正");
    t.release("wkr_1");
    expect(t.todoSnapshot("wkr_1")).toBe("");
  });
});
