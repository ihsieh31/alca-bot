import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  applyChunks,
  BashSessions,
  cleanEnv,
  cleanOutput,
  decodeText,
  editApplied,
  globToRegex,
  loadInstructions,
  lockedFiles,
  nestedInstructions,
  parseIgnore,
  parsePatch,
  planEdits,
  ReadState,
  readBack,
  runCommand,
  saveText,
  sha256,
  WriteVerifyError,
  walkFiles,
  withFileLock,
} from "../src/index.ts";

/** Plan §4: the coding harness's library parts, one block per file. Fictional files only. */

const root = mkdtempSync(join(tmpdir(), "alca-coding-lib-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const updateChunks = (patch: string) => {
  const ops = parsePatch(patch);
  if (typeof ops === "string" || ops[0]?.kind !== "update") throw new Error(String(ops));
  return ops[0].chunks;
};

describe("match.ts — edit matching", () => {
  const src = "function a() {\n  return 1;  \n}\n\nconst q = “hi”;\n";
  it("exact, unique, several edits at once", () => {
    const r = planEdits(
      src,
      [
        { old: "return 1;", new: "return 2;" },
        { old: "function a", new: "function b" },
      ],
      "f.ts",
    );
    expect(typeof r !== "string" && r.text).toContain("function b() {\n  return 2;  \n}");
  });
  it("trailing blanks, Unicode quotes, indentation, escapes — loosened in that order", () => {
    const trail = planEdits(src, [{ old: "  return 1;\n}", new: "  return 3;\n}" }], "f");
    expect(typeof trail !== "string" && trail.loose[0]?.level).toBe("trailing");
    const uni = planEdits(src, [{ old: 'const q = "hi";', new: 'const q = "yo";' }], "f");
    expect(typeof uni !== "string" && uni.loose[0]?.level).toBe("unicode");
    const ind = planEdits(
      "if (x) {\n    go();\n    stop();\n}\n",
      [{ old: "go();\nstop();", new: "go();\nwait();\nstop();" }],
      "f",
    );
    expect(typeof ind !== "string" && ind.text).toBe("if (x) {\n    go();\n    wait();\n    stop();\n}\n");
  });
  it("refuses an ambiguous, overlapping, missing or no-op edit", () => {
    expect(planEdits("x\nx\n", [{ old: "x", new: "y" }], "f")).toMatch(/出現 2 次/);
    expect(
      planEdits(
        "abcdef",
        [
          { old: "abc", new: "1" },
          { old: "cde", new: "2" },
        ],
        "f",
      ),
    ).toMatch(/重疊/);
    expect(planEdits("hello world", [{ old: "hello wrld", new: "x" }], "f")).toMatch(/找不到/);
    expect(planEdits("a", [{ old: "a", new: "a" }], "f")).toMatch(/相同/);
  });
  it("already applied: old gone and new there is not an error, and nothing changes", () => {
    const done = "const limit = 10;\n";
    expect(editApplied(done, { old: "const limit = 5;", new: "const limit = 10;" })).toBe(true);
    const r = planEdits(done, [{ old: "const limit = 5;", new: "const limit = 10;" }], "f");
    expect(r).toMatchObject({ text: done, replacements: 0, applied: [0] });
  });
  it("already applied when new contains old: a retry must not apply twice", () => {
    const once = "import a;\nimport b;\n";
    const e = { old: "import a;", new: "import a;\nimport b;" };
    expect(editApplied(once, e)).toBe(true);
    expect(planEdits(once, [e], "f")).toMatchObject({ text: once, applied: [0] });
    // Not applied yet: old there, new not → a normal edit.
    expect(editApplied("import a;\n", e)).toBe(false);
  });
  it("one edit applied and one not: only the second changes the text", () => {
    const r = planEdits(
      "x = 2;\ny = 1;\n",
      [
        { old: "x = 1;", new: "x = 2;" },
        { old: "y = 1;", new: "y = 2;" },
      ],
      "f",
    );
    expect(r).toMatchObject({ text: "x = 2;\ny = 2;\n", applied: [0], replacements: 1 });
  });
});

describe("patch.ts — apply_patch parsing and chunks", () => {
  it("parses with line numbers in errors", () => {
    expect(parsePatch("hello")).toMatch(/第 1 行/);
    expect(parsePatch("*** Begin Patch\n*** Frob File: x\n*** End Patch")).toMatch(/不是有效的區段標頭/);
  });
  it("update with an anchor; context keeps the file's own text", () => {
    const chunks = updateChunks(
      "*** Begin Patch\n*** Update File: a.ts\n@@ function b\n   const x = 1;\n-  return x;\n+  return x + 1;\n*** End Patch",
    );
    const r = applyChunks(
      "function a\n  return x;\nfunction b\n  const x = 1;   \n  return x;\n",
      chunks,
      "a.ts",
    );
    expect(r).toEqual({
      text: "function a\n  return x;\nfunction b\n  const x = 1;   \n  return x + 1;\n",
      applied: 0,
    });
  });
  it("an ambiguous chunk without an anchor is refused", () => {
    const chunks = updateChunks("*** Begin Patch\n*** Update File: a\n-x\n+y\n*** End Patch");
    expect(applyChunks("x\nx\n", chunks, "a")).toMatch(/多個符合位置/);
  });
  it("a chunk already in the file counts as applied, not as an error", () => {
    const chunks = updateChunks("*** Begin Patch\n*** Update File: a\n keep\n-old\n+new\n*** End Patch");
    expect(applyChunks("keep\nnew\n", chunks, "a")).toEqual({ text: "keep\nnew\n", applied: 1 });
    // Neither old nor new there: still an error.
    expect(applyChunks("keep\nother\n", chunks, "a")).toMatch(/找不到/);
  });
  it("an insertion after an anchor that is already there is applied once", () => {
    const chunks = updateChunks("*** Begin Patch\n*** Update File: a\n@@ start\n+added\n*** End Patch");
    const once = applyChunks("start\nend\n", chunks, "a");
    expect(once).toEqual({ text: "start\nadded\nend\n", applied: 0 });
    expect(applyChunks("start\nadded\nend\n", chunks, "a")).toEqual({
      text: "start\nadded\nend\n",
      applied: 1,
    });
  });
});

describe("text.ts — encoding, write with read-back, read state", () => {
  it("keeps BOM and the majority line ending", () => {
    expect(decodeText("\uFEFFa\r\nb\r\nc\n")).toMatchObject({
      bom: true,
      eol: "\r\n",
      mixedEol: true,
      text: "a\nb\nc\n",
    });
  });
  it("saveText writes atomically, keeps the format and returns the hash it read back", () => {
    const p = join(root, "crlf.txt");
    const hash = saveText(p, "a\nb\n", { bom: true, eol: "\r\n" });
    const bytes = readFileSync(p);
    expect(bytes.toString("utf8")).toBe("\uFEFFa\r\nb\r\n");
    expect(hash).toBe(sha256(bytes));
  });
  it("a read-back that differs from what was written is an error", () => {
    const p = join(root, "raced.txt");
    const real = readBack.read;
    readBack.read = () => Buffer.from("someone else");
    try {
      expect(() => saveText(p, "mine\n", { bom: false, eol: "\n" })).toThrow(WriteVerifyError);
    } finally {
      readBack.read = real;
    }
  });
  it("ReadState: unread → refuse; changed since → stale; stale() ignores files never read", () => {
    const p = join(root, "state.txt");
    writeFileSync(p, "one\n");
    const s = new ReadState();
    expect(s.check(p, "state.txt")).toMatch(/先用 read/);
    expect(s.stale(p, "state.txt")).toBeUndefined();
    s.note(p);
    expect(s.check(p, "state.txt")).toBeUndefined();
    writeFileSync(p, "two\n");
    expect(s.check(p, "state.txt")).toMatch(/已被修改/);
    expect(s.stale(p, "state.txt")).toMatch(/已被修改/);
  });
});

describe("lock.ts — withFileLock", () => {
  it("serializes writers of one file; other files run alongside; the table empties", async () => {
    const order: string[] = [];
    const slow = (tag: string, ms: number) => async () => {
      order.push(`${tag}+`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`${tag}-`);
    };
    const f = join(root, "locked.txt");
    await Promise.all([
      withFileLock(f, slow("a", 40)),
      withFileLock(f, slow("b", 1)),
      withFileLock(join(root, "other.txt"), slow("c", 1)),
    ]);
    expect(order.indexOf("a-")).toBeLessThan(order.indexOf("b+"));
    expect(order.indexOf("c-")).toBeLessThan(order.indexOf("a-"));
    expect(lockedFiles()).toBe(0);
  });
  it("several files are locked in one order (no deadlock) and a throw releases them", async () => {
    const a = join(root, "la");
    const b = join(root, "lb");
    await Promise.all([withFileLock([a, b], () => 1), withFileLock([b, a], () => 2)]);
    await expect(
      withFileLock(a, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await withFileLock(a, () => "free")).toBe("free");
  });
});

describe("ignore.ts — the built-in walk honours .gitignore", () => {
  it("globs: *, **, ?, braces, classes", () => {
    expect(globToRegex("*.ts", false).test("src/a.ts")).toBe(true);
    expect(globToRegex("src/**/*.ts", true).test("src/x/y/a.ts")).toBe(true);
    expect(globToRegex("src/**/*.ts", true).test("lib/a.ts")).toBe(false);
    expect(globToRegex("*.{ts,js}", false).test("a.js")).toBe(true);
    expect(globToRegex("file?.[ch]", false).test("file1.c")).toBe(true);
  });
  it("negation, folder-only and anchored lines; deeper files add rules", () => {
    const repo = join(root, "ign");
    mkdirSync(join(repo, ".git", "info"), { recursive: true });
    mkdirSync(join(repo, "build"), { recursive: true });
    mkdirSync(join(repo, "src", "gen"), { recursive: true });
    mkdirSync(join(repo, "logs"), { recursive: true });
    writeFileSync(join(repo, ".gitignore"), "build/\n*.log\n!keep.log\n/top.txt\n");
    writeFileSync(join(repo, ".git", "info", "exclude"), "secret.env\n");
    writeFileSync(join(repo, "build", "out.js"), "");
    writeFileSync(join(repo, "logs", "a.log"), "");
    writeFileSync(join(repo, "logs", "keep.log"), "");
    writeFileSync(join(repo, "top.txt"), "");
    writeFileSync(join(repo, "src", "top.txt"), "");
    writeFileSync(join(repo, "secret.env"), "");
    writeFileSync(join(repo, "src", ".gitignore"), "gen/\n");
    writeFileSync(join(repo, "src", "gen", "x.ts"), "");
    writeFileSync(join(repo, "src", "a.ts"), "");
    const files = walkFiles(repo, repo)
      .files.map((f) => f.slice(repo.length + 1))
      .sort();
    expect(files).toEqual([".gitignore", "logs/keep.log", "src/.gitignore", "src/a.ts", "src/top.txt"]);
    expect(walkFiles(repo, repo, 2)).toMatchObject({ capped: true });
    expect(parseIgnore("# c\n\n\\#lit\n", "")).toHaveLength(1);
  });
});

describe("project.ts — AGENTS.md layered from the repo root", () => {
  const repo = join(root, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(join(repo, "pkg", "deep"), { recursive: true });
  writeFileSync(join(repo, "AGENTS.md"), "根目錄規則");
  writeFileSync(join(repo, "pkg", "CLAUDE.md"), "pkg 規則");
  writeFileSync(join(repo, "pkg", "deep", "AGENTS.md"), "deep 規則");

  it("loads root → work folder, shallow first, within 32 KiB", () => {
    const l = loadInstructions(join(repo, "pkg"));
    expect(l.text.indexOf("根目錄規則")).toBeLessThan(l.text.indexOf("pkg 規則"));
    expect(l.text).not.toContain("deep 規則");
    expect(l.used).toBeGreaterThan(0);
    expect(loadInstructions(join(repo, "pkg"), 10).text).toMatch(/已截斷/);
  });
  it("a deeper folder's file comes once, when something there is read, within what is left", () => {
    const budget = { seen: new Set<string>(), used: 0 };
    const first = nestedInstructions(join(repo, "pkg", "deep", "x.ts"), join(repo, "pkg"), budget);
    expect(first).toContain("deep 規則");
    expect(nestedInstructions(join(repo, "pkg", "deep", "y.ts"), join(repo, "pkg"), budget)).toBe("");
    const full = { seen: new Set<string>(), used: 32 * 1024 };
    expect(nestedInstructions(join(repo, "pkg", "deep", "x.ts"), join(repo, "pkg"), full)).toMatch(
      /32KiB 上限/,
    );
  });
});

describe("bash.ts — sessions", () => {
  // Every session a test opens is closed after it, so no group outlives the test.
  const opened: BashSessions[] = [];
  const sessions = () => {
    const b = new BashSessions();
    opened.push(b);
    return b;
  };
  afterEach(() => {
    for (const b of opened.splice(0)) b.closeAll();
  });
  it("secret-looking variables never reach the command; output is cleaned", () => {
    const env = cleanEnv({ PATH: "/bin", MY_API_KEY: "s3cret", GITHUB_TOKEN: "t", LANG: "C" }, 12345);
    expect(env.MY_API_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.PAGER).toBe("cat");
    expect(cleanOutput("\x1b[31mred\x1b[0m\n10%\r50%\r100%")).toBe("red\n100%");
  });
  it("a non-zero exit is a structured result, not an error", async () => {
    const b = sessions();
    const r = await b.exec({ command: "echo out; echo err >&2; exit 3", cwd: root });
    expect(r).toMatchObject({ status: "exited", exitCode: 3, running: false });
    expect(r.text).toContain("exit_code: 3");
    expect(r.text).toContain("out");
    expect(r.text).toContain("err");
  });
  it("waits to the end by default; background returns a session to poll", async () => {
    const b = sessions();
    const fg = await b.exec({ command: "sleep 0.4; echo fg-done", cwd: root });
    expect(fg).toMatchObject({ status: "exited", exitCode: 0 });
    const bg = await b.exec({ command: "sleep 0.4; echo bg-done", cwd: root, background: true });
    expect(bg.running).toBe(true);
    const later = await b.poll({ sessionId: bg.sessionId as number, yieldMs: 5000 });
    expect(later.text).toContain("bg-done");
    expect(later.exitCode).toBe(0);
    b.closeAll();
  });
  it("the timeout ends the tree and says so", async () => {
    const b = sessions();
    const r = await b.exec({ command: "sleep 5", cwd: root, timeoutMs: 200 });
    expect(r).toMatchObject({ status: "timeout", exitCode: null });
    b.closeAll();
  });
  it("output over 50 KB is cut and spilled whole", async () => {
    const b = sessions();
    let kept = "";
    const r = await b.exec({
      command:
        "i=0; while [ $i -lt 3000 ]; do echo line-$i-0123456789012345678901234567890; i=$((i+1)); done",
      cwd: root,
      spill: (full) => {
        kept = full;
        return "spill_1";
      },
    });
    expect(r.truncated).toBe(true);
    expect(r.spilled).toBe("spill_1");
    expect(r.text).toContain("全文：spill_1");
    expect(kept).toContain("line-2999-");
    expect(Buffer.byteLength(r.text)).toBeLessThan(60 * 1024);
  });
  it("runCommand (the host's checks) stops the whole tree on abort", async () => {
    const c = new AbortController();
    const pidFile = join(root, "bg.pid");
    const running = runCommand({
      command: `sh -c 'sleep 30 & echo $! > ${pidFile}; wait'`,
      cwd: root,
      signal: c.signal,
    });
    for (let i = 0; i < 200 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 10));
    c.abort();
    const r = await running;
    expect(r).toMatchObject({ exitCode: null, stopped: true });
  });
});
