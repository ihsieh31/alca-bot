import { createHmac } from "node:crypto";
import { segment } from "@alca/store";

/**
 * Tombstones: what the person told Alca to forget, kept only as keyed
 * hashes so extraction can recognise it again without storing the text.
 * The key is per store (`memory_meta.tombstone_key`); shingles are 8 hex
 * chars of an HMAC per token, so similar wording still matches.
 *
 * Limit (documented in SECURITY.md): with the store file *and* its key, a
 * dictionary of common words can test which tokens a tombstone contains.
 */

/** Words that say nothing about the content (who, filler). */
const FILLER =
  /使用者|用戶|我們|我的|我|你|請|幫我|麻煩|一下|關於|有關|的事|的|了|啦|喔|哦|呢|吧|嗎|\b(?:that|about|the|my|i|me|a|an)\b/giu;

export function normalizeForMatch(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(FILLER, " ").replace(/\s+/g, " ").trim();
}

/** Content tokens: CJK bigrams and latin words (single characters dropped). */
export function contentTokens(text: string): string[] {
  return [...new Set(segment(normalizeForMatch(text)).filter((t) => [...t].length >= 2))];
}

const mac = (key: string, s: string) => createHmac("sha256", key).update(s).digest("hex");

export function tombstoneDigest(key: string, text: string): string {
  return mac(key, `d:${normalizeForMatch(text)}`);
}

export function tombstoneShingles(key: string, text: string): string[] {
  return contentTokens(text)
    .map((t) => mac(key, `s:${t}`).slice(0, 8))
    .sort();
}

/**
 * Does a candidate repeat something forgotten? Either the same normalized
 * text, or most of the forgotten tokens appear in it (or most of its tokens
 * are forgotten ones), with at least two tokens in common.
 */
export function matchesTombstone(
  key: string,
  candidate: string,
  tomb: { digest: string; shingles: readonly string[] },
): boolean {
  if (tombstoneDigest(key, candidate) === tomb.digest) return true;
  const t = new Set(tomb.shingles);
  const c = new Set(tombstoneShingles(key, candidate));
  if (t.size === 0 || c.size === 0) return false;
  let both = 0;
  for (const s of c) if (t.has(s)) both++;
  if (both < Math.min(2, t.size)) return false;
  return both / t.size >= 0.6 || both / c.size >= 0.6;
}
