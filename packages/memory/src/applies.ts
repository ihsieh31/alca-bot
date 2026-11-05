import type { MemoryApplies } from "@alca/store";

/**
 * P14 B2: which kind of action a sentence is about, and the person's
 * standing instructions for a kind of action (「寫信不要提到 X」「買東西一律選可
 * 退款」), suppress rules (「別再提 X」) and deadlines they mention (「11 月 20
 * 日要交報告」). Plain rules, no model; written for Chinese and English.
 */

/** Words that name a kind of action (also used to classify a worker's task). */
export const APPLIES_WORDS: ReadonlyArray<[Exclude<MemoryApplies, "any" | "proactive">, RegExp]> = [
  [
    "send_message",
    /寫信|寄信|回信|封信|寫郵件|寄郵件|e-?mail|郵件|信件|傳訊|發訊息|回訊息|訊息給|寫訊息|\bmessages?\b|\bmail\b|\breply\b/iu,
  ],
  ["publish", /發文|貼文|發布|發佈|發推|po文|\bpost(?:s|ing)?\b|\btweet|\bpublish/iu],
  [
    "purchase",
    /買東西|購買|下單|付款|結帳|網購|購票|(?:幫我|去|要|想)買|買[一兩二三幾個張杯份台支雙件]|買.{0,6}(?:的時候|時)|\bbuy(?:ing)?\b|\bpurchas|\bcheckout\b|\border(?:ing)?\b/iu,
  ],
  ["booking", /訂房|訂位|訂票|訂餐廳|訂機票|預約|預訂|\bbook(?:ing)?\b|\breservation/iu],
  ["code", /寫程式|程式碼|寫code|改code|\bcommit|\bcode\b|\bpull request|\bPR\b/iu],
  ["schedule", /排程|行事曆|排會議|約時間|排行程|\bschedul|\bcalendar|\bmeeting/iu],
];

/** The action kinds a text talks about (a worker's task, a person's message). */
export function appliesOf(text: string): Array<Exclude<MemoryApplies, "any" | "proactive">> {
  return APPLIES_WORDS.filter(([, re]) => re.test(text)).map(([k]) => k);
}

/** A standing instruction: never / always / don't / remember to … */
const DIRECTIVE =
  /不要|不准|不可以|不能|別|勿|禁止|一律|一定要|都要|都用|都選|只用|只選|記得|請先|要先|務必|\bnever\b|\balways\b|\bdon'?t\b|\bdo not\b|\bonly\b|\bmust\b|\bmake sure\b/iu;

export interface ActionRule {
  appliesTo: Array<Exclude<MemoryApplies, "any" | "proactive">>;
  /** A short subject key (same kinds + the instruction's object → supersedes the older one). */
  subject: string;
  body: string;
}

/** 「寫信不要提到我的學校」 → applies to send_message. Undefined when it is not an instruction about an action. */
export function actionRule(sentence: string): ActionRule | undefined {
  const s = sentence.trim().replace(/^我(?=.{2,})/u, "");
  if (s.length < 4 || s.length > 120) return undefined;
  if (!DIRECTIVE.test(s)) return undefined;
  const kinds = appliesOf(s);
  if (!kinds.length) return undefined;
  const obj = s
    .replace(/[，,。.!！]+$/u, "")
    .split(DIRECTIVE)
    .at(-1)
    ?.trim()
    .slice(0, 30);
  return {
    appliesTo: kinds,
    subject: `rule:${kinds.join("+")}:${obj ?? ""}`,
    body: s.replace(/[。.!！]+$/u, ""),
  };
}

const SUPPRESS =
  /^(?:請|以後|之後)?(?:少提|別再提|不要再提|別再建議|不要再建議|不用再提醒|不要再推|別再推|少推)(?:我)?(?:關於|有關)?[:：\s]*(.{1,40}?)(?:了|啦|這類的?事?|的事|的建議)?$/u;
const SUPPRESS_EN =
  /^(?:please\s+)?(?:stop|don'?t keep|no more)\s+(?:suggesting|recommending|bringing up|offering)\s+(.{1,60})$/iu;

/** 「別再提副業」 → the topic the person does not want offered again. */
export function parseSuppress(text: string): Array<{ topic: string; quote: string }> {
  const out: Array<{ topic: string; quote: string }> = [];
  for (const raw of text.split(/[。！!\n；;]+/u)) {
    const s = raw.trim();
    const m = SUPPRESS.exec(s) ?? SUPPRESS_EN.exec(s);
    const topic = m?.[1]?.trim().replace(/[。.!！?？]+$/u, "");
    // 「別再提這類」 is about the offer just made (the offer ledger handles it), not a topic.
    if (
      topic &&
      !/^(?:這|那)(?:類|種|個|些|件)?(?:事|的)?$|^(?:this|that|these|those)(?: kind)?$/iu.test(topic)
    )
      out.push({ topic: topic.slice(0, 40), quote: s });
  }
  return out;
}

// ── deadlines ─────────────────────────────────────────────────

const DUE_VERB =
  /(?<!不)(?:交(?!通|朋友|流)|考(?!慮|量)|繳|報名|截止|到期|續約|續訂|開會|出發|面試|比賽|參加|提交|上台|還款)|deadline|\bdue\b|\bexams?\b|\bsubmit|\brenew|\binterview/iu;
/** Wishes and negations are not deadlines (「希望明天不要下雨」). */
const NOT_DUE = /希望|但願|不要|不用|不必|\bhope\b|\bwish\b/iu;
const WEEKDAY: Record<string, number> = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };

/** Y-M-D of a moment in a zone. */
function ymd(d: Date, timeZone: string): { y: number; m: number; d: number; wd: number } {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    weekday: "short",
  }).formatToParts(d);
  const n = (t: string) => Number(p.find((x) => x.type === t)?.value);
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
    p.find((x) => x.type === "weekday")?.value ?? "",
  );
  return { y: n("year"), m: n("month"), d: n("day"), wd };
}

/** The instant of local Y-M-D hh:mm in a zone. */
export function zonedInstant(
  y: number,
  m: number,
  d: number,
  hh: number,
  mm: number,
  timeZone: string,
): Date {
  const guess = new Date(Date.UTC(y, m - 1, d, hh, mm));
  const back = ymdhm(guess, timeZone);
  const diff = Date.UTC(back.y, back.m - 1, back.d, back.hh, back.mm) - guess.getTime();
  return new Date(guess.getTime() - diff);
}

function ymdhm(d: Date, timeZone: string) {
  const p = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const n = (t: string) => Number(p.find((x) => x.type === t)?.value);
  return { y: n("year"), m: n("month"), d: n("day"), hh: n("hour"), mm: n("minute") };
}

/** A local calendar day. */
export interface LocalDay {
  y: number;
  m: number;
  d: number;
}

/** The local day `n` days after `day`. */
export function addLocalDays(day: LocalDay, n: number): LocalDay {
  const base = new Date(Date.UTC(day.y, day.m - 1, day.d + n));
  return { y: base.getUTCFullYear(), m: base.getUTCMonth() + 1, d: base.getUTCDate() };
}

/** Today in a zone, with its weekday (0 = Sunday). */
export function localToday(now: Date, timeZone: string): LocalDay & { wd: number } {
  return ymd(now, timeZone);
}

const EN_WEEKDAYS = ["sun", "mon", "tues", "wednes", "thurs", "fri", "satur"];
const EN_MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * The local day a sentence names (「11 月 20 日」「後天」「下週三」「this
 * Friday」「Mar 12」), resolved against `now` in `timeZone`; a month-day that
 * already passed this year means next year. Undefined = no day named.
 */
export function resolveDay(sentence: string, now: Date, timeZone = "Asia/Taipei"): LocalDay | undefined {
  const today = ymd(now, timeZone);
  const md = /(\d{1,2})\s*月\s*(\d{1,2})\s*[日號]?|(?<![\d/])(\d{1,2})\/(\d{1,2})(?![\d/])/u.exec(sentence);
  const en =
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/iu.exec(
      sentence,
    );
  if (md || en) {
    const m = md ? Number(md[1] ?? md[3]) : EN_MONTHS.indexOf((en?.[1] ?? "").toLowerCase()) + 1;
    const d = Number(md ? (md[2] ?? md[4]) : en?.[2]);
    if (m < 1 || m > 12 || d < 1 || d > 31) return undefined;
    const end = zonedInstant(today.y, m, d, 23, 59, timeZone);
    return end.getTime() < now.getTime() - 24 * 3600_000 ? { y: today.y + 1, m, d } : { y: today.y, m, d };
  }
  if (/大後天/u.test(sentence)) return addLocalDays(today, 3);
  if (/後天|day after tomorrow/iu.test(sentence)) return addLocalDays(today, 2);
  if (/明天|明早|明晚|\btomorrow\b/iu.test(sentence)) return addLocalDays(today, 1);
  if (/今天|今晚|\btoday\b|\btonight\b/iu.test(sentence)) return addLocalDays(today, 0);
  const wk = /(下|這|本)?(?:週|星期|禮拜)([一二三四五六日天])/u.exec(sentence);
  if (wk) {
    const target = WEEKDAY[wk[2] ?? ""] ?? 0;
    // Weeks start on Monday: 下週三 is the Wednesday of next week.
    const mon = (today.wd + 6) % 7;
    const tgt = (target + 6) % 7;
    let delta = tgt - mon;
    if (wk[1] === "下") delta += 7;
    else if (!wk[1] && delta < 0) delta += 7;
    return delta < 0 ? undefined : addLocalDays(today, delta);
  }
  const enWd = /\b(next|this|on)\s+(mon|tues|wednes|thurs|fri|satur|sun)day\b/iu.exec(sentence);
  if (enWd) {
    const target = EN_WEEKDAYS.indexOf((enWd[2] ?? "").toLowerCase());
    const ahead = (target - today.wd + 7) % 7;
    // "next Friday" never means today; "on / this Friday" is the coming one (today counts).
    const delta = (enWd[1] ?? "").toLowerCase() === "next" ? ahead || 7 : ahead;
    return addLocalDays(today, delta);
  }
  return undefined;
}

/**
 * A deadline in a sentence that says something is due (「11 月 20 日要交報告」
 * 「下週三考試」「明天要繳費」). The end of that local day (23:59); a date
 * that already passed this year means next year. Undefined = no deadline.
 */
export function parseDue(sentence: string, now: Date, timeZone = "Asia/Taipei"): Date | undefined {
  if (!DUE_VERB.test(sentence) || NOT_DUE.test(sentence)) return undefined;
  const day = resolveDay(sentence, now, timeZone);
  return day ? zonedInstant(day.y, day.m, day.d, 23, 59, timeZone) : undefined;
}
