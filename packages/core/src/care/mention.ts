/**
 * Care moments: does a text talk about a timeline item, and which sentences of
 * a reply are care lines. Shared by the decision policy (already mentioned in
 * this thread?), the post-check (how many care lines, about what) and the
 * feedback loop (was the line shown?). Plain string rules, no model.
 */

const CJK = /[\p{Script=Han}]/u;
const norm = (s: string) => s.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");

function bigrams(s: string): string[] {
  const c = [...s];
  if (c.length < 2) return c.length ? [s] : [];
  const out: string[] = [];
  for (let i = 0; i < c.length - 1; i++) out.push(`${c[i]}${c[i + 1]}`);
  return out;
}

const EN_STOP = new Set(["the", "and", "for", "with", "fly", "flight", "trip", "test", "exam", "my"]);

/**
 * True when `text` talks about the item titled `title`: for Chinese, most of
 * the title's character pairs appear in the text (「鋼琴檢定」 in 「後天的鋼琴檢定
 * 加油」); for English, a significant word of the title appears.
 */
export function mentions(text: string, title: string): boolean {
  const t = norm(title);
  if (!t) return false;
  const body = norm(text);
  if (body.includes(t)) return true;
  if (CJK.test(t)) {
    const grams = bigrams(t);
    if (grams.length < 2) return false;
    const hit = grams.filter((g) => body.includes(g)).length;
    return hit / grams.length >= 0.6;
  }
  const words = title
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((w) => w.length >= 4 && !EN_STOP.has(w));
  const lower = text.toLowerCase();
  return words.some((w) => new RegExp(`\\b${w}`, "u").test(lower));
}

/** 「去睡吧」「早點休息」「get some rest」: a line telling the person to rest. */
export const REST_LINE =
  /快去睡|去睡吧|早點睡|早點休息|好好休息|好好睡|睡個好覺|好眠|休息吧|\bget some (?:rest|sleep)\b|\bsleep well\b|\brest up\b|\bget to bed\b/iu;

/** 「加油」「祝…順利」「good luck」: the shape of a wish for an event. */
export const WISH_LINE =
  /加油|順利|祝你|祝您|好運|一路順風|玩得開心|生日快樂|\bgood luck\b|\bbreak a leg\b|\bhave a great\b|\benjoy\b|\bsafe travels\b|\bhappy birthday\b|\byou(?:'ve| have) got this\b/iu;

/** Naming where a memory came from (「我記得你說過」「from your calendar」). */
export const SOURCE_LINE =
  /我記得你(?:說|提)|你(?:之前|上次|曾經)(?:說|提)|根據(?:你的)?(?:記憶|紀錄|行事曆)|(?:你的)?(?:行事曆|日曆|信|郵件|記憶)(?:裡|上)(?:寫|看到|顯示)|\bI remember (?:you|that you)\b|\byou (?:mentioned|told me|said) (?:earlier|before)\b|\b(?:from|in|on) your (?:calendar|email|inbox|notes|memory)\b|\baccording to (?:your|my) (?:notes|memory|records)\b/iu;

/** Closing quotes and brackets that belong to the sentence before them (「好嗎？」 stays whole). */
const CLOSERS = '」』）)"”’〉》】';
const SENTENCE_END = new RegExp(
  `(?<=[。！？!?][${CLOSERS}]*)(?![。！？!?${CLOSERS}])|(?<=\\n)|(?<=[.;]\\s)`,
  "u",
);

/** A fenced code block (```…```) is one unit: never split inside, never dropped by a care rule. */
export const FENCE = /^\s*```/u;

/**
 * The sentences of a reply, each with its end punctuation (joined back, they
 * give the reply exactly). Splits after 。！？!? (a run like 「！？」 and the
 * closing quote after it stay with the sentence), after a newline, and after
 * 「. 」/「; 」. A fenced code block stays one piece.
 */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  const parts = text.split(/(```[\s\S]*?(?:```|$))/u);
  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith("```")) out.push(part);
    else out.push(...part.split(SENTENCE_END).filter((x) => x.length > 0));
  }
  return out;
}
