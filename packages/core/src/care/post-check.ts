import { FENCE, mentions, REST_LINE, SOURCE_LINE, splitSentences, WISH_LINE } from "./mention.ts";
import type { CareDecision } from "./policy.ts";

/**
 * Care moments, step 5: the post-check, run by code on the reply the model
 * wrote. It never adds anything; it only removes what breaks the rules:
 *
 *   - a care line about a timeline item the policy did not choose;
 *   - more than one care line (the first allowed one stays);
 *   - a care line that names where the memory came from;
 *   - after a goodbye: a trailing question or a new offer.
 *
 * The reply is changed only by dropping whole sentences, and never down to
 * nothing (an empty result keeps the original).
 */

export type CareViolation =
  | "unchosen-item"
  | "extra-care-line"
  | "cites-source"
  | "question-after-goodbye"
  | "offer-after-goodbye";

export interface PostCheckResult {
  text: string;
  changed: boolean;
  violations: CareViolation[];
  /** Care lines left in the reply: the chosen item, rest. */
  shown: { item: boolean; rest: boolean };
}

/**
 * 「要不要我…」「需要我…嗎」「我可以再幫你…」「want me to…」: an offer of more work.
 * A bare 「要我」 is an offer only as a question: 「你要我改的都改好了」 reports
 * what was done and stays.
 */
const OFFER =
  /要不要(?:我|順便|再)|(?<!不)需要我|我可以(?:幫|再|順便)|想要我|\bwant me to\b|\bshould I\b|\bI can also\b|\bshall I\b|\blet me know if\b/iu;
const OFFER_IF_ASKED = /要我/u;
const ASKS = /[?？][」』）)"”’]*\s*$|嗎[\s。]*$/u;
/** 「別忘了」「記得帶」「提醒你」: a reminder, which is a care line too. */
const REMIND = /別忘|不要忘|記得|提醒你|\bdon'?t forget\b|\bremember to\b|\breminder\b/iu;

export interface PostCheckInput {
  reply: string;
  decision: CareDecision;
  /**
   * Titles of the upcoming timeline items the person did not bring up in this
   * message (to spot one the policy did not choose).
   */
  timelineTitles: readonly string[];
  /** The person is leaving: a goodbye, still here after good night, or wrapping up (「不用」). */
  leaving: boolean;
  /**
   * Titles already talked about earlier in this thread. A plain report about
   * one (「鋼琴檢定的報名表寄出了」) is part of confirming what is handled and
   * stays; a wish, a reminder or a rest line about it is still a care line.
   */
  discussed?: readonly string[];
}

function dropUnpromptedWishes(reply: string, titles: readonly string[]): PostCheckResult {
  const shown = { item: false, rest: false };
  const sentences = splitSentences(reply);
  const keep = sentences.filter(
    (s) => FENCE.test(s) || !(WISH_LINE.test(s) && titles.some((t) => mentions(s, t))),
  );
  const text = keep.join("").replace(/\s+$/u, "");
  if (keep.length === sentences.length || !text.trim())
    return { text: reply, changed: false, violations: [], shown };
  return { text, changed: true, violations: ["unchosen-item"], shown };
}

export function postCheckCare(i: PostCheckInput): PostCheckResult {
  const d = i.decision;
  // Not a moment: a mention of an item may answer the person, but an unprompted wish
  // for one (「明天考試加油」 in the middle of a task) is a false care line.
  if (!d.moment) return dropUnpromptedWishes(i.reply, i.timelineTitles);
  const chosen = d.kind === "event" ? d.item?.title : undefined;
  const others = i.timelineTitles.filter((t) => t && t !== chosen);
  const closing = i.leaving;
  const banned = d.reason === "suppressed";
  const sentences = splitSentences(i.reply);
  const keep: string[] = [];
  const violations = new Set<CareViolation>();
  let careLines = 0;
  const shown = { item: false, rest: false };
  const discussed = i.discussed ?? [];
  // The goodbye tail is the last two sentences with words in them (blank lines do not count).
  const filled = sentences.map((x, idx) => (x.trim() ? idx : -1)).filter((idx) => idx >= 0);
  const tail = new Set(filled.slice(-2));
  sentences.forEach((raw, idx) => {
    const s = raw.trim();
    if (!s || FENCE.test(raw)) {
      keep.push(raw);
      return;
    }
    const careShaped = WISH_LINE.test(s) || REST_LINE.test(s) || REMIND.test(s) || SOURCE_LINE.test(s);
    const aboutOther =
      others.some((t) => mentions(s, t) && (careShaped || !discussed.includes(t))) &&
      !(chosen && mentions(s, chosen));
    const aboutChosen = !!chosen && mentions(s, chosen);
    const isRest = REST_LINE.test(s);
    const isCare = aboutChosen || isRest || (aboutOther && WISH_LINE.test(s));
    if (aboutOther) {
      violations.add("unchosen-item");
      return;
    }
    if (isCare) {
      const allowed = !banned && (aboutChosen ? d.kind === "event" : d.rest || d.kind === "rest");
      if (!allowed && !banned && isRest && !aboutChosen) {
        // A plain 「早點休息」 in a goodbye is part of saying goodnight, not a personal item: keep one.
        if (careLines > 0 || !closing) {
          violations.add("extra-care-line");
          return;
        }
      } else if (!allowed) {
        violations.add("unchosen-item");
        return;
      }
      if (SOURCE_LINE.test(s)) {
        violations.add("cites-source");
        return;
      }
      careLines++;
      if (careLines > 1) {
        violations.add("extra-care-line");
        return;
      }
      if (aboutChosen) shown.item = true;
      if (isRest) shown.rest = true;
    }
    // After a goodbye nothing may ask or offer: drop such sentences from the end of the reply.
    if (closing && tail.has(idx)) {
      if (OFFER.test(s) || (OFFER_IF_ASKED.test(s) && ASKS.test(s))) {
        violations.add("offer-after-goodbye");
        return;
      }
      if (ASKS.test(s)) {
        violations.add("question-after-goodbye");
        return;
      }
    }
    keep.push(raw);
  });
  const text = keep.join("").replace(/\s+$/u, "");
  if (!violations.size || !text.trim())
    return { text: i.reply, changed: false, violations: [...violations], shown };
  return { text, changed: text !== i.reply.replace(/\s+$/u, ""), violations: [...violations], shown };
}
