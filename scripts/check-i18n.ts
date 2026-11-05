// R9.4: the i18n guard. Five rules, run by `pnpm check:i18n` (and by
// apps/desktop/test/check-i18n.test.ts, so CI's test step runs them too):
//
//   1. hard-coded words: CJK word literals in the UI sources, and CJK text in
//      the two index.html files without `data-i18n`, counted per file against
//      scripts/i18n-baseline.json. More than the baseline fails (new code goes
//      through t()); fewer asks for `--update` (the baseline only goes down).
//   2. English that is still Chinese: an en value with a CJK character.
//   3. params: the same `{name}` set for a key in both languages.
//   4. unused keys: a key no t("…") / tx("…") / tn("…") / tKey("…") / tSource("…") /
//      data-i18n*="…" names, unless listed in i18n/dynamic-keys.ts (`shell.*`
//      keys are read by the desktop shell through rule 5's files).
//   5. the shell's JSON (apps/desktop-shell/ui/strings.<locale>.json) matches
//      the table's `shell.*` keys; `--write` regenerates it.
//   6. the shell's splash page (apps/desktop-shell/ui/index.html, splash.js)
//      has no CJK of its own: its words come from rule 5's JSON.
//
// Also: both tables have the same keys (typecheck catches a missing English
// key; this catches an extra one), and no text has a brace that is not a
// `{param}`.
//
// Usage: node scripts/check-i18n.ts [--update] [--write]
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CJK, findWords, htmlWords, parse, UI_DIRS, UI_HTML } from "./i18n-scan.ts";

export const BASELINE = "scripts/i18n-baseline.json";
export const SHELL_LOCALES = ["zh-Hant-TW", "en"] as const;
export const shellJsonPath = (l: string) => `apps/desktop-shell/ui/strings.${l}.json`;
export const SHELL_PAGE = ["apps/desktop-shell/ui/index.html", "apps/desktop-shell/ui/splash.js"] as const;
/** Where key uses are looked for: the UI, the phone page, and the core that sends UI text. */
export const USE_ROOTS = [
  "apps/desktop/ui",
  "apps/phone-pwa/app",
  "apps/phone-pwa/index.html",
  "apps/desktop/src",
];

export type Table = Readonly<Record<string, string>>;

export interface Inputs {
  zh: Table;
  en: Table;
  /** file → source text, for rule 1 (the UI .ts files and the two index.html). */
  uiSources: Map<string, string>;
  /** Source texts where keys are used (rule 4). */
  useSources: string[];
  dynamicKeys: readonly string[];
  baseline: Record<string, number>;
  /** locale → the shell JSON's current content (undefined = missing). */
  shellJson: Record<string, string | undefined>;
  /** Rule 6: the shell's splash page files → their text. */
  shellPage?: Record<string, string>;
}

export interface Report {
  errors: string[];
  notes: string[];
  counts: Record<string, number>;
}

const paramSet = (s: string) =>
  [...s.matchAll(/\{(\w+)\}/g)]
    .map((m) => m[1] as string)
    .sort()
    .join(",");

/** Rule 1's count for one file. */
export function countWords(file: string, text: string): number {
  if (file.endsWith(".html")) return htmlWords(text).length;
  return findWords(parse(file, text)).length;
}

/** The shell JSON for one locale: `shell.x` → `x`, sorted, two-space indent. */
export function shellJsonOf(table: Table): string {
  const out: Record<string, string> = {};
  for (const k of Object.keys(table).sort()) if (k.startsWith("shell.")) out[k.slice(6)] = table[k] as string;
  return `${JSON.stringify(out, null, 2)}\n`;
}

/** Every key a source names through t / tx / tn / tKey or data-i18n. */
export function usedKeys(sources: readonly string[]): Set<string> {
  const used = new Set<string>();
  for (const s of sources) {
    for (const m of s.matchAll(/\b(?:t|tx|tKey|tSource)\(\s*"([\w.-]+)"/g)) used.add(m[1] as string);
    for (const m of s.matchAll(/\btn\(\s*"([\w.-]+)"/g)) {
      used.add(`${m[1]}.one`);
      used.add(`${m[1]}.other`);
    }
    for (const m of s.matchAll(/\bdata-i18n(?:-[a-z-]+)?="([\w.-]+)"/g)) used.add(m[1] as string);
  }
  return used;
}

export function check(i: Inputs): Report {
  const errors: string[] = [];
  const notes: string[] = [];
  const counts: Record<string, number> = {};
  // Rule 1.
  for (const [file, text] of i.uiSources) {
    const n = countWords(file, text);
    if (n) counts[file] = n;
    const base = i.baseline[file] ?? 0;
    if (n > base)
      errors.push(
        `${file}: ${n} hard-coded CJK strings, baseline ${base}: put new words through t() (the i18n table)`,
      );
    else if (n < base) notes.push(`${file}: ${n} < baseline ${base}: run with --update to lower it`);
  }
  for (const file of Object.keys(i.baseline))
    if (!i.uiSources.has(file)) notes.push(`${file}: in the baseline but gone: run with --update`);
  // Same keys in both tables.
  for (const k of Object.keys(i.en)) if (!(k in i.zh)) errors.push(`en has ${k}, the Chinese table does not`);
  for (const k of Object.keys(i.zh)) if (!(k in i.en)) errors.push(`en lacks ${k}`);
  for (const [k, zh] of Object.entries(i.zh)) {
    const en = i.en[k];
    // Rule 2.
    if (en !== undefined && CJK.test(en)) errors.push(`en ${k} still has CJK text: ${JSON.stringify(en)}`);
    // Rule 3.
    if (en !== undefined && paramSet(zh) !== paramSet(en))
      errors.push(`${k}: params differ: zh {${paramSet(zh)}} vs en {${paramSet(en)}}`);
    for (const [l, s] of [
      ["zh", zh],
      ["en", en ?? ""],
    ] as const)
      if (/[{}]/.test(s.replace(/\{\w+\}/g, ""))) errors.push(`${l} ${k}: a brace that is not a {param}`);
  }
  // Rule 4.
  const used = usedKeys(i.useSources);
  const dynamic = new Set(i.dynamicKeys);
  for (const k of Object.keys(i.zh))
    if (!k.startsWith("shell.") && !used.has(k) && !dynamic.has(k))
      errors.push(
        `${k} is not used (no t("${k}") anywhere; list it in i18n/dynamic-keys.ts if built at run time)`,
      );
  for (const k of dynamic)
    if (!(k in i.zh)) errors.push(`dynamic-keys.ts lists ${k}, which is not in the table`);
  // Rule 5.
  for (const l of SHELL_LOCALES)
    if (i.shellJson[l] !== shellJsonOf(l === "en" ? i.en : i.zh))
      errors.push(`${shellJsonPath(l)} is out of date with the table's shell.* keys: run with --write`);
  // Rule 6.
  for (const [file, text] of Object.entries(i.shellPage ?? {}))
    if (CJK.test(text)) errors.push(`${file} has CJK text: the splash words come from strings.<locale>.json`);
  return { errors, notes, counts };
}

function walk(root: string): string[] {
  if (!existsSync(root)) return [];
  if (/\.(ts|html)$/.test(root)) return [root];
  return readdirSync(root, { withFileTypes: true }).flatMap((d) => {
    const p = join(root, d.name);
    if (d.isDirectory()) return d.name === "node_modules" ? [] : walk(p);
    return /\.(ts|html)$/.test(d.name) ? [p] : [];
  });
}

/** The real inputs, read from the repo (cwd = the repo root). */
export async function readInputs(): Promise<Inputs> {
  const { zhHantTW } = await import("../packages/design/src/i18n/zh-Hant-TW.ts");
  const { en } = await import("../packages/design/src/i18n/en.ts");
  const { DYNAMIC_KEYS } = await import("../packages/design/src/i18n/dynamic-keys.ts");
  const uiSources = new Map<string, string>();
  for (const d of UI_DIRS)
    for (const f of readdirSync(d)
      .filter((x) => x.endsWith(".ts"))
      .sort())
      uiSources.set(`${d}/${f}`, readFileSync(`${d}/${f}`, "utf8"));
  for (const f of UI_HTML) uiSources.set(f, readFileSync(f, "utf8"));
  const useSources = USE_ROOTS.flatMap(walk).map((f) => readFileSync(f, "utf8"));
  const baseline = existsSync(BASELINE)
    ? (JSON.parse(readFileSync(BASELINE, "utf8")) as Record<string, number>)
    : {};
  const shellJson: Record<string, string | undefined> = {};
  for (const l of SHELL_LOCALES)
    shellJson[l] = existsSync(shellJsonPath(l)) ? readFileSync(shellJsonPath(l), "utf8") : undefined;
  const shellPage: Record<string, string> = {};
  for (const f of SHELL_PAGE) shellPage[f] = readFileSync(f, "utf8");
  return {
    zh: zhHantTW,
    en,
    uiSources,
    useSources,
    dynamicKeys: DYNAMIC_KEYS,
    baseline,
    shellJson,
    shellPage,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const inputs = await readInputs();
  if (args.includes("--write")) {
    for (const l of SHELL_LOCALES) {
      const json = shellJsonOf(l === "en" ? inputs.en : inputs.zh);
      writeFileSync(shellJsonPath(l), json);
      inputs.shellJson[l] = json;
    }
    console.log("wrote the shell JSON");
  }
  let r = check(inputs);
  if (args.includes("--update")) {
    // Only ever down: a file over its baseline stays an error. No baseline yet = today's counts.
    const first = !existsSync(BASELINE);
    const next: Record<string, number> = {};
    for (const [f, n] of Object.entries(r.counts)) next[f] = first ? n : Math.min(n, inputs.baseline[f] ?? 0);
    writeFileSync(BASELINE, `${JSON.stringify(next, null, 2)}\n`);
    inputs.baseline = next;
    r = check(inputs);
    console.log(`updated ${BASELINE}`);
  }
  for (const n of r.notes) console.log(`· ${n}`);
  if (r.errors.length) {
    for (const e of r.errors) console.error(`✗ ${e}`);
    process.exit(1);
  }
  const left = Object.values(r.counts).reduce((a, b) => a + b, 0);
  console.log(
    `✓ i18n: ${Object.keys(inputs.zh).length} keys in both languages; ${left} hard-coded CJK strings left`,
  );
}

if (process.argv[1]?.endsWith("check-i18n.ts")) await main();
