import { type ScriptContext, ScriptedEngine } from "@alca/engines";
import type { AlcaEvent } from "@alca/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { call, type Harness, makeAgents, say, until } from "./agents-helpers.ts";
import { tool } from "./helpers.ts";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const whoAmI = (ctx: ScriptContext) => /你是「([^」]+)」/.exec(ctx.req.system.volatile)?.[1] ?? "Alca";

/**
 * One router script for every bot. The person's "交給<bot>：<task>" makes the
 * bot delegate; a teammate's request is answered or worked on according to
 * its words.
 */
function router(ctx: ScriptContext) {
  const { req, pass } = ctx;
  const me = whoAmI(ctx);
  const msg = req.userMessage;
  const r = req.toolResults?.[0];
  if (pass > 0 && r) return say(`${me}：${r.ok ? "已送出" : `沒送出（${r.output}）`}`);
  if (msg.includes("<alca:peer-report")) {
    const body = /<alca:peer-report[^>]*>\n([\s\S]*?)\n<\/alca:peer-report>/.exec(msg)?.[1] ?? "";
    return say(`${me} 收到隊友回覆：${body}`);
  }
  if (msg.includes("<alca:worker"))
    return say(`${me} 的工人做完了：${/做完：(.+)/.exec(msg)?.[1] ?? "寄好了"}`);
  const peerTask = /<alca:peer [^>]*>\n([\s\S]*?)\n<\/alca:peer>/.exec(msg)?.[1];
  const text = peerTask ?? msg.trim().split("\n").at(-1) ?? "";
  const hand = /^(問|交給)([^：]+)：(.+)$/.exec(text);
  if (hand) {
    const [, verb, bot, rest] = hand as unknown as [string, string, string, string];
    return verb === "問"
      ? call("p1", "peer_ask", { bot, question: rest })
      : call("p1", "peer_delegate", { bot, task: rest });
  }
  if (text.startsWith("派工："))
    return call("w1", "worker_start", { title: "工作", goal: text.slice("派工：".length) });
  return say(`${me} 的回答：${text}`);
}

function worker({ req, pass }: ScriptContext) {
  const goal = req.userMessage.trim().split("\n").at(-1) ?? "";
  if (pass > 0) return say(`做完：${goal}`);
  if (goal === "寄信") return call("s1", "send_mail", { to: "boss@example.com" });
  if (goal === "寫檔") return call("s1", "write_note", { title: "x" });
  return say(`做完：${goal}`);
}

function team(
  o: Parameters<typeof makeAgents>[0] & { rule?: "auto" | "ask_delegate" | "ask_all"; maxDepth?: number },
) {
  h = makeAgents(o);
  const { store } = h;
  if (o.rule || o.maxDepth)
    store.team.setRules({
      ...(o.rule ? { peerApproval: o.rule } : {}),
      ...(o.maxDepth ? { maxDepth: o.maxDepth } : {}),
    });
  const lead = store.bots.default()!;
  const res = store.bots.create("研究員", { role: "查資料" });
  const wri = store.bots.create("寫手", { role: "寫稿" });
  return { ...h, lead, res, wri };
}

const assistantTexts = (h: Harness, threadId: string) =>
  h.core
    .messages(threadId)
    .filter((m) => m.role === "assistant")
    .map((m) => m.content);

describe("bot-to-bot (A2A)", () => {
  it("auto rule: the lead delegates, the teammate's worker does it, the answer comes back as a peer report", async () => {
    const t0 = team({ router, worker, rule: "auto" });
    const { core, store, agentEvents } = t0;
    const t = core.createThread("team");
    await core.send(t.id, "交給研究員：派工：比價").done;
    const req = await until(() => store.team.byRoot(t.id).find((r) => r.status === "done"));
    expect(req.fromBotId).toBe(t0.lead.id);
    expect(req.toBotId).toBe(t0.res.id);
    expect(req.depth).toBe(1);
    expect(req.result).toContain("研究員 的工人做完了：比價");
    // The peer conversation belongs to the teammate and is not in the person's thread list.
    const peerThread = store.threads.get(req.peerThreadId!)!;
    expect(peerThread.botId).toBe(t0.res.id);
    expect(core.listThreads().map((x) => x.id)).not.toContain(peerThread.id);
    // The worker ran as the teammate.
    expect(store.workers.byThread(peerThread.id)[0]?.botId).toBe(t0.res.id);
    // The lead reported back to the person.
    await until(() => assistantTexts(t0, t.id).some((x) => x.includes("Alca 收到隊友回覆")));
    // Trail + agents channel.
    expect(store.team.events(req.id).map((e) => e.kind)).toEqual(["requested", "started", "answered"]);
    const statuses = agentEvents.filter((e) => e.type === "peer.updated").map((e) => e.data.status);
    expect(statuses).toEqual(["running", "done"]);
    // The run on the peer thread is recorded as the teammate speaking.
    const runs = store.threads.runBots(peerThread.id);
    expect([...runs.values()].every((b) => b === t0.res.id)).toBe(true);
  });

  it("ask_delegate rule: a delegation waits for the person's yes; asking a question does not", async () => {
    const t0 = team({ router, worker, rule: "ask_delegate" });
    const { core, store, events } = t0;
    const t = core.createThread("team");
    // A question goes straight through.
    await core.send(t.id, "問研究員：今天幾號").done;
    await until(() => store.team.byRoot(t.id).find((r) => r.kind === "ask" && r.status === "done"));
    expect(events.some((e) => e.type === "approval.requested")).toBe(false);
    await until(() => !core.isBusy(t.id) && assistantTexts(t0, t.id).some((x) => x.includes("收到隊友回覆")));
    // A delegation asks first.
    const sent = core.send(t.id, "交給研究員：查天氣");
    const card = await until(() =>
      events.find(
        (e): e is Extract<AlcaEvent, { type: "approval.requested" }> => e.type === "approval.requested",
      ),
    );
    expect(card.threadId).toBe(t.id);
    expect(card.data.summary).toContain("交辦給隊友「研究員」：查天氣");
    expect(store.team.byRoot(t.id).filter((r) => r.kind === "delegate")).toHaveLength(0);
    core.answerApproval(card.data.approvalId, "approved");
    await sent.done;
    const req = await until(() =>
      store.team.byRoot(t.id).find((r) => r.kind === "delegate" && r.status === "done"),
    );
    expect(store.team.events(req.id).map((e) => e.kind)).toEqual([
      "requested",
      "approved",
      "started",
      "answered",
    ]);
  });

  it("ask_delegate rule: a denied delegation is never sent and stays in the trail as denied", async () => {
    const t0 = team({ router, worker, rule: "ask_delegate" });
    const { core, store, events } = t0;
    const t = core.createThread("team");
    const sent = core.send(t.id, "交給寫手：寫新聞稿");
    const card = await until(() =>
      events.find(
        (e): e is Extract<AlcaEvent, { type: "approval.requested" }> => e.type === "approval.requested",
      ),
    );
    core.answerApproval(card.data.approvalId, "denied");
    await sent.done;
    const req = await until(() => store.team.byRoot(t.id)[0]);
    expect(req.status).toBe("denied");
    expect(req.peerThreadId).toBeNull();
    expect(req.toBotId).toBe(t0.wri.id);
    expect(store.workers.pendingInbox(t0.wri.id)).toHaveLength(0);
    expect(assistantTexts(t0, t.id).at(-1)).toContain("沒送出");
  });

  it("depth limit and loops: a chain stops at the team's depth, and a bot already in the chain is never asked again", async () => {
    const t0 = team({ router, worker, rule: "auto", maxDepth: 2 });
    const { core, store } = t0;
    const t = core.createThread("chain");
    // Alca → 研究員 → 寫手 (depth 2, allowed) → 研究員 (loop) …
    await core.send(t.id, "交給研究員：交給寫手：交給研究員：回來").done;
    const done = await until(() => {
      const rs = store.team.byRoot(t.id);
      return rs.length >= 3 && rs.every((r) => r.status !== "running") ? rs : undefined;
    });
    const [first, second, third] = done;
    expect([first!.depth, second!.depth]).toEqual([1, 2]);
    expect(third!.status).toBe("refused");
    expect(third!.reason).toBe("loop");
    expect(third!.chain).toEqual([t0.lead.id, t0.res.id, t0.wri.id]);
    // … and with a deeper chain to a fresh bot the depth limit stops it.
    store.bots.create("編輯", { role: "校對" });
    const t2 = core.createThread("deep");
    await core.send(t2.id, "交給研究員：交給寫手：交給編輯：校對").done;
    const deep = await until(() => {
      const rs = store.team.byRoot(t2.id);
      return rs.length >= 3 && rs.every((r) => r.status !== "running") ? rs : undefined;
    });
    expect(deep[2]!.status).toBe("refused");
    expect(deep[2]!.reason).toBe("depth");
    expect(store.team.events(deep[2]!.id).map((e) => e.kind)).toEqual(["refused"]);
    // The refusal reached the asking bot as the tool's error; the chain still answered up.
    expect(deep[1]!.status).toBe("done");
    expect(deep[0]!.status).toBe("done");
  });

  it("a send from a teammate's worker still asks the person, in the person's conversation, even under 自主", async () => {
    const send = tool("send_mail", "send");
    const t0 = team({ router, worker, tools: [send], rule: "auto", level: "autonomous" });
    const { core, store } = t0;
    const t = core.createThread("send");
    const seen: AlcaEvent[] = [];
    core.bus.subscribe(t.id, (e) => seen.push(e));
    await core.send(t.id, "交給研究員：派工：寄信").done;
    const card = await until(() =>
      seen.find(
        (e): e is Extract<AlcaEvent, { type: "approval.requested" }> => e.type === "approval.requested",
      ),
    );
    expect(card.data.actionClass).toBe("send");
    expect(card.data.botId).toBe(t0.res.id);
    expect(card.threadId).not.toBe(t.id); // the event belongs to the peer thread …
    expect(t0.agents.pendingCards(t.id).some((e) => e.type === "approval.requested")).toBe(true); // … and replays here
    expect(send.calls).toHaveLength(0);
    const req = store.team.byRoot(t.id)[0]!;
    expect(store.team.events(req.id).some((e) => e.kind === "card" && e.detail.actionClass === "send")).toBe(
      true,
    );
    core.answerApproval(card.data.approvalId, "approved");
    await until(() => store.team.request(req.id)?.status === "done");
    expect(send.calls).toHaveLength(1);
  });

  it("a delegation never widens the level: a 自主 teammate asks for a write when the asking bot is 每步確認", async () => {
    const write = tool("write_note", "write");
    const t0 = team({ router, worker, tools: [write], rule: "auto", level: "autonomous" });
    const { core, store } = t0;
    store.bots.update(t0.lead.id, { approvalLevel: "confirm_each_step" });
    const t = core.createThread("narrow");
    const seen: AlcaEvent[] = [];
    core.bus.subscribe(t.id, (e) => seen.push(e));
    await core.send(t.id, "交給研究員：派工：寫檔").done;
    const card = await until(() =>
      seen.find(
        (e): e is Extract<AlcaEvent, { type: "approval.requested" }> => e.type === "approval.requested",
      ),
    );
    expect(card.data.actionClass).toBe("write");
    expect(core.levelFor(t0.res.id)).toBe("autonomous");
    core.answerApproval(card.data.approvalId, "denied");
    await until(() => store.team.byRoot(t.id)[0]?.status === "done");
    expect(write.calls).toHaveLength(0);
  });

  it("an @mention answers as that bot in the same thread; per-bot engines are used", async () => {
    const t0 = team({ router, worker, rule: "auto" });
    const { core, store } = t0;
    const own = new ScriptedEngine(() => say("研究員自己的引擎"), { id: "res-engine" });
    // Swap the router engine resolver: the teammate has its own engine.
    const mode = (core as unknown as { router: { engineFor?: (b: string) => unknown } }).router;
    mode.engineFor = (b: string) => (b === t0.res.id ? own : undefined);
    const t = core.createThread("mention");
    const { runId, done } = core.send(t.id, "你好", { botId: t0.res.id });
    await done;
    expect(store.runs.get(runId)?.botId).toBe(t0.res.id);
    expect(store.runs.get(runId)?.engine).toBe("res-engine");
    expect(assistantTexts(t0, t.id).at(-1)).toBe("研究員自己的引擎");
    // The thread still belongs to its own bot.
    expect(store.threads.get(t.id)?.botId).toBe(t0.lead.id);
  });

  it("stopping a request stops the teammate's work and tells the asker", async () => {
    const slow = new ScriptedEngine(() => [{ type: "wait" as const, ms: 60_000 }, ...say("慢")], {
      id: "slow",
    });
    const t0 = team({ router, worker, rule: "auto" });
    const { core, store, agents } = t0;
    (agents.workers as unknown as { o: { engineFor?: (b: string) => unknown } }).o.engineFor = (b) =>
      b === t0.res.id ? slow : undefined;
    const t = core.createThread("stop");
    await core.send(t.id, "交給研究員：派工：慢慢做").done;
    const req = await until(() => store.team.byRoot(t.id)[0]);
    await until(() => store.workers.byThread(req.peerThreadId ?? "").some((w) => w.status === "running"));
    expect(await agents.peers.stop(req.id)).toBe(true);
    expect(store.team.request(req.id)?.status).toBe("stopped");
    await until(() => assistantTexts(t0, t.id).some((x) => x.includes("收到隊友回覆")));
    expect(store.workers.byThread(req.peerThreadId!).every((w) => w.status === "stopped")).toBe(true);
  });
});
