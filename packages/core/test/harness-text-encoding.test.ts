import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { encodeMixed, matchLines } from "../src/harness/coding/eol.ts";
import { decodeText, isUtf8, loadText } from "../src/harness/coding/text.ts";
import { CodingTools, type HostTool } from "../src/index.ts";

/**
 * Research audit A2: files that are not UTF-8 are refused by the text tools
 * (read still shows them, with a note), and mixed line endings survive an
 * edit byte for byte outside the changed lines. Fictional files only.
 */

const root = mkdtempSync(join(tmpdir(), "alca-text-enc-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const sets: CodingTools[] = [];
afterEach(() => {
  for (const t of sets.splice(0)) t.closeAll();
});

let n = 0;
function setup(files: Record<string, Buffer | string>) {
  const dir = join(root, `p${n++}`);
  mkdirSync(dir, { recursive: true });
  for (const [p, body] of Object.entries(files)) writeFileSync(join(dir, p), body);
  const t = new CodingTools({ dirFor: () => dir, rg: false, spill: () => undefined });
  sets.push(t);
  const byName = new Map(t.tools().map((x) => [x.spec.name, x] as const));
  const run = (name: string, args: Record<string, unknown>) =>
    (byName.get(name) as HostTool).run(args, new AbortController().signal, {
      actionClass: "write",
      threadId: "thr_1",
      runId: "run_1",
      botId: "bot_1",
      workerId: "wkr_1",
    });
  const bytes = (p: string) => readFileSync(join(dir, p));
  return { run, bytes };
}

// "測試檔案\n名稱 = 範例\n" in Big5 (fictional content).
const BIG5 = Buffer.from([
  0xb4, 0xfa, 0xb8, 0xd5, 0xc0, 0xc9, 0xae, 0xd7, 0x0a, 0xa6, 0x57, 0xba, 0xd9, 0x20, 0x3d, 0x20, 0xbd, 0x64,
  0xa8, 0xd2, 0x0a,
]);

describe("non-UTF-8 files", () => {
  it("isUtf8 tells Big5 from UTF-8", () => {
    expect(isUtf8(BIG5)).toBe(false);
    expect(isUtf8(Buffer.from("測試 = ok\n", "utf8"))).toBe(true);
    expect(isUtf8(Buffer.from("\uFEFFplain\r\n", "utf8"))).toBe(true);
  });

  it("read shows a Big5 file with a note", async () => {
    const { run } = setup({ "big5.txt": BIG5 });
    const r = await run("read", { path: "big5.txt" });
    expect(r).toContain("不是 UTF-8");
    expect(r).toContain("bash");
  });

  it("edit refuses a Big5 file, tells the model to use bash and leaves the bytes alone", async () => {
    const { run, bytes } = setup({ "big5.txt": BIG5 });
    await run("read", { path: "big5.txt" });
    await expect(run("edit", { path: "big5.txt", edits: [{ old: " = ", new: " := " }] })).rejects.toThrow(
      /不是 UTF-8[\s\S]*bash/,
    );
    expect(bytes("big5.txt").equals(BIG5)).toBe(true);
  });

  it("write refuses to overwrite a Big5 file", async () => {
    const { run, bytes } = setup({ "big5.txt": BIG5 });
    await run("read", { path: "big5.txt" });
    await expect(run("write", { path: "big5.txt", content: "new\n" })).rejects.toThrow(/不是 UTF-8/);
    expect(bytes("big5.txt").equals(BIG5)).toBe(true);
  });

  it("apply_patch refuses an Update of a Big5 file", async () => {
    const { run, bytes } = setup({ "big5.txt": BIG5, "ok.txt": "a\n" });
    await run("read", { path: "big5.txt" });
    const patch = ["*** Begin Patch", "*** Update File: big5.txt", "@@", "-x", "+y", "*** End Patch"].join(
      "\n",
    );
    await expect(run("apply_patch", { patch })).rejects.toThrow(/不是 UTF-8[\s\S]*bash/);
    expect(bytes("big5.txt").equals(BIG5)).toBe(true);
  });

  it("a UTF-8 file still edits", async () => {
    const { run, bytes } = setup({ "u.txt": "名稱 = 範例\n" });
    await run("read", { path: "u.txt" });
    await run("edit", { path: "u.txt", edits: [{ old: "範例", new: "樣本" }] });
    expect(bytes("u.txt").toString("utf8")).toBe("名稱 = 樣本\n");
    expect(loadText(join(root, `p${n - 1}`, "u.txt")).utf8).toBe(true);
  });
});

describe("mixed line endings", () => {
  const MIXED = "one\r\ntwo\nthree\r\nfour\nfive\r\n";

  it("decodeText keeps the endings of a mixed file", () => {
    expect(decodeText(MIXED).endings).toEqual(["\r\n", "\n", "\r\n", "\n", "\r\n"]);
    expect(decodeText("a\nb\n").endings).toBeUndefined();
  });

  it("an edit of one line leaves every other line's bytes as they were", async () => {
    const { run, bytes } = setup({ "m.txt": MIXED });
    await run("read", { path: "m.txt" });
    await run("edit", { path: "m.txt", edits: [{ old: "three", new: "THREE" }] });
    expect(bytes("m.txt").toString("utf8")).toBe("one\r\ntwo\nTHREE\r\nfour\nfive\r\n");
  });

  it("an added line takes the common ending; the rest keep theirs", async () => {
    const { run, bytes } = setup({ "m.txt": MIXED });
    await run("read", { path: "m.txt" });
    await run("edit", { path: "m.txt", edits: [{ old: "two\n", new: "two\nnew\n" }] });
    // three CRLF vs two LF: CRLF is the common ending.
    expect(bytes("m.txt").toString("utf8")).toBe("one\r\ntwo\nnew\r\nthree\r\nfour\nfive\r\n");
  });

  it("apply_patch keeps the untouched lines' endings too", async () => {
    const { run, bytes } = setup({ "m.txt": MIXED });
    await run("read", { path: "m.txt" });
    const patch = [
      "*** Begin Patch",
      "*** Update File: m.txt",
      "@@",
      " four",
      "-five",
      "+FIVE",
      "*** End Patch",
    ].join("\n");
    await run("apply_patch", { patch });
    expect(bytes("m.txt").toString("utf8")).toBe("one\r\ntwo\nthree\r\nfour\nFIVE\r\n");
  });

  it("matchLines pairs moved and repeated lines; encodeMixed keeps their endings", () => {
    const a = ["x", "y", "z", "y", ""];
    const b = ["x", "q", "z", "y", ""];
    const m = matchLines(a, b);
    expect(m[0]).toBe(0);
    expect(m[1]).toBe(-1);
    expect(m[2]).toBe(2);
    expect(encodeMixed(b.join("\n"), a.join("\n"), ["\n", "\r\n", "\n", "\r\n"], "\r\n")).toBe(
      "x\nq\r\nz\ny\r\n",
    );
  });
});

describe("apply_patch on a file never read (research audit A1)", () => {
  const patch = (body: string) => `*** Begin Patch\n${body}\n*** End Patch`;
  it("is applied with a reminder to read first; a read file gets no reminder", async () => {
    const { run, bytes } = setup({ "a.ts": "one\ntwo\n", "b.ts": "x\ny\n" });
    const out = await run("apply_patch", { patch: patch("*** Update File: a.ts\n one\n-two\n+TWO") });
    expect(out).toContain("M a.ts");
    expect(out).toContain("修改前沒有用 read 讀過");
    expect(bytes("a.ts").toString("utf8")).toBe("one\nTWO\n");
    await run("read", { path: "b.ts" });
    const read = await run("apply_patch", { patch: patch("*** Update File: b.ts\n x\n-y\n+Y") });
    expect(read).not.toContain("沒有用 read 讀過");
  });
  it("a patch already applied says so without a reminder", async () => {
    const { run } = setup({ "c.ts": "keep\nnew\n" });
    const out = await run("apply_patch", { patch: patch("*** Update File: c.ts\n keep\n-old\n+new") });
    expect(out).toMatch(/^已套用/);
    expect(out).not.toContain("沒有用 read 讀過");
  });
});
