// The Home Screen app fills the whole iPhone screen: drawn under the status
// bar (theme-color, no black-translucent so light-theme text stays readable; viewport-fit=cover), a root pinned to the screen
// (no 100dvh / 100vh, which can come up a safe area short in standalone),
// nothing that rubber-bands to show the page behind, and every edge part
// padded by the safe areas. Screenshots: scripts/shots-fit.ts.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = fileURLToPath(new URL("..", import.meta.url));
const read = (f: string) => readFileSync(join(HERE, f), "utf8");
const html = read("index.html");
const styles = readdirSync(join(HERE, "styles")).filter((f) => f.endsWith(".css"));
const css = Object.fromEntries(styles.map((f) => [f, read(`styles/${f}`)]));

/** The declarations of the first rule whose selector list is exactly `sel` in `src`. */
function rule(src: string, sel: string): string {
  const re = new RegExp(`(^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`);
  const m = re.exec(src);
  if (!m) throw new Error(`no rule for ${sel}`);
  return m[2] as string;
}

describe("phone PWA fits the iPhone screen as a Home Screen app", () => {
  it("draws edge to edge under the status bar", () => {
    expect(html).toMatch(/name="viewport"[^>]*viewport-fit=cover/);
    expect(html).toContain('name="apple-mobile-web-app-capable" content="yes"');
    expect(html).not.toContain("black-translucent");
    const icon = /rel="apple-touch-icon" href="\.\/([^"]+)"/.exec(html)?.[1];
    expect(icon && existsSync(join(HERE, icon))).toBe(true);
  });

  it("has a theme color for the dark and the light theme", () => {
    expect(html).toMatch(/name="theme-color" content="#000000" media="\(prefers-color-scheme: dark\)"/);
    expect(html).toMatch(/name="theme-color" content="#ffffff" media="\(prefers-color-scheme: light\)"/);
    const m = JSON.parse(read("manifest.webmanifest")) as { display: string; display_override?: string[] };
    expect(m.display).toBe("standalone");
    expect(m.display_override ?? ["standalone"]).toEqual(["standalone"]);
  });

  it("pins the root to the screen so it never shows a gap or rubber-bands", () => {
    const base = css["base.css"] as string;
    const htmlRule = rule(base, "html");
    expect(htmlRule).toContain("background: var(--c-canvas)");
    expect(htmlRule).toContain("overflow: hidden");
    expect(htmlRule).toContain("overscroll-behavior: none");
    const body = rule(base, "body");
    for (const d of ["position: fixed", "inset: 0", "overflow: hidden", "background: var(--c-canvas)"])
      expect(body).toContain(d);
    expect(body).toContain("overscroll-behavior: none");
    expect(rule(base, "#app")).toContain("inset: 0");
    // Viewport units on the root are what leave a strip at the bottom in standalone.
    for (const [f, src] of Object.entries(css))
      expect(src, f).not.toMatch(/(^|\n)\s*(html|body|#app)[^{]*\{[^}]*\b\d+(dvh|vh|svh|lvh)\b/);
  });

  it("pads every edge part by the safe areas", () => {
    const chat = css["chat.css"] as string;
    expect(rule(chat, ".nav-bar.chat-bar")).toContain("var(--safe-top)");
    expect(rule(chat, ".dock")).toContain("var(--safe-bottom)");
    const sheet = css["sheet.css"] as string;
    const s = rule(sheet, ".sheet");
    for (const t of ["--safe-top", "--safe-bottom", "--safe-left", "--safe-right"]) expect(s).toContain(t);
    expect(rule(sheet, '.sheet[data-size="full"]')).toContain("var(--safe-top)");
    expect(rule(sheet, ".sheet.page")).toContain("var(--safe-top)");
    expect(rule(sheet, ".sheet.page .sheet-body")).toContain("var(--safe-bottom)");
    // The shell (素 Plain §2.1): large-title bar under the status bar, tab bar over the home indicator.
    const ui = css["ui.css"] as string;
    expect(rule(ui, ".nav-bar.root-bar")).toContain("var(--safe-top)");
    const tabbar = rule(ui, ".tabbar");
    for (const t of ["--safe-bottom", "--safe-left", "--safe-right"]) expect(tabbar).toContain(t);
    const root = rule(ui, ".root-screen");
    for (const t of ["--safe-left", "--safe-right"]) expect(root).toContain(t);
    // Full screens: Google sign-in (and the computer's), pairing.
    // They share one frame rule in screens.css.
    for (const sel of [".pairing,\n.gs"]) {
      const r = rule(css["screens.css"] as string, sel);
      expect(r, sel).toContain("var(--safe-top)");
      expect(r, sel).toContain("var(--safe-bottom)");
    }
    const screen = rule(css["base.css"] as string, ".screen");
    expect(screen).toContain("var(--safe-left)");
    expect(screen).toContain("var(--safe-right)");
  });
});
