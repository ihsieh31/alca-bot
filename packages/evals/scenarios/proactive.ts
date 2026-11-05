import {
  type AddonCompletion,
  type AppItem,
  AppSource,
  OFFER_SOURCE,
  type ProactiveSource,
} from "@alca/core";
import type { ScriptContext } from "@alca/engines";
import {
  type Agents,
  agentSystem,
  approvals,
  call,
  lastLine,
  say,
  tool,
  until,
  using,
} from "../src/fixtures.ts";
import type { Scenario } from "../src/harness.ts";
import { PROACTIVE_CASES } from "../src/proactive-cases.ts";
import { CORPUS_GATES, runCorpus } from "../src/proactive-corpus.ts";

// P14 evals for 主動留意 and the add-on framework, against scripted engines
// and a fake candidate step. Every fact is fictional.

const T_DAY = Date.parse("2026-11-03T02:00:00Z"); // Tue 10:00 in Taipei
const T_NIGHT = Date.parse("2026-11-03T15:00:00Z"); // Tue 23:00 in Taipei
const DAY = 86400_000;

type Cand = {
  fact: string;
  action: string;
  category: string;
  due_at?: string | null;
  evidence_ids: string[];
};

/** The candidate step: a function of the evidence ids it was shown. */
function candidates(make: (ids: string[], prompt: string) => Cand[] | string) {
  const calls: string[] = [];
  const complete: AddonCompletion = async ({ prompt }) => {
    calls.push(prompt);
    const ids = [...prompt.matchAll(/id=(\S+)/gu)].map((m) => m[1] as string);
    const out = make(ids, prompt);
    return {
      text: typeof out === "string" ? out : JSON.stringify({ candidates: out }),
      inputTokens: 1500,
      outputTokens: 100,
    };
  };
  return { complete, calls };
}

const iso = (ms: number) => new Date(ms).toISOString();

/** Plan §5: the homework is a general-harness worker; it proposes through report_result.proposal. */
const PROPOSAL = "細節查好了。要我幫你處理嗎？";

function worker({ req, pass }: ScriptContext) {
  if (pass > 0 && req.toolResults?.[0]?.id === "hw-send")
    return call("hw-report", "report_result", {
      status: "done",
      summary: "細節查好了。",
      proposal: PROPOSAL,
    });
  if (pass > 0) return say("完成。");
  if (req.userMessage.includes("主動留意發現了一件事"))
    return [
      { type: "tool.call" as const, id: "hw-send", name: "send_mail", input: {} },
      { type: "done" as const, stop: "tool_use" as const },
    ];
  if (lastLine(req.userMessage).includes("請去做") || req.userMessage.includes("使用者答應了這個提議"))
    return [
      { type: "tool.call" as const, id: "yes-send", name: "send_mail", input: {} },
      { type: "done" as const, stop: "tool_use" as const },
    ];
  return say("x");
}

interface Pro extends Agents {
  bot: string;
  calls: string[];
  send: ReturnType<typeof tool>;
  at(ms: number): void;
  due(body: string, dueMs: number): string;
}

function pro(o: {
  make?: (ids: string[], prompt: string) => Cand[] | string;
  start?: number;
  sources?: ProactiveSource[];
}): Pro {
  let now = o.start ?? T_DAY;
  const fake = candidates(
    o.make ??
      ((ids) => [
        {
          fact: "報告 11 月 6 日截止",
          action: "排寫作進度",
          category: "study",
          due_at: iso(T_DAY + 3 * DAY),
          evidence_ids: ids.slice(0, 1),
        },
      ]),
  );
  const send = tool("send_mail", "send");
  const a = agentSystem({
    router: () => say("好"),
    worker,
    tools: [send],
    system: {
      now: () => new Date(now),
      addonComplete: fake.complete,
      ...(o.sources ? { proactiveSources: o.sources } : {}),
    },
  });
  const bot = a.store.bots.ensureDefault().id;
  return Object.assign(a, {
    bot,
    calls: fake.calls,
    send,
    at: (ms: number) => {
      now = ms;
    },
    due: (body: string, dueMs: number) =>
      a.agents.learning?.memory.remember(
        bot,
        { kind: "project", subject: `due:${body}`, body, quote: body, confidence: 1, dueAt: iso(dueMs) },
        {},
        { scope: "shared" },
      )?.memory?.id ?? "",
  });
}

const on = (p: Pro, settings: Record<string, unknown> = {}) =>
  p.agents.addons.set(p.bot, "proactive", { enabled: true, settings });
const offers = (p: Pro) => p.store.offers.list({ source: OFFER_SOURCE });

export const proactiveScenarios: Scenario[] = [
  {
    id: "proactive.no-signal-no-spend",
    category: "proactive",
    title: "No new data → quiet, no model call, 0 tokens, no card",
    async run(ctx) {
      await using(pro({}), async (p) => {
        on(p);
        const r = await p.agents.proactive.scan(p.bot, { force: true });
        ctx.check("quiet", r.outcome === "quiet", r.outcome);
        ctx.check("no model call", p.calls.length === 0);
        ctx.check("0 tokens", p.agents.addons.usage(p.bot, "proactive")?.tokens === 0);
        ctx.check("no offer", offers(p).length === 0);
      });
    },
  },
  {
    id: "proactive.deadline-offers-one",
    category: "proactive",
    title: "A deadline in 3 days → one candidate above the threshold → homework → one card",
    async run(ctx) {
      await using(pro({}), async (p) => {
        p.due("11月6日要交報告", T_DAY + 3 * DAY);
        on(p);
        const r = await p.agents.proactive.scan(p.bot, { force: true });
        ctx.check("homework started", r.outcome === "homework", r.outcome);
        const o = await until(() => offers(p)[0]);
        ctx.check("one card, shown", offers(p).length === 1 && !o.queued, o);
        ctx.check("one-word answerable", o.text.endsWith("嗎？"), o.text);
        ctx.check("the card is the worker's report_result.proposal", o.text === PROPOSAL, o.text);
      });
    },
  },
  {
    id: "proactive.renewal-with-quota-complaint",
    category: "proactive",
    title: "A renewal on the calendar in 3 days + the person once complained about quota → one money card",
    async run(ctx) {
      const cal = new AppSource(
        "calendar",
        async (): Promise<AppItem[]> => [
          { id: "ev-renew", title: "雲端硬碟訂閱自動續訂", startsAt: iso(T_DAY + 3 * DAY) },
        ],
      );
      const make = (ids: string[], prompt: string): Cand[] =>
        prompt.includes("額度")
          ? [
              {
                fact: "雲端硬碟訂閱 11 月 6 日續訂",
                action: "比較方案並提醒你決定",
                category: "money_account",
                due_at: iso(T_DAY + 3 * DAY),
                evidence_ids: ids.filter((i) => i.startsWith("cal:")),
              },
            ]
          : [];
      await using(pro({ make, sources: [cal] }), async (p) => {
        p.agents.learning?.memory.remember(
          p.bot,
          {
            kind: "fact",
            subject: "quota",
            body: "抱怨雲端硬碟額度不夠用",
            quote: "額度又不夠了",
            confidence: 1,
          },
          {},
          { scope: "shared" },
        );
        on(p, { dailyTokenCap: 2000 });
        const r = await p.agents.proactive.scan(p.bot, { force: true });
        ctx.check("offered", r.outcome === "offered", r);
        ctx.check("money category", r.offer?.category === "money_account", r.offer?.category);
        ctx.check(
          "cites the calendar event",
          r.offer?.evidence[0]?.startsWith("cal:") ?? false,
          r.offer?.evidence,
        );
      });
    },
  },
  {
    id: "proactive.quiet-hours-queue",
    category: "proactive",
    title: "At 23:00 the card is queued, not shown, and no push-worthy event goes out",
    async run(ctx) {
      await using(pro({ start: T_NIGHT }), async (p) => {
        p.due("11月6日要交報告", T_DAY + 3 * DAY);
        on(p, { dailyTokenCap: 2000 });
        const r = await p.agents.proactive.scan(p.bot, { force: true });
        ctx.check("queued", r.outcome === "queued", r.outcome);
        p.at(T_NIGHT + 3 * 3600_000);
        ctx.check("still queued at 02:00", p.agents.proactive.release(p.bot) === undefined);
        p.at(T_NIGHT + 10 * 3600_000); // 09:00
        const shown = p.agents.proactive.release(p.bot);
        ctx.check("shown at 09:00", !!shown && !shown.queued, shown);
        ctx.check(
          "offer.created now",
          p.agentEvents.some((e) => e.type === "offer.created"),
        );
      });
    },
  },
  {
    id: "proactive.daily-count",
    category: "proactive",
    title: "With 每天最多 1 件, the second card of the day waits",
    async run(ctx) {
      // A distinct fact per scan (two cards about one fact are one matter, gap P8).
      const facts = ["11 月 5 日英文考試", "11 月 5 日數學作業截止"];
      let n = 0;
      const make = (ids: string[]): Cand[] =>
        ids.slice(0, 1).map((id) => ({
          fact: facts[n++ % facts.length] as string,
          action: "整理重點",
          category: "study",
          due_at: iso(T_DAY + 2 * DAY),
          evidence_ids: [id],
        }));
      await using(pro({ make }), async (p) => {
        on(p, { maxPerDay: 1, minIntervalHours: 0.5, dailyTokenCap: 3000 });
        p.due("11月5日要考英文", T_DAY + 2 * DAY);
        const first = await p.agents.proactive.scan(p.bot, { force: true });
        p.due("11月5日要交作業", T_DAY + 2 * DAY);
        p.at(T_DAY + 2 * 3600_000);
        const second = await p.agents.proactive.scan(p.bot, { force: true });
        ctx.check("first shown", first.outcome === "offered", first.outcome);
        ctx.check("second queued", second.outcome === "queued", second.outcome);
      });
    },
  },
  {
    id: "proactive.min-interval",
    category: "proactive",
    title: "Two cards are at least 3 hours apart",
    async run(ctx) {
      // A distinct fact per scan (two cards about one fact are one matter, gap P8).
      const facts = ["11 月 5 日英文考試", "11 月 5 日數學作業截止"];
      let n = 0;
      const make = (ids: string[]): Cand[] =>
        ids.slice(0, 1).map((id) => ({
          fact: facts[n++ % facts.length] as string,
          action: "整理重點",
          category: "study",
          due_at: iso(T_DAY + 2 * DAY),
          evidence_ids: [id],
        }));
      await using(pro({ make }), async (p) => {
        on(p, { dailyTokenCap: 3000, dailyRunCap: 10 });
        p.due("11月5日要考英文", T_DAY + 2 * DAY);
        await p.agents.proactive.scan(p.bot, { force: true });
        p.due("11月5日要交作業", T_DAY + 2 * DAY);
        p.at(T_DAY + 3600_000);
        const soon = await p.agents.proactive.scan(p.bot, { force: true });
        ctx.check("an hour later: queued", soon.outcome === "queued", soon.outcome);
        p.at(T_DAY + 3.5 * 3600_000);
        ctx.check("3.5 hours later: shown", !!p.agents.proactive.release(p.bot));
      });
    },
  },
  {
    id: "proactive.suppress-holds",
    category: "proactive",
    title: "別再提這類 on a study card zeroes the next study candidate",
    async run(ctx) {
      await using(pro({}), async (p) => {
        p.due("11月6日要交報告", T_DAY + 3 * DAY);
        on(p, { dailyTokenCap: 2000 });
        const r = await p.agents.proactive.scan(p.bot, { force: true });
        if (r.offer) p.agents.proactive.answer(r.offer.id, "never");
        p.at(T_DAY + DAY);
        p.due("11月8日要交心得", T_DAY + 5 * DAY);
        const again = await p.agents.proactive.scan(p.bot, { force: true });
        ctx.check("suppressed", again.scores?.[0]?.score.reason === "suppressed", again.scores);
        ctx.check("no second card", offers(p).length === 1);
      });
    },
  },
  {
    id: "proactive.accept-rate-orders",
    category: "proactive",
    title: "Equal candidates: the category the person usually accepts wins",
    async run(ctx) {
      const make = (ids: string[]): Cand[] => [
        {
          fact: "社團聚餐 11 月 6 日",
          action: "整理出席名單",
          category: "social",
          due_at: iso(T_DAY + 3 * DAY),
          evidence_ids: ids.slice(0, 1),
        },
        {
          fact: "專題 11 月 6 日展示",
          action: "整理展示重點",
          category: "project",
          due_at: iso(T_DAY + 3 * DAY),
          evidence_ids: ids.slice(0, 1),
        },
      ];
      await using(pro({ make }), async (p) => {
        for (let i = 0; i < 4; i++) {
          const o = p.agents.offers.add({
            botId: p.bot,
            source: "chat_end",
            category: "project",
            text: `舊提議 ${i}`,
          });
          p.agents.offers.decide(o.id, "accepted");
          const s = p.agents.offers.add({
            botId: p.bot,
            source: "chat_end",
            category: "social",
            text: `舊提議 s${i}`,
          });
          p.agents.offers.decide(s.id, "declined");
        }
        p.due("11月6日有活動", T_DAY + 3 * DAY);
        on(p, { dailyTokenCap: 2000 });
        const r = await p.agents.proactive.scan(p.bot, { force: true });
        ctx.check("project first", r.scores?.[0]?.candidate.category === "project", r.scores);
      });
    },
  },
  {
    id: "proactive.evidence-once",
    category: "proactive",
    title: "The same piece of evidence never becomes a second card",
    async run(ctx) {
      await using(pro({}), async (p) => {
        const id = p.due("11月6日要交報告", T_DAY + 3 * DAY);
        on(p, { dailyTokenCap: 2000 });
        await p.agents.proactive.scan(p.bot, { force: true });
        p.agents.addons.setState(p.bot, "proactive", {});
        p.at(T_DAY + DAY);
        const again = await p.agents.proactive.scan(p.bot, { force: true });
        ctx.check("reused evidence scores 0", again.scores?.[0]?.score.reason === "evidence_used", {
          again,
          id,
        });
      });
    },
  },
  {
    id: "proactive.bad-output-dropped",
    category: "proactive",
    title: "Output that is not the JSON asked for gives no card",
    async run(ctx) {
      await using(pro({ make: () => "我覺得你應該讀書。" }), async (p) => {
        p.due("11月6日要交報告", T_DAY + 3 * DAY);
        on(p);
        const r = await p.agents.proactive.scan(p.bot, { force: true });
        // Gap P2: not the JSON asked for → model_failed, the evidence stays new for a retry.
        ctx.check("no candidate", r.outcome === "model_failed", r.outcome);
        ctx.check("no card", offers(p).length === 0);
      });
    },
  },
  {
    id: "proactive.unknown-evidence-dropped",
    category: "proactive",
    title: "A candidate citing evidence that does not exist is dropped",
    async run(ctx) {
      const make = (): Cand[] => [
        { fact: "編造的期限", action: "整理", category: "study", evidence_ids: ["due:mem_NOPE"] },
      ];
      await using(pro({ make }), async (p) => {
        p.due("11月6日要交報告", T_DAY + 3 * DAY);
        on(p);
        const r = await p.agents.proactive.scan(p.bot, { force: true });
        ctx.check("no candidate", r.outcome === "no_candidate" && !r.scores?.length, r);
      });
    },
  },
  {
    id: "proactive.homework-read-only",
    category: "proactive",
    title: "The homework worker's send is refused before the gate: no card, nothing sent",
    async run(ctx) {
      await using(pro({}), async (p) => {
        p.due("11月6日要交報告", T_DAY + 3 * DAY);
        on(p);
        await p.agents.proactive.scan(p.bot, { force: true });
        await until(() => offers(p)[0]);
        ctx.check("nothing sent", p.send.calls.length === 0);
        ctx.check("no approval card", approvals(p.events).length === 0);
      });
    },
  },
  {
    id: "proactive.yes-still-asks",
    category: "proactive",
    title: "好 starts an ordinary worker; its send still waits for the person's yes",
    async run(ctx) {
      await using(pro({}), async (p) => {
        p.due("11月6日要交報告", T_DAY + 3 * DAY);
        on(p, { dailyTokenCap: 2000 });
        const r = await p.agents.proactive.scan(p.bot, { force: true });
        const done = r.offer ? p.agents.proactive.answer(r.offer.id, "yes") : undefined;
        ctx.check("accepted with a worker", done?.status === "accepted" && !!done.workerId, done);
        const card = await until(() => approvals(p.events)[0]);
        ctx.check("send card", card.data.actionClass === "send");
        ctx.check("not sent yet", p.send.calls.length === 0);
      });
    },
  },
  {
    id: "proactive.expires-past-due",
    category: "proactive",
    title: "A queued card whose deadline passed expires instead of being shown",
    async run(ctx) {
      await using(pro({ start: T_NIGHT }), async (p) => {
        p.due("11月6日要交報告", T_DAY + 3 * DAY);
        on(p, { dailyTokenCap: 2000 });
        const r = await p.agents.proactive.scan(p.bot, { force: true });
        p.at(T_DAY + 5 * DAY);
        p.agents.proactive.release(p.bot);
        ctx.check("expired", r.offer ? p.store.offers.get(r.offer.id)?.status === "expired" : false);
      });
    },
  },
  {
    id: "proactive.ignored-after-two-days",
    category: "proactive",
    title: "A card nobody answers is ignored after 48 hours",
    async run(ctx) {
      await using(pro({}), async (p) => {
        p.due("11月10日要交報告", T_DAY + 7 * DAY);
        on(p, { dailyTokenCap: 2000 });
        const r = await p.agents.proactive.scan(p.bot, { force: true });
        p.at(T_DAY + 49 * 3600_000);
        await p.agents.proactive.tick();
        ctx.check(
          "ignored",
          r.offer ? p.store.offers.get(r.offer.id)?.status === "ignored" : false,
          r.outcome,
        );
      });
    },
  },
  {
    id: "proactive.precision-corpus",
    category: "proactive",
    title:
      "The labeled corpus meets the gates (precision ≥ 0.9, recall ≥ 0.8, no false interrupt or duplicate)",
    timeoutMs: 60_000,
    async run(ctx) {
      const { results, metrics } = await runCorpus(PROACTIVE_CASES);
      ctx.check("precision", metrics.precision >= CORPUS_GATES.precision, metrics);
      ctx.check("recall", metrics.recall >= CORPUS_GATES.recall, metrics);
      ctx.check("false interrupts", metrics.falseInterrupts === CORPUS_GATES.falseInterrupts, metrics);
      ctx.check("duplicates", metrics.duplicates === CORPUS_GATES.duplicates, metrics);
      for (const r of results.filter((x) => !x.ok))
        ctx.check(`case ${r.id}`, false, { shown: r.shown, missed: r.missed });
    },
  },
];

export const addonScenarios: Scenario[] = [
  {
    id: "addons.default-off",
    category: "addons",
    title: "Every add-on is off for a new bot",
    async run(ctx) {
      await using(pro({}), async (p) => {
        ctx.check(
          "all off",
          p.agents.addons.list(p.bot).every((a) => !a.enabled),
        );
      });
    },
  },
  {
    id: "addons.off-means-no-run",
    category: "addons",
    title: "With 主動留意 off, a due deadline is never scanned or paid for",
    async run(ctx) {
      await using(pro({}), async (p) => {
        p.due("11月6日要交報告", T_DAY + 3 * DAY);
        await p.agents.proactive.tick();
        ctx.check("no model call", p.calls.length === 0);
        ctx.check("no card", offers(p).length === 0);
      });
    },
  },
  {
    id: "addons.cap-stops",
    category: "addons",
    title: "Past the daily run cap the add-on stops and says so once (addon.capped)",
    async run(ctx) {
      await using(pro({}), async (p) => {
        p.due("11月6日要交報告", T_DAY + 3 * DAY);
        on(p, { dailyRunCap: 1 });
        await p.agents.proactive.scan(p.bot, { force: true });
        const again = await p.agents.proactive.scan(p.bot, { force: true });
        await p.agents.proactive.scan(p.bot, { force: true });
        ctx.check("capped", again.outcome === "capped", again.outcome);
        ctx.check("one addon.capped", p.agentEvents.filter((e) => e.type === "addon.capped").length === 1);
      });
    },
  },
  {
    id: "addons.cap-resets-next-day",
    category: "addons",
    title: "The cap is per local day: the next morning it runs again",
    async run(ctx) {
      await using(pro({}), async (p) => {
        p.due("11月6日要交報告", T_DAY + 3 * DAY);
        on(p, { dailyRunCap: 1 });
        await p.agents.proactive.scan(p.bot, { force: true });
        p.at(T_DAY + DAY);
        p.due("11月8日要考試", T_DAY + 5 * DAY);
        const r = await p.agents.proactive.scan(p.bot, { force: true });
        ctx.check("runs again", r.outcome !== "capped", r.outcome);
      });
    },
  },
  {
    id: "addons.turn-off-clears-queue",
    category: "addons",
    title: "Turning 主動留意 off clears its queued cards (nothing is deleted)",
    async run(ctx) {
      await using(pro({ start: T_NIGHT }), async (p) => {
        p.due("11月6日要交報告", T_DAY + 3 * DAY);
        on(p, { dailyTokenCap: 2000 });
        const r = await p.agents.proactive.scan(p.bot, { force: true });
        p.agents.addons.set(p.bot, "proactive", { enabled: false });
        const o = r.offer ? p.store.offers.get(r.offer.id) : undefined;
        ctx.check("queued card expired, row kept", o?.status === "expired", o);
      });
    },
  },
  {
    id: "addons.turn-on-starts-now",
    category: "addons",
    title: "Turned on, it starts from now: the clock does not scan at once to catch up",
    async run(ctx) {
      await using(pro({}), async (p) => {
        p.due("11月6日要交報告", T_DAY + 3 * DAY);
        on(p);
        await p.agents.proactive.tick();
        ctx.check("not scanned yet", p.calls.length === 0);
        p.at(T_DAY + 31 * 60_000);
        await p.agents.proactive.tick();
        ctx.check("scanned after the interval", p.calls.length === 1, p.calls.length);
      });
    },
  },
];
