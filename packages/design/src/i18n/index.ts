// R9.3: the UI string table and `t()`. One table, shared by the desktop UI, the
// phone web app and the desktop shell (its `shell.*` keys become JSON files).
// Plain TypeScript with no imports outside this folder: the desktop server
// strips the types and serves it as /ui/i18n/*, the phone build copies it.
//
// Chinese (zh-Hant-TW) is the source language and is always loaded: a key the
// English table lacks falls back to it. A key is a dotted string
// ("desktop.workers.stop"); a mistyped key, a missing `{param}` or a missing
// English entry is a typecheck error. Switching language reloads the page.
import { en } from "./en.ts";
import { zhHantTW } from "./zh-Hant-TW.ts";

export type Locale = "zh-Hant-TW" | "en";
/** `auto` follows the system language: zh* → 繁中, anything else → English. */
export type LocalePref = "auto" | Locale;
export const LOCALES: readonly Locale[] = ["zh-Hant-TW", "en"];

export type MessageKey = keyof typeof zhHantTW;
/** Same keys as the source table, every value a string (en.ts `satisfies` it). */
export type Messages = { readonly [K in MessageKey]: string };

type ParamNames<S extends string> = S extends `${string}{${infer N}}${infer R}` ? N | ParamNames<R> : never;
/** `[]` for a text without `{params}`, otherwise `[{ name: value, … }]` naming every one. */
export type ParamsOf<K extends MessageKey> = [ParamNames<(typeof zhHantTW)[K]>] extends [never]
  ? []
  : [{ readonly [N in ParamNames<(typeof zhHantTW)[K]>]: unknown }];

/** Keys that come in `.one` / `.other` pairs, for `tn()`. */
export type PluralBase = MessageKey extends infer K ? (K extends `${infer B}.other` ? B : never) : never;

const TABLES: Record<Locale, Readonly<Record<string, string>>> = { "zh-Hant-TW": zhHantTW, en };
const SOURCE: Readonly<Record<string, string>> = zhHantTW;
/** Where the choice is kept between page loads. */
export const LOCALE_STORAGE_KEY = "alca.locale";

// No DOM types here: this file is also compiled (and run) in Node, by the core and the tests.
type Nav = { navigator?: { language?: string } };
type Doc = { documentElement: { lang: string } };
const doc = (): Doc | undefined => (globalThis as { document?: Doc }).document;
/** The part of a DOM element applyI18n touches. */
export interface I18nElement {
  textContent: string | null;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
}
export interface I18nRoot {
  querySelectorAll(selector: string): Iterable<I18nElement>;
}

/** The locale a preference means on a system whose language is `system` (e.g. navigator.language). */
export function resolveLocale(pref: string | undefined, system: string | undefined): Locale {
  if (pref === "zh-Hant-TW" || pref === "en") return pref;
  return !system || /^zh\b/i.test(system) ? "zh-Hant-TW" : "en";
}

function storage(): Storage | undefined {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage;
  } catch {
    return undefined;
  }
}

function remember(l: Locale): void {
  try {
    storage()?.setItem(LOCALE_STORAGE_KEY, l);
  } catch {
    // Private mode or no storage: the choice lasts for this page only.
  }
}

/**
 * The locale a page starts in, decided synchronously before any UI module runs
 * (module-level strings resolve at import time): the stored choice, else, in a
 * browser, the system language, else (Node, tests) Chinese.
 */
function initialLocale(): Locale {
  let stored: string | null | undefined;
  try {
    stored = storage()?.getItem(LOCALE_STORAGE_KEY);
  } catch {
    stored = undefined;
  }
  if (stored === "zh-Hant-TW" || stored === "en") return stored;
  if (!doc()) return "zh-Hant-TW";
  return resolveLocale("auto", (globalThis as Nav).navigator?.language);
}

let current: Locale = initialLocale();
const page = doc();
if (page) page.documentElement.lang = current;

export function locale(): Locale {
  return current;
}

/** Switch the language for this page and the next loads. Text already on screen is not redrawn. */
export function setLocale(l: Locale): void {
  current = l;
  remember(l);
  const d = doc();
  if (d) d.documentElement.lang = l;
}

/**
 * Bring the page in line with a preference (the core's `advanced.locale`, or
 * the phone's own choice): when it means another language than the page is
 * in, store it and reload. Returns whether a reload was started.
 */
export function applyLocalePref(
  pref: string | undefined,
  reload: () => void = () => (globalThis as { location?: { reload(): void } }).location?.reload(),
): boolean {
  const want = resolveLocale(pref, (globalThis as Nav).navigator?.language);
  if (want === current) {
    remember(want);
    return false;
  }
  setLocale(want);
  reload();
  return true;
}

function fill(text: string, params: Readonly<Record<string, unknown>> | undefined): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m));
}

/** The text for `key` in the current language (Chinese when English lacks it), `{params}` filled in. */
export function t<K extends MessageKey>(key: K, ...params: ParamsOf<K>): string {
  return fill(
    TABLES[current][key] ?? SOURCE[key] ?? key,
    params[0] as Readonly<Record<string, unknown>> | undefined,
  );
}

/** A key built at run time (listed in dynamic-keys.ts); an unknown key comes back as itself. */
export function tKey(key: string, params?: Readonly<Record<string, unknown>>): string {
  return fill(TABLES[current][key] ?? SOURCE[key] ?? key, params);
}

/**
 * The Chinese (source) text for `key`, whatever language a page is in. The core
 * sends this as a message's `text` (R9.3 batch 5): old clients show it as is,
 * new ones find the key again (`codeOf`) and show their own language.
 */
export function tSource<K extends MessageKey>(key: K, ...params: ParamsOf<K>): string {
  return fill(SOURCE[key] ?? key, params[0] as Readonly<Record<string, unknown>> | undefined);
}

let corePatterns: Array<[string, RegExp]> | undefined;
/** A core message's key and params, found from its Chinese text (the table's `core.*` keys). */
export function codeOf(text: string): { code: string; params: Record<string, string> } | undefined {
  corePatterns ??= Object.keys(SOURCE)
    .filter((k) => k.startsWith("core."))
    .map((k) => {
      const src = (SOURCE[k] as string)
        .split(/(\{\w+\})/)
        .map((part) => {
          const m = /^\{(\w+)\}$/.exec(part);
          return m ? `(?<${m[1]}>[\\s\\S]*?)` : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        })
        .join("");
      return [k, new RegExp(`^${src}$`)] as [string, RegExp];
    });
  for (const [code, re] of corePatterns) {
    const m = re.exec(text);
    if (m) return { code, params: { ...m.groups } };
  }
  return undefined;
}

/** A message from the core as the UI shows it: by its code, else found from its text, else as sent. */
export function coreText(
  m: string | { code?: string; params?: Readonly<Record<string, unknown>>; text?: string; error?: string },
): string {
  const text = typeof m === "string" ? m : (m.text ?? m.error ?? "");
  const c = typeof m === "string" || !m.code || !(m.code in SOURCE) ? codeOf(text) : m;
  return c?.code ? tKey(c.code, c.params) : text;
}

const plural = new Map<Locale, Intl.PluralRules>();
/** Count-dependent text: `${base}.one` or `${base}.other` by the language's plural rules, `{n}` filled in. */
export function tn(base: PluralBase, n: number, params: Readonly<Record<string, unknown>> = {}): string {
  let rules = plural.get(current);
  if (!rules) {
    rules = new Intl.PluralRules(current);
    plural.set(current, rules);
  }
  return tKey(`${base}.${rules.select(n) === "one" ? "one" : "other"}`, { n, ...params });
}

/** A date and time in the current language. */
export function fmtDate(d: Date, style: "short" | "long" = "short"): string {
  return new Intl.DateTimeFormat(current, { dateStyle: style, timeStyle: "short" }).format(d);
}

/**
 * Fill a page's static text: `data-i18n="key"` sets the text, and
 * `data-i18n-aria-label` / `-placeholder` / `-title` / `-alt` set that
 * attribute. Text only (no innerHTML), like the rest of the UI.
 */
export function applyI18n(root: I18nRoot): void {
  for (const el of root.querySelectorAll("[data-i18n]"))
    el.textContent = tKey(el.getAttribute("data-i18n") ?? "");
  for (const attr of ["aria-label", "placeholder", "title", "alt"] as const)
    for (const el of root.querySelectorAll(`[data-i18n-${attr}]`))
      el.setAttribute(attr, tKey(el.getAttribute(`data-i18n-${attr}`) ?? ""));
}
