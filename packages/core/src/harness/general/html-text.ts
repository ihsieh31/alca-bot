/**
 * Plan §5: a page's HTML as plain text for `web_fetch` — no scripts, styles
 * or markup; block elements become line breaks; entities decoded. Not a
 * renderer: good enough for a model to read a page.
 */

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  laquo: "«",
  raquo: "»",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n =
        e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

const BLOCK =
  /<\/?(p|div|section|article|header|footer|nav|aside|main|h[1-6]|li|ul|ol|tr|table|blockquote|pre|br|hr|dt|dd|figure|figcaption)\b[^>]*>/gi;

export function htmlToText(html: string): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim();
  const body = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|template|svg|head|title)\b[\s\S]*?<\/\1>/gi, "")
    .replace(BLOCK, "\n")
    .replace(/<td\b[^>]*>/gi, "\t")
    .replace(/<[^>]+>/g, "");
  const text = decodeEntities(body)
    .replace(/[ \t\f\v\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
  return title ? `${decodeEntities(title)}\n\n${text}` : text;
}
