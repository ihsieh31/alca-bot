import type { ScriptContext, ScriptedEngine } from "@alca/engines";
import type { AgentsEvent } from "@alca/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { classifyAnswer, detectOffer, offerCategory } from "../src/index.ts";
import { type Harness, lastLine, makeAgents, say } from "./agents-helpers.ts";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe("P14 B3: offer detection rules", () => {
  it("finds an offer only in the last sentence of a reply", () => {
    expect(detectOffer("查好了，週六晚上有位。要我幫你訂位嗎？")).toMatchObject({
      text: "要我幫你訂位嗎？",
      action: "幫你訂位",
      category: "errand",
    });
    expect(detectOffer("Done. Want me to draft the reply email?")?.action).toBe("draft the reply email");
    expect(detectOffer("你想要長期的還是快速的？")).toBeUndefined();
    expect(detectOffer("要我幫你整理嗎？\n\n不過先說，這要花點時間。")).toBeUndefined();
    expect(detectOffer("好的。")).toBeUndefined();
    expect(offerCategory("要我提醒你續訂嗎？")).toBe("money_account");
    expect(offerCategory("要我幫你排複習進度嗎？")).toBe("study");
    expect(offerCategory("要我把網站部署上去嗎？")).toBe("project");
  });

  it("classifies the next message as accept, decline, suppress or neither", () => {
    expect(classifyAnswer("好")).toBe("accepted");
    expect(classifyAnswer("可以，麻煩了")).toBe("accepted");
    expect(classifyAnswer("yes please")).toBe("accepted");
    expect(classifyAnswer("不用了")).toBe("declined");
    expect(classifyAnswer("先不，謝謝")).toBe("declined");
    expect(classifyAnswer("no thanks")).toBe("declined");
    expect(classifyAnswer("別再提這類")).toBe("suppress");
    expect(classifyAnswer("那餐廳在哪裡？")).toBe("none");
    expect(classifyAnswer("好不好吃？")).toBe("none");
  });
});

function router({ req, pass }: ScriptContext) {
  if (pass > 0) return say("好");
  const t = lastLine(req.userMessage);
  if (t.includes("餐廳")) return say("週六有位。要我幫你訂位嗎？");
  if (t.includes("報告")) return say("下週三交。要我幫你排複習進度嗎？");
  if (t.includes("帳單")) return say("這期 1,200 元。要我提醒你繳費嗎？");
  return say("了解。");
}

describe("P14 B3: the ledger in a conversation", () => {
  it("records reply offers; the next message accepts or declines; ignored after a day; stats per category", async () => {
    let now = new Date("2026-11-04T08:00:00Z");
    h = makeAgents({ router, worker: () => say("x") });
    const { core, store, agents, agentEvents } = h;
    (agents.offers as unknown as { now: () => Date }).now = () => now;
    const bot = store.bots.ensureDefault().id;
    const t = core.createThread("提議");

    await core.send(t.id, "幫我找餐廳").done;
    const [o1] = store.offers.list({ threadId: t.id });
    expect(o1).toMatchObject({
      source: "chat_end",
      status: "pending",
      category: "errand",
      action: "幫你訂位",
    });
    await core.send(t.id, "好").done;
    expect(store.offers.get(o1!.id)?.status).toBe("accepted");

    await core.send(t.id, "報告什麼時候交").done;
    await core.send(t.id, "不用了").done;
    const study = store.offers.list({ threadId: t.id }).find((o) => o.category === "study");
    expect(study?.status).toBe("declined");
    // The router is told what this conversation declined, so it is not offered again here.
    const r = (core as unknown as { router: { engine: ScriptedEngine } }).router.engine;
    await core.send(t.id, "還有別的嗎").done;
    expect(r.requests.at(-1)?.system.volatile).toContain("拒絕過的提議（不要再提）：幫你排複習進度");

    // A question that is not an answer leaves the offer pending; a day later it is ignored.
    await core.send(t.id, "帳單多少").done;
    await core.send(t.id, "上一期呢").done;
    const bill = store.offers.list({ threadId: t.id }).find((o) => o.category === "money_account")!;
    expect(bill.status).toBe("pending");
    now = new Date(now.getTime() + 25 * 3600_000);
    agents.offers.sweep();
    expect(store.offers.get(bill.id)?.status).toBe("ignored");

    expect(agents.offers.offerStats(bot, "errand")).toMatchObject({ accepted: 1, total: 1 });
    expect(agents.offers.offerStats(bot)).toMatchObject({ accepted: 1, declined: 1, ignored: 1, total: 3 });
    expect(agents.addons.view(bot, "proactive").notes).toEqual([
      "近 30 天提議接受：雜務 1/1、錢與帳戶 0/1、讀書 0/1",
    ]);
    const types = agentEvents.map((e: AgentsEvent) => e.type);
    expect(types.filter((x) => x === "offer.created")).toHaveLength(3);
    expect(types.filter((x) => x === "offer.updated")).toHaveLength(3);
  }, 20_000);

  it("「別再提這類」 declines the offer and stores the person's suppress rule", async () => {
    h = makeAgents({ router, worker: () => say("x") });
    const { core, store, agents } = h;
    const t = core.createThread();
    await core.send(t.id, "帳單多少").done;
    await core.send(t.id, "別再提這類").done;
    await agents.learning?.settle();
    expect(store.offers.list({ threadId: t.id })[0]?.status).toBe("declined");
    const sup = store.memory.list().filter((m) => m.subject.startsWith("suppress:"));
    expect(sup).toHaveLength(1);
    expect(sup[0]).toMatchObject({ origin: "user", kind: "preference", appliesTo: ["proactive"] });
    expect(sup[0]?.body).toContain("錢與帳戶");
    // 「別再提副業」 without an offer is its own topic.
    await core.send(t.id, "別再提副業了").done;
    expect(store.memory.list().filter((m) => m.subject.startsWith("suppress:"))).toHaveLength(2);
  }, 20_000);
});
