// Layout bugs from the iPhone run (2026-11-05), checked on the stylesheets
// (screenshots: scripts/shots-plain.ts).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { questionText } from "../app/worker-view.ts";

const css = (f: string) => readFileSync(new URL(`../styles/${f}`, import.meta.url), "utf8");
function rule(src: string, sel: string): string {
  const re = new RegExp(`(^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`);
  const m = re.exec(src);
  if (!m) throw new Error(`no rule for ${sel}`);
  return m[2] as string;
}

describe("phone layout fixes", () => {
  it("BUG-12: the reconnect banner never grows past the screen; 現在重試 stays on one line", () => {
    const chat = css("chat.css");
    // Icon, text that may shrink below its content, the button at its own width.
    expect(rule(chat, ".conn-banner.rc")).toContain("grid-template-columns: auto minmax(0, 1fr) auto");
    expect(rule(chat, ".rc-text")).toContain("min-width: 0");
    const btn = rule(chat, ".rc-retry");
    expect(btn).toContain("white-space: nowrap");
    expect(btn).toContain("flex: none");
    expect(chat).toMatch(/@media \(max-width: 340px\)[\s\S]*grid-template-columns: auto minmax\(0, 1fr\);/);
  });

  it("BUG-11 / BUG-13: a task page scrolls inside the screen (landscape, a long question form)", () => {
    // The worker card became a pushed task page (素 Plain §3.6): its body is the scroller,
    // it can shrink below its content, and it clears the home indicator.
    const sheet = css("sheet.css");
    const body = rule(sheet, ".sheet-body");
    expect(body).toContain("overflow-y: auto");
    expect(body).toContain("min-height: 0");
    expect(body).toContain("flex: 1");
    expect(rule(sheet, ".sheet.page")).toContain("max-height: 100%");
    expect(rule(sheet, ".sheet.page .sheet-body")).toContain("var(--safe-bottom)");
    // Long words in a result never push the page sideways.
    expect(rule(css("views.css"), ".task-result-text")).toContain("overflow-wrap: anywhere");
    expect(rule(css("workers.css"), ".wh-opt")).toContain("max-width: 100%");
  });

  it("D4: every sheet is padded by all four safe areas and sized to the visible viewport", () => {
    const sheet = css("sheet.css");
    const s = rule(sheet, ".sheet");
    for (const t of ["--safe-top", "--safe-bottom", "--safe-left", "--safe-right"]) expect(s).toContain(t);
    expect(s).toContain("max-height: calc(100% - var(--safe-top)");
    expect(rule(sheet, ".sheet-body")).toContain("overflow-y: auto");
    const layer = rule(sheet, ".sheet-layer");
    expect(layer).toContain("top: var(--vvt, 0px)");
    expect(layer).toContain("height: var(--vvh, auto)");
    expect(css("browser.css")).not.toMatch(/max-height: \d+vh/);
  });

  it("review #15: a page leaves horizontal drags to its edge swipe (touch-action: pan-y)", () => {
    const sheet = css("sheet.css");
    expect(rule(sheet, ".sheet.page,\n.sheet.page > .sheet-body")).toContain("touch-action: pan-y");
  });

  it("BUG-13: a question the model numbered itself shows one number, not 「1. 1.」", () => {
    expect(questionText("1. 今晚想吃哪一類餐廳？")).toBe("今晚想吃哪一類餐廳？");
    expect(questionText("2、哪一天？")).toBe("哪一天？");
    expect(questionText("(3) How many people?")).toBe("How many people?");
    expect(questionText("（3）幾個人？")).toBe("幾個人？");
    expect(questionText("Q1: Which day?")).toBe("Which day?");
    expect(questionText("3) 大概幾個人用餐？")).toBe("大概幾個人用餐？");
    // Not a list number: kept.
    expect(questionText("2026 年要去哪裡？")).toBe("2026 年要去哪裡？");
    expect(questionText("10:30 可以嗎？")).toBe("10:30 可以嗎？");
    expect(questionText("1.")).toBe("1.");
    expect(questionText("1.5 公斤夠嗎？")).toBe("1.5 公斤夠嗎？");
  });
});
