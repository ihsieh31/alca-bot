import { parseSettings } from "@alca/config";
import { type ScriptContext, ScriptedEngine } from "@alca/engines";
import type { AgentsEvent } from "@alca/protocol";
import { openStore } from "@alca/store";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSystem, AlcaCore } from "../src/index.ts";
import { say } from "./agents-helpers.ts";

// Care moments end to end: capture → situation → decision → <alca:moment> →
// post-check → feedback, through the real router turn with a scripted engine
// and a fake clock. Every name and date is fictional.

const TZ = "Asia/Taipei";
let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

function router({ req, pass }: ScriptContext) {
  if (pass > 0) return say("好");
  const v = req.system.volatile;
  if (v.includes("可以提的一件事：休息")) return say("不客氣，快去睡吧。");
  if (v.includes("可以提的一件事："))
    return say("好，剩下的我跑完測試再合併。晚安，後天的鋼琴檢定加油。要我明天早上提醒你嗎？");
  if (v.includes("<alca:moment>")) return say("好，晚安。");
  return say("了解。");
}

function setup() {
  let now = new Date("2027-03-10T12:00:00Z"); // Wed 20:00 Taipei
  const clock = () => now;
  const store = openStore(":memory:");
  const settings = parseSettings({ engineering: { routines: { startDelaySec: 0 } } });
  const engine = new ScriptedEngine(router, { id: "router" });
  const core = new AlcaCore({ store, engine, settings: () => settings, now: clock, timeZone: TZ });
  const agents = new AgentSystem({
    core,
    routerEngine: engine,
    workerEngine: new ScriptedEngine(() => say("x"), { id: "worker" }),
    settings: () => settings,
    tickMs: 0,
    now: clock,
    timeZone: TZ,
  });
  const events: AgentsEvent[] = [];
  agents.subscribe((e) => events.push(e));
  close = async () => {
    await agents.close();
    await core.close();
  };
  const send = async (threadId: string, text: string) => {
    await core.send(threadId, text).done;
    await agents.learning?.settle();
  };
  return {
    core,
    agents,
    store,
    engine,
    events,
    send,
    set: (iso: string) => {
      now = new Date(iso);
    },
    volatile: () => engine.requests.at(-1)?.system.volatile ?? "",
    lastReply: (threadId: string) =>
      store.threads
        .messages(threadId)
        .filter((m) => m.role === "assistant")
        .at(-1)?.content,
  };
}

describe("care moments: the pipeline in a conversation", () => {
  it("remembers, waits for the right moment, says one line, strips the offer, learns from the reaction", async () => {
    const x = setup();
    const bot = x.store.bots.ensureDefault().id;
    const a = x.core.createThread("閒聊");
    await x.send(a.id, "我後天下午兩點半要考鋼琴檢定");
    const life = x.store.memory
      .list({ visibleTo: bot, kinds: ["fact"] })
      .find((m) => m.subject.startsWith("life:"));
    expect(life?.body).toBe("鋼琴檢定 (2027-03-12 14:30, Asia/Taipei)");
    expect(x.volatile()).not.toContain("<alca:moment>");

    // Working session in another thread: mid-task and quick questions get no block.
    const b = x.core.createThread("修 bug");
    x.set("2027-03-10T13:00:00Z");
    await x.send(b.id, "幫我把登入頁的按鈕修好");
    expect(x.volatile()).not.toContain("<alca:moment>");
    x.set("2027-03-10T15:40:00Z");
    await x.send(b.id, "還要多久？");
    expect(x.volatile()).not.toContain("<alca:moment>");

    // 23:52, leaving for the night: the exam is chosen; the trailing offer is stripped.
    x.set("2027-03-10T15:52:00Z");
    await x.send(b.id, "剩下的都交給你，我要睡了，晚安");
    expect(x.volatile()).toContain("可以提的一件事：鋼琴檢定，後天（3/12 週五） 14:30");
    expect(x.volatile()).not.toMatch(/mem_|life:/);
    expect(x.lastReply(b.id)).toBe("好，剩下的我跑完測試再合併。晚安，後天的鋼琴檢定加油。");
    expect(x.events.some((e) => e.type === "reply.revised")).toBe(true);
    const shown = x.store.careLog.list({ botId: bot, since: new Date(0), kinds: ["shown"] });
    expect(shown.map((r) => r.category)).toEqual(["exam"]);

    // Still here two minutes later: the reaction is recorded; one rest line is allowed, once.
    x.set("2027-03-10T15:54:00Z");
    await x.send(b.id, "謝謝");
    expect(x.store.careLog.get(shown[0]?.id ?? "")?.reaction).toBe("positive");
    expect(x.volatile()).toContain("可以提的一件事：休息");
    expect(x.lastReply(b.id)).toBe("不客氣，快去睡吧。");
    x.set("2027-03-10T15:56:00Z");
    await x.send(b.id, "你怎麼做到的？");
    expect(x.volatile()).not.toContain("<alca:moment>");

    // Next morning, another thread: a goodbye, but the exam was brought up within 24 h.
    const c = x.core.createThread("早上");
    x.set("2027-03-11T02:00:00Z");
    await x.send(c.id, "先這樣，掰");
    expect(x.volatile()).toContain("<alca:moment>");
    expect(x.volatile()).not.toContain("可以提的一件事");

    // Every moment is logged with its reason (no content).
    const reasons = x.store.careLog
      .list({ botId: bot, since: new Date(0), kinds: ["decision"] })
      .map((r) => r.reason);
    expect(reasons.sort()).toEqual(["chosen", "chosen-rest", "no-event", "thread-cooldown"].sort());
    expect(x.agents.care?.metrics(bot)).toMatchObject({ shown: 2, positive: 1 });
  });

  it("a cancellation takes the event off the timeline; a suppression is kept as the person's rule", async () => {
    const x = setup();
    const bot = x.store.bots.ensureDefault().id;
    const t = x.core.createThread("t");
    await x.send(t.id, "後天下午兩點半要考鋼琴檢定");
    expect(x.agents.care?.timeline(bot)).toHaveLength(1);
    await x.send(t.id, "鋼琴檢定取消了");
    expect(x.agents.care?.timeline(bot)).toHaveLength(0);
    await x.send(t.id, "以後別再提醒我考試");
    const rule = x.store.memory
      .list({ visibleTo: bot, kinds: ["preference"] })
      .find((m) => m.subject === "suppress:care:exam");
    expect(rule?.origin).toBe("user");
  });
  it("memory off: no line, and nothing is written (no suppression rule, no cancellation note)", async () => {
    const x = setup();
    const bot = x.store.bots.ensureDefault().id;
    const t = x.core.createThread("t");
    await x.send(t.id, "後天下午兩點半要考鋼琴檢定");
    expect(x.agents.care?.timeline(bot)).toHaveLength(1);
    x.store.bots.update(bot, { memoryMode: "off" });
    expect(x.agents.care?.timeline(bot)).toHaveLength(0);
    const before = x.store.memory.list({ visibleTo: bot, limit: 500 }).length;
    x.set("2027-03-10T15:52:00Z"); // 23:52 Taipei
    await x.send(t.id, "我要睡了，晚安");
    expect(x.volatile()).not.toContain("可以提的一件事");
    await x.send(t.id, "以後別再提醒我考試");
    await x.send(t.id, "鋼琴檢定取消了");
    expect(x.store.memory.list({ visibleTo: bot, limit: 500 })).toHaveLength(before);
    expect(
      x.store.memory.list({ visibleTo: bot, limit: 500 }).some((m) => m.subject.startsWith("suppress:care")),
    ).toBe(false);
  });

  it("own notes only: the shared timeline is not read", async () => {
    const x = setup();
    const bot = x.store.bots.ensureDefault().id;
    const t = x.core.createThread("t");
    await x.send(t.id, "後天下午兩點半要考鋼琴檢定");
    const item = x.agents.care?.timeline(bot)[0];
    expect(item).toBeDefined();
    expect(x.store.memory.get(item?.memoryId ?? "")?.scope).toBe("shared"); // a fact about the person
    x.store.bots.update(bot, { memoryMode: "own" });
    expect(x.agents.care?.timeline(bot)).toHaveLength(0);
    // This bot's own note is still read.
    x.store.memory.rescope(item?.memoryId ?? "", "bot");
    expect(x.agents.care?.timeline(bot)).toHaveLength(1);
  });

  it("the person sees the event in their memory, can move it by editing, and forgetting removes it", async () => {
    const x = setup();
    const bot = x.store.bots.ensureDefault().id;
    const t = x.core.createThread("t");
    await x.send(t.id, "後天下午兩點半要考鋼琴檢定");
    const listed = x.store.memory
      .list({ visibleTo: bot, limit: 500 })
      .find((m) => m.subject.startsWith("life:"));
    expect(listed?.body).toBe("鋼琴檢定 (2027-03-12 14:30, Asia/Taipei)");
    const learning = x.agents.learning;
    if (!learning || !listed) throw new Error("no learning");
    // Edited in the memory page to a day further out: the timeline follows the body.
    const moved = learning.memory.edit(listed.id, { body: "鋼琴檢定 (2027-03-20 09:00, Asia/Taipei)" });
    expect(moved.memory?.dueAt).toBe("2027-03-20T01:00:00.000Z");
    expect(x.agents.care?.timeline(bot)).toHaveLength(0); // beyond the window now
    // Edited back into the window.
    const back = learning.memory.edit(moved.memory?.id ?? "", {
      body: "鋼琴檢定 (2027-03-11 10:00, Asia/Taipei)",
    });
    expect(x.agents.care?.timeline(bot).map((i) => i.date)).toEqual(["2027-03-11"]);
    // Free text without a day: off the timeline, never a stale reminder.
    const vague = learning.memory.edit(back.memory?.id ?? "", { body: "鋼琴檢定，日期再確認" });
    expect(vague.memory?.dueAt).toBeFalsy();
    expect(x.agents.care?.timeline(bot)).toHaveLength(0);
    // Forgetting: gone from the timeline too.
    const again = learning.memory.edit(vague.memory?.id ?? "", {
      body: "鋼琴檢定 (2027-03-11 10:00, Asia/Taipei)",
    });
    expect(x.agents.care?.timeline(bot)).toHaveLength(1);
    learning.memory.forget(again.memory?.id ?? "");
    expect(x.agents.care?.timeline(bot)).toHaveLength(0);
  });
});
