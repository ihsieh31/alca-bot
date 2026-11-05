// Review 2026-11-05 (#11–#14): VoiceOver semantics, checked on the sources (no DOM in this runner).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (f: string) => readFileSync(new URL(`../app/${f}`, import.meta.url), "utf8");

describe("phone accessibility", () => {
  it("#11: a thread row stays a button; the list item is its wrapper; actions reachable without swipe", () => {
    const src = read("threads-view.ts");
    const row = /h\(\s*"button",\s*\{\s*class: "thread-row",[^}]*\}/.exec(src)?.[0] ?? "";
    expect(row).not.toBe("");
    expect(row).not.toContain("role:");
    expect(src).toMatch(/h\("div", \{ class: "tr-wrap", role: "listitem" \}/);
    // A not-drawn second button opens the same action sheet as long-press.
    expect(src).toMatch(/class: "sr-only",[\s\S]{0,80}onclick: \(\) => actions\(th\)/);
    expect(readFileSync(new URL("../styles/base.css", import.meta.url), "utf8")).toMatch(
      /\.sr-only \{[^}]*clip-path: inset\(50%\)/,
    );
  });

  it("#12: the back button's name is its visible label", () => {
    const back = /class: "nav-back",[\s\S]*?onclick/.exec(read("sheet.ts"))?.[0] ?? "";
    expect(back).not.toBe("");
    expect(back).not.toContain("aria-label");
  });

  it("#13: a picker says which choice is current", () => {
    expect(read("sheet.ts")).toMatch(/"aria-current": a\.checked \? "true" : undefined/);
  });

  it("#14: what is covered is inert — tabs and tab bar under the chat, the app and lower sheets under a sheet", () => {
    const tabs = read("tabs.ts");
    expect(tabs).toMatch(
      /this\.holder\.inert = chat;\s*this\.bar\.inert = chat;\s*this\.chatLayer\.inert = !chat;/,
    );
    expect(tabs).toMatch(/openChat\(\)[\s\S]*?this\.setUnder\(true\)/);
    expect(tabs).toMatch(/closeChat\(\)[\s\S]*?this\.setUnder\(false\)/);
    const sheet = read("sheet.ts");
    expect(sheet).toMatch(/getElementById\("app"\)\?\.toggleAttribute\("inert", stack\.length > 0\)/);
    expect(sheet).toMatch(/x\.layer\.inert = x !== top/);
    expect(sheet.match(/syncInert\(\);/g)?.length).toBe(2);
  });

  it("#17: one live region for toasts, made empty at boot; messages carry no second role", () => {
    const src = read("toast.ts");
    expect(src).toMatch(/class: "toast-layer", role: "status", "aria-live": "polite"/);
    expect(src).not.toMatch(/class: "app-toast", role/);
    expect(src).toMatch(/if \(fresh\) setTimeout\(\(\) => el\.replaceChildren\(t\)/);
    expect(read("main.ts")).toMatch(/\ntoastLayer\(\);/);
  });

  it("#20: iPhone Return is a newline, so the composer's key is not labelled send", () => {
    const chat = read("chat.ts");
    expect(chat).not.toMatch(/enterkeyhint:\s*"send"/);
    expect(chat).toMatch(/e\.key === "Enter"[\s\S]{0,160}matchMedia\("\(hover: hover\)"\)\.matches/);
  });

  it("#20: the home-screen shortcut says 任務 like the app does", () => {
    const m = JSON.parse(readFileSync(new URL("../manifest.webmanifest", import.meta.url), "utf8")) as {
      shortcuts: Array<{ name: string; url: string }>;
    };
    expect(m.shortcuts.find((x) => x.url === "./#workers")?.name).toBe("任務");
    expect(JSON.stringify(m)).not.toContain("工人");
  });

  it("#20: the page tells the service worker its 介面語言", () => {
    expect(read("main.ts")).toMatch(/postMessage\(\{ type: "alca-locale", locale: locale\(\) \}\)/);
  });
});
