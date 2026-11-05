import type { ScriptContext } from "@alca/engines";
import {
  type Agents,
  agentSystem,
  approvals,
  call,
  say,
  tool,
  until,
  using,
  within,
} from "../src/fixtures.ts";
import type { Scenario } from "../src/harness.ts";

const whoAmI = (ctx: ScriptContext) => /你是「([^」]+)」/.exec(ctx.req.system.volatile)?.[1] ?? "Alca";

/** "交給<bot>：<task>" delegates; a teammate's "派工：<goal>" starts its worker. */
function teamRouter(ctx: ScriptContext) {
  const { req, pass } = ctx;
  const me = whoAmI(ctx);
  const msg = req.userMessage;
  if (pass > 0) return say(`${me}：好`);
  if (msg.includes("<alca:peer-report")) return say(`${me} 收到隊友回覆`);
  if (msg.includes("<alca:worker")) return say(`${me} 的工人做完了`);
  const peerTask = /<alca:peer [^>]*>\n([\s\S]*?)\n<\/alca:peer>/.exec(msg)?.[1];
  const text = peerTask ?? msg.trim().split("\n").at(-1) ?? "";
  const hand = /^交給([^：]+)：(.+)$/.exec(text);
  if (hand) return call("p1", "peer_delegate", { bot: hand[1], task: hand[2] });
  if (text.startsWith("派工：")) return call("w1", "worker_start", { title: "工作", goal: text.slice(3) });
  return say(`${me}：${text}`);
}

function teamWorker({ req, pass }: ScriptContext) {
  const goal = req.userMessage.trim().split("\n").at(-1) ?? "";
  if (pass > 0) return say(`做完：${goal}`);
  if (goal === "寄信") return call("s1", "send_mail", { to: "boss@example.com" });
  if (goal === "寫檔") return call("s1", "write_note", { title: "x" });
  if (goal === "付款") return call("s1", "checkout_pay", { amount: 1280 });
  return say(`做完：${goal}`);
}

function team(o: { level: "autonomous" | "confirm_each_step"; rule: "auto" | "ask_delegate" | "ask_all" }) {
  const tools = {
    send: tool("send_mail", "send"),
    write: tool("write_note", "write"),
    pay: tool("checkout_pay", "payment"),
  };
  const a = agentSystem({
    router: teamRouter,
    worker: teamWorker,
    tools: Object.values(tools),
    level: o.level,
  });
  a.store.team.setRules({ peerApproval: o.rule });
  const lead = a.store.bots.default()!;
  const res = a.store.bots.create("研究員", { role: "查資料" });
  return { a, lead, res, tools };
}

const cardIn = (a: Agents, rootThread: string) =>
  until(
    () =>
      a.agents.pendingCards(rootThread).find((e) => e.type === "approval.requested") as
        | ReturnType<typeof approvals>[number]
        | undefined,
    5000,
  ).catch(() => undefined);

export const teamScenarios: Scenario[] = [
  {
    id: "team.delegation-narrows-level",
    category: "team",
    title: "A 自主 teammate works at the asker's 每步確認 level: a write asks",
    async run(ctx) {
      const f = team({ level: "autonomous", rule: "auto" });
      await using(f.a, async (a) => {
        a.store.bots.update(f.lead.id, { approvalLevel: "confirm_each_step" });
        const t = a.core.createThread("narrow");
        await a.core.send(t.id, "交給研究員：派工：寫檔").done;
        const card = await cardIn(a, t.id);
        ctx.check("teammate is 自主 on its own", a.core.levelFor(f.res.id) === "autonomous");
        ctx.check("write asked in the person's conversation", card?.data.actionClass === "write", card?.data);
        ctx.check("nothing written yet", f.tools.write.calls.length === 0);
        if (card) a.core.answerApproval(card.data.approvalId, "denied");
        await within(() => a.store.team.byRoot(t.id)[0]?.status === "done", 5000);
        ctx.check("denied: never written", f.tools.write.calls.length === 0);
      });
    },
  },
  {
    id: "team.send-asks-under-autonomous",
    category: "team",
    title: "A send by a teammate's worker asks the person even when everyone is 自主 and the rule is auto",
    async run(ctx) {
      const f = team({ level: "autonomous", rule: "auto" });
      await using(f.a, async (a) => {
        const t = a.core.createThread("send");
        await a.core.send(t.id, "交給研究員：派工：寄信").done;
        const card = await cardIn(a, t.id);
        ctx.check("send card", card?.data.actionClass === "send", card?.data);
        ctx.check("card is the teammate's", card?.data.botId === f.res.id, card?.data.botId);
        ctx.check("not sent", f.tools.send.calls.length === 0);
        const req = a.store.team.byRoot(t.id)[0];
        ctx.check(
          "trail records the card",
          !!req &&
            a.store.team.events(req.id).some((e) => e.kind === "card" && e.detail.actionClass === "send"),
        );
      });
    },
  },
  {
    id: "team.payment-asks-under-autonomous",
    category: "team",
    title: "A payment by a teammate's worker asks the person under 自主",
    async run(ctx) {
      const f = team({ level: "autonomous", rule: "auto" });
      await using(f.a, async (a) => {
        const t = a.core.createThread("pay");
        await a.core.send(t.id, "交給研究員：派工：付款").done;
        const card = await cardIn(a, t.id);
        ctx.check("payment card", card?.data.actionClass === "payment", card?.data);
        if (card) a.core.answerApproval(card.data.approvalId, "denied");
        await within(() => a.store.team.byRoot(t.id)[0]?.status === "done", 5000);
        ctx.check("never paid", f.tools.pay.calls.length === 0);
      });
    },
  },
  {
    id: "team.ask-delegate-rule",
    category: "team",
    title: "ask_delegate: a delegation waits for the person's yes; denied, it is never sent",
    async run(ctx) {
      const f = team({ level: "autonomous", rule: "ask_delegate" });
      await using(f.a, async (a) => {
        const t = a.core.createThread("rule");
        const { done } = a.core.send(t.id, "交給研究員：派工：寫檔");
        const card = await until(() => approvals(a.events)[0], 4000).catch(() => undefined);
        ctx.check(
          "delegation card raised",
          !!card,
          a.events.map((e) => e.type),
        );
        ctx.check(
          "nothing delegated before the yes",
          a.store.team.byRoot(t.id).filter((r) => r.kind === "delegate").length === 0,
        );
        if (card) a.core.answerApproval(card.data.approvalId, "denied");
        await done;
        const req = a.store.team.byRoot(t.id)[0];
        ctx.check("request ends denied", req?.status === "denied", req?.status);
        ctx.check("no peer conversation was opened", req?.peerThreadId === null, req?.peerThreadId);
        ctx.check("teammate's worker never ran", f.tools.write.calls.length === 0);
      });
    },
  },
];
