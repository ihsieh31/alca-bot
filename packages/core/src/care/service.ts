import { type Candidate, parseLifeCancel, parseLifeMemory } from "@alca/memory";
import type { AgentsEventData } from "@alca/protocol";
import type { CareLogRecord, MemoryRecord, Store } from "@alca/store";
import type { TurnInfo, TurnObserver } from "../learning.ts";
import type { TurnState } from "../turn.ts";
import { momentBlock } from "./block.ts";
import {
  careMetrics,
  careSuppression,
  categoryWeights,
  REACTION_WINDOW_HOURS,
  reactionOf,
  WEIGHT_DAYS,
} from "./feedback.ts";
import { mentions } from "./mention.ts";
import {
  type CandidateItem,
  type CareDecision,
  decideCare,
  RECENT_MENTION_HOURS,
  THREAD_COOLDOWN_HOURS,
  type TimelineItem,
  WINDOW_HOURS,
} from "./policy.ts";
import { postCheckCare } from "./post-check.ts";
import { type ReplyLanguage, type Situation, situationOf } from "./situation.ts";

/**
 * Care moments: the pipeline wired to the store (docs/design/CARE-MOMENTS.md).
 *
 *   capture   — life events are memories (`life:` subjects, @alca/memory life.ts),
 *               written by the learning hooks after a turn; cancellations here.
 *   situation — `situationOf` per router turn.
 *   decide    — `decideCare`; moments are logged with their reason.
 *   generate  — `<alca:moment>` in the turn's context, only when it says something.
 *   post-check— `postCheckCare` on the reply; a change is a `reply.revised`.
 *   feedback  — the next message is the reaction; weights and suppressions follow.
 */

export interface CareOptions {
  store: Store;
  now?: () => Date;
  timeZone?: string;
  memoryMode?: (botId: string) => "team" | "own" | "off";
  /** The bot's pinned language (fallback when a message has no letters). */
  language?: (botId: string) => ReplyLanguage | undefined;
  /** Write a memory (the person's suppression; a cancelled event). */
  learn?: (
    botId: string,
    c: Candidate,
    prov: { threadId?: string; messageId?: string; runId?: string },
    confirmed: boolean,
  ) => void;
  publish?: (d: AgentsEventData<"reply.revised">) => void;
}

interface Pending {
  decision: CareDecision;
  situation: Situation;
  items: TimelineItem[];
  /** Titles talked about earlier in the thread (a plain report about one is not a care line). */
  discussed: string[];
}

const H = 3600_000;
const KEEP_DAYS = 90;

const CATEGORY_LABEL: Record<string, { zh: string; en: string }> = {
  exam: { zh: "考試", en: "exams" },
  contest: { zh: "比賽", en: "competitions" },
  interview: { zh: "面試", en: "interviews" },
  trip: { zh: "旅行", en: "trips" },
  birthday: { zh: "生日", en: "birthdays" },
  performance: { zh: "上台發表", en: "talks and performances" },
  ceremony: { zh: "典禮", en: "ceremonies" },
  rest: { zh: "去睡、休息", en: "going to sleep" },
};

export class CareMoments implements TurnObserver {
  private readonly o: CareOptions;
  private readonly now: () => Date;
  private readonly pending = new Map<string, Pending>();
  private lastPrune = 0;

  constructor(o: CareOptions) {
    this.o = o;
    this.now = o.now ?? (() => new Date());
  }

  private get store(): Store {
    return this.o.store;
  }

  private get tz(): string {
    return this.o.timeZone ?? "Asia/Taipei";
  }

  /** The upcoming life events a bot can read, soonest first (never the whole timeline into a prompt). */
  timeline(botId: string, now = this.now()): Array<TimelineItem & { memory: MemoryRecord }> {
    const mode = this.o.memoryMode?.(botId) ?? "team";
    if (mode === "off") return [];
    const rows = this.store.memory.dueBetween(
      botId,
      new Date(now.getTime() - 24 * H),
      new Date(now.getTime() + (WINDOW_HOURS + 24) * H),
      50,
    );
    const out: Array<TimelineItem & { memory: MemoryRecord }> = [];
    for (const m of rows) {
      if (!m.subject.startsWith("life:") || !m.dueAt) continue;
      // 只用自己的筆記 (own): the shared user model is not this bot's to read.
      if (mode === "own" && (m.botId !== botId || m.scope !== "bot")) continue;
      const p = parseLifeMemory(m.subject, m.body);
      if (p) out.push({ ...p, timeZone: p.timeZone || this.tz, memoryId: m.id, at: m.dueAt, memory: m });
    }
    return out;
  }

  private memoryOff(botId: string): boolean {
    return (this.o.memoryMode?.(botId) ?? "team") === "off";
  }

  private suppressedSubjects(botId: string): string[] {
    return this.store.memory
      .list({ visibleTo: botId, kinds: ["preference"], limit: 200 })
      .filter((m) => m.status === "active" && m.subject.startsWith("suppress:"))
      .map((m) => m.subject.slice("suppress:".length));
  }

  private history(threadId: string, text: string) {
    const all = this.store.threads
      .messages(threadId, 120)
      .filter((m) => m.role === "user" || m.role === "assistant");
    const last = all.at(-1);
    // A launch path that stored the message already: it is "now", not history.
    return last && last.role === "user" && last.content === text ? all.slice(0, -1) : all;
  }

  /** The decision for a router turn, before it runs; returns the context lines (none on most turns). */
  contextLines(botId: string, threadId: string, text: string): string[] {
    try {
      return this.prepare(botId, threadId, text);
    } catch {
      return []; // care must never break a turn
    }
  }

  private prepare(botId: string, threadId: string, text: string): string[] {
    const now = this.now();
    const history = this.history(threadId, text);
    const waiting = this.store.workers.byThread(threadId).filter((w) => w.status === "waiting").length;
    const fallback = this.o.language?.(botId);
    const situation = situationOf({
      text,
      now,
      timeZone: this.tz,
      history: history.map((m) => ({ role: m.role, content: m.content, createdAt: m.createdAt })),
      waitingApprovals: waiting,
      ...(fallback ? { fallbackLang: fallback } : {}),
    });
    const items = this.timeline(botId, now);
    const decision = this.decide(botId, threadId, text, situation, items, history, now);
    const discussed = items
      .filter((it) => history.some((m) => mentions(m.content, it.title)))
      .map((it) => it.title);
    this.pending.set(threadId, { decision, situation, items, discussed });
    if (decision.moment)
      this.store.careLog.add(
        {
          botId,
          threadId,
          kind: "decision",
          reason: decision.reason,
          ...(decision.item ? { memoryId: decision.item.memoryId, category: decision.item.category } : {}),
          ...(decision.kind === "rest" ? { category: "rest" } : {}),
          ...(decision.score !== undefined ? { score: decision.score } : {}),
        },
        now,
      );
    return momentBlock(decision, situation);
  }

  private decide(
    botId: string,
    threadId: string,
    text: string,
    situation: Situation,
    items: readonly TimelineItem[],
    history: ReadonlyArray<{ content: string }>,
    now: Date,
  ): CareDecision {
    const mode = this.o.memoryMode?.(botId) ?? "team";
    if (!situation.closing && !situation.endOfExchange && !situation.lingering)
      return decideCare({
        situation,
        now,
        timeZone: this.tz,
        items: [],
        shownInThread: { event: false, rest: false },
      });
    const sup = this.suppressedSubjects(botId);
    const recent = new Date(now.getTime() - RECENT_MENTION_HOURS * H);
    const shown = this.store.careLog.list({
      botId,
      threadId,
      kinds: ["shown"],
      since: new Date(now.getTime() - THREAD_COOLDOWN_HOURS * H),
    });
    const candidates: CandidateItem[] = items.map((it) => ({
      ...it,
      mentionedInThread: mentions(text, it.title) || history.some((m) => mentions(m.content, it.title)),
      mentionedRecently:
        this.store.careLog.list({
          botId,
          memoryId: it.memoryId,
          kinds: ["shown", "mention"],
          since: recent,
          limit: 1,
        }).length > 0,
      suppressed: sup.some(
        (s) => s === `care:${it.category}` || (!s.startsWith("care") && mentions(it.title, s)),
      ),
    }));
    const weights = categoryWeights(
      this.store.careLog.list({
        botId,
        kinds: ["shown"],
        since: new Date(now.getTime() - WEIGHT_DAYS * 86400_000),
        limit: 500,
      }),
      now,
    );
    return decideCare({
      situation,
      now,
      timeZone: this.tz,
      items: candidates,
      shownInThread: {
        event: shown.some((r) => r.category !== "rest"),
        rest: shown.some((r) => r.category === "rest"),
      },
      suppressedAll: sup.includes("care"),
      restSuppressed: sup.includes("care:rest"),
      weights,
      memoryOff: mode === "off",
    });
  }

  // ── turn observer ────────────────────────────────────────────

  /** Before a turn: the reaction to a line shown in this thread, and a care suppression. */
  before(info: TurnInfo): string[] {
    if (info.role === "worker" || info.messageRole !== "user" || info.initiatorKind !== "user") return [];
    try {
      return this.react(info);
    } catch {
      return [];
    }
  }

  private react(info: TurnInfo): string[] {
    const now = this.now();
    const last = this.store.careLog
      .list({
        botId: info.botId,
        threadId: info.threadId,
        kinds: ["shown"],
        since: new Date(now.getTime() - REACTION_WINDOW_HOURS * H),
        limit: 5,
      })
      .find((r) => !r.reaction);
    const lang: ReplyLanguage = /[\p{Script=Han}]/u.test(info.text) ? "zh" : "en";
    let category: string | undefined;
    if (last) {
      const reaction = reactionOf(info.text);
      this.store.careLog.react(last.id, reaction, now);
      if (reaction === "negative") category = last.category || "all";
    }
    if (!category && careSuppression(info.text))
      category = /睡|休息|sleep|rest|bed/iu.test(info.text)
        ? "rest"
        : /考|exam|test/iu.test(info.text)
          ? "exam"
          : "all";
    if (!category) return [];
    // Memory off: nothing is written (and with memory off no care line is shown to stop).
    if (this.memoryOff(info.botId)) return [];
    const subject = category === "all" ? "suppress:care" : `suppress:care:${category}`;
    const label = CATEGORY_LABEL[category]?.[lang];
    const body =
      lang === "en"
        ? `Do not bring up ${label ?? "personal reminders"} when the user is leaving`
        : `道別時不要主動提${label ?? "生活上的事"}`;
    this.o.learn?.(
      info.botId,
      {
        kind: "preference",
        subject,
        body,
        quote: info.text.slice(0, 200),
        confidence: 1,
        appliesTo: ["proactive"],
      },
      { threadId: info.threadId, messageId: info.messageId, runId: info.runId },
      true,
    );
    return [
      lang === "en"
        ? `Noted: no more ${label ?? "personal reminders"} when the user says goodbye.`
        : `已記下：之後道別時不會再主動提${label ?? "這類生活上的事"}。`,
    ];
  }

  /** After a turn: post-check the reply, log what was shown and mentioned, catch cancellations. */
  after(info: TurnInfo, state: TurnState): void {
    if (info.role === "worker" || info.messageRole !== "user") return;
    const p = this.pending.get(info.threadId);
    this.pending.delete(info.threadId);
    try {
      this.settle(info, state, p);
    } catch {
      // care must never break a turn
    }
  }

  private settle(info: TurnInfo, state: TurnState, p: Pending | undefined): void {
    const now = this.now();
    if (now.getTime() - this.lastPrune > 24 * H) {
      this.lastPrune = now.getTime();
      this.store.careLog.prune(new Date(now.getTime() - KEEP_DAYS * 86400_000));
    }
    if (info.initiatorKind === "user" && !this.memoryOff(info.botId)) this.cancellations(info);
    const items = p?.items ?? this.timeline(info.botId, now);
    let reply = state.assistantTexts.join("\n").trim();
    const shown = { item: false, rest: false };
    if (p && reply && state.finish?.reason === "completed") {
      const r = postCheckCare({
        reply,
        decision: p.decision,
        timelineTitles: items.filter((it) => !mentions(info.text, it.title)).map((it) => it.title),
        leaving: !!p.situation.closing || p.situation.lingering || p.situation.endOfExchange,
        discussed: p.discussed,
      });
      Object.assign(shown, r.shown);
      if (r.changed) {
        reply = r.text;
        this.revise(info, state, r.text, r.violations);
      }
      const d = p.decision;
      if (shown.item && d.item)
        this.store.careLog.add(
          {
            botId: info.botId,
            threadId: info.threadId,
            runId: info.runId,
            kind: "shown",
            memoryId: d.item.memoryId,
            category: d.item.category,
            ...(d.score !== undefined ? { score: d.score } : {}),
          },
          now,
        );
      if (shown.rest && (d.kind === "rest" || d.rest))
        this.store.careLog.add(
          { botId: info.botId, threadId: info.threadId, runId: info.runId, kind: "shown", category: "rest" },
          now,
        );
    }
    // Mentioned-at history: the assistant talked about an item this turn (what the person
    // says counts in its own thread only, read from the thread itself).
    for (const it of items) {
      if (shown.item && p?.decision.item?.memoryId === it.memoryId) continue;
      if (reply && mentions(reply, it.title))
        this.store.careLog.add(
          {
            botId: info.botId,
            threadId: info.threadId,
            runId: info.runId,
            kind: "mention",
            memoryId: it.memoryId,
            category: it.category,
          },
          now,
        );
    }
  }

  /** The reply as stored and as the next observers see it (the 回覆檢查 add-on reads `assistantTexts`). */
  private revise(info: TurnInfo, state: TurnState, text: string, issues: readonly string[]): void {
    state.assistantTexts.splice(0, state.assistantTexts.length, text);
    const msg = this.store.threads
      .messages(info.threadId, 20)
      .filter((m) => m.runId === info.runId && m.role === "assistant")
      .at(-1);
    if (!msg) return;
    this.store.threads.reviseMessage(msg.id, text);
    this.o.publish?.({
      botId: info.botId,
      threadId: info.threadId,
      messageId: msg.id,
      text,
      issues: issues.slice(0, 6).map((x) => `care:${x}`),
    });
  }

  /** 「鋼琴檢定取消了」: the event leaves the timeline (superseded by a cancelled note without a date). */
  private cancellations(info: TurnInfo): void {
    for (const sentence of info.text.split(/[。！!？?\n；;，,]+/u)) {
      const c = parseLifeCancel(sentence);
      if (!c) continue;
      const pool = this.store.memory
        .list({ visibleTo: info.botId, kinds: ["fact"], limit: 200 })
        .filter(
          (m) =>
            m.status === "active" &&
            m.dueAt &&
            m.subject.startsWith(`life:${c.category}:`) &&
            Date.parse(m.dueAt) > this.now().getTime(),
        );
      const hit =
        pool.find((m) => c.title && mentions(m.body, c.title)) ?? (pool.length === 1 ? pool[0] : undefined);
      const parsed = hit ? parseLifeMemory(hit.subject, hit.body) : undefined;
      if (!hit || !parsed) continue;
      const zh = /[\p{Script=Han}]/u.test(sentence);
      this.o.learn?.(
        info.botId,
        {
          kind: "fact",
          subject: hit.subject,
          body: `${parsed.title}${zh ? "（已取消）" : " (cancelled)"}`,
          quote: sentence.trim(),
          confidence: 0.9,
          correction: true,
        },
        { threadId: info.threadId, messageId: info.messageId, runId: info.runId },
        false,
      );
    }
  }

  /** Telemetry for a bot over the last `days` days. */
  metrics(botId: string, days = 30): ReturnType<typeof careMetrics> {
    const now = this.now();
    const rows: CareLogRecord[] = this.store.careLog.list({
      botId,
      since: new Date(now.getTime() - days * 86400_000),
      limit: 1000,
    });
    return careMetrics(rows, now);
  }
}
