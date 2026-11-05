// G2 batch 5 (R9.3): text the core sends to the UI. The core sends the Chinese
// text (tSource); errorBody adds its key and params; the UI shows coreText().
import { afterEach, describe, expect, it } from "vitest";
import { codeOf, coreText, setLocale, tSource } from "../src/i18n/index.ts";
import { zhHantTW } from "../src/i18n/zh-Hant-TW.ts";

afterEach(() => setLocale("zh-Hant-TW"));

describe("core text", () => {
  it("tSource is Chinese whatever the page's language", () => {
    setLocale("en");
    expect(tSource("core.common.noBot")).toBe("沒有這個 bot");
    expect(tSource("core.team.nameTaken", { name: "小幫手" })).toBe("已經有叫「小幫手」的 bot 了");
  });

  it("codeOf finds the key and params from the Chinese text", () => {
    expect(codeOf("沒有這個 bot")).toEqual({ code: "core.common.noBot", params: {} });
    expect(codeOf("沒有這個 bot：b1")).toEqual({ code: "core.siteLogins.unknownBot", params: { id: "b1" } });
    expect(codeOf("過去 1 小時有 3 筆查詢超過 200 ms")).toEqual({
      code: "core.system.slowQueries",
      params: { count: "3", ms: "200" },
    });
    // Regex characters in the text are literal, not patterns.
    expect(codeOf("SearXNG 網址要是 http:// 或 https:// 開頭")?.code).toBe("core.search.searxScheme");
    expect(codeOf("something the core says that is not in the table")).toBeUndefined();
    expect(codeOf("沒有這個 bot!")).toBeUndefined();
  });

  it("every core.* text is found again from itself", () => {
    for (const [k, v] of Object.entries(zhHantTW))
      if (k.startsWith("core.") && !/\{\w+\}/.test(v)) expect(codeOf(v)?.code, k).toBe(k);
  });

  it("coreText shows the code in the page's language, else finds it from the text, else the text", () => {
    setLocale("en");
    expect(coreText({ error: "沒有這個 bot", code: "core.common.noBot", params: {} })).toBe("No such bot");
    expect(coreText("已經有叫「小幫手」的 bot 了")).toBe("There is already a bot named “小幫手”");
    expect(coreText({ error: "沒有這個 bot", code: "core.no.such.key" })).toBe("No such bot");
    expect(coreText("HTTP 500")).toBe("HTTP 500");
    setLocale("zh-Hant-TW");
    expect(coreText({ error: "沒有這個 bot", code: "core.common.noBot" })).toBe("沒有這個 bot");
  });
});
