import type { CareLogRecord, CareReaction } from "@alca/store";

/**
 * Care moments, step 6: the feedback loop. After a care line was shown, the
 * person's next message in that thread is its reaction: thanks or warmth
 * (positive), 「別再提這種」 (negative, and a standing suppression), anything
 * else (ignored; also when no next message comes within 12 hours). The
 * reactions move a per-category weight the decision policy multiplies in, and
 * give the precision numbers in `careMetrics`.
 */

/** A shown line nobody answered within this many hours counts as ignored. */
export const REACTION_WINDOW_HOURS = 12;
/** Reactions older than this do not move the weights. */
export const WEIGHT_DAYS = 90;

const POSITIVE =
  /謝謝|謝啦|感謝|會的|好喔|好der|晚安|你也是|你也早點|哈哈|❤|♥|🥰|😊|🙏|加油|\bthanks?\b|\bthank you\b|\bthx\b|\bwill do\b|\byou too\b|\bnight\b|\bappreciate/iu;
/** 「別再提這種」「不用提醒我考試」「stop reminding me」. */
const NEGATIVE =
  /(?:別|不要|不用|不必)(?:再)?(?:提醒|提|說|講|關心|管)|少提|很煩|好煩|多管閒事|不需要你提醒|\bstop (?:reminding|mentioning|bringing)\b|\bdon'?t (?:remind|mention|bring (?:it|that) up)\b|\bnone of your business\b|\bplease don'?t\b/iu;

/** The person's reaction to the care line just shown, from their next message. */
export function reactionOf(text: string): CareReaction {
  if (NEGATIVE.test(text)) return "negative";
  if (POSITIVE.test(text)) return "positive";
  return "ignored";
}

/** 「不用關心我」「別再提醒我睡覺」「stop reminding me about exams」: a care suppression in a message (no shown line needed). */
export function careSuppression(text: string): boolean {
  return /不用關心我|別管我|別再(?:提醒|叫)我(?:去)?(?:睡|休息|考試|比賽)|不要再(?:提醒|叫)我(?:去)?(?:睡|休息|考試|比賽)|\bstop reminding me\b|\bstop telling me to (?:sleep|rest)\b/iu.test(
    text,
  );
}

/**
 * Per-category weights from the shown lines' reactions: start at 1, +0.1 per
 * positive, −0.1 per ignored, −0.3 per negative, kept in [0.5, 1.2]. A
 * category with no history weighs 1.
 */
export function categoryWeights(shown: readonly CareLogRecord[], now: Date): Record<string, number> {
  const acc: Record<string, number> = {};
  for (const r of shown) {
    if (r.kind !== "shown" || !r.category) continue;
    const reaction =
      r.reaction ??
      (now.getTime() - Date.parse(r.createdAt) > REACTION_WINDOW_HOURS * 3600_000 ? "ignored" : null);
    if (!reaction) continue;
    const step = reaction === "positive" ? 0.1 : reaction === "negative" ? -0.3 : -0.1;
    acc[r.category] = (acc[r.category] ?? 1) + step;
  }
  for (const k of Object.keys(acc))
    acc[k] = Math.min(1.2, Math.max(0.5, Math.round((acc[k] ?? 1) * 100) / 100));
  return acc;
}

export interface CareMetrics {
  /** Moments looked at (the person was leaving, or the exchange ended). */
  moments: number;
  /** Care lines that reached the person. */
  shown: number;
  positive: number;
  negative: number;
  ignored: number;
  /** Shown lines still inside the reaction window. */
  pending: number;
  /** positive ÷ (positive + negative + ignored); undefined before any reaction. */
  precision?: number;
  /** Why the moments that got no line got none. */
  quietReasons: Record<string, number>;
}

/** Telemetry over a window of the care log (like 主動留意's precision metrics). */
export function careMetrics(rows: readonly CareLogRecord[], now: Date): CareMetrics {
  const m: CareMetrics = {
    moments: 0,
    shown: 0,
    positive: 0,
    negative: 0,
    ignored: 0,
    pending: 0,
    quietReasons: {},
  };
  for (const r of rows) {
    if (r.kind === "decision") {
      m.moments++;
      if (r.reason !== "chosen" && r.reason !== "chosen-rest")
        m.quietReasons[r.reason] = (m.quietReasons[r.reason] ?? 0) + 1;
    } else if (r.kind === "shown") {
      m.shown++;
      const old = now.getTime() - Date.parse(r.createdAt) > REACTION_WINDOW_HOURS * 3600_000;
      const reaction = r.reaction ?? (old ? "ignored" : null);
      if (reaction) m[reaction]++;
      else m.pending++;
    }
  }
  const judged = m.positive + m.negative + m.ignored;
  if (judged) m.precision = Math.round((m.positive / judged) * 1000) / 1000;
  return m;
}
