/**
 * A new conversation's title from its first message (mac test 2026-11-04: a fixed 24-character
 * cut gave 「用瀏覽器打開 https://example.c」). The first line; a URL reads as its host; when it is
 * still long, cut at the last clause or word break that keeps at least half, and say so with 「…」.
 */
export const TITLE_MAX = 32;

const BREAKS = ["，", "。", "；", "！", "？", "、", ",", ";", " "];

export function threadTitle(text: string, max = TITLE_MAX): string {
  const line = (text.split("\n").find((l) => l.trim()) ?? "").trim();
  const t = line
    .replace(/\bhttps?:\/\/([^\s/?#]+)\S*/giu, (_, host: string) => host.replace(/^www\./i, ""))
    .replace(/\s+/gu, " ")
    .trim();
  const chars = [...t];
  if (chars.length <= max) return t || "新對話";
  const head = chars.slice(0, max).join("");
  const at = Math.max(...BREAKS.map((b) => head.lastIndexOf(b)));
  const cut = at >= head.length / 2 ? head.slice(0, at) : head;
  return `${cut.replace(/[，。；！？、,;:：\s]+$/u, "")}…`;
}
