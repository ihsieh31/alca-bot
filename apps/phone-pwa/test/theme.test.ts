// BUG-10: the light theme's status bar in the Home Screen app (theme.ts, theme-boot.ts).
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyTheme, THEME_STORAGE_KEY, themePlan } from "../app/theme.ts";

/** Just enough of a document: <html>, <head> with the metas index.html ships. */
class El {
  attrs = new Map<string, string>();
  parent: El | undefined;
  children: El[] = [];
  dataset: Record<string, string> = {};
  style: { colorScheme: string; [k: string]: string } = { colorScheme: "" };
  readonly tagName: string;
  constructor(tagName: string) {
    this.tagName = tagName;
  }
  getAttribute(k: string) {
    return this.attrs.get(k) ?? null;
  }
  setAttribute(k: string, v: string) {
    this.attrs.set(k, v);
  }
  removeAttribute(k: string) {
    this.attrs.delete(k);
  }
  append(c: El) {
    c.parent = this;
    this.children.push(c);
  }
  before(c: El) {
    const p = this.parent as El;
    c.parent = p;
    p.children.splice(p.children.indexOf(this), 0, c);
  }
  remove() {
    const p = this.parent;
    if (p) p.children.splice(p.children.indexOf(this), 1);
  }
}

function fakeDoc() {
  const html = new El("html");
  html.dataset.theme = "dark";
  const head = new El("head");
  html.append(head);
  const meta = (attrs: Record<string, string>) => {
    const m = new El("meta");
    for (const [k, v] of Object.entries(attrs)) m.setAttribute(k, v);
    head.append(m);
  };
  meta({ charset: "utf-8" });
  meta({ name: "theme-color", content: "#000000", media: "(prefers-color-scheme: dark)" });
  meta({ name: "theme-color", content: "#ffffff", media: "(prefers-color-scheme: light)" });
  meta({ name: "color-scheme", content: "dark light" });
  const named = (sel: string) => /name="([\w-]+)"/.exec(sel)?.[1];
  const all = (sel: string) => head.children.filter((c) => c.getAttribute("name") === named(sel));
  return {
    documentElement: html,
    head,
    createElement: (t: string) => new El(t),
    querySelector: (sel: string) => all(sel)[0] ?? null,
    querySelectorAll: (sel: string) => all(sel),
  };
}

const state = (d: ReturnType<typeof fakeDoc>) => ({
  theme: d.documentElement.dataset.theme,
  colorScheme: d.documentElement.style.colorScheme,
  scheme: d.querySelector('meta[name="color-scheme"]')?.getAttribute("content"),
  metas: d
    .querySelectorAll('meta[name="theme-color"]')
    .map((m) => [m.getAttribute("content"), m.getAttribute("media")]),
});

const store = new Map<string, string>();
const localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
};

function boot(d: ReturnType<typeof fakeDoc>) {
  const src = stripTypeScriptTypes(readFileSync(new URL("../app/theme-boot.ts", import.meta.url), "utf8"), {
    mode: "strip",
  });
  runInNewContext(src, { document: d, localStorage });
}

afterEach(() => {
  store.clear();
  vi.unstubAllGlobals();
});

describe("phone theme: status bar and color scheme follow the chosen theme", () => {
  it("a chosen theme is one theme-color with no media query and a fixed color scheme", () => {
    expect(themePlan("light")).toEqual({
      dataTheme: "light",
      colorScheme: "light",
      metas: [{ content: "#ffffff" }],
    });
    expect(themePlan("dark").metas).toEqual([{ content: "#000000" }]);
    expect(themePlan("system").colorScheme).toBe("dark light");
    expect(themePlan("system").metas.map((m) => m.media)).toEqual([
      "(prefers-color-scheme: dark)",
      "(prefers-color-scheme: light)",
    ]);
  });

  it("applyTheme rewrites the metas (light on a dark system no longer keeps the dark meta) and restores them for 跟隨系統", () => {
    vi.stubGlobal("localStorage", localStorage);
    const d = fakeDoc();
    applyTheme("light", d);
    expect(state(d)).toEqual({
      theme: "light",
      colorScheme: "light",
      scheme: "light",
      metas: [["#ffffff", null]],
    });
    expect(store.get(THEME_STORAGE_KEY)).toBe("light");
    applyTheme("system", d);
    expect(state(d)).toEqual({
      theme: undefined,
      colorScheme: "dark light",
      scheme: "dark light",
      metas: [
        ["#000000", "(prefers-color-scheme: dark)"],
        ["#ffffff", "(prefers-color-scheme: light)"],
      ],
    });
  });

  it("theme-boot.js gives the first paint the same result as applyTheme, from the localStorage copy", () => {
    vi.stubGlobal("localStorage", localStorage);
    for (const t of ["light", "dark"] as const) {
      const a = fakeDoc();
      applyTheme(t, a);
      const b = fakeDoc();
      store.set(THEME_STORAGE_KEY, t);
      boot(b);
      expect(state(b)).toEqual(state(a));
    }
    // 跟隨系統 / nothing saved: index.html untouched.
    store.clear();
    const c = fakeDoc();
    const before = state(c);
    boot(c);
    expect(state(c)).toEqual(before);
  });

  it("index.html loads theme-boot as a blocking file script before the stylesheets (CSP: no inline script)", () => {
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    const at = html.indexOf('<script src="./app/theme-boot.js"></script>');
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(html.indexOf('<link rel="stylesheet"'));
    expect(readFileSync(new URL("../app/theme-boot.ts", import.meta.url), "utf8")).not.toMatch(
      /^\s*(import|export)\b/m,
    );
  });
});
