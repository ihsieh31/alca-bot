import { daysUntil, LIFE_IMPORTANCE, type LifeCategory } from "@alca/memory";
import type { Situation } from "./situation.ts";

/**
 * Care moments, step 3: the decision. Restraint is the default: the answer
 * is "nothing extra" unless every hard gate passes and one timeline item
 * scores above the threshold. At most one item is chosen; every decision
 * carries a fixed reason word, logged for the metrics.
 *
 *   score = importance(category) × careProximity(days away) × careRelevance(moment) × weight(feedback)
 *
 * The thresholds come from the analysis in docs/design/CARE-MOMENTS.md §4.
 */

/** Hours ahead an event may be to count (today, tomorrow, the day after). */
export const WINDOW_HOURS = 72;
/** The lowest score that may become a care line. */
export const SCORE_MIN = 0.5;
/** One care line of a kind per thread within this many hours. */
export const THREAD_COOLDOWN_HOURS = 18;
/** An item brought up anywhere is not brought up again within this many hours. */
export const RECENT_MENTION_HOURS = 24;

/** By local days away: today, tomorrow, the day after, three days. */
const PROXIMITY = [1, 1, 0.85, 0.6] as const;

export interface TimelineItem {
  memoryId: string;
  category: LifeCategory;
  title: string;
  /** Local day YYYY-MM-DD in the item's zone. */
  date: string;
  time?: string;
  timeZone: string;
  /** Start instant (or 23:59 local when no time was said). ISO. */
  at: string;
}

export interface CandidateItem extends TimelineItem {
  /** Said by either side in this thread already. */
  mentionedInThread: boolean;
  /** Mentioned or shown in any thread within RECENT_MENTION_HOURS. */
  mentionedRecently: boolean;
  /** The person asked not to hear about this kind (or this item). */
  suppressed: boolean;
}

export type CareReason =
  | "not-a-moment"
  | "memory-off"
  | "heavy"
  | "question-pending"
  | "suppressed"
  | "thread-cooldown"
  | "no-event"
  | "below-threshold"
  | "chosen"
  | "chosen-rest";

/** Why one item did not make it (or `chosen`). */
export type ItemVerdict =
  | "chosen"
  | "heavy-item"
  | "past"
  | "too-far"
  | "already-mentioned"
  | "recently-mentioned"
  | "suppressed"
  | "thread-cooldown"
  | "below-threshold"
  | "runner-up";

export type CareDecisionKind = "none" | "closing" | "event" | "rest";

export interface ChosenItem extends TimelineItem {
  daysAway: number;
}

export interface CareDecision {
  kind: CareDecisionKind;
  reason: CareReason;
  /** Worth logging: the person was leaving or the exchange ended. */
  moment: boolean;
  item?: ChosenItem;
  score?: number;
  /** A rest line is allowed (night, the person is going to sleep). */
  rest: boolean;
  scored: Array<{ memoryId: string; category: string; score: number; verdict: ItemVerdict }>;
}

export interface PolicyInput {
  situation: Situation;
  now: Date;
  timeZone: string;
  items: readonly CandidateItem[];
  /** Care lines already shown in this thread within THREAD_COOLDOWN_HOURS. */
  shownInThread: { event: boolean; rest: boolean };
  /** 「別再關心我這些」: no care lines at all. */
  suppressedAll?: boolean;
  restSuppressed?: boolean;
  /** Per category (and `rest`), from the person's reactions; default 1. */
  weights?: Readonly<Record<string, number>>;
  memoryOff?: boolean;
}

export function careProximity(daysAway: number): number {
  return daysAway < 0 ? 0 : (PROXIMITY[daysAway] ?? 0);
}

/** How well the moment suits a personal line: a goodbye more than an exchange that just ended. */
export function careRelevance(s: Situation): number {
  if (s.closing) return s.night ? 1 : 0.9;
  if (s.endOfExchange) return 0.7;
  return 0;
}

function verdictOf(
  c: CandidateItem,
  p: PolicyInput,
): { verdict: ItemVerdict; score: number; daysAway: number } {
  const daysAway = daysUntil(c.date, p.now, c.timeZone || p.timeZone);
  const importance = LIFE_IMPORTANCE[c.category] ?? 0;
  const hoursAway = (Date.parse(c.at) - p.now.getTime()) / 3600_000;
  const score =
    importance * careProximity(daysAway) * careRelevance(p.situation) * (p.weights?.[c.category] ?? 1);
  const v = (verdict: ItemVerdict) => ({ verdict, score, daysAway });
  if (importance <= 0) return v("heavy-item");
  if (hoursAway <= 0 || daysAway < 0) return v("past");
  // No time said and it is today: past noon it may well be over.
  if (!c.time && daysAway === 0 && p.situation.hour >= 12) return v("past");
  if (hoursAway > WINDOW_HOURS) return v("too-far");
  if (c.suppressed) return v("suppressed");
  if (c.mentionedInThread) return v("already-mentioned");
  if (c.mentionedRecently) return v("recently-mentioned");
  if (p.shownInThread.event) return v("thread-cooldown");
  if (score < SCORE_MIN) return v("below-threshold");
  return v("chosen");
}

/** The care decision for one turn. Pure: the same input gives the same decision. */
export function decideCare(p: PolicyInput): CareDecision {
  const s = p.situation;
  const moment = !!s.closing || s.endOfExchange || s.lingering;
  const base = { moment, rest: false, scored: [] as CareDecision["scored"] };
  const quiet = (reason: CareReason): CareDecision => ({
    ...base,
    kind: s.closing ? "closing" : "none",
    reason,
  });
  if (!moment) return { ...base, kind: "none", reason: "not-a-moment" };
  if (p.memoryOff) return quiet("memory-off");
  if (s.heavy) return quiet("heavy");
  if (p.suppressedAll) return quiet("suppressed");
  if (s.closing && s.question) return quiet("question-pending");
  const restOk = s.night && !p.restSuppressed && !p.shownInThread.rest;
  // Still here after saying good night: at most one line, about rest.
  if (s.lingering)
    return restOk ? { ...base, kind: "rest", reason: "chosen-rest", rest: true } : quiet("thread-cooldown");
  const scored = p.items.map((c) => ({ c, ...verdictOf(c, p) }));
  const ok = scored.filter((x) => x.verdict === "chosen").sort((a, b) => b.score - a.score);
  const best = ok[0];
  const out: CareDecision["scored"] = scored.map((x) => ({
    memoryId: x.c.memoryId,
    category: x.c.category,
    score: Math.round(x.score * 1000) / 1000,
    verdict: x.verdict === "chosen" && x !== best ? "runner-up" : x.verdict,
  }));
  const rest = restOk && s.closing === "sleep";
  if (best) {
    const { mentionedInThread: _a, mentionedRecently: _b, suppressed: _c, ...item } = best.c;
    return {
      ...base,
      kind: "event",
      reason: "chosen",
      rest,
      scored: out,
      item: { ...item, daysAway: best.daysAway },
      score: best.score,
    };
  }
  if (rest) return { ...base, kind: "rest", reason: "chosen-rest", rest: true, scored: out };
  const why: CareReason = scored.some((x) => x.verdict === "thread-cooldown")
    ? "thread-cooldown"
    : scored.some((x) => x.verdict === "suppressed")
      ? "suppressed"
      : scored.some((x) => x.verdict === "below-threshold")
        ? "below-threshold"
        : "no-event";
  return { ...base, kind: s.closing ? "closing" : "none", reason: why, scored: out };
}
