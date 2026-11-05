import {
  type AddonCompletion,
  buildStablePrompt,
  CONVERSATION_RULES,
  classifyAnswer,
  DEFAULT_PROFILE,
  detectOffer,
  ruleIssues,
  workerProfile,
} from "@alca/core";
import type { ScriptContext } from "@alca/engines";
import { agentSystem, approvals, lastLine, say, tool, until, using } from "../src/fixtures.ts";
import type { Scenario } from "../src/harness.ts";

// P14 evals (plan v10 §E), deterministic part: conversation rules in the
// stable layer, the offer ledger, must-follow preferences and the reply
// check, all against scripted engines. Every name and fact is fictional.

const echo = () => say("好");

/** A router that answers by keyword, so a scenario can script a conversation. */
const routerBy =
  (table: Array<[string, string]>) =>
  ({ req, pass }: ScriptContext) => {
    if (pass > 0) return say("好");
    const t = lastLine(req.userMessage);
    return say(table.find(([k]) => t.includes(k))?.[1] ?? "了解。");
  };

const fixedComplete =
  (answers: string[]): AddonCompletion =>
  async () => ({ text: answers.shift() ?? '{"ok":true}', inputTokens: 200, outputTokens: 20 });

export const conversationScenarios: Scenario[] = [
  {
    id: "conversation.rules-in-stable-layer",
    category: "conversation",
    title: "The conversation rules are in the router's stable prompt, byte-identical turn to turn",
    async run(ctx) {
      const a = buildStablePrompt(DEFAULT_PROFILE, ["b", "a"]);
      const b = buildStablePrompt(DEFAULT_PROFILE, ["a", "b"]);
      ctx.check("byte-identical", a === b);
      ctx.check("rules present (zh)", a.includes(CONVERSATION_RULES.zh));
      ctx.check("one question per message", CONVERSATION_RULES.zh.includes("一則最多一個問題"));
    },
  },
  {
    id: "conversation.rules-english-bot",
    category: "conversation",
    title: "An English-speaking bot gets the English rules",
    async run(ctx) {
      const p = buildStablePrompt({ ...DEFAULT_PROFILE, language: "en" });
      ctx.check("english rules", p.includes(CONVERSATION_RULES.en));
      ctx.check("no chinese rules", !p.includes(CONVERSATION_RULES.zh));
    },
  },
  {
    id: "conversation.rules-not-for-workers",
    category: "conversation",
    title: "Workers never talk to the person, so their prompt has no conversation rules",
    async run(ctx) {
      ctx.check(
        "absent in worker prompt",
        !buildStablePrompt(workerProfile()).includes(CONVERSATION_RULES.zh),
      );
    },
  },
  {
    id: "conversation.clarify-one-question",
    category: "conversation",
    title: "Clarify: a reply with two questions is flagged; one direct question is fine",
    async run(ctx) {
      ctx.check("two questions flagged", ruleIssues("要訂哪一天？幾位？").length === 1);
      ctx.check("one question ok", ruleIssues("週六晚上七點，兩位，對嗎？").length === 0);
      ctx.check("an answer with no question ok", ruleIssues("查好了，週六晚上有位。").length === 0);
    },
  },
  {
    id: "conversation.converge-after-two-declines",
    category: "conversation",
    title:
      "Converge: after two declined side-project ideas the router is told both, and the rule says ask a direction",
    async run(ctx) {
      const router = routerBy([
        ["點子", "可以開一個手作課程。要我幫你寫企劃嗎？"],
        ["別的", "也可以做二手書轉賣。要我幫你整理流程嗎？"],
      ]);
      await using(agentSystem({ router, worker: echo }), async (a) => {
        const t = a.core.createThread("副業");
        await a.core.send(t.id, "給我副業點子").done;
        await a.core.send(t.id, "不要").done;
        await a.core.send(t.id, "還有別的嗎").done;
        await a.core.send(t.id, "不用").done;
        await a.core.send(t.id, "那怎麼辦").done;
        const v = a.router.requests.at(-1)?.system.volatile ?? "";
        ctx.check(
          "both declined offers in context",
          v.includes("幫你寫企劃") && v.includes("幫你整理流程"),
          v,
        );
        ctx.check("rule: change to a direction question", CONVERSATION_RULES.zh.includes("方向"));
      });
    },
  },
  {
    id: "conversation.offer-recorded",
    category: "conversation",
    title: "End-of-reply offer: 「要我…嗎？」 is recorded as a pending offer with a category",
    async run(ctx) {
      const router = routerBy([["餐廳", "週六有位。要我幫你訂位嗎？"]]);
      await using(agentSystem({ router, worker: echo }), async (a) => {
        const t = a.core.createThread();
        await a.core.send(t.id, "找餐廳").done;
        const [o] = a.store.offers.list({ threadId: t.id });
        ctx.check("pending chat_end offer", o?.status === "pending" && o.source === "chat_end", o);
        ctx.check("errand category", o?.category === "errand", o?.category);
      });
    },
  },
  {
    id: "conversation.offer-accepted",
    category: "conversation",
    title: "好 accepts the offer just made",
    async run(ctx) {
      const router = routerBy([["餐廳", "週六有位。要我幫你訂位嗎？"]]);
      await using(agentSystem({ router, worker: echo }), async (a) => {
        const t = a.core.createThread();
        await a.core.send(t.id, "找餐廳").done;
        await a.core.send(t.id, "好").done;
        ctx.check("accepted", a.store.offers.list({ threadId: t.id })[0]?.status === "accepted");
      });
    },
  },
  {
    id: "conversation.offer-declined-and-not-repeated",
    category: "conversation",
    title: "不用 declines; the router is told not to offer it again in this conversation",
    async run(ctx) {
      const router = routerBy([["報告", "下週三交。要我幫你排進度嗎？"]]);
      await using(agentSystem({ router, worker: echo }), async (a) => {
        const t = a.core.createThread();
        await a.core.send(t.id, "報告何時交").done;
        await a.core.send(t.id, "不用").done;
        ctx.check("declined", a.store.offers.list({ threadId: t.id })[0]?.status === "declined");
        await a.core.send(t.id, "好喔謝謝").done;
        ctx.check(
          "declined offer in the router's context",
          a.router.requests.at(-1)?.system.volatile.includes("幫你排進度") ?? false,
        );
      });
    },
  },
  {
    id: "conversation.question-is-not-an-offer",
    category: "conversation",
    title: "A direction question is not an offer; neither is a plain statement",
    async run(ctx) {
      ctx.check("direction question", detectOffer("你想要長期的，還是快速有收入的？") === undefined);
      ctx.check("statement", detectOffer("好的，已經記下了。") === undefined);
      ctx.check("english offer", detectOffer("Done. Want me to set a reminder?") !== undefined);
    },
  },
  {
    id: "conversation.goodnight-is-a-decline",
    category: "conversation",
    title: "「先這樣」 / 「不用」 decline; a follow-up question leaves the offer open",
    async run(ctx) {
      ctx.check("先這樣", classifyAnswer("先這樣") === "declined");
      ctx.check("不用了", classifyAnswer("不用了，謝謝") === "declined");
      ctx.check("question", classifyAnswer("那要多少錢？") === "none");
      ctx.check("別再提這類", classifyAnswer("別再提這類") === "suppress");
    },
  },
  {
    id: "conversation.offer-ignored-after-a-day",
    category: "conversation",
    title: "An offer nobody answers is ignored after 24 hours",
    async run(ctx) {
      let now = Date.parse("2026-11-03T02:00:00Z");
      const router = routerBy([["帳單", "這期 980 元。要我提醒你繳費嗎？"]]);
      await using(agentSystem({ router, worker: echo, system: { now: () => new Date(now) } }), async (a) => {
        const t = a.core.createThread();
        await a.core.send(t.id, "帳單多少").done;
        now += 25 * 3600_000;
        a.agents.offers.sweep();
        ctx.check("ignored", a.store.offers.list({ threadId: t.id })[0]?.status === "ignored");
      });
    },
  },
  {
    id: "conversation.reply-check-rewrites-once",
    category: "conversation",
    title: "回覆檢查: two questions → one rewrite; the stored reply becomes the rewrite (已修改)",
    async run(ctx) {
      const router = routerBy([["旅行", "你想去哪裡？什麼時候去？"]]);
      const complete = fixedComplete(['{"ok":false,"issues":["兩個問題"]}', "你想什麼時候出發？"]);
      await using(agentSystem({ router, worker: echo, system: { addonComplete: complete } }), async (a) => {
        const bot = a.store.bots.ensureDefault().id;
        a.agents.addons.set(bot, "reply-check", { enabled: true });
        const t = a.core.createThread();
        await a.core.send(t.id, "想去旅行").done;
        await a.agents.replyCheck.settle();
        const last = a.store.threads
          .messages(t.id)
          .filter((m) => m.role === "assistant")
          .at(-1);
        ctx.check("rewritten", last?.content === "你想什麼時候出發？", last?.content);
        ctx.check(
          "reply.revised",
          a.agentEvents.some((e) => e.type === "reply.revised"),
        );
      });
    },
  },
  {
    id: "conversation.reply-check-timeout-keeps",
    category: "conversation",
    title: "回覆檢查: a check that times out sends the original",
    async run(ctx) {
      const complete: AddonCompletion = ({ signal }) =>
        new Promise((_, rej) => signal.addEventListener("abort", () => rej(new Error("timeout"))));
      await using(
        agentSystem({ router: () => say("好的。"), worker: echo, system: { addonComplete: complete } }),
        async (a) => {
          const bot = a.store.bots.ensureDefault().id;
          a.agents.addons.set(bot, "reply-check", { enabled: true, settings: { timeoutSec: 1 } });
          const t = a.core.createThread();
          await a.core.send(t.id, "嗨").done;
          await a.agents.replyCheck.settle();
          const last = a.store.threads
            .messages(t.id)
            .filter((m) => m.role === "assistant")
            .at(-1);
          ctx.check("original kept", last?.content === "好的。", last?.content);
        },
      );
    },
  },
];

/** Router that dispatches one worker for a mail / purchase / weather request. */
function dispatcher({ req, pass }: ScriptContext) {
  if (pass === 0 && req.userMessage.includes("<alca:worker")) return say("做好了。");
  if (pass > 0) return say("好");
  const t = lastLine(req.userMessage);
  const job = t.includes("寫一封信")
    ? { title: "寫信給開源團隊", goal: "寫信給開源團隊，問能不能加入" }
    : t.includes("買")
      ? { title: "買耳機", goal: "幫我買一副耳機" }
      : t.includes("天氣")
        ? { title: "查天氣", goal: "查明天天氣" }
        : undefined;
  if (!job) return say("好");
  return [
    ...say("好，我請工人去做。"),
    { type: "tool.call" as const, id: "r1", name: "worker_start", input: job },
    { type: "done" as const, stop: "tool_use" as const },
  ];
}

function doer({ req, pass }: ScriptContext) {
  if (pass > 0) return say("完成。");
  const goal = lastLine(req.userMessage);
  if (goal.includes("開源團隊"))
    return [
      { type: "tool.call" as const, id: "w1", name: "send_mail", input: { body: "你好" } },
      { type: "done" as const, stop: "tool_use" as const },
    ];
  if (goal.includes("耳機"))
    return [
      { type: "tool.call" as const, id: "w2", name: "pay", input: { item: "耳機" } },
      { type: "done" as const, stop: "tool_use" as const },
    ];
  return say("明天晴。");
}

export const mustFollowScenarios: Scenario[] = [
  {
    id: "memory.must-follow-mail",
    category: "memory",
    title: "「寫信不要提到我的學校」 → the mail worker's request carries it; the send card shows 已套用",
    async run(ctx) {
      const send = tool("send_mail", "send");
      await using(agentSystem({ router: dispatcher, worker: doer, tools: [send] }), async (a) => {
        const t = a.core.createThread();
        await a.core.send(t.id, "記住寫信不要提到我的學校").done;
        await a.agents.learning?.settle();
        ctx.check(
          "applies to send_message",
          a.store.memory.list()[0]?.appliesTo.includes("send_message") ?? false,
        );
        await a.core.send(t.id, "幫我寫一封信給開源團隊").done;
        const card = await until(() => approvals(a.events)[0]);
        ctx.check("card shows 已套用", card.data.applied?.[0] === "寫信不要提到我的學校", card.data.applied);
        const req = a.worker.requests.find((r) => r.userMessage.includes("開源團隊"));
        ctx.check(
          "worker request has the must-follow block",
          /<alca:must-follow>[\s\S]*學校/u.test(req?.userMessage ?? ""),
        );
        ctx.check("nothing sent before the yes", send.calls.length === 0);
      });
    },
  },
  {
    id: "memory.must-follow-purchase",
    category: "memory",
    title: "「買東西一律選可退款」 reaches a purchase worker and its payment card",
    async run(ctx) {
      const pay = tool("pay", "payment");
      await using(agentSystem({ router: dispatcher, worker: doer, tools: [pay] }), async (a) => {
        const t = a.core.createThread();
        await a.core.send(t.id, "記住買東西一律選可退款").done;
        await a.agents.learning?.settle();
        await a.core.send(t.id, "幫我買耳機").done;
        const card = await until(() => approvals(a.events)[0]);
        ctx.check("payment card", card.data.actionClass === "payment");
        ctx.check(
          "已套用 on the card",
          (card.data.applied ?? []).some((x) => x.includes("可退款")),
          card.data.applied,
        );
      });
    },
  },
  {
    id: "memory.must-follow-only-when-relevant",
    category: "memory",
    title: "A weather lookup gets no must-follow block",
    async run(ctx) {
      await using(agentSystem({ router: dispatcher, worker: doer }), async (a) => {
        const t = a.core.createThread();
        await a.core.send(t.id, "記住寫信不要提到我的學校").done;
        await a.agents.learning?.settle();
        await a.core.send(t.id, "明天天氣如何").done;
        const req = await until(() => a.worker.requests.find((r) => r.userMessage.includes("查明天天氣")));
        ctx.check("no block", !req.userMessage.includes("<alca:must-follow>"));
      });
    },
  },
  {
    id: "memory.no-source-talk",
    category: "memory",
    title: "Saying where a memory came from is flagged by the reply check's rules",
    async run(ctx) {
      ctx.check("flagged", ruleIssues("我在你的信裡看到你下週要面試。").length === 1);
      ctx.check("plain use ok", ruleIssues("你下週要面試，要我幫你準備問題嗎？").length === 0);
    },
  },
  {
    id: "memory.deadline-becomes-project",
    category: "memory",
    title: "「下週三考物理」 is learned as a project memory with a due date",
    async run(ctx) {
      await using(agentSystem({ router: echo, worker: echo, advanced: { learning: true } }), async (a) => {
        const t = a.core.createThread();
        await a.core.send(t.id, "下週三考物理").done;
        await a.agents.learning?.settle();
        const m = a.store.memory.list().find((x) => x.kind === "project");
        ctx.check("project with due_at", !!m?.dueAt, a.store.memory.list());
      });
    },
  },
  {
    id: "memory.suppress-is-the-persons",
    category: "memory",
    title: "「別再提副業」 is the person's own rule for proactive offers, not a must-follow for sends",
    async run(ctx) {
      await using(agentSystem({ router: echo, worker: echo }), async (a) => {
        const t = a.core.createThread();
        await a.core.send(t.id, "別再提副業了").done;
        const m = a.store.memory.list().find((x) => x.subject.startsWith("suppress:"));
        ctx.check("origin user", m?.origin === "user", m);
        ctx.check(
          "applies to proactive only",
          JSON.stringify(m?.appliesTo) === '["proactive"]',
          m?.appliesTo,
        );
      });
    },
  },
];
