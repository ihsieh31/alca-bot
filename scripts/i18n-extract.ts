// R9.5: the extraction tool. Moves the hard-coded CJK words of the UI sources
// into the string table (packages/design/src/i18n/) and rewrites each literal
// as a `t("key", { params })` call.
//
//   node scripts/i18n-extract.ts list <out.json>
//       every word literal still in the UI, as placeholder text (`已連線 {n} 台`),
//       grouped by file: the list a translator works from.
//   node scripts/i18n-extract.ts apply <translations.json> <file ...>
//       rewrites the given files; translations.json maps each placeholder text
//       to its English. Keys come from the English (`stopWorker`), under the
//       file's namespace (`desktop.timeline.*`, `phone.chat.*`), or `common.*`
//       when the same text appears in more than one file. The table files for
//       the touched namespaces are (re)written; run `biome check --write` after.
//   node scripts/i18n-extract.ts aggregate
//       rewrites zh-Hant-TW.ts / en.ts from the namespace files.
//
// What counts as a word literal is scripts/i18n-scan.ts (shared with the guard).
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { findWords, parse, type TextLiteral, UI_DIRS } from "./i18n-scan.ts";

export const TABLE_DIR = "packages/design/src/i18n";

export interface Piece {
  /** Placeholder text: the literal's parts joined by `{name}`. */
  text: string;
  params: Array<{ name: string; expr: ts.Expression }>;
}

/** A readable param name for one `${}` expression. */
export function paramName(e: ts.Expression, used: Set<string>, i: number): string {
  let x: ts.Expression = e;
  for (;;) {
    if (ts.isParenthesizedExpression(x) || ts.isNonNullExpression(x) || ts.isAsExpression(x))
      x = x.expression;
    else if (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
      x = x.left;
    else if (ts.isCallExpression(x) && x.arguments.length >= 1 && ts.isIdentifier(x.expression))
      x = x.arguments[0] as ts.Expression;
    else break;
  }
  let base = "";
  if (ts.isIdentifier(x)) base = x.text;
  else if (ts.isPropertyAccessExpression(x)) {
    base = x.name.text;
    if (x.name.text === "length" && ts.isIdentifier(x.expression)) base = `${x.expression.text}Count`;
    if (x.name.text === "length" && ts.isPropertyAccessExpression(x.expression))
      base = `${x.expression.name.text}Count`;
  }
  if (!/^[A-Za-z_]\w*$/.test(base) || base === "length") base = `p${i}`;
  let name = base;
  for (let k = 2; used.has(name); k++) name = `${base}${k}`;
  used.add(name);
  return name;
}

export function pieceOf(n: TextLiteral): Piece {
  if (!ts.isTemplateExpression(n)) return { text: n.text, params: [] };
  const used = new Set<string>();
  let text = n.head.text;
  const params: Piece["params"] = [];
  n.templateSpans.forEach((s, i) => {
    const name = paramName(s.expression, used, i);
    params.push({ name, expr: s.expression });
    text += `{${name}}${s.literal.text}`;
  });
  return { text, params };
}

export function uiFiles(): string[] {
  return UI_DIRS.flatMap((d) =>
    readdirSync(d)
      .filter((f) => f.endsWith(".ts"))
      .sort()
      .map((f) => `${d}/${f}`),
  );
}

/** `apps/desktop/ui/worker-view.ts` → `desktop.workerView`. */
export function namespaceOf(file: string): string {
  const app = file.startsWith("apps/phone-pwa/") ? "phone" : "desktop";
  const stem = basename(file, ".ts").replace(/-(\w)/g, (_, c: string) => c.toUpperCase());
  return `${app}.${stem}`;
}

/** The English → a camelCase key word (at most five words). */
export function slug(en: string): string {
  const words = en
    .replace(/\{\w+\}/g, " ")
    .replace(/[’']/g, "")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .slice(0, 5);
  const s = words
    .map((w, i) => (i === 0 ? w.toLowerCase() : `${w[0]?.toUpperCase()}${w.slice(1).toLowerCase()}`))
    .join("");
  if (!s) return "text";
  return /^[0-9]/.test(s) ? `n${s}` : s;
}

/** `desktop.workerView` → `desktop-worker-view` (the table file name). */
export function fileOfNamespace(ns: string): string {
  return ns.replace(/\./g, "-").replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/** The exported const name of a namespace file (`desktopWorkerView`). */
export function constOfFile(file: string): string {
  return file.replace(/-(\w)/g, (_, c: string) => c.toUpperCase());
}

function list(out: string): void {
  const byFile: Record<string, string[]> = {};
  for (const f of uiFiles()) {
    const texts = findWords(parse(f, readFileSync(f, "utf8"))).map((w) => pieceOf(w.node).text);
    if (texts.length) byFile[f] = texts;
  }
  writeFileSync(out, `${JSON.stringify(byFile, null, 1)}\n`);
  const all = Object.values(byFile).flat();
  console.log(
    `${all.length} word literals (${new Set(all).size} distinct) in ${Object.keys(byFile).length} files`,
  );
}

/** The table as it is on disk: namespace file → key → text (each file imported, so any quoting works). */
async function readTable(locale: "zh" | "en"): Promise<Map<string, Map<string, string>>> {
  const dir = `${TABLE_DIR}/${locale}`;
  const out = new Map<string, Map<string, string>>();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
    const mod = (await import(pathToFileURL(resolve(dir, f)).href)) as Record<string, Record<string, string>>;
    const table = mod[constOfFile(basename(f, ".ts"))] ?? {};
    out.set(basename(f, ".ts"), new Map(Object.entries(table)));
  }
  return out;
}

function writeTableFile(locale: "zh" | "en", file: string, entries: Map<string, string>): void {
  const name = constOfFile(file);
  const sorted = [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const body = sorted.map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`).join("\n");
  const head =
    locale === "zh"
      ? `// Source-language strings (zh-Hant-TW), ${file}. Generated by scripts/i18n-extract.ts; edit by hand from here on.\n`
      : `// English strings, ${file}. Same keys as ../zh/${file}.ts (typecheck enforces it).\n`;
  writeFileSync(
    `${TABLE_DIR}/${locale}/${file}.ts`,
    `${head}export const ${name} = {\n${body}\n}${locale === "zh" ? " as const" : ""};\n`,
  );
}

/** zh-Hant-TW.ts and en.ts: every namespace file of the table, spread into one object. */
export function writeAggregates(): void {
  const files = readdirSync(`${TABLE_DIR}/zh`)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => basename(f, ".ts"))
    .sort();
  const imports = (dir: string) =>
    files.map((f) => `import { ${constOfFile(f)} } from "./${dir}/${f}.ts";`).join("\n");
  const spread = files.map((f) => `  ...${constOfFile(f)},`).join("\n");
  writeFileSync(
    `${TABLE_DIR}/zh-Hant-TW.ts`,
    `// The source-language table: every namespace file under zh/. Generated by scripts/i18n-extract.ts.\n${imports("zh")}\n\nexport const zhHantTW = {\n${spread}\n} as const;\n`,
  );
  writeFileSync(
    `${TABLE_DIR}/en.ts`,
    `// The English table: every namespace file under en/. Generated by scripts/i18n-extract.ts.\n// \`satisfies Messages\`: a key the Chinese table has and this one lacks is a typecheck error.\n${imports("en")}\nimport type { Messages } from "./index.ts";\n\nexport const en = {\n${spread}\n} satisfies Messages;\n`,
  );
}

type Entry = { ns: string; key: string; zh: string; en: string };

/** Rewrite one file's word literals into t() calls; returns the entries it used. */
function rewriteFile(
  file: string,
  en: Record<string, string>,
  commonTexts: Set<string>,
  keyOf: (ns: string, zh: string, en: string) => string,
): Entry[] {
  const src = readFileSync(file, "utf8");
  const sf = parse(file, src);
  const words = findWords(sf);
  if (!words.length) return [];
  const set = new Set(words.map((w) => w.node as ts.Node));
  const ownNs = namespaceOf(file);
  const declared = new Set<string>();
  const scanT = (n: ts.Node) => {
    if (
      (ts.isVariableDeclaration(n) ||
        ts.isParameter(n) ||
        ts.isFunctionDeclaration(n) ||
        ts.isBindingElement(n) ||
        ts.isImportSpecifier(n)) &&
      n.name &&
      ts.isIdentifier(n.name) &&
      (n.name.text === "t" || n.name.text === "tx")
    )
      declared.add(n.name.text);
    ts.forEachChild(n, scanT);
  };
  // A file that already imports t from the table keeps using it.
  const rel = "./i18n/index.ts";
  const tableImport = sf.statements
    .filter(ts.isImportDeclaration)
    .find((i) => (i.moduleSpecifier as ts.StringLiteral).text === rel);
  const named = tableImport?.importClause?.namedBindings;
  const importedT =
    named && ts.isNamedImports(named)
      ? named.elements.find((e) => (e.propertyName ?? e.name).text === "t")?.name.text
      : undefined;
  if (!importedT) scanT(sf);
  if (!importedT && declared.has("t") && declared.has("tx"))
    throw new Error(`${file}: declares both t and tx`);
  const fn = importedT ?? (declared.has("t") ? "tx" : "t");
  const used: Entry[] = [];
  /** Source text of an expression with every word literal inside it rewritten. */
  const textOf = (node: ts.Node): string => {
    if (set.has(node)) return callOf(node as TextLiteral);
    let out = "";
    let at = node.getStart(sf);
    const walk = (c: ts.Node) => {
      if (set.has(c)) {
        out += src.slice(at, c.getStart(sf)) + callOf(c as TextLiteral);
        at = c.end;
        return;
      }
      ts.forEachChild(c, walk);
    };
    ts.forEachChild(node, walk);
    return out + src.slice(at, node.end);
  };
  const callOf = (n: TextLiteral): string => {
    const p = pieceOf(n);
    const english = en[p.text];
    if (english === undefined) throw new Error(`${file}: no English for ${JSON.stringify(p.text)}`);
    const ns = commonTexts.has(p.text) ? "common" : ownNs;
    const key = keyOf(ns, p.text, english);
    used.push({ ns, key, zh: p.text, en: english });
    if (!p.params.length) return `${fn}(${JSON.stringify(key)})`;
    const args = p.params.map(({ name, expr }) => {
      const code = textOf(expr);
      return code === name ? name : `${name}: ${code}`;
    });
    return `${fn}(${JSON.stringify(key)}, { ${args.join(", ")} })`;
  };
  let out = "";
  let at = 0;
  const top = (c: ts.Node) => {
    if (set.has(c)) {
      out += src.slice(at, c.getStart(sf)) + callOf(c as TextLiteral);
      at = c.end;
      return;
    }
    ts.forEachChild(c, top);
  };
  ts.forEachChild(sf, top);
  out += src.slice(at);
  const imports = sf.statements.filter(ts.isImportDeclaration);
  if (tableImport && !importedT) {
    // The file imports something else from the table (tn, applyI18n…): add t to that import.
    const spec = fn === "t" ? "t" : "t as tx";
    out = out.replace(
      /import \{([^}]*)\} from "\.\/i18n\/index\.ts";/,
      (_m, names: string) => `import {${names}, ${spec} } from "${rel}";`,
    );
  } else if (!tableImport) {
    const last = imports[imports.length - 1];
    // `out` equals `src` up to the first rewritten literal, which is never inside an import.
    const pos = last ? last.end + 1 : leadingCommentEnd(src);
    out = `${out.slice(0, pos)}import { ${fn === "t" ? "t" : "t as tx"} } from "${rel}";\n${out.slice(pos)}`;
  }
  writeFileSync(file, out);
  return used;
}

function leadingCommentEnd(src: string): number {
  const m = /^(?:\s*\/\/[^\n]*\n|\s*\/\*[\s\S]*?\*\/\s*\n)*/.exec(src);
  return m ? m[0].length : 0;
}

async function apply(translations: string, files: string[]): Promise<void> {
  const en = JSON.parse(readFileSync(translations, "utf8")) as Record<string, string>;
  // Texts in more than one file (of all UI files, migrated or not) go in `common`.
  const seen = new Map<string, Set<string>>();
  for (const f of uiFiles())
    for (const w of findWords(parse(f, readFileSync(f, "utf8")))) {
      const text = pieceOf(w.node).text;
      seen.set(text, (seen.get(text) ?? new Set()).add(f));
    }
  const zhTable = await readTable("zh");
  const enTable = await readTable("en");
  const commonTexts = new Set([...seen].filter(([, fs]) => fs.size > 1).map(([text]) => text));
  for (const text of zhTable.get("common")?.values() ?? []) commonTexts.add(text);
  const keyOf = (ns: string, zh: string, english: string): string => {
    const file = fileOfNamespace(ns);
    const zm = zhTable.get(file) ?? new Map<string, string>();
    zhTable.set(file, zm);
    for (const [k, v] of zm) if (v === zh) return k;
    const base = `${ns}.${slug(english)}`;
    let key = base;
    for (let i = 2; zm.has(key); i++) key = `${base}${i}`;
    zm.set(key, zh);
    const em = enTable.get(file) ?? new Map<string, string>();
    enTable.set(file, em);
    em.set(key, english);
    return key;
  };
  const touched = new Set<string>();
  let n = 0;
  for (const f of files) {
    const used = rewriteFile(f, en, commonTexts, keyOf);
    n += used.length;
    for (const u of used) touched.add(fileOfNamespace(u.ns));
  }
  for (const file of touched) {
    writeTableFile("zh", file, zhTable.get(file) as Map<string, string>);
    writeTableFile("en", file, enTable.get(file) as Map<string, string>);
  }
  writeAggregates();
  console.log(
    `rewrote ${n} literals in ${files.length} files; table files: ${[...touched].sort().join(", ")}`,
  );
}

if (process.argv[1]?.endsWith("i18n-extract.ts")) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "list") list(rest[0] ?? "i18n-list.json");
  else if (cmd === "apply") await apply(rest[0] as string, rest.slice(1));
  else if (cmd === "aggregate") writeAggregates();
  else {
    console.error(
      "usage: i18n-extract.ts list <out.json> | apply <translations.json> <file ...> | aggregate",
    );
    process.exit(2);
  }
}
