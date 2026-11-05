// G2 (R9.4, R9.10): the i18n guard — each rule fails on a bad input, and the
// repository itself passes (so CI's test step enforces it like `pnpm check:i18n`).
import { describe, expect, it } from "vitest";
import { check, type Inputs, readInputs, shellJsonOf, usedKeys } from "../../../scripts/check-i18n.ts";
import { htmlWords } from "../../../scripts/i18n-scan.ts";

const zh = { "a.hello": "你好 {name}", "a.bye": "再見", "shell.quit": "結束" };
const en = { "a.hello": "Hello {name}", "a.bye": "Bye", "shell.quit": "Quit" };
const good = (): Inputs => ({
  zh: { ...zh },
  en: { ...en },
  uiSources: new Map([["apps/desktop/ui/x.ts", 'h("p", {}, t("a.hello", { name }), t("a.bye"));']]),
  useSources: ['h("p", {}, t("a.hello", { name }), t("a.bye"));'],
  dynamicKeys: [],
  baseline: {},
  shellJson: { "zh-Hant-TW": shellJsonOf(zh), en: shellJsonOf(en) },
});

describe("check-i18n rules", () => {
  it("a clean input passes", () => {
    expect(check(good()).errors).toEqual([]);
  });

  it("rule 1: a new hard-coded CJK string over the baseline fails; under it asks to lower it", () => {
    const i = good();
    i.uiSources.set("apps/desktop/ui/y.ts", 'h("p", {}, "新的字");');
    expect(check(i).errors.join("\n")).toMatch(/y\.ts: 1 hard-coded CJK strings, baseline 0/);
    i.baseline = { "apps/desktop/ui/y.ts": 3 };
    const r = check(i);
    expect(r.errors).toEqual([]);
    expect(r.notes.join("\n")).toMatch(/--update/);
  });

  it("rule 1: data the UI matches against core text is not a word; i18n-ignore opts a line out", () => {
    const i = good();
    i.uiSources.set(
      "apps/desktop/ui/z.ts",
      'if (s.startsWith("原因：") || s === "剛剛") x = "繁體中文"; // i18n-ignore',
    );
    expect(check(i).errors).toEqual([]);
  });

  it("rule 1: HTML text without data-i18n counts; with it, or inside data-i18n-ignore, it does not", () => {
    expect(htmlWords('<p>你好</p><span data-i18n="a.bye">再見</span>')).toEqual(["你好"]);
    expect(htmlWords('<input placeholder="輸入" />')).toEqual(["輸入"]);
    expect(htmlWords('<input placeholder="輸入" data-i18n-placeholder="a.bye" />')).toEqual([]);
    expect(htmlWords("<noscript data-i18n-ignore>需要 JavaScript</noscript>")).toEqual([]);
    expect(htmlWords("<p><kbd>⌘</kbd> 即 <kbd>Ctrl</kbd></p>")).toEqual(["即"]);
  });

  it("rule 2: English that is still Chinese fails", () => {
    const i = good();
    i.en = { ...en, "a.bye": "再見" };
    expect(check(i).errors.join("\n")).toMatch(/en a\.bye still has CJK/);
  });

  it("rule 3: different {params} in the two languages fail", () => {
    const i = good();
    i.en = { ...en, "a.hello": "Hello {who}" };
    expect(check(i).errors.join("\n")).toMatch(/a\.hello: params differ/);
  });

  it("rule 4: an unused key fails unless dynamic-keys lists it; a listed key must exist", () => {
    const i = good();
    i.useSources = ['t("a.hello", { name })'];
    expect(check(i).errors.join("\n")).toMatch(/a\.bye is not used/);
    i.dynamicKeys = ["a.bye"];
    expect(check(i).errors).toEqual([]);
    i.dynamicKeys = ["a.bye", "a.gone"];
    expect(check(i).errors.join("\n")).toMatch(/lists a\.gone/);
  });

  it("rule 4: tn() uses both plural forms, data-i18n uses its key", () => {
    expect([...usedKeys(['tn("p.steps", n)', '<b data-i18n-title="a.x">'])].sort()).toEqual([
      "a.x",
      "p.steps.one",
      "p.steps.other",
    ]);
  });

  it("rule 5: the shell JSON out of date with the table's shell.* keys fails", () => {
    const i = good();
    i.shellJson.en = shellJsonOf({ "shell.quit": "Exit" });
    expect(check(i).errors.join("\n")).toMatch(/strings\.en\.json is out of date/);
    expect(JSON.parse(shellJsonOf(zh))).toEqual({ quit: "結束" });
  });

  it("rule 6: Chinese in the shell's splash page fails", () => {
    const bad = check({
      ...good(),
      shellPage: { "apps/desktop-shell/ui/index.html": "<p>Alca 正在啟動…</p>" },
    });
    expect(bad.errors.join("\n")).toMatch(/index\.html has CJK/);
    expect(check({ ...good(), shellPage: { "x.js": "fetch(`strings.en.json`)" } }).errors).toEqual([]);
  });

  it("an extra English key, a missing one, or a stray brace fails", () => {
    const i = good();
    i.en = { ...en, "a.extra": "x" };
    expect(check(i).errors.join("\n")).toMatch(/en has a\.extra/);
    const j = good();
    const { "a.bye": _gone, ...rest } = en;
    j.en = rest;
    expect(check(j).errors.join("\n")).toMatch(/en lacks a\.bye/);
    const k = good();
    k.zh = { ...zh, "a.bye": "再見 {" };
    expect(check(k).errors.join("\n")).toMatch(/a brace/);
  });
});

describe("the repository", () => {
  it("passes the guard: no hard-coded UI words, both tables complete, shell JSON current", async () => {
    const r = check(await readInputs());
    expect(r.errors).toEqual([]);
    expect(Object.values(r.counts).reduce((a, b) => a + b, 0)).toBe(0);
  });
});
