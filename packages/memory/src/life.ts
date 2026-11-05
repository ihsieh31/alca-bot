import { type LocalDay, localToday, resolveDay, zonedInstant } from "./applies.ts";

/**
 * Care moments, step 1 (capture): the person's life timeline. A dated
 * personal event they mention in passing (「後天下午兩點半要考鋼琴檢定」
 * 「I fly to Osaka on Friday」) becomes its own memory, separate from
 * preferences: what it is, its kind, the absolute local day (and time, when
 * said) in the person's zone, resolved when it is heard, so 「後天」 never
 * goes stale. The memory keeps the turn it came from (its source); when the
 * care pipeline brought it up is kept in the care log, not here.
 *
 * Plain rules, no model, Chinese and English. A sentence that is a question,
 * a wish or a hypothetical is not an event.
 */

export const LIFE_CATEGORIES = [
  "exam",
  "contest",
  "interview",
  "trip",
  "birthday",
  "performance",
  "ceremony",
  "medical",
  "deadline",
] as const;
export type LifeCategory = (typeof LIFE_CATEGORIES)[number];

/**
 * How much an event matters to the person's day, 0..1. `medical` is heavy
 * (never a cheerful line); `deadline` is work the 主動留意 add-on tracks,
 * below the care threshold on purpose.
 */
export const LIFE_IMPORTANCE: Readonly<Record<LifeCategory, number>> = {
  exam: 1,
  contest: 1,
  interview: 1,
  trip: 0.8,
  performance: 0.8,
  birthday: 0.7,
  ceremony: 0.6,
  medical: 0,
  deadline: 0.4,
};

/** First match wins: the more specific kinds come first. */
const KIND_WORDS: ReadonlyArray<[LifeCategory, RegExp]> = [
  ["medical", /手術|開刀|住院|化療|看診|回診|\bsurgery\b|\boperation\b|\bchemo/iu],
  [
    "contest",
    /初選|複選|決賽|比賽|競賽|奧林匹亞|物奧|數奧|化奧|生奧|黑客松|\bolympiad|\bcompetition|\btournament|\bhackathon/iu,
  ],
  ["interview", /面試|\binterview/iu],
  [
    "exam",
    /考試|路考|筆試|口試|術科|期中考|期末考|段考|模擬考|小考|大考|學測|指考|分科|會考|統測|檢定|英檢|多益|托福|雅思|國考|^考|要考|\bexams?\b|\b(?:driving|road) test\b|\bfinals?\b|\bmidterms?\b|\bSAT\b|\bGRE\b|\bIELTS\b|\bTOEFL\b/iu,
  ],
  ["birthday", /生日|\bbirthday/iu],
  [
    "trip",
    /出國|旅行|旅遊|出遊|班機|航班|搭機|飛(?:往|去|到)|\bflight\b|\bfly(?:ing)? to\b|\btrip\b|\bvacation\b/iu,
  ],
  [
    "performance",
    /發表會|上台|演講|表演|演出|成果展|\bpresentation\b|\brecital\b|\bgive a talk\b|\bdemo day\b/iu,
  ],
  ["ceremony", /婚禮|畢業典禮|典禮|\bwedding\b|\bgraduation\b/iu],
  ["deadline", /截止|到期|要交|交報告|繳費|\bdeadline\b|\bdue\b|\bsubmit/iu],
];

const QUESTION = /[?？]$|嗎$|是不是|要不要|會不會|幾點|什麼時候|\bwhen\b|\bwhat\b|\bhow\b/iu;
const NOT_EVENT =
  /希望|但願|如果|假如|要是|假設|考完|比完|結束了|完了|已經|剛剛|\bhope\b|\bwish\b|\bif\b|\bwent\b|\bwas\b|\bfinished\b|\bdid\b/iu;
const CANCEL =
  /取消|不考了|不去了|不比了|不辦了|延期|改期|延後|\bcancel(?:l?ed)?\b|\bcalled off\b|\bpostponed\b/iu;

const MOVED = /延期到|改期到|延後到|改到|延到|\b(?:moved|postponed) to\b/giu;
const TIME_WORDS =
  /(?:上午|早上|中午|下午|晚上|傍晚|凌晨)?\s*\d{1,2}\s*(?:[:：]\s*\d{2}|點(?:半|\s*\d{1,2}\s*分?)?)|\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\bat \d{1,2}(?::\d{2})?\b/giu;
const DAY_WORDS =
  /\d{1,2}\s*月\s*\d{1,2}\s*[日號]?|(?<![\d/])\d{1,2}\/\d{1,2}(?![\d/])|[（(][一二三四五六日天][)）]|大後天|後天|明天|明早|明晚|今天|今晚|(?:下|這|本)?(?:週|星期|禮拜)[一二三四五六日天]|\b(?:on|this|next)\s+\w+day\b|\bday after tomorrow\b|\btomorrow\b|\btoday\b|\btonight\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?\b/giu;
const FILLER =
  /^(?:我們?|我的|的|要|會|得|就|那天|當天|有個|有一個|有|是|去|在|記得|參加|考|飛|搭)+|(?:了|啦|喔|哦|耶|呢|唷|嘛|～+|~+)+$/gu;
const EN_FILLER =
  /^(?:i(?:'m| am| have| will| got)?|we(?:'re| are| have)?|my|have|has|got|going to|gonna|will|to|a|an|the|on|at|for)\s+/iu;

/** 「延期到 11/20」「moved to Friday」: the event got a new day (an update, not a cancel). */
export function isMoved(s: string): boolean {
  return new RegExp(MOVED.source, "iu").test(s);
}

/** A dated personal event, resolved to the person's zone when it was heard. */
export interface LifeEvent {
  title: string;
  category: LifeCategory;
  /** Local day, YYYY-MM-DD. */
  date: string;
  /** Local start time, HH:MM, when the person said one. */
  time?: string;
  timeZone: string;
  /** The instant it starts (or 23:59 local, when no time was said). ISO. */
  at: string;
  quote: string;
}

const pad = (n: number) => String(n).padStart(2, "0");
const dayString = (d: LocalDay) => `${d.y}-${pad(d.m)}-${pad(d.d)}`;

const CJK_DIGIT: Readonly<Record<string, number>> = {
  零: 0,
  一: 1,
  二: 2,
  兩: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

/** 「一」→1, 「十二」→12, 「二十五」→25 (up to 59). */
function cjkNumber(w: string): number | undefined {
  const m = /^([一二兩三四五]?)十([一二三四五六七八九]?)$|^([零一二兩三四五六七八九])$/u.exec(w);
  if (!m) return undefined;
  if (m[3]) return CJK_DIGIT[m[3]];
  return (m[1] ? (CJK_DIGIT[m[1]] ?? 1) : 1) * 10 + (m[2] ? (CJK_DIGIT[m[2]] ?? 0) : 0);
}

/** 「一點半」「十點十五分」 → 「1點半」「10點15分」, so the clock rule reads them. */
function cjkClock(s: string): string {
  return s.replace(/([零一二兩三四五六七八九十]{1,3})(?=\s*[點分])/gu, (w) => String(cjkNumber(w) ?? w));
}

/** 「下午一點半」「13:30」「1:30 pm」 → 13:30. Undefined = no time said. */
export function parseClock(text: string): { hh: number; mm: number } | undefined {
  const s = cjkClock(text);
  const zh =
    /(上午|早上|中午|下午|晚上|傍晚|凌晨)?\s*(\d{1,2})\s*(?:[:：]\s*(\d{2})|點(?:(半)|\s*(\d{1,2})\s*分?)?)/u.exec(
      s,
    );
  const en = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/iu.exec(s) ?? /\bat (\d{1,2}):(\d{2})\b/iu.exec(s);
  let hh: number;
  let mm: number;
  if (zh) {
    hh = Number(zh[2]);
    mm = zh[3] ? Number(zh[3]) : zh[4] ? 30 : zh[5] ? Number(zh[5]) : 0;
    if (/下午|晚上|傍晚/u.test(zh[1] ?? "") && hh < 12) hh += 12;
    if (zh[1] === "中午" && hh < 6) hh += 12;
  } else if (en) {
    hh = Number(en[1]);
    mm = en[2] ? Number(en[2]) : 0;
    const ap = (en[3] ?? "").toLowerCase();
    if (ap === "pm" && hh < 12) hh += 12;
    if (ap === "am" && hh === 12) hh = 0;
  } else return undefined;
  return hh <= 23 && mm <= 59 ? { hh, mm } : undefined;
}

/** The kind of life event a sentence talks about. */
export function lifeCategoryOf(s: string): LifeCategory | undefined {
  return KIND_WORDS.find(([, re]) => re.test(s))?.[0];
}

/** What the event is, without its day, time and filler words (「後天下午考鋼琴檢定」 → 「鋼琴檢定」). */
export function lifeTitle(s: string): string {
  let t = cjkClock(s).replace(DAY_WORDS, " ").replace(TIME_WORDS, " ").replace(MOVED, " ");
  t = t
    .replace(/[，,。.!！、]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (/[\p{Script=Han}]/u.test(t)) {
    t = t.replace(/\s+/gu, "");
    const whole = t;
    for (let i = 0; i < 3; i++) t = t.replace(FILLER, "");
    // 「明天考試」: stripping 考 would leave one character; keep the word.
    if ([...t].length < 2) t = whole.replace(/^(?:我們?|要|會|有)+/u, "");
  } else {
    for (let i = 0; i < 4; i++) t = t.replace(EN_FILLER, "");
    t = t.replace(/(?:\s+(?:at|on|in|got|is|was|has been|will be|for))+$/iu, "");
  }
  return [...t].slice(0, 24).join("").trim();
}

/** The key two mentions of the same event share (supersede / cancel). */
export function lifeKey(title: string): string {
  return title.toLowerCase().replace(/[\s\p{P}]/gu, "");
}

/** The memory subject of an event: `life:<category>:<key>`. */
export function lifeSubject(e: Pick<LifeEvent, "category" | "title">): string {
  return `life:${e.category}:${lifeKey(e.title)}`;
}

/** The memory body: what, then the absolute local day/time and zone, e.g. `鋼琴檢定 (2027-03-12 14:30, Asia/Taipei)`. */
export function lifeBody(e: Pick<LifeEvent, "title" | "date" | "time" | "timeZone">): string {
  return `${e.title} (${e.date}${e.time ? ` ${e.time}` : ""}, ${e.timeZone})`;
}

/** Read a life memory back: its body and subject, as written by `lifeBody` / `lifeSubject`. */
export function parseLifeMemory(
  subject: string,
  body: string,
): { category: LifeCategory; title: string; date: string; time?: string; timeZone: string } | undefined {
  const sm = /^life:([a-z]+):/u.exec(subject);
  const bm = /^(.*) \((\d{4}-\d{2}-\d{2})(?: (\d{2}:\d{2}))?, ([^)]+)\)$/u.exec(body);
  const category = sm?.[1] as LifeCategory | undefined;
  if (!category || !(LIFE_CATEGORIES as readonly string[]).includes(category) || !bm) return undefined;
  return {
    category,
    title: bm[1] ?? "",
    date: bm[2] ?? "",
    ...(bm[3] ? { time: bm[3] } : {}),
    timeZone: bm[4] ?? "",
  };
}

/**
 * The instant a life memory's body names (its day, its time or 23:59, in its
 * zone), for `due_at`; undefined when the body no longer reads as one. Used
 * when the person edits the item in the memory page, so a new day moves it.
 */
export function lifeInstant(subject: string, body: string): string | undefined {
  const p = parseLifeMemory(subject, body);
  if (!p) return undefined;
  const [y, m, d] = p.date.split("-").map(Number);
  const [hh, mm] = (p.time ?? "23:59").split(":").map(Number);
  if (!y || !m || !d || m > 12 || d > 31 || (hh ?? 0) > 23 || (mm ?? 0) > 59) return undefined;
  try {
    const at = zonedInstant(y, m, d, hh ?? 23, mm ?? 59, p.timeZone);
    return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
  } catch {
    return undefined; // an unknown zone typed by hand
  }
}

/**
 * A dated life event in one sentence of the person's, or undefined. The day
 * is resolved now, in the person's zone (「後天」 on Mar 10 → 2027-03-12).
 */
export function parseLifeEvent(sentence: string, now: Date, timeZone = "Asia/Taipei"): LifeEvent | undefined {
  const s = sentence.trim();
  if (s.length < 3 || s.length > 120 || QUESTION.test(s) || NOT_EVENT.test(s)) return undefined;
  if (CANCEL.test(s) && !isMoved(s)) return undefined;
  const category = lifeCategoryOf(s);
  // Deadlines stay the 主動留意 add-on's (`due:` project memories); they are work, not a life moment.
  if (!category || category === "deadline") return undefined;
  const day = resolveDay(s, now, timeZone);
  if (!day) return undefined;
  const clock = parseClock(s.replace(DAY_WORDS, " "));
  const title = lifeTitle(s);
  if ([...title].length < 2) return undefined;
  const at = clock
    ? zonedInstant(day.y, day.m, day.d, clock.hh, clock.mm, timeZone)
    : zonedInstant(day.y, day.m, day.d, 23, 59, timeZone);
  // Something that already happened is not on the timeline.
  if (at.getTime() < now.getTime()) return undefined;
  return {
    title,
    category,
    date: dayString(day),
    ...(clock ? { time: `${pad(clock.hh)}:${pad(clock.mm)}` } : {}),
    timeZone,
    at: at.toISOString(),
    quote: s,
  };
}

/** 「鋼琴檢定取消了」「the trip got called off」: the event the person cancelled (no new day). */
export function parseLifeCancel(sentence: string): { category: LifeCategory; title: string } | undefined {
  const s = sentence.trim();
  if (!CANCEL.test(s) || QUESTION.test(s) || isMoved(s)) return undefined;
  const category = lifeCategoryOf(s);
  if (!category) return undefined;
  return { category, title: lifeTitle(s.replace(CANCEL, " ")) };
}

/** How many local days from `now` to an event's local day (0 = today, 1 = tomorrow). */
export function daysUntil(date: string, now: Date, timeZone: string): number {
  const today = localToday(now, timeZone);
  const [y, m, d] = date.split("-").map(Number);
  const a = Date.UTC(today.y, today.m - 1, today.d);
  const b = Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1);
  return Math.round((b - a) / 86400_000);
}
