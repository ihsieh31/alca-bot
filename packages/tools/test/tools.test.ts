import { describe, expect, it } from "vitest";
import { canRunInParallel, DuplicateToolError, loopGuardVerdict, ToolRegistryImpl } from "../src/index.ts";

describe("path-aware scheduling", () => {
  it("parallelises disjoint work and serialises conflicting writes", () => {
    expect(canRunInParallel({ reads: ["/a/x"], writes: [] }, { reads: ["/a/x"], writes: [] })).toBe(true);
    expect(canRunInParallel({ reads: [], writes: ["/a"] }, { reads: ["/a/b/c"], writes: [] })).toBe(false);
    expect(canRunInParallel({ reads: ["/a/b"], writes: [] }, { reads: [], writes: ["/a/b/"] })).toBe(false);
    expect(canRunInParallel({ reads: [], writes: ["/a/b"] }, { reads: [], writes: ["/a/bc"] })).toBe(true);
  });
});

describe("loop guard", () => {
  const p = { warnAfterRepeats: 3, hardStopAfterRepeats: 6 };
  it("warns when attended and hard-stops when unattended", () => {
    expect(loopGuardVerdict(2, false, p)).toBe("ok");
    expect(loopGuardVerdict(3, false, p)).toBe("warn");
    expect(loopGuardVerdict(6, true, p)).toBe("warn");
    expect(loopGuardVerdict(6, false, p)).toBe("stop");
  });
});

describe("registry (progressive disclosure)", () => {
  const mk = (name: string, summary: string) => ({
    name,
    summary,
    inputSchema: { type: "object", properties: { x: { type: "string" } } },
    actionClass: "read" as const,
    source: "builtin" as const,
    run: async () => "ok",
  });
  it("searches by words and CJK bigrams, describes on demand, refuses duplicates", async () => {
    const reg = new ToolRegistryImpl().registerAll([
      mk("browser_click", "點擊網頁上的元素"),
      mk("browser_snapshot", "拍下網頁的語意快照"),
      mk("read_note", "讀一則筆記"),
    ]);
    expect((await reg.search("網頁")).map((t) => t.name)).toEqual(["browser_click", "browser_snapshot"]);
    expect((await reg.search("snapshot"))[0]?.name).toBe("browser_snapshot");
    expect(await reg.search("天氣")).toEqual([]);
    expect((await reg.search("")).length).toBe(3);
    const d = await reg.describe("read_note");
    expect(d).toMatchObject({ name: "read_note", actionClass: "read" });
    expect(d && "run" in d).toBe(false);
    expect(() => reg.register(mk("read_note", "x"))).toThrow(DuplicateToolError);
    expect(() => reg.register(mk("Bad Name", "x"))).toThrow();
  });
});
