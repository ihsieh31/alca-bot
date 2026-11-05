/**
 * Care moments, step 2: the situation of one turn, computed by code (no
 * model) from the person's message, the clock in their zone and the thread
 * so far. The decision policy reads only this, so the same inputs always give
 * the same decision.
 */

export type ReplyLanguage = "zh" | "en";

/** How the person is ending, if they are. */
export type Closing = "sleep" | "bye" | null;

export interface HistoryMessage {
  role: string;
  content: string;
  createdAt: string;
}

export interface Situation {
  /** Local hour 0..23 in the person's zone. */
  hour: number;
  minute: number;
  /** 22:00–04:59 local. */
  night: boolean;
  /** The person says they are going (to sleep, or just going). */
  closing: Closing;
  /**
   * The exchange ended on its own: a short decline or acknowledgement after
   * the assistant's last message (「不用」 to an offer, 「好」 to a report).
   */
  endOfExchange: boolean;
  /** Said they were going to sleep within the last hour, and are still here at night. */
  lingering: boolean;
  /** The message asks something (it wants an answer, not a goodbye). */
  question: boolean;
  /** The message asks for work and is not a goodbye. */
  midTask: boolean;
  /** Minutes since this session's first message (messages less than 45 min apart). */
  sessionMinutes: number;
  /** Grief, illness, a break-up … in this message or the recent thread. */
  heavy: boolean;
  lang: ReplyLanguage;
}

export interface SituationInput {
  text: string;
  now: Date;
  timeZone: string;
  /** The thread before this message, oldest first. */
  history: readonly HistoryMessage[];
  /** Workers of the thread waiting for the person's approval. */
  waitingApprovals?: number;
  /** Fallback language when the message has no letters. */
  fallbackLang?: ReplyLanguage;
}

/** 「我要睡了」「去睡了」「going to bed」 anywhere in the message. */
const SLEEP =
  /(?<!不|沒|不想)(?:要|先|準備|該|去)睡(?:覺)?|睡覺去|睡了[\s!！。.~～…]*$|晚安|\bgood ?night\b|\bgoing to (?:bed|sleep)\b|\bheading to bed\b|\boff to bed\b|\bgn\b|\bnight night\b/iu;
/** A goodbye at the end of the message (「先這樣」 in the middle of an instruction is not one). */
const BYE_END =
  /(?:先這樣(?:吧|囉|啦|喔)?|今天先到這(?:裡|邊)?(?:吧)?|先到這(?:裡|邊)?(?:吧)?|先下線了?|下線了|我先走了|先閃了?|掰掰?|拜拜|bye(?:\s*bye)?|see you(?: tomorrow| later)?|talk (?:to you )?(?:tomorrow|later)|signing off|that'?s all for (?:today|now)|明天見|我要休息了|先休息了?)[\s!！。.~～…]*$/iu;
const QUESTION =
  /[?？]|嗎[\s。!！~～]*$|\b(?:what|how|why|when|where|which|can you|could you)\b|怎麼|為什麼|多久|幾點|哪裡|什麼時候/iu;
const REQUEST =
  /幫我|請你|麻煩|你(?:先|再|去|把)|改一下|修一下|處理|查一下|做一個|寫一個|\b(?:please|can you|could you|help me|fix|make|write|check)\b/iu;
const DECLINE =
  /^(?:不用|不要|不必|不需要|免了|算了|先不用|先不要|沒關係|no thanks|no|nope|not now|nah)[\s,，.。!！~～]*(?:了|啦|喔|謝謝|thanks)?[\s.。!！~～]*$/iu;
/** 「這樣就好」「沒事了」「that's all」: the person says the task is done. */
const WRAP =
  /^(?:(?:好[，,\s]*)?(?:謝謝|謝啦|感謝)?[，,\s]*(?:這樣就好|這樣就可以|就這樣|沒事了|沒問題了|可以了|搞定了?)|(?:thanks[,\s]*)?(?:that'?s all|that'?s it|all good|nothing else|we'?re done))[\s,，.。!！~～]*(?:了|啦|謝謝|thanks)?[\s.。!！~～]*$/iu;
const DEFER = /^(?:晚上|明天|之後|等等|等一下|再說|改天|later|tomorrow|tonight)/iu;
const HEAVY =
  /過世|去世|離開我們|喪禮|告別式|葬禮|離婚|分手|住院|病危|生病了|罹癌|癌症|難過|憂鬱|想哭|崩潰|\bpassed away\b|\bdied\b|\bfuneral\b|\bdivorce|\bbroke up\b|\bcancer\b|\bdepress|\bhospital/iu;

const SESSION_GAP_MIN = 45;

/** Local hour and minute of a moment in a zone. */
export function localClock(now: Date, timeZone: string): { hour: number; minute: number } {
  const p = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const n = (t: string) => Number(p.find((x) => x.type === t)?.value ?? 0);
  return { hour: n("hour"), minute: n("minute") };
}

export function isNight(hour: number): boolean {
  return hour >= 22 || hour < 5;
}

/** The person's way of leaving in this message, if any. */
export function closingOf(text: string): Closing {
  const t = text.trim();
  if (SLEEP.test(t)) return "sleep";
  if (BYE_END.test(t)) return "bye";
  return null;
}

export function languageOf(text: string, fallback: ReplyLanguage = "zh"): ReplyLanguage {
  if (/[\p{Script=Han}]/u.test(text)) return "zh";
  if (/[A-Za-z]{2,}/u.test(text)) return "en";
  return fallback;
}

export function isHeavy(text: string): boolean {
  return HEAVY.test(text);
}

/** What is left of a closing message once the goodbye words are removed (is a question left?). */
function withoutGoodbye(text: string): string {
  return text.replace(new RegExp(SLEEP.source, "giu"), " ").replace(BYE_END, " ");
}

const len = (s: string) => [...s.trim()].length;

/**
 * 「不用」「這樣就好」「晚上再試」 right after the assistant's last message: the
 * task is done and the person wraps up. A plain 「好」「ok」 is an
 * acknowledgement mid-conversation (after an offer it is a yes), not an end.
 */
export function endsExchange(text: string, history: readonly HistoryMessage[]): boolean {
  const t = text.trim();
  const max = /[\p{Script=Han}]/u.test(t) ? 12 : 24;
  if (!t || len(t) > max || QUESTION.test(t) || REQUEST.test(t)) return false;
  const last = history.at(-1);
  if (last?.role !== "assistant") return false;
  const offered = /[?？]\s*$|嗎[\s。]*$/u.test(last.content.trim());
  if (DECLINE.test(t) || WRAP.test(t)) return true;
  // Putting the offered thing off (「晚上再試」) also ends it for now.
  return offered && DEFER.test(t);
}

function sessionMinutes(history: readonly HistoryMessage[], now: Date): number {
  let start = now.getTime();
  let prev = now.getTime();
  for (let i = history.length - 1; i >= 0; i--) {
    const at = Date.parse(history[i]?.createdAt ?? "");
    if (!Number.isFinite(at) || prev - at > SESSION_GAP_MIN * 60_000) break;
    start = at;
    prev = at;
  }
  return Math.max(0, Math.round((now.getTime() - start) / 60_000));
}

/** The person said they were going to sleep in this thread within the last hour. */
function saidSleepRecently(history: readonly HistoryMessage[], now: Date): boolean {
  return history.some(
    (m) =>
      m.role === "user" &&
      now.getTime() - Date.parse(m.createdAt) <= 60 * 60_000 &&
      closingOf(m.content) === "sleep",
  );
}

export function situationOf(i: SituationInput): Situation {
  const { hour, minute } = localClock(i.now, i.timeZone);
  const night = isNight(hour);
  const closing = closingOf(i.text);
  const rest = closing ? withoutGoodbye(i.text) : i.text;
  const question = QUESTION.test(rest);
  const endOfExchange = !closing && endsExchange(i.text, i.history);
  const lingering = !closing && night && saidSleepRecently(i.history, i.now);
  const recentUser = i.history
    .filter((m) => m.role === "user")
    .slice(-6)
    .map((m) => m.content);
  return {
    hour,
    minute,
    night,
    closing,
    endOfExchange,
    lingering,
    question,
    midTask:
      !closing && !endOfExchange && (question || REQUEST.test(i.text) || (i.waitingApprovals ?? 0) > 0),
    sessionMinutes: sessionMinutes(i.history, i.now),
    heavy: isHeavy(i.text) || recentUser.some(isHeavy),
    lang: languageOf(i.text, i.fallbackLang),
  };
}
