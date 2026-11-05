import type { AgentsEventData } from "@alca/protocol";
import type { OfferCategory, OfferRecord, OfferStats, Store } from "@alca/store";
import type { TurnInfo } from "./learning.ts";
import type { TurnState } from "./turn.ts";

/**
 * P14 B3: the offer ledger. Every offer a bot makes is one row: the last
 * line of a router reply that offers to do something (「要我幫你…嗎？」), or
 * a card an add-on shows. The person's next message decides a reply's
 * offer with cheap rules (好／可以 → accepted; 不用／先不 → declined; anything
 * else leaves it pending, and after 24 hours it is ignored). Accept rates
 * per category feed the 主動留意 add-on and its settings line. No model is
 * called here.
 */

export const CATEGORY_LABEL: Record<OfferCategory, string> = {
  project: "專案",
  errand: "雜務",
  money_account: "錢與帳戶",
  social: "人際",
  study: "讀書",
  other: "其他",
};

/** A reply's offer goes stale after a day; an add-on card after two. */
export const CHAT_END_IGNORE_HOURS = 24;

const OFFER_CUE =
  /要我|要不要我|需要我|我可以(?:幫|替|先|再|直接)|我來.{0,20}(?:嗎|好嗎)|\bwant me to\b|\bshall i\b|\bshould i\b|\bwould you like me to\b|\bdo you want me to\b/iu;

/** The offer in the last sentence of a reply, or undefined (a plain question is not an offer). */
export function detectOffer(
  reply: string,
): { text: string; action: string; category: OfferCategory } | undefined {
  const lines = reply
    .trim()
    .split(/\n+/u)
    .map((l) => l.trim())
    .filter(Boolean);
  const last = lines.at(-1);
  if (!last || !/[?？]\s*\S{0,3}$/u.test(last)) return undefined;
  const sentences = last.split(/(?<=[。！!.])\s*/u).filter((s) => s.trim());
  const text = (sentences.at(-1) ?? last).trim().slice(0, 300);
  if (!OFFER_CUE.test(text)) return undefined;
  const action = text
    .replace(/^.*?(?:要不要我|要我|需要我|我可以|我來)/u, "")
    .replace(/^.*?\b(?:want me to|shall i|should i|would you like me to|do you want me to)\b/iu, "")
    .replace(/(?:嗎|好嗎|呢)?\s*[?？]\s*\S{0,3}$/u, "")
    .trim();
  return { text, action: action || text, category: offerCategory(text) };
}

const CATEGORY_WORDS: ReadonlyArray<[OfferCategory, RegExp]> = [
  [
    "money_account",
    /付款|繳費|繳|帳單|訂閱|續訂|續約|額度|帳戶|帳號|銀行|退款|發票|保險|\bbill|\bsubscription|\brefund|\baccount|\bpayment/iu,
  ],
  ["study", /考試|讀書|複習|作業|報告|上課|課程|講義|單字|模擬考|\bstudy|\bexam|\bhomework|\bcourse/iu],
  ["social", /朋友|家人|同學|生日|聚餐|邀請|祝福|道謝|\bfriend|\bfamily|\bbirthday|\binvite/iu],
  ["project", /專案|程式|repo|網站|部署|功能|上線|bug|\bcode|\bproject|\bdeploy|\bfeature|\bPR\b/iu],
  ["errand", /訂|買|預約|提醒|整理|查|寄|排|安排|\bbook|\bbuy|\bremind|\border|\bschedule|\bfind/iu],
];

export function offerCategory(text: string): OfferCategory {
  return CATEGORY_WORDS.find(([, re]) => re.test(text))?.[0] ?? "other";
}

export type OfferAnswer = "accepted" | "declined" | "suppress" | "none";

const SUPPRESS_ANSWER =
  /別再提這(?:類|種|個)|不要再提這(?:類|種|個)|這類(?:的)?(?:事|建議)?(?:以後)?(?:都)?(?:不用|不要|別)再?提|\bstop (?:suggesting|offering) (?:this|these|that)\b|\bdon'?t (?:suggest|offer) (?:this|that) again\b/iu;
const ACCEPT =
  /^(?:好|好啊|好喔|好的|好呀|可以|行|沒問題|去做|做吧|麻煩|拜託|要|嗯好|就這樣做|ok|okay|yes|yep|yeah|sure|please|go ahead|do it)(?:[，,。.!！~\s]|$)/iu;
const DECLINE =
  /^(?:不用|不要|先不|不必|算了|免了|先這樣|晚點再說|之後再說|no|nope|not now|no thanks|nah|later)(?:[，,。.!！~\s了]|$)/iu;

/** What a person's message does to the offer that was just made. */
export function classifyAnswer(text: string): OfferAnswer {
  const s = text.trim();
  if (SUPPRESS_ANSWER.test(s)) return "suppress";
  if (DECLINE.test(s)) return "declined";
  if (ACCEPT.test(s) && !/不/u.test(s.slice(0, 4))) return "accepted";
  return "none";
}

export interface OfferLedgerOptions {
  store: Store;
  now?: () => Date;
  publish?: <T extends "offer.created" | "offer.updated">(type: T, data: AgentsEventData<T>) => void;
  /** Store a 「別再提這類」 rule (the person's own preference). */
  suppress?: (
    botId: string,
    topic: string,
    quote: string,
    prov: { threadId?: string; messageId?: string },
  ) => void;
}

export class OfferLedger {
  private readonly o: OfferLedgerOptions;
  private readonly now: () => Date;

  constructor(o: OfferLedgerOptions) {
    this.o = o;
    this.now = o.now ?? (() => new Date());
  }

  get store(): Store {
    return this.o.store;
  }

  private created(r: OfferRecord): void {
    try {
      this.o.publish?.("offer.created", {
        offerId: r.id,
        botId: r.botId,
        ...(r.threadId ? { threadId: r.threadId } : {}),
        source: r.source,
        category: r.category,
        text: r.text,
        ...(r.dueAt ? { dueAt: r.dueAt } : {}),
      });
    } catch {
      // the event is a notice
    }
  }

  updated(r: OfferRecord | undefined): void {
    if (!r) return;
    try {
      this.o.publish?.("offer.updated", {
        offerId: r.id,
        botId: r.botId,
        ...(r.threadId ? { threadId: r.threadId } : {}),
        status: r.status,
        ...(r.workerId ? { workerId: r.workerId } : {}),
      });
    } catch {
      // the event is a notice
    }
  }

  /** Record an offer an add-on made (the add-on decides when it is shown). */
  add(input: Parameters<Store["offers"]["add"]>[0], opts: { silent?: boolean } = {}): OfferRecord {
    const r = this.store.offers.add(input, this.now());
    if (!opts.silent) this.created(r);
    return r;
  }

  /** A queued offer was shown now (offer.created goes out then, not when it was queued). */
  shown(r: OfferRecord): void {
    this.created(r);
  }

  /** Decide a pending offer once; publishes offer.updated. */
  decide(
    id: string,
    status: "accepted" | "declined" | "ignored" | "expired",
    extra: { workerId?: string } = {},
  ): boolean {
    const ok = this.store.offers.decide(id, status, this.now(), extra);
    if (ok) this.updated(this.store.offers.get(id));
    return ok;
  }

  /**
   * Before a person's message: it answers the newest pending reply offer of
   * the conversation. 「別再提這類」 declines it and stores a suppress rule.
   */
  before(info: TurnInfo): string[] {
    if (info.role === "worker" || info.messageRole !== "user" || info.initiatorKind !== "user") return [];
    const offer = this.store.offers.latestPending(info.threadId, "chat_end");
    if (!offer) return [];
    const a = classifyAnswer(info.text);
    if (a === "none") return [];
    if (a === "suppress") {
      this.decide(offer.id, "declined");
      const topic = `${CATEGORY_LABEL[offer.category]}・${offer.topic || offer.action}`.slice(0, 40);
      try {
        this.o.suppress?.(offer.botId, topic, info.text.slice(0, 200), {
          threadId: info.threadId,
          messageId: info.messageId,
        });
      } catch {
        // the decline holds even if the rule could not be written
      }
      return [`已記下：之後不會再主動提這類事（${topic}）。`];
    }
    this.decide(offer.id, a);
    return [];
  }

  /** After a router reply: record the offer in its last line, if any. */
  after(info: TurnInfo, state: TurnState): OfferRecord | undefined {
    if (info.role === "worker" || state.finish?.reason === "failed") return undefined;
    const reply = state.assistantTexts.join("\n").trim();
    const found = reply ? detectOffer(reply) : undefined;
    if (!found) return undefined;
    // A repeat of the same offer in this conversation is not a new row.
    const same = this.store.offers
      .list({ threadId: info.threadId, source: "chat_end", limit: 20 })
      .find((o) => o.text === found.text && o.status === "pending");
    if (same) return same;
    return this.add({
      botId: info.botId,
      threadId: info.threadId,
      source: "chat_end",
      category: found.category,
      topic: found.action.slice(0, 30),
      text: found.text,
      action: found.action,
    });
  }

  /** Reply offers nobody answered within a day → ignored; overdue offers → expired. */
  sweep(): void {
    const now = this.now();
    const before = new Date(now.getTime() - CHAT_END_IGNORE_HOURS * 3600_000);
    for (const r of this.store.offers.ignoreStale(before, "chat_end", now))
      this.updated(this.store.offers.get(r.id));
    for (const r of this.store.offers.expireOverdue(now)) this.updated(this.store.offers.get(r.id));
  }

  /** Accept-rate inputs for a bot and category over the last `windowDays` days. */
  offerStats(botId: string, category?: OfferCategory, windowDays = 30): OfferStats {
    return this.store.offers.stats(botId, category, new Date(this.now().getTime() - windowDays * 86400_000));
  }

  /** 「專案 4/4、雜務 0/3」: accepted / decided per category, the last 30 days. */
  statsLine(botId: string): string | undefined {
    const parts: string[] = [];
    for (const c of Object.keys(CATEGORY_LABEL) as OfferCategory[]) {
      const s = this.offerStats(botId, c);
      if (s.total) parts.push(`${CATEGORY_LABEL[c]} ${s.accepted}/${s.total}`);
    }
    return parts.length ? `近 30 天提議接受：${parts.join("、")}` : undefined;
  }

  /** Router context: offers this conversation declined (not to be made again here). */
  declinedLines(threadId: string): string[] {
    const rows = this.store.offers.list({ threadId, status: ["declined"], limit: 5 });
    return rows.length
      ? [`這個對話裡使用者拒絕過的提議（不要再提）：${rows.map((r) => r.action).join("；")}`]
      : [];
  }
}
