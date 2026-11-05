import { describe, expect, it } from "vitest";
import { threadTitle } from "../src/thread-title.ts";

describe("thread titles (mac test 2026-11-04: a fixed cut gave 「用瀏覽器打開 https://example.c」)", () => {
  it("keeps a short message whole and reads a URL as its host", () => {
    expect(threadTitle("嗨")).toBe("嗨");
    expect(threadTitle("用瀏覽器打開 https://example.com 讀出頁面標題，只回覆標題")).toBe(
      "用瀏覽器打開 example.com 讀出頁面標題，只回覆標題",
    );
    expect(threadTitle("看一下 https://www.example.org/a/b?c=1#d")).toBe("看一下 example.org");
    expect(threadTitle("  \n第一行\n第二行")).toBe("第一行");
    expect(threadTitle("   ")).toBe("新對話");
  });

  it("cuts a long one at a clause break and marks the cut", () => {
    const long = "請幫我比較三家店的藍牙耳機價格與保固，整理成一份給主管看的報告，明天早上前寄給我";
    const t = threadTitle(long);
    expect(t).toBe("請幫我比較三家店的藍牙耳機價格與保固，整理成一份給主管看的報告…");
    expect([...t].length).toBeLessThanOrEqual(33);
    const noBreak = "一".repeat(50);
    expect(threadTitle(noBreak)).toBe(`${"一".repeat(32)}…`);
  });
});
