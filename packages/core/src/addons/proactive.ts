import { randomUUID } from "node:crypto";
import type { CandidateOutcome, MemoryRecord, OfferRecord, Store, WorkerRecord } from "@alca/store";
import { defuseAlcaTags } from "@alca/tools";
import type { AlcaCore } from "../agent.ts";
import { quietUntil } from "../agents/early.ts";
import type { WorkerSupervisor } from "../agents/workers.ts";
import type { AddonCompletion } from "../extract-engine.ts";
import type { Learning } from "../learning.ts";
import { CATEGORY_LABEL, type OfferLedger } from "../offers.ts";
import { PROACTIVE_ID, type ProactiveSettings } from "./manifest.ts";
import { LOG_KEEP_DAYS, logRow, type ProactiveMetrics, proactiveMetrics } from "./proactive-metrics.ts";
import {
  type Candidate,
  candidatePrompt,
  defaultDoable,
  parseAnswer,
  proposalOf,
  proposalText,
  SCORE_THRESHOLD,
  type ScoreParts,
  sameMatter,
  scoreCandidate,
  suppressed,
  suppressTopic,
} from "./proactive-pick.ts";
import {
  dueEntries,
  enqueue,
  type QueueEntry,
  reschedule,
  runnerUp,
  watch,
  without,
} from "./proactive-queue.ts";
import {
  AlcaStateSource,
  DeadlineSource,
  type Evidence,
  evidenceRef,
  type ProactiveSource,
} from "./proactive-sources.ts";
import { DEDUPE_DAYS, offerFact, type Presence, vet, withPresence } from "./proactive-vet.ts";
import type { AddonService } from "./service.ts";

/**
 * P14 §C, the 主動留意 add-on. Per bot that has it on:
 *  1. scan (no model) the sources it may read; nothing new → quiet, 0 tokens;
 *  2. one tool-less completion turns the new evidence into ≤ 3 candidates;
 *  3. plain code scores them (threshold 0.55);
 *  4. the best one gets a read-only homework worker when the day's budget allows;
 *  5. the proposal becomes an offer card (好 / 先不用 / 別再提這類), shown within the
 *     quiet hours, the daily count and the minimum gap, else queued;
 *  6. 好 starts an ordinary worker (sends, payments, deletes, posts still ask).
 * It never sends anything itself. Usage goes into addon_usage; past a cap it stops for the day.
 */

export const OFFER_SOURCE = `addon:${PROACTIVE_ID}`;
/** An add-on card nobody answered in two days is ignored. */
export const PROACTIVE_IGNORE_HOURS = 48;
/** Homework needs at least this many tokens left today, else the candidate text is used as is. */
export const HOMEWORK_MIN_TOKENS = 8000;
export const HOMEWORK_NO = "主動留意的功課工人只能讀資料和搜尋；寄送、發布、付款、刪除和任何修改都不做。";

export type ScanOutcome =
  | "off"
  | "capped"
  | "not_due"
  | "busy"
  | "quiet"
  | "read_failed"
  /** The candidate call failed or answered something that is not the JSON asked for; the evidence stays new. */
  | "model_failed"
  | "no_candidate"
  | "homework"
  | "offered"
  | "queued";

export interface ScanResult {
  outcome: ScanOutcome;
  evidence?: number;
  scores?: Array<{ candidate: Candidate; score: ScoreParts }>;
  offer?: OfferRecord;
  errors?: string[];
}

export interface ProactiveDeskOptions {
  core: AlcaCore;
  addons: AddonService;
  offers: OfferLedger;
  workers: () => WorkerSupervisor;
  learning: () => Learning | undefined;
  /** The bot's own engine, one tool-less turn. Absent = the add-on cannot pick candidates (no model call). */
  complete?: AddonCompletion;
  /** Calendar / mail sources from the host (connected apps). Deadlines and Alca's state are built in. */
  sources?: readonly ProactiveSource[];
  /** 可代勞 (0–1): can the bot do this action with its tools and connections. */
  doable?: (botId: string, action: string) => number;
  timeZone?: string;
  now?: () => Date;
}

interface DeskState {
  lastScanAt?: string;
  cursors?: Record<string, Record<string, unknown>>;
  threadId?: string;
  homework?: { workerId: string; candidate: Candidate; score: number; threadId: string } | undefined;
  lastErrors?: string[];
  /** Candidate calls that failed in a row (the scan interval doubles, up to 8×). */
  failStreak?: number;
  /** Paid-for candidates waiting for their turn (proactive-queue.ts). */
  queue?: QueueEntry[];
  /** What each source's last complete read showed (proactive-vet.ts). */
  presence?: Presence;
}

/** After this many failed candidate calls in a row the evidence is let go (a bounded retry). */
export const MAX_FAIL_STREAK = 3;

export class ProactiveDesk {
  private readonly o: ProactiveDeskOptions;
  private readonly now: () => Date;
  private readonly sources: ProactiveSource[];
  private readonly running = new Set<string>();

  constructor(o: ProactiveDeskOptions) {
    this.o = o;
    this.now = o.now ?? (() => new Date());
    this.sources = [
      new DeadlineSource(o.core.store),
      new AlcaStateSource(o.core.store),
      ...(o.sources ?? []),
    ];
    o.addons.onToggle((e) => {
      if (e.addonId !== PROACTIVE_ID) return;
      if (!e.enabled) this.turnedOff(e.botId);
      // Turned on: it starts from now, it does not catch up.
      else this.patch(e.botId, { lastScanAt: this.now().toISOString() });
    });
  }

  private get store(): Store {
    return this.o.core.store;
  }

  private get tz(): string {
    return this.o.timeZone ?? this.o.addons.timeZone;
  }

  private state(botId: string): DeskState {
    return this.o.addons.state(botId, PROACTIVE_ID) as DeskState;
  }

  private patch(botId: string, p: Partial<DeskState>): void {
    this.o.addons.setState(botId, PROACTIVE_ID, { ...this.state(botId), ...p });
  }

  private settings(botId: string): ProactiveSettings {
    return this.o.addons.settingsOf<ProactiveSettings>(botId, PROACTIVE_ID);
  }

  /** Off: the queue is cleared (queued cards expire), a homework worker is stopped; nothing is deleted. */
  private turnedOff(botId: string): void {
    for (const o of this.store.offers.list({
      botId,
      source: OFFER_SOURCE,
      status: ["pending"],
      queued: true,
    }))
      this.o.offers.decide(o.id, "expired");
    const hw = this.state(botId).homework;
    if (hw)
      void this.o
        .workers()
        .stop(hw.workerId, "addon turned off")
        .catch(() => undefined);
    this.patch(botId, { homework: undefined });
  }

  /** The reason a worker may not run a call (homework workers only read); undefined = no restriction. */
  restrict(info: {
    botId: string;
    workerId?: string;
    actionClass: string;
    tool: string;
  }): string | undefined {
    if (!info.workerId) return undefined;
    const hw = this.state(info.botId).homework;
    if (hw?.workerId !== info.workerId) return undefined;
    return info.actionClass === "read" ? undefined : HOMEWORK_NO;
  }

  /** The conversation the add-on's cards live in (the bot's own 主動留意 thread). */
  threadFor(botId: string): string {
    const id = this.state(botId).threadId;
    const t = id ? this.store.threads.get(id) : undefined;
    if (t && !t.archivedAt) return t.id;
    const created = this.o.core.createThread("主動留意", botId);
    this.patch(botId, { threadId: created.id });
    return created.id;
  }

  /** Every few seconds from the agents clock: ignore old cards, release queued ones, scan bots that are due. */
  async tick(): Promise<void> {
    const now = this.now();
    for (const r of this.store.offers.ignoreStale(
      new Date(now.getTime() - PROACTIVE_IGNORE_HOURS * 3600_000),
      OFFER_SOURCE,
      now,
    ))
      this.o.offers.updated(this.store.offers.get(r.id));
    for (const botId of this.o.addons.enabledBots(PROACTIVE_ID)) {
      try {
        this.release(botId);
        this.pump(botId);
        await this.scan(botId);
      } catch {
        // one bot's failure must not stop the others
      }
    }
  }

  /** May a card be shown to this bot's person now (quiet hours, daily count, minimum gap)? */
  private window(botId: string, s: ProactiveSettings): boolean {
    const now = this.now();
    if (quietUntil(s.quietHours, now, this.tz)) return false;
    const day = this.o.addons.day(now);
    const shown = this.store.offers
      .list({ botId, source: OFFER_SOURCE, limit: 50 })
      .filter((o) => o.shownAt && this.o.addons.day(new Date(o.shownAt)) === day).length;
    if (shown >= s.maxPerDay) return false;
    const last = this.store.offers.lastShown(botId, OFFER_SOURCE);
    return !last || now.getTime() - Date.parse(last) >= s.minIntervalHours * 3600_000;
  }

  /** Show the best queued card if the window allows it now; overdue ones expire. */
  release(botId: string): OfferRecord | undefined {
    const queued = this.store.offers.list({ botId, source: OFFER_SOURCE, status: ["pending"], queued: true });
    if (!queued.length) return undefined;
    const now = this.now();
    const live = queued.filter((o) => {
      if (o.dueAt && Date.parse(o.dueAt) < now.getTime()) {
        this.o.offers.decide(o.id, "expired");
        return false;
      }
      return true;
    });
    if (!live.length || !this.window(botId, this.settings(botId))) return undefined;
    // Gap P9: revalidate before showing — a suppress rule written since, evidence
    // gone or changed, or the same matter already shown / answered → it expires.
    const suppress = this.suppressTopics(botId);
    const shownOrDecided = this.recentOffers(botId, now).filter((o) => o.shownAt || o.status !== "pending");
    let best: OfferRecord | undefined;
    for (const o of [...live].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))) {
      const why = suppressed({ fact: o.text, action: o.action, category: o.category }, suppress)
        ? "suppressed"
        : vet(
            { text: offerFact(o), dueAt: o.dueAt, evidenceIds: o.evidence },
            this.state(botId).presence ?? {},
            shownOrDecided.filter((x) => x.id !== o.id),
          );
      if (!why) {
        best = o;
        break;
      }
      this.o.offers.decide(o.id, "expired");
      this.relog(this.store.proactiveLog.byOffer(o.id)?.id, { outcome: "revalidated_out", dropReason: why });
    }
    if (!best) return undefined;
    if (!this.store.offers.markShown(best.id, now)) return undefined;
    const shown = this.store.offers.get(best.id) as OfferRecord;
    this.o.offers.shown(shown);
    return shown;
  }

  /** This add-on's cards of the last DEDUPE_DAYS that still count (not expired unseen). */
  private recentOffers(botId: string, now: Date): OfferRecord[] {
    return this.store.offers.list({
      botId,
      source: OFFER_SOURCE,
      status: ["pending", "accepted", "declined", "ignored"],
      since: new Date(now.getTime() - DEDUPE_DAYS * 86400_000).toISOString(),
      limit: 100,
    });
  }

  private profile(botId: string): MemoryRecord[] {
    const learning = this.o.learning();
    if (!learning || learning.memoryMode(botId) === "off") return [];
    return this.store.memory
      .list({ visibleTo: botId, limit: 60 })
      .filter((m) => !m.subject.startsWith("suppress:") && (m.scope === "shared" || m.kind === "project"))
      .slice(0, 20);
  }

  private suppressTopics(botId: string): string[] {
    return this.store.memory
      .list({ visibleTo: botId, kinds: ["preference"], limit: 200 })
      .filter((m) => m.appliesTo.includes("proactive"))
      .map(suppressTopic);
  }

  /** One scan for one bot. `force` skips the scan interval (tests, 「現在看一次」). */
  async scan(botId: string, opts: { force?: boolean } = {}): Promise<ScanResult> {
    if (this.running.has(botId)) return { outcome: "busy" };
    const allow = this.o.addons.allowance(botId, PROACTIVE_ID);
    if (!allow.ok) return { outcome: allow.reason };
    const s = this.settings(botId);
    const st = this.state(botId);
    const now = this.now();
    const every = s.scanMinutes * 60_000 * 2 ** Math.min(st.failStreak ?? 0, MAX_FAIL_STREAK);
    if (!opts.force && st.lastScanAt && now.getTime() - Date.parse(st.lastScanAt) < every)
      return { outcome: "not_due" };
    if (st.homework) return { outcome: "busy" };
    this.running.add(botId);
    try {
      return await this.scanNow(botId, s, st, now);
    } finally {
      this.running.delete(botId);
    }
  }

  private async scanNow(botId: string, s: ProactiveSettings, st: DeskState, now: Date): Promise<ScanResult> {
    try {
      this.store.proactiveLog.prune(new Date(now.getTime() - LOG_KEEP_DAYS * 86400_000));
    } catch {
      // measuring must not stop the add-on
    }
    const cursors = { ...(st.cursors ?? {}) };
    let presence: Presence = { ...(st.presence ?? {}) };
    const evidence: Evidence[] = [];
    const errors: string[] = [];
    for (const src of this.sources) {
      if (!s.sources[src.id]) continue;
      const r = await src.read({ botId, cursor: cursors[src.id] ?? {}, now });
      if (!r.ok) {
        errors.push(`${src.id}: ${r.error}`);
        continue;
      }
      evidence.push(...r.items);
      cursors[src.id] = r.cursor;
      presence = withPresence(presence, src.id, r, now);
    }
    // Gap P2: the cursors move only once the candidate step has answered, so a
    // failed call does not lose the evidence (bounded: MAX_FAIL_STREAK).
    // Presence is what the sources show now, whatever the candidate step does.
    const base = { lastScanAt: now.toISOString(), lastErrors: errors, presence };
    if (!evidence.length || !this.o.complete) {
      this.patch(botId, { ...base, cursors, failStreak: 0 });
      if (!evidence.length) return { outcome: errors.length ? "read_failed" : "quiet", evidence: 0, errors };
      return { outcome: "no_candidate", evidence: evidence.length };
    }
    const profile = this.profile(botId);
    const suppress = this.suppressTopics(botId);
    const recent = this.store.offers.list({
      botId,
      since: new Date(now.getTime() - 7 * 86400_000).toISOString(),
      limit: 20,
    });
    const prompt = candidatePrompt({
      evidence,
      profile,
      recentOffers: recent,
      suppress,
      now,
      timeZone: this.tz,
    });
    let answer: { text: string; inputTokens: number; outputTokens: number } | undefined;
    let failure: string | undefined;
    try {
      answer = await this.o.complete({
        botId,
        prompt,
        signal: AbortSignal.timeout(60_000),
        purpose: "proactive",
      });
    } catch (err) {
      failure = String((err as Error)?.message ?? err).slice(0, 300);
    }
    this.o.addons.charge(botId, PROACTIVE_ID, {
      runs: 1,
      ...(answer ? { inputTokens: answer.inputTokens, outputTokens: answer.outputTokens } : {}),
    });
    const parsed = answer ? parseAnswer(answer.text, evidence) : undefined;
    if (!parsed) {
      failure ??= "候選步驟的回答不是要求的 JSON";
      const streak = (st.failStreak ?? 0) + 1;
      // Past the retry bound the evidence is let go (so a broken model cannot spend every scan on it).
      this.patch(botId, {
        ...base,
        lastErrors: [...errors, failure],
        failStreak: streak >= MAX_FAIL_STREAK ? 0 : streak,
        ...(streak >= MAX_FAIL_STREAK ? { cursors } : {}),
      });
      return { outcome: "model_failed", evidence: evidence.length, errors: [...errors, failure] };
    }
    this.patch(botId, { ...base, cursors, failStreak: 0 });
    // A candidate that cites only bulk mail carries that (proactive-pick `bulk`).
    const bulkIds = new Set(evidence.filter((e) => e.bulk).map((e) => e.id));
    for (const c of parsed) if (c.evidenceIds.every((id) => bulkIds.has(id))) c.bulk = true;
    const scores = parsed.map((candidate) => ({
      candidate,
      score: this.score(botId, candidate, now, { profile, suppress }),
    }));
    scores.sort((a, b) => b.score.total - a.score.total);
    // Gap P8: two candidates about one matter (an event and its confirmation mail) → the better one.
    for (let i = 1; i < scores.length; i++) {
      const x = scores[i] as (typeof scores)[number];
      if (x.score.total === 0) continue;
      const dup = scores
        .slice(0, i)
        .some(
          (y) =>
            y.score.total > 0 &&
            sameMatter(
              { text: y.candidate.fact, dueAt: y.candidate.dueAt ?? null },
              { text: x.candidate.fact, dueAt: x.candidate.dueAt ?? null },
            ),
        );
      if (dup) x.score = { ...x.score, total: 0, reason: "duplicate" };
    }
    scores.sort((a, b) => b.score.total - a.score.total);
    const passing = scores.filter((x) => x.score.total >= SCORE_THRESHOLD);
    const best = passing[0];
    // Gap P3: the other passing candidates were paid for too; they wait in the queue.
    // Gap P4: a dated one that was only too far off is watched and re-scored as it nears.
    const later: QueueEntry[] = passing.slice(1).map((x) => runnerUp(x.candidate, now));
    for (const x of scores)
      if (x.score.total < SCORE_THRESHOLD && !x.score.reason) {
        const w = watch(x.candidate, now);
        if (w) later.push(w);
      }
    // Gap P14: every candidate this scan looked at, with what became of it.
    const scanId = randomUUID();
    const queued = new Map(later.map((e) => [e.candidate, e.kind] as const));
    for (const x of scores) {
      if (x === best) continue;
      const kind = queued.get(x.candidate);
      const id = this.log(
        { botId, scanId, via: "scan", candidate: x.candidate, score: x.score, now },
        kind ?? "dropped",
        kind ? {} : { dropReason: x.score.reason ?? "below_threshold" },
      );
      // Shared with its queue entry, so the card it makes later updates this row.
      if (id) x.candidate.logId = id;
    }
    if (later.length) this.patch(botId, { queue: enqueue(this.state(botId).queue ?? [], later, now) });
    if (!best) return { outcome: "no_candidate", evidence: evidence.length, scores };
    const outcome = this.offerOrHomework(botId, best.candidate, best.score, { scanId, via: "scan" }, s);
    return { ...outcome, evidence: evidence.length, scores };
  }

  /** One telemetry row (never throws: measuring must not stop the add-on). */
  private log(
    i: Parameters<typeof logRow>[0],
    outcome: CandidateOutcome,
    extra: Parameters<typeof logRow>[2] = {},
  ): string | undefined {
    try {
      return this.store.proactiveLog.add(logRow(i, outcome, extra), i.now);
    } catch {
      return undefined;
    }
  }

  private relog(id: string | undefined, p: Parameters<Store["proactiveLog"]["update"]>[1]): void {
    if (!id) return;
    try {
      this.store.proactiveLog.update(id, p, this.now());
    } catch {
      // measuring must not stop the add-on
    }
  }

  /** Gap P14: precision over the last 30 days (the add-on's settings view shows it). */
  metrics(botId: string): ProactiveMetrics {
    return proactiveMetrics(this.store, botId, OFFER_SOURCE, this.now());
  }

  /** Score one candidate now (fresh profile, suppress rules, accept rate, evidence use). */
  private score(
    botId: string,
    candidate: Candidate,
    now: Date,
    ctx: { profile?: MemoryRecord[]; suppress?: string[] } = {},
  ): ScoreParts {
    const parts = scoreCandidate({
      candidate,
      now,
      profile: ctx.profile ?? this.profile(botId),
      doable: this.o.doable?.(botId, candidate.action) ?? defaultDoable(candidate.action),
      stats: this.o.offers.offerStats(botId, candidate.category),
      suppress: ctx.suppress ?? this.suppressTopics(botId),
      evidenceUsed: candidate.evidenceIds.some((id) => this.evidenceUsed(botId, id)),
    });
    if (parts.reason) return parts;
    // Gap P8 / P9: evidence still there, and not the same matter as a card already made.
    const why = vet(
      {
        text: candidate.fact,
        dueAt: candidate.dueAt ?? null,
        evidenceIds: candidate.evidenceIds,
      },
      this.state(botId).presence ?? {},
      this.recentOffers(botId, now),
    );
    return why ? { ...parts, total: 0, reason: why } : parts;
  }

  /** Offered before: this exact evidence, or (cards made before ids carried a version) the same unversioned id. */
  private evidenceUsed(botId: string, id: string): boolean {
    const ref = evidenceRef(id);
    return (
      this.store.offers.evidenceUsed(botId, id) || (ref !== id && this.store.offers.evidenceUsed(botId, ref))
    );
  }

  /** The winner: homework when today's budget allows, else the card from the candidate's own words. */
  private offerOrHomework(
    botId: string,
    c: Candidate,
    parts: ScoreParts,
    at: { scanId: string; via: "scan" | "queue" },
    s: ProactiveSettings,
  ): { outcome: "homework" | "offered" | "queued"; offer?: OfferRecord } {
    const now = this.now();
    // The row first, so the homework's card (later) finds it through `logId`.
    const won: Candidate = { ...c };
    const logId = this.log({ botId, ...at, candidate: c, score: parts, now }, "homework");
    if (logId) won.logId = logId;
    else delete won.logId;
    const threadId = this.threadFor(botId);
    if (this.startHomework(botId, threadId, won, parts.total, s)) return { outcome: "homework" };
    const offer = this.propose(botId, threadId, won, parts.total, proposalText(c.fact, c.action));
    return { outcome: offer.queued ? "queued" : "offered", offer };
  }

  /**
   * Gap P3 / P4: when no homework is running, the best queued candidate whose
   * turn came is re-scored (no model call) and, when it passes, goes the same
   * way as a scan's winner. One per call.
   */
  pump(botId: string): ScanResult | undefined {
    const st = this.state(botId);
    if (st.homework || this.running.has(botId)) return undefined;
    const now = this.now();
    let queue = enqueue(st.queue ?? [], [], now);
    const due = dueEntries(queue, now);
    if (!due.length) {
      if (queue.length !== (st.queue ?? []).length) this.patch(botId, { queue });
      return undefined;
    }
    if (!this.o.addons.allowance(botId, PROACTIVE_ID).ok) return undefined;
    const s = this.settings(botId);
    const scored = due
      .map((e) => ({ e, score: this.score(botId, e.candidate, now) }))
      .sort((a, b) => b.score.total - a.score.total);
    const scanId = randomUUID();
    for (const { e, score } of scored) {
      if (score.total >= SCORE_THRESHOLD) {
        this.patch(botId, { queue: without(queue, e.candidate) });
        const r = this.offerOrHomework(botId, e.candidate, score, { scanId, via: "queue" }, s);
        return { ...r, scores: [{ candidate: e.candidate, score }] };
      }
      // Suppressed, gone, changed, a duplicate, offered already: it will not pass later either.
      if (score.reason) {
        queue = without(queue, e.candidate);
        this.log({ botId, scanId, via: "queue", candidate: e.candidate, score, now }, "dropped", {
          dropReason: score.reason,
        });
      } else queue = reschedule(queue, e, now);
    }
    this.patch(botId, { queue });
    return {
      outcome: "no_candidate",
      scores: scored.map((x) => ({ candidate: x.e.candidate, score: x.score })),
    };
  }

  /** C4: a read-only worker checks the details, when today's budget allows. */
  private startHomework(
    botId: string,
    threadId: string,
    c: Candidate,
    score: number,
    s: ProactiveSettings,
  ): boolean {
    const u = this.o.addons.usage(botId, PROACTIVE_ID);
    const left = u?.tokenCap != null ? u.tokenCap - u.tokens : s.dailyTokenCap;
    const runsLeft = u?.runCap != null ? u.runCap - u.runs : s.dailyRunCap;
    if (left < HOMEWORK_MIN_TOKENS || runsLeft < 1) return false;
    try {
      const w = this.o.workers().start({
        botId,
        threadId,
        // Review extra: workers.title is not sealed, so no mail-derived words in it; the fact is in the sealed goal.
        title: `主動留意・${CATEGORY_LABEL[c.category]}`,
        goal: [
          "主動留意發現了一件事，請先把細節查清楚（只讀資料和搜尋，不寄出、不發布、不付款、不刪除、不修改任何東西）。",
          `事實：${defuseAlcaTags(c.fact)}`,
          `想提議的事：${defuseAlcaTags(c.action)}`,
          "查清楚確切的時間、金額或條件後，呼叫 report_result：summary 寫查到的細節，proposal 寫一句話的提案，格式「[事實＋時間]。要我[動作]嗎？」",
        ].join("\n"),
        initiator: { kind: "agent", id: OFFER_SOURCE },
        budget: { maxSteps: 6, maxRunMs: 5 * 60_000, maxTokens: Math.min(left, 20_000) },
        // Plan §5: a general-harness worker, read-only by `restrict` (homework never acts).
        grants: { harness: "general" },
      });
      this.patch(botId, { homework: { workerId: w.id, candidate: c, score, threadId } });
      return true;
    } catch {
      return false;
    }
  }

  /** A homework worker finished (true = it was ours; the router is not woken). */
  workerFinished(w: WorkerRecord): boolean {
    const hw = this.state(w.botId).homework;
    if (!hw || hw.workerId !== w.id) return false;
    this.patch(w.botId, { homework: undefined });
    this.o.addons.charge(w.botId, PROACTIVE_ID, { runs: 1, inputTokens: w.tokens });
    const said = w.status === "succeeded" ? (w.result?.summary ?? "") : "";
    const reported =
      w.status === "succeeded" ? this.o.workers().harnessResult(w)?.report.proposal : undefined;
    const text =
      proposalOf(reported, said)?.slice(0, 300) || proposalText(hw.candidate.fact, hw.candidate.action);
    if (this.o.addons.isEnabled(w.botId, PROACTIVE_ID))
      this.propose(
        w.botId,
        hw.threadId,
        hw.candidate,
        hw.score,
        text.endsWith("？") || text.endsWith("?")
          ? text
          : proposalText(hw.candidate.fact, hw.candidate.action),
      );
    return true;
  }

  /** C5: store the offer; shown now when the window allows, else queued. */
  private propose(botId: string, threadId: string, c: Candidate, score: number, text: string): OfferRecord {
    const show = this.window(botId, this.settings(botId));
    const r = this.o.offers.add(
      {
        botId,
        threadId,
        source: OFFER_SOURCE,
        category: c.category,
        topic: c.action.slice(0, 30),
        text,
        action: `${c.action}（背景：${c.fact}）`,
        evidence: c.evidenceIds,
        score,
        dueAt: c.dueAt ?? null,
        queued: !show,
      },
      { silent: !show },
    );
    this.relog(c.logId, { outcome: r.queued ? "queued" : "offered", offerId: r.id });
    return r;
  }

  /**
   * C6: the person's answer on a card. 好 → an ordinary worker does the action
   * (its sends / payments / deletes / posts still ask); 先不用 → declined;
   * 別再提這類 → declined + the person's suppress rule for this kind and topic.
   */
  answer(offerId: string, choice: "yes" | "later" | "never"): OfferRecord {
    const o = this.store.offers.get(offerId);
    if (!o || o.source !== OFFER_SOURCE) throw new Error("沒有這個提議");
    if (o.status !== "pending") return o;
    if (choice === "yes") {
      let workerId: string | undefined;
      const threadId = o.threadId ?? this.threadFor(o.botId);
      try {
        workerId = this.o.workers().start({
          botId: o.botId,
          threadId,
          title: o.topic || o.text.slice(0, 40),
          goal: `使用者答應了這個提議：「${defuseAlcaTags(o.text)}」\n請去做：${defuseAlcaTags(o.action)}\n寄出、發布、付款、刪除前一定先問使用者。`,
          initiator: { kind: "user", id: `offer:${o.id}` },
        }).id;
      } catch {
        workerId = undefined;
      }
      this.o.offers.decide(o.id, "accepted", workerId ? { workerId } : {});
    } else {
      this.o.offers.decide(o.id, "declined");
      if (choice === "never")
        this.o
          .learning()
          ?.suppress(o.botId, `${CATEGORY_LABEL[o.category]}・${o.topic}`.slice(0, 40), "別再提這類", {
            ...(o.threadId ? { threadId: o.threadId } : {}),
          });
    }
    return this.store.offers.get(o.id) as OfferRecord;
  }

  /** Pending add-on cards (shown, not queued) for the phone's 待處理 and the desktop strip. */
  pending(botId?: string): OfferRecord[] {
    return this.store.offers.list({
      ...(botId ? { botId } : {}),
      source: OFFER_SOURCE,
      status: ["pending"],
      queued: false,
      limit: 20,
    });
  }
}
