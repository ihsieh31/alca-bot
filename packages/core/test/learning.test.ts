import { ScriptedEngine, streamText } from "@alca/engines";
import type { LearningEvent } from "@alca/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { Learning } from "../src/index.ts";
import { call, type Harness, lastLine, makeAgents, say, until } from "./agents-helpers.ts";
import { makeCore, tool } from "./helpers.ts";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const echoRouter = () => say("好");

describe("memory write / read path (router mode)", () => {
  it("stores an inferred preference with provenance; a new thread recalls it; 忘記 removes it for good", async () => {
    let learningOn = true;
    h = makeAgents({
      router: echoRouter,
      worker: () => say("x"),
      advanced: () => ({ learning: learningOn }),
    });
    const { core, store, agents } = h;
    const router = (core as unknown as { router: { engine: ScriptedEngine } }).router.engine;
    const a = core.createThread("A");
    const sent = core.send(a.id, "我喜歡喝燕麥奶拿鐵");
    await sent.done;
    await agents.learning?.settle();
    const [m] = store.memory.list();
    expect(m).toMatchObject({
      kind: "preference",
      origin: "inferred",
      body: "喜歡喝燕麥奶拿鐵",
      scope: "shared",
    });
    expect(m?.source).toMatchObject({ kind: "chat", threadId: a.id, runId: sent.runId });
    expect(store.threads.messages(a.id).find((x) => x.id === m?.source.messageId)?.content).toBe(
      "我喜歡喝燕麥奶拿鐵",
    );
    expect(m?.confidence).toBeLessThan(1);

    // A new thread: the router's user message carries it, fenced and tagged; the system prompt does not.
    const b = core.createThread("B");
    await core.send(b.id, "幫我點一杯咖啡").done;
    const req = router.requests.at(-1)!;
    expect(req.userMessage).toMatch(/<alca:recalled>\n- 喜歡喝燕麥奶拿鐵（偏好・推測 70%・mem_/);
    expect(req.system.stable).not.toContain("燕麥奶");
    expect(req.system.volatile).not.toContain("燕麥奶");

    // 忘記: hard delete + note in the same turn; nothing recalled any more.
    await core.send(b.id, "忘記我喜歡燕麥奶拿鐵").done;
    const forgot = router.requests.at(-1)!;
    expect(forgot.userMessage).toContain("<alca:memory-update>");
    expect(forgot.userMessage).toContain("已忘記");
    expect(forgot.userMessage).not.toContain("<alca:recalled>");
    expect(store.memory.count({ includeSuperseded: true })).toBe(0);
    const tomb = store.db.prepare("SELECT * FROM memory_tombstones").all() as Array<Record<string, string>>;
    expect(tomb.length).toBeGreaterThan(0);
    expect(JSON.stringify(tomb)).not.toContain("燕麥");

    // Said again later, it is not re-learned.
    await core.send(a.id, "我喜歡喝燕麥奶拿鐵").done;
    await agents.learning?.settle();
    expect(store.memory.count()).toBe(0);

    // The learning switch off: nothing inferred; an explicit 記住 still works (and is confirmed).
    learningOn = false;
    await core.send(a.id, "我住在高雄").done;
    await core.send(a.id, "記住我喜歡靠窗的座位").done;
    await agents.learning?.settle();
    expect(store.memory.list().map((x) => [x.body, x.origin])).toEqual([["喜歡靠窗的座位", "user"]]);
  }, 20_000);

  it("never stores a secret, and says so", async () => {
    h = makeAgents({ router: echoRouter, worker: () => say("x") });
    const { core, store, agents } = h;
    const router = (core as unknown as { router: { engine: ScriptedEngine } }).router.engine;
    const t = core.createThread();
    await core.send(t.id, "記住我的密碼是 hunter2").done;
    expect(router.requests.at(-1)?.userMessage).toContain("沒有記下");
    await core.send(t.id, "我的 API key 是 sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv").done;
    await core.send(t.id, "我的信用卡是 4111 1111 1111 1111").done;
    await agents.learning?.settle();
    expect(store.memory.count({ includeSuperseded: true })).toBe(0);
    const dump = JSON.stringify(store.db.prepare("SELECT * FROM memories").all());
    expect(dump).not.toMatch(/hunter2|sk-ant|4111/);
  });

  it("a correction supersedes the old item instead of overwriting it", async () => {
    h = makeAgents({ router: echoRouter, worker: () => say("x") });
    const { core, store, agents } = h;
    const t = core.createThread();
    await core.send(t.id, "我喜歡喝紅茶").done;
    await agents.learning?.settle();
    await core.send(t.id, "不對，我現在改喝綠茶").done;
    await agents.learning?.settle();
    const active = store.memory.list();
    expect(active.map((m) => m.body)).toEqual(["現在喝綠茶"]);
    const chain = store.memory.chain(active[0]!.id);
    expect(chain.map((m) => [m.body, m.status])).toEqual([
      ["喜歡喝紅茶", "superseded"],
      ["現在喝綠茶", "active"],
    ]);
    // An inference does not override what the person confirmed.
    const confirmed = agents.learning!.memory.remember(store.bots.ensureDefault().id, {
      kind: "preference",
      subject: "pref:喝",
      body: "只喝無糖綠茶",
      quote: "記住我只喝無糖綠茶",
      confidence: 1,
    });
    expect(confirmed.status).toBe("superseded");
    await core.send(t.id, "我喜歡喝奶茶").done;
    await agents.learning?.settle();
    expect(store.memory.list().map((m) => m.body)).toEqual(["只喝無糖綠茶"]);
  });

  it("workers read no memory except what the router grants, by id", async () => {
    let memId = "";
    h = makeAgents({
      router: ({ req, pass }) => {
        if (pass === 0 && req.userMessage.includes("<alca:worker")) return say("回報");
        if (pass === 0) return call("m1", "memory_search", { query: "座位" });
        const r = req.toolResults?.[0];
        if (r?.id === "m1") {
          memId = /mem_[0-9A-Z]{26}/.exec(r.output)?.[0] ?? "";
          return call("w1", "worker_start", {
            title: "訂位",
            goal: "訂高鐵票",
            memoryIds: [memId, "mem_nope"],
          });
        }
        return say("派出去了");
      },
      worker: ({ req }) => say(`收到：${req.userMessage.includes("靠窗") ? "有偏好" : "沒有偏好"}`),
    });
    const { core, store } = h;
    const botId = store.bots.ensureDefault().id;
    h.agents.learning!.memory.remember(botId, {
      kind: "preference",
      subject: "seat",
      body: "喜歡靠窗的座位",
      quote: "q",
      confidence: 1,
    });
    h.agents.learning!.memory.remember(botId, {
      kind: "fact",
      subject: "",
      body: "生日是十一月九日",
      quote: "q",
      confidence: 1,
    });
    const t = core.createThread();
    await core.send(t.id, "幫我訂下週去台中的高鐵").done;
    const w = await until(() => store.workers.byThread(t.id).find((x) => x.status === "succeeded"));
    // Phase 5: every dispatch runs under a harness (general here) with its ledger row.
    expect(w.grants).toMatchObject({ memoryIds: [memId], harness: "general" });
    expect(Object.keys(w.grants).sort()).toEqual(["dispatchId", "harness", "memoryIds"]);
    const worker = (h.agents.workers as unknown as { o: { engine: ScriptedEngine } }).o.engine;
    const task = worker.requests[0]!.userMessage;
    expect(task).toContain('<alca:memory granted-by="router">');
    expect(task).toContain("喜歡靠窗的座位");
    expect(task).not.toContain("生日");
    expect(task).not.toContain("<alca:recalled>");
  });
});

describe("memory in direct mode", () => {
  it("the same hooks work without a router", async () => {
    const engine = new ScriptedEngine(() => streamText("ok"));
    const { core, store } = makeCore(engine);
    const learning = new Learning({ store });
    core.useHooks(learning);
    const t = core.createThread();
    await core.send(t.id, "記住我對花生過敏").done;
    expect(store.memory.list()[0]).toMatchObject({ body: "對花生過敏", origin: "user", kind: "fact" });
    await core.send(t.id, "晚餐吃什麼好").done;
    expect(engine.requests.at(-1)?.userMessage).toContain("對花生過敏");
  });
});

/** A worker that writes a weekly report in two steps (read, then write), or pays (shop). */
function reportWorker(seen: string[]) {
  return ({
    req,
    pass,
  }: {
    req: { userMessage: string; toolResults?: readonly { id: string }[] };
    pass: number;
  }) => {
    if (pass === 0) seen.push(req.userMessage);
    const goal = lastLine(req.userMessage);
    const r = req.toolResults?.[0];
    if (r?.id === "p1") return call("p2", "pay", { amount: 1280 });
    if (r?.id === "p2") return say("付好了");
    if (pass === 0 && /付款/.test(goal)) return call("p1", "open_cart", {});
    if (pass === 0) return call("s1", "read_note", { title: "本週" });
    if (r?.id === "s1") return call("s2", "write_note", { title: "週報", body: "整理好了" });
    // Phase 5: dispatches run under the general harness; the worker ends with report_result.
    if (r?.id === "s2") return call("s3", "report_result", { status: "done", summary: "週報寫好了" });
    return say("週報寫好了");
  };
}

function skillRouter() {
  return ({ req, pass }: { req: { userMessage: string; system: { volatile: string } }; pass: number }) => {
    const msg = req.userMessage;
    if (pass === 0 && msg.includes("<alca:worker")) return say("回報");
    if (pass > 0) return say("派出去了");
    const skill = /(skl_[0-9A-Z]{26})/.exec(req.system.volatile)?.[1];
    const goal = lastLine(msg);
    return call("w", "worker_start", {
      title: /付款/.test(goal) ? "示範付款" : "整理週報",
      goal,
      ...(skill ? { skillId: skill } : {}),
    });
  };
}

describe("skills: propose → approve → reuse", () => {
  it("a two-step task becomes a proposal; approved, it is offered next time and handed to the worker", async () => {
    const seen: string[] = [];
    h = makeAgents({
      router: skillRouter(),
      worker: reportWorker(seen),
      tools: [tool("read_note", "read"), tool("write_note", "write")],
      level: "autonomous",
    });
    const { core, store, agents } = h;
    const learned: LearningEvent[] = [];
    agents.learning!.subscribe((e) => learned.push(e));
    const t = core.createThread();
    await core.send(t.id, "幫我整理週報").done;
    const first = await until(() => store.workers.byThread(t.id).find((w) => w.status === "succeeded"));
    await agents.learning!.settle();
    const [p] = store.skills.list();
    expect(p).toMatchObject({
      status: "proposed",
      version: 0,
      sourceWorkerId: first.id,
      sourceThreadId: t.id,
    });
    expect(p!.pending?.steps.map((s) => s.tool)).toEqual(["read_note", "write_note"]);
    expect(p!.pending?.triggers).toContain("整理週報");
    expect(learned.find((e) => e.type === "skill.proposed")?.data).toMatchObject({
      skill: { skillId: p!.id, stepCount: 2 },
    });

    // Not approved yet: the router is not told about it.
    const t2 = core.createThread();
    await core.send(t2.id, "再幫我整理一次週報").done;
    await until(() => store.workers.byThread(t2.id).find((w) => w.status === "succeeded"));
    expect(store.workers.byThread(t2.id)[0]?.grants.skillId).toBeUndefined();

    agents.learning!.approveSkill(p!.id);
    const t3 = core.createThread();
    await core.send(t3.id, "再幫我整理一次週報").done;
    const used = await until(() => store.workers.byThread(t3.id).find((w) => w.status === "succeeded"));
    expect(used.grants.skillId).toBe(p!.id);
    expect(seen.at(-1)).toContain(`<alca:skill id="${p!.id}" version="1"`);
    expect(store.skills.get(p!.id)?.uses).toBe(1);
    await agents.learning!.settle();
    expect(store.skills.list()).toHaveLength(1); // the reuse proposes nothing new

    // A correction right after a skill-based task proposes a revision, not a silent change.
    await core.send(t3.id, "不對，下次要先確認上週的週報").done;
    await agents.learning!.settle();
    const s = store.skills.get(p!.id)!;
    expect(s.version).toBe(1);
    expect(s.pending?.version).toBe(2);
    expect(s.pending?.steps.at(-1)?.text).toContain("下次要先確認上週的週報");

    // Disabled: no longer offered.
    agents.learning!.setSkillEnabled(p!.id, false);
    expect(agents.learning!.contextLines(s.botId, "整理週報")).toEqual([]);
  }, 30_000);

  it("the time in the person's request reaches the proposal even when the worker's goal drops it (mac test 2026-11-04b A8)", async () => {
    const rewriting = ({ req, pass }: { req: { userMessage: string }; pass: number }) => {
      if (pass === 0 && req.userMessage.includes("<alca:worker")) return say("回報");
      if (pass > 0) return say("派出去了");
      return call("w", "worker_start", { title: "整理週報", goal: "整理週報" });
    };
    h = makeAgents({
      router: rewriting,
      worker: reportWorker([]),
      tools: [tool("read_note", "read"), tool("write_note", "write")],
      level: "autonomous",
    });
    const { core, store, agents } = h;
    const t = core.createThread();
    await core.send(t.id, "以後每天 09:30 幫我整理週報，現在先做一次").done;
    await until(() => store.workers.byThread(t.id).find((w) => w.status === "succeeded"));
    await agents.learning!.settle();
    const [p] = store.skills.list();
    // At b034304 the triggers and the description had no 09:30 (both came from the worker's goal).
    expect(p!.pending?.triggers[0]).toBe("每天 09:30");
    expect(p!.pending?.description).toMatch(/每天 09:30.*例行工作/);
  }, 30_000);

  it("an approved skill with a payment step still asks before paying, even under 自主", async () => {
    const seen: string[] = [];
    const pay = tool("pay", "payment");
    h = makeAgents({
      router: skillRouter(),
      worker: reportWorker(seen),
      tools: [tool("open_cart", "read"), pay],
      level: "autonomous",
    });
    const { core, store, agents, events } = h;
    const t = core.createThread();
    await core.send(t.id, "幫我付款").done;
    const card1 = await until(() => events.find((e) => e.type === "approval.requested"));
    core.answerApproval(String(card1.data.approvalId), "approved");
    await until(() => store.workers.byThread(t.id).find((w) => w.status === "succeeded"));
    await agents.learning!.settle();
    const [p] = store.skills.list();
    expect(p?.pending?.actionClasses).toEqual(["payment", "read"]);
    agents.learning!.approveSkill(p!.id);

    const before = events.filter((e) => e.type === "approval.requested").length;
    const t2 = core.createThread();
    await core.send(t2.id, "再幫我付款").done;
    const w = await until(() => store.workers.byThread(t2.id)[0]);
    expect(w.grants.skillId).toBe(p!.id);
    const card2 = await until(() => events.filter((e) => e.type === "approval.requested")[before]);
    expect(card2.data).toMatchObject({ actionClass: "payment", workerId: w.id });
    expect(pay.calls).toHaveLength(1); // the second payment has not run
    core.answerApproval(String(card2.data.approvalId), "denied");
    await until(() => store.workers.get(w.id)?.finishedAt);
    expect(pay.calls).toHaveLength(1);
  }, 30_000);

  it("a rejected proposal is not proposed again", async () => {
    h = makeAgents({
      router: skillRouter(),
      worker: reportWorker([]),
      tools: [tool("read_note", "read"), tool("write_note", "write")],
      level: "autonomous",
    });
    const { core, store, agents } = h;
    const t = core.createThread();
    await core.send(t.id, "幫我整理週報").done;
    await until(() => store.workers.byThread(t.id).find((w) => w.status === "succeeded"));
    await agents.learning!.settle();
    agents.learning!.rejectSkill(store.skills.list()[0]!.id);
    await core.send(t.id, "幫我整理週報").done;
    await until(() => store.workers.byThread(t.id).filter((w) => w.status === "succeeded").length === 2);
    await agents.learning!.settle();
    expect(store.skills.list().map((s) => s.status)).toEqual(["rejected"]);
  }, 30_000);
});
