import type { CareDecision, ChosenItem } from "./policy.ts";
import type { ReplyLanguage, Situation } from "./situation.ts";

/**
 * Care moments, step 4: constrained generation. The model never sees the
 * timeline; when the policy chose something it sees that one item (what,
 * which day in the person's words, the time) plus a few lines of rules, in an
 * `<alca:moment>` block of the per-turn context. When the policy chose
 * nothing but the person is leaving, the block only says "close, don't
 * prolong". On every other turn there is no block at all.
 */

/** The fixed rules of the block (measured by check:prompt-budget). */
export const CARE_RULES: Readonly<Record<ReplyLanguage, { closing: string; care: string }>> = {
  zh: {
    closing: "使用者要離開了：確認已處理的事、簡短道別；不要問問題、不提新建議或新工作、不延長對話。",
    care: "只有真的自然才在結尾加一句溫暖的話，關於上面這一件事或休息，最多一句；不說你怎麼知道的、不提其他事；不合適就什麼都不加。",
  },
  en: {
    closing:
      "The user is leaving: confirm what is handled and say goodbye briefly; no questions, no new offers or work, do not prolong.",
    care: "Only if it truly fits, end with one warm line about the item above or rest, at most one; never say how you know, mention nothing else; if it does not fit, add nothing.",
  },
};

const WEEKDAY_ZH = ["日", "一", "二", "三", "四", "五", "六"];
const WEEKDAY_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const REL_ZH = ["今天", "明天", "後天", "大後天"];
const REL_EN = ["today", "tomorrow", "the day after tomorrow", "in three days"];

/** 「後天（3/12 週五）14:30」 / "the day after tomorrow (Fri, Mar 12) at 14:30". */
export function whenLabel(item: ChosenItem, lang: ReplyLanguage): string {
  const [y, m, d] = item.date.split("-").map(Number);
  const wd = new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1)).getUTCDay();
  if (lang === "en") {
    const rel = REL_EN[item.daysAway] ?? `on ${item.date}`;
    return `${rel} (${WEEKDAY_EN[wd]}, ${MONTH_EN[(m ?? 1) - 1]} ${d})${item.time ? ` at ${item.time}` : ""}`;
  }
  const rel = REL_ZH[item.daysAway] ?? item.date;
  return `${rel}（${m}/${d} 週${WEEKDAY_ZH[wd]}）${item.time ? ` ${item.time}` : ""}`;
}

const hhmm = (s: Situation) => `${String(s.hour).padStart(2, "0")}:${String(s.minute).padStart(2, "0")}`;

function momentLine(s: Situation, lang: ReplyLanguage): string {
  const hours = s.sessionMinutes >= 60 ? Math.round(s.sessionMinutes / 30) / 2 : 0;
  if (lang === "en") {
    const what =
      s.closing === "sleep"
        ? "is going to sleep"
        : s.closing
          ? "is leaving"
          : s.lingering
            ? "said good night and is still here"
            : "has wrapped up this exchange";
    return `Moment: ${s.night ? "late, " : ""}${hhmm(s)} local; the user ${what}${hours ? ` (session about ${hours} h)` : ""}.`;
  }
  const what =
    s.closing === "sleep"
      ? "要去睡了"
      : s.closing
        ? "要離開了"
        : s.lingering
          ? "說過晚安但還在"
          : "這段對話告一段落";
  return `時刻：${s.night ? "深夜 " : ""}當地 ${hhmm(s)}；使用者${what}${hours ? `（這次聊了約 ${hours} 小時）` : ""}。`;
}

/** The `<alca:moment>` lines for this turn; empty when the decision adds nothing. */
export function momentBlock(d: CareDecision, s: Situation): string[] {
  if (d.kind === "none") return [];
  const lang = s.lang;
  const r = CARE_RULES[lang];
  const lines = ["<alca:moment>", momentLine(s, lang)];
  if (d.kind === "event" && d.item) {
    const title = d.item.title.replace(/[<>]/gu, "");
    lines.push(
      lang === "en"
        ? `One thing that may fit: ${title}, ${whenLabel(d.item, lang)}.${d.rest ? " (Or rest.)" : ""}`
        : `可以提的一件事：${title}，${whenLabel(d.item, lang)}。${d.rest ? "（或請他休息。）" : ""}`,
    );
  } else if (d.kind === "rest") {
    lines.push(lang === "en" ? "One thing that may fit: rest." : "可以提的一件事：休息。");
  }
  if (s.closing) lines.push(r.closing);
  if (d.kind === "event" || d.kind === "rest") lines.push(r.care);
  lines.push("</alca:moment>");
  return [lines.join("\n")];
}
