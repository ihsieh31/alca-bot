// R9.2 / R9.4: find the hard-coded human text in the UI sources. Shared by the
// extraction tool (scripts/i18n-extract.ts) and the guard (scripts/check-i18n.ts).
//
// A literal counts when it holds a CJK character and is not *data*: text the UI
// matches against what the core sends (`.startsWith("原因：")`, `=== "剛剛"`,
// `new RegExp(…)`), a type, or a property name. Those stay in the source on
// purpose: they are protocol, not words shown to a person. A line may also opt
// out with an `i18n-ignore` comment (on it or the line above), for the rare
// literal the rules can't tell.
import ts from "typescript";

export const CJK = /[\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/;

/** The UI source roots the guard scans (R9.4 rule 1). */
export const UI_DIRS = ["apps/desktop/ui", "apps/phone-pwa/app"] as const;
export const UI_HTML = ["apps/desktop/ui/index.html", "apps/phone-pwa/index.html"] as const;

const DATA_METHODS =
  /^(includes|startsWith|endsWith|test|match|matchAll|replace|replaceAll|split|indexOf|lastIndexOf|search)$/;
const COMPARE = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

export type TextLiteral = ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | ts.TemplateExpression;

export function isTextLiteral(n: ts.Node): n is TextLiteral {
  return ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n);
}

/** Whether the literal itself (not counting nested `${}` code) has CJK text. */
export function hasCjk(n: TextLiteral): boolean {
  if (ts.isTemplateExpression(n))
    return [n.head, ...n.templateSpans.map((s) => s.literal)].some((p) => CJK.test(p.text));
  return CJK.test(n.text);
}

/** Why a CJK literal is data rather than words, or "" when it is words. */
export function dataReason(n: TextLiteral, sf: ts.SourceFile): string {
  const par = n.parent;
  if (ts.isBinaryExpression(par) && COMPARE.has(par.operatorToken.kind)) return "compare";
  if (ts.isCaseClause(par)) return "case";
  if (ts.isLiteralTypeNode(par)) return "type";
  if (ts.isImportDeclaration(par) || ts.isExportDeclaration(par)) return "module";
  if ((ts.isPropertyAssignment(par) || ts.isPropertySignature(par)) && par.name === n) return "property";
  if (ts.isElementAccessExpression(par) && par.argumentExpression === n) return "property";
  if (ts.isCallExpression(par) || ts.isNewExpression(par)) {
    const callee = par.expression;
    if (ts.isPropertyAccessExpression(callee) && DATA_METHODS.test(callee.name.text)) return "match";
    if (ts.isIdentifier(callee) && callee.text === "RegExp") return "match";
  }
  const lines = sf.text.split("\n");
  const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line;
  if (/i18n-ignore/.test(lines[line] ?? "") || /^\s*\/\/.*i18n-ignore/.test(lines[line - 1] ?? ""))
    return "ignored";
  return "";
}

export interface Found {
  node: TextLiteral;
  line: number;
}

/** Every CJK word literal of a file, outermost first, nested ones inside `${}` too (source order). */
export function findWords(sf: ts.SourceFile): Found[] {
  const out: Found[] = [];
  const visit = (n: ts.Node) => {
    if (isTextLiteral(n) && hasCjk(n) && !dataReason(n, sf)) {
      out.push({ node: n, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1 });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

export function parse(path: string, text: string): ts.SourceFile {
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/**
 * HTML text and translatable attributes with CJK that nothing fills in: a text
 * node counts unless its own element has `data-i18n`; an attribute counts
 * unless the element has `data-i18n-<attr>`. Inside `data-i18n-ignore` (e.g. a
 * bilingual <noscript>) nothing counts.
 */
export function htmlWords(html: string): string[] {
  const out: string[] = [];
  const VOID = /^(area|base|br|col|embed|hr|img|input|link|meta|source|track|wbr)$/i;
  const stack: string[] = [];
  const ignored = () => stack.some((a) => /\bdata-i18n-ignore\b/.test(a));
  for (const m of html.replace(/<!--[\s\S]*?-->/g, "").matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*)>|([^<]+)/g)) {
    if (m[4] !== undefined) {
      const text = m[4].trim();
      if (text && CJK.test(text) && !ignored() && !/\bdata-i18n="/.test(stack[stack.length - 1] ?? ""))
        out.push(text);
      continue;
    }
    if (m[1]) {
      stack.pop();
      continue;
    }
    const attrs = m[3] ?? "";
    if (!ignored() && !/\bdata-i18n-ignore\b/.test(attrs))
      for (const a of attrs.matchAll(/\s(aria-label|placeholder|title|alt)="([^"]*)"/g)) {
        const attr = a[1] as string;
        if (CJK.test(a[2] ?? "") && !new RegExp(`\\bdata-i18n-${attr}="`).test(attrs))
          out.push(a[2] as string);
      }
    if (!VOID.test(m[2] ?? "") && !attrs.trim().endsWith("/")) stack.push(attrs);
  }
  return out;
}
