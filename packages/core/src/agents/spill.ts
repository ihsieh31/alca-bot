/**
 * Inline / spill (plan v4): a worker's result goes into the router's context
 * whole only when it is small. A large one is kept in the store (`spills`)
 * and the router sees a short summary plus the spill's id; the `recall`
 * tool fetches it, a page at a time, on demand.
 */

export interface ResultShape {
  mode: "inline" | "spill";
  /** What the router's context gets: the whole text (inline) or a summary (spill). */
  summary: string;
  /** Characters of the whole result (code points). */
  chars: number;
}

const len = (s: string) => [...s].length;
const take = (s: string, n: number) => [...s].slice(0, n).join("");

/**
 * A short extractive summary: the conclusion (the last paragraph that says
 * something), cut at a sentence end when one is near the limit. No model call,
 * so spilling costs nothing; the router recalls the rest when it needs it.
 */
export function summarize(text: string, maxChars: number): string {
  const paras = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  const pick = paras.at(-1) ?? text.trim();
  if (len(pick) <= maxChars) return pick;
  const cut = take(pick, maxChars);
  const end = Math.max(...["。", "！", "？", ". ", "；", "\n"].map((m) => cut.lastIndexOf(m)));
  return end > maxChars * 0.5 ? cut.slice(0, end + 1).trim() : `${cut.trim()}…`;
}

export function shapeResult(text: string, o: { inlineChars: number; summaryChars: number }): ResultShape {
  const chars = len(text);
  if (chars <= o.inlineChars) return { mode: "inline", summary: text, chars };
  return { mode: "spill", summary: summarize(text, o.summaryChars), chars };
}

/** One page of a long text, with where the next page starts (code-point offsets). */
export function page(
  text: string,
  offset: number,
  size: number,
): { body: string; next?: number; total: number } {
  const chars = [...text];
  const start = Math.max(0, Math.min(offset, chars.length));
  const end = Math.min(chars.length, start + size);
  return {
    body: chars.slice(start, end).join(""),
    total: chars.length,
    ...(end < chars.length ? { next: end } : {}),
  };
}
