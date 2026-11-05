// G2 (R9.10): t() / tn() / the locale choice / applyI18n, on the real table.
import { afterEach, describe, expect, it } from "vitest";
import { en } from "../src/i18n/en.ts";
import {
  applyI18n,
  applyLocalePref,
  fmtDate,
  type I18nElement,
  LOCALE_STORAGE_KEY,
  locale,
  resolveLocale,
  setLocale,
  t,
  tKey,
  tn,
} from "../src/i18n/index.ts";
import { zhHantTW } from "../src/i18n/zh-Hant-TW.ts";

afterEach(() => setLocale("zh-Hant-TW"));

describe("t()", () => {
  it("Node (no document, no stored choice) starts in Chinese: the default behaviour is unchanged", () => {
    expect(locale()).toBe("zh-Hant-TW");
    expect(t("common.newChat")).toBe("新對話");
  });

  it("fills {params} and switches language", () => {
    expect(t("shell.waiting", { n: 3 })).toBe("等你決定：3 件");
    setLocale("en");
    expect(t("shell.waiting", { n: 3 })).toBe("Waiting on you: 3");
    expect(t("common.newChat")).toBe("New chat");
  });

  it("a param value that looks like a placeholder is not filled again", () => {
    expect(t("shell.startFailed", { e: "{e}" })).toBe("無法啟動核心：{e}");
  });

  it("falls back to Chinese for a key English lacks, and to the key itself for an unknown one", () => {
    setLocale("en");
    const table = en as Record<string, string>;
    const saved = table["common.newChat"];
    delete table["common.newChat"];
    try {
      expect(t("common.newChat")).toBe("新對話");
    } finally {
      table["common.newChat"] = saved as string;
    }
    expect(tKey("no.such.key")).toBe("no.such.key");
  });

  it("keys and params are checked by the typechecker", () => {
    // @ts-expect-error: not a key
    t("no.such.key");
    // @ts-expect-error: {n} is missing
    t("shell.waiting");
    // @ts-expect-error: a key without params takes none
    t("common.newChat", { n: 1 });
    expect(true).toBe(true);
  });

  it("every key has the same {params} in both languages and English has no CJK", () => {
    const params = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    const zh = zhHantTW as Record<string, string>;
    for (const [k, v] of Object.entries(en as Record<string, string>)) {
      expect(params(v), k).toEqual(params(zh[k] ?? ""));
      expect(v, k).not.toMatch(/[\u3400-\u9fff]/);
    }
    expect(Object.keys(en).sort()).toEqual(Object.keys(zhHantTW).sort());
  });
});

describe("tn()", () => {
  it("picks .one / .other by the language's plural rules", () => {
    expect(tn("plural.steps", 1)).toBe("1 步");
    expect(tn("plural.steps", 4)).toBe("4 步");
    setLocale("en");
    expect(tn("plural.steps", 1)).toBe("1 step");
    expect(tn("plural.steps", 4)).toBe("4 steps");
  });
});

describe("the locale choice", () => {
  it("auto follows the system language: zh* is 繁中, anything else English, unknown stays 繁中", () => {
    expect(resolveLocale("auto", "zh-TW")).toBe("zh-Hant-TW");
    expect(resolveLocale("auto", "zh-Hans-CN")).toBe("zh-Hant-TW");
    expect(resolveLocale("auto", "en-US")).toBe("en");
    expect(resolveLocale("auto", "ja-JP")).toBe("en");
    expect(resolveLocale("auto", undefined)).toBe("zh-Hant-TW");
    expect(resolveLocale("en", "zh-TW")).toBe("en");
    expect(resolveLocale("zh-Hant-TW", "en-US")).toBe("zh-Hant-TW");
  });

  it("applyLocalePref reloads only when the language changes, and remembers the choice", () => {
    const store = new Map<string, string>();
    const g = globalThis as { localStorage?: unknown };
    const before = g.localStorage;
    g.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
    };
    try {
      let reloads = 0;
      expect(applyLocalePref("zh-Hant-TW", () => reloads++)).toBe(false);
      expect(reloads).toBe(0);
      expect(applyLocalePref("en", () => reloads++)).toBe(true);
      expect(reloads).toBe(1);
      expect(locale()).toBe("en");
      expect(store.get(LOCALE_STORAGE_KEY)).toBe("en");
    } finally {
      g.localStorage = before;
    }
  });

  it("dates follow the language", () => {
    const d = new Date(Date.UTC(2026, 10, 5, 7, 0));
    const zh = fmtDate(d, "long");
    setLocale("en");
    expect(fmtDate(d, "long")).not.toBe(zh);
    expect(fmtDate(d, "long")).toMatch(/November/);
  });
});

describe("applyI18n", () => {
  it("fills data-i18n text and data-i18n-<attr> attributes, as text", () => {
    const el = (attrs: Record<string, string>): I18nElement & { attrs: Record<string, string> } => ({
      attrs,
      textContent: "舊",
      getAttribute: (n) => attrs[n] ?? null,
      setAttribute(n, v) {
        attrs[n] = v;
      },
    });
    const text = el({ "data-i18n": "desktop.index.newChat" });
    const label = el({ "data-i18n-aria-label": "desktop.index.chatList" });
    setLocale("en");
    applyI18n({
      querySelectorAll: (sel) =>
        sel === "[data-i18n]" ? [text] : sel === "[data-i18n-aria-label]" ? [label] : [],
    });
    expect(text.textContent).toBe("New chat");
    expect(label.attrs["aria-label"]).toBe("Chat list");
  });
});
