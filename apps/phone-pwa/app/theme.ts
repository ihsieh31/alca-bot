// The phone's theme (BUG-10). The Home Screen app on iOS paints the status
// bar from `theme-color` and the page's color scheme. With the two
// media-query metas from index.html and `color-scheme: dark light`, a phone
// whose system is dark kept a black status bar over the light theme. So:
//
// - a chosen theme (深色 / 淺色): one theme-color meta with no media query,
//   `<meta name=color-scheme>` and the root's `color-scheme` set to it;
// - 跟隨系統: the two media-query metas come back, color scheme "dark light".
//
// theme-boot.ts applies the same plan before the first paint (a blocking
// classic script, from the copy kept in localStorage); keep the two in step.
// No DOM types here (the node typecheck reads this file through its test): the
// document is described by the little it is asked to do.
type ThemePref = "dark" | "light" | "system";

interface ThemeEl {
  getAttribute(k: string): string | null;
  setAttribute(k: string, v: string): void;
  remove(): void;
  before(n: ThemeEl): void;
}
export interface ThemeDoc {
  documentElement: { dataset: Record<string, string | undefined>; style: { colorScheme: string } };
  head: { append(n: ThemeEl): void };
  createElement(tag: "meta"): ThemeEl;
  querySelector(sel: string): ThemeEl | null;
  querySelectorAll(sel: string): Iterable<ThemeEl>;
}
const env = globalThis as unknown as {
  document: ThemeDoc;
  localStorage?: { setItem(k: string, v: string): void };
};

export const THEME_COLOR = { dark: "#000000", light: "#ffffff" } as const;
/** The synchronous copy theme-boot.ts reads (IndexedDB is too late for the first paint). */
export const THEME_STORAGE_KEY = "alca.theme";

export interface ThemePlan {
  /** `data-theme` on <html>; undefined = follow the system (attribute removed). */
  dataTheme: "dark" | "light" | undefined;
  /** `<meta name=color-scheme>` content and the root's `color-scheme`. */
  colorScheme: "dark" | "light" | "dark light";
  /** The theme-color metas to have, in order. */
  metas: Array<{ content: string; media?: string }>;
}

export function themePlan(t: ThemePref): ThemePlan {
  if (t === "dark" || t === "light")
    return { dataTheme: t, colorScheme: t, metas: [{ content: THEME_COLOR[t] }] };
  return {
    dataTheme: undefined,
    colorScheme: "dark light",
    metas: [
      { content: THEME_COLOR.dark, media: "(prefers-color-scheme: dark)" },
      { content: THEME_COLOR.light, media: "(prefers-color-scheme: light)" },
    ],
  };
}

export function applyTheme(t: ThemePref, doc: ThemeDoc = env.document): void {
  const plan = themePlan(t);
  const root = doc.documentElement;
  if (plan.dataTheme) root.dataset.theme = plan.dataTheme;
  else delete root.dataset.theme;
  root.style.colorScheme = plan.colorScheme;
  let scheme = doc.querySelector('meta[name="color-scheme"]');
  if (!scheme) {
    scheme = doc.createElement("meta");
    scheme.setAttribute("name", "color-scheme");
    doc.head.append(scheme);
  }
  scheme.setAttribute("content", plan.colorScheme);
  const old = [...doc.querySelectorAll('meta[name="theme-color"]')];
  const anchor = old[0] ?? null;
  for (const m of plan.metas) {
    const el = doc.createElement("meta");
    el.setAttribute("name", "theme-color");
    el.setAttribute("content", m.content);
    if (m.media) el.setAttribute("media", m.media);
    if (anchor) anchor.before(el);
    else doc.head.append(el);
  }
  for (const m of old) m.remove();
  try {
    env.localStorage?.setItem(THEME_STORAGE_KEY, t);
  } catch {
    // private mode: the next launch starts dark until IndexedDB answers
  }
}
