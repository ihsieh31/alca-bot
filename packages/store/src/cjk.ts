/**
 * CJK-friendly segmentation for SQLite FTS5 (unicode61 tokenizer).
 *
 * unicode61 treats a run of Han characters as ONE token, so "長期記憶系統"
 * would only match the exact whole run. We pre-segment in app code:
 * every CJK run becomes overlapping bigrams plus its last character as a
 * unigram ("長期 期記 記憶 憶系 系統 統"). Queries are segmented the same
 * way and wrapped as FTS phrases, so any 2+ char substring matches, and a
 * single character matches via a prefix query.
 */

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const WORD = /[\p{L}\p{N}]/u;

type Run = { cjk: boolean; text: string };

function runs(input: string): Run[] {
  const out: Run[] = [];
  let cur: Run | undefined;
  for (const ch of input.normalize("NFKC").toLowerCase()) {
    if (!WORD.test(ch)) {
      cur = undefined;
      continue;
    }
    const cjk = CJK.test(ch);
    if (cur && cur.cjk === cjk) cur.text += ch;
    else {
      cur = { cjk, text: ch };
      out.push(cur);
    }
  }
  return out;
}

/** Tokens for one CJK run: overlapping bigrams + trailing unigram. */
function cjkTokens(text: string): string[] {
  const chars = [...text];
  if (chars.length === 1) return chars;
  const out: string[] = [];
  for (let i = 0; i < chars.length - 1; i++) out.push(`${chars[i]}${chars[i + 1]}`);
  out.push(chars[chars.length - 1] as string);
  return out;
}

/** Segment text into FTS tokens (space separated in the indexed column). */
export function segment(input: string): string[] {
  return runs(input).flatMap((r) => (r.cjk ? cjkTokens(r.text) : [r.text]));
}

/**
 * R7.4: turns a token into its keyed form (`Sealer.ftsToken`: HMAC-SHA256
 * with the FTS sub-key, first 10 hex chars). With a keyer the indexed column
 * holds no readable word.
 */
export interface FtsKeyer {
  ftsToken(token: string): string;
}

/**
 * Value to store in an FTS-indexed column. Keyed: the same tokens in the
 * same order (so phrases still match), then one unigram per CJK character
 * (a single-character query cannot use a prefix match on keyed tokens).
 */
export function toSearchTerms(input: string, keyer?: FtsKeyer): string {
  const tokens = segment(input);
  if (!keyer) return tokens.join(" ");
  const unigrams = runs(input).flatMap((r) => (r.cjk && [...r.text].length > 1 ? [...r.text] : []));
  return [...tokens, ...unigrams].map((t) => keyer.ftsToken(t)).join(" ");
}

function quote(tokens: string[]): string {
  return `"${tokens.join(" ").replaceAll('"', '""')}"`;
}

/**
 * Build an FTS5 MATCH expression. Whitespace-separated query chunks are ANDed;
 * each chunk becomes a phrase over its segmented tokens. A single CJK char or
 * a short latin chunk uses a prefix match. Returns null for an empty query.
 */
export function toMatchQuery(query: string, keyer?: FtsKeyer): string | null {
  const parts: string[] = [];
  const k = (ts: string[]) => (keyer ? ts.map((t) => keyer.ftsToken(t)) : ts);
  for (const chunk of query.split(/\s+/u)) {
    const tokens = segment(chunk);
    if (tokens.length === 0) continue;
    const single = tokens.length === 1 ? (tokens[0] as string) : undefined;
    if (single !== undefined && ([...single].length === 1 || !CJK.test(single))) {
      // Keyed tokens have no prefix: a single character or a latin word matches whole (R7.4).
      parts.push(keyer ? quote(k(tokens)) : `${quote(tokens)}*`);
    } else {
      // Drop the trailing unigram: it is redundant inside a phrase and would
      // prevent a match when the query ends mid-run in the indexed text.
      const last = runs(chunk).at(-1);
      const trimmed = last?.cjk && tokens.length > 1 ? tokens.slice(0, -1) : tokens;
      parts.push(quote(k(trimmed)));
    }
  }
  return parts.length ? parts.join(" AND ") : null;
}

/**
 * Loose MATCH expression for recall: any content token (CJK bigrams, latin
 * words) may match, bm25 ranks items with more hits higher. Single CJK
 * characters are dropped when longer tokens exist. Null for an empty query.
 */
export function toAnyMatchQuery(query: string, keyer?: FtsKeyer): string | null {
  const tokens = [...new Set(segment(query))];
  const long = tokens.filter((t) => [...t].length >= 2);
  const use = (long.length ? long : tokens).slice(0, 32);
  if (!use.length) return null;
  return use.map((t) => `"${(keyer ? keyer.ftsToken(t) : t).replaceAll('"', '""')}"`).join(" OR ");
}
