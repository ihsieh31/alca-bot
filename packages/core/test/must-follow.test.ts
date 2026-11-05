import type { ScriptContext, ScriptedEngine } from "@alca/engines";
import type { AlcaEvent } from "@alca/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { appliesForCall, mustFollowBlock, mustFollowItems } from "../src/index.ts";
import { call, type Harness, lastLine, makeAgents, say, until } from "./agents-helpers.ts";
import { tool } from "./helpers.ts";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

/** Router: on a writing request, start one worker that writes and sends the mail. */
function routerScript({ req, pass }: ScriptContext) {
  if (pass === 0 && req.userMessage.includes("<alca:worker")) return say("寄好了。");
  if (pass === 0 && req.userMessage.includes("寫一封信給開源團隊"))
    return [
      ...say("好，我請工人寫好再給你確認。"),
      {
        type: "tool.call" as const,
        id: "r1",
        name: "worker_start",
        input: { title: "寫信給開源團隊", goal: "寫一封信給開源團隊，問能不能加入" },
      },
      { type: "done" as const, stop: "tool_use" as const },
    ];
  return say("好");
}

function workerScript({ req, pass }: ScriptContext) {
  if (pass > 0) return say("寄出了。");
  if (lastLine(req.userMessage).includes("開源團隊"))
    return call("w-send", "send_mail", { to: "team@example.org", body: "你好，我想加入。" });
  return say("x");
}

describe("P14 B2: must-follow preferences", () => {
  it("「寫信不要提到我的學校」 reaches the worker's send request, and the approval card shows 已套用", async () => {
    const send = tool("send_mail", "send");
    h = makeAgents({ router: routerScript, worker: workerScript, tools: [send] });
    const { core, store, agents, events } = h;
    const t = core.createThread("信");
    await core.send(t.id, "記住寫信不要提到我的學校").done;
    await agents.learning?.settle();
    const [m] = store.memory.list();
    expect(m).toMatchObject({ kind: "preference", origin: "user", appliesTo: ["send_message"] });

    // The router's own user message for a mail request carries the block too.
    await core.send(t.id, "幫我寫一封信給開源團隊").done;
    const router = (core as unknown as { router: { engine: ScriptedEngine } }).router.engine;
    expect(router.requests.find((r) => r.userMessage.includes("寫一封信給開源團隊"))?.userMessage).toContain(
      "<alca:must-follow>",
    );

    const card = await until(() =>
      events.find(
        (e): e is Extract<AlcaEvent, { type: "approval.requested" }> => e.type === "approval.requested",
      ),
    );
    expect(card.data.actionClass).toBe("send");
    expect(card.data.applied).toEqual(["寫信不要提到我的學校"]);
    const worker = (agents as unknown as { o: { workerEngine: ScriptedEngine } }).o.workerEngine;
    const req = worker.requests.find((r) => r.userMessage.includes("開源團隊"));
    expect(req?.userMessage).toMatch(
      /<alca:must-follow>[\s\S]*寫信不要提到我的學校[\s\S]*<\/alca:must-follow>/,
    );
    expect(req?.system.stable).not.toContain("學校");
    expect(send.calls).toHaveLength(0);
    core.answerApproval(card.data.approvalId, "approved");
    await until(() => send.calls.length === 1);
  }, 20_000);

  it("maps action classes and keeps the block within five items and 200 tokens", async () => {
    expect(appliesForCall("send", "send_mail")).toEqual(["send_message"]);
    expect(appliesForCall("read", "draft_save")).toEqual(["send_message"]);
    expect(appliesForCall("payment", "pay")).toEqual(["purchase"]);
    expect(appliesForCall("read", "search")).toEqual([]);
    h = makeAgents({ router: () => say("好"), worker: () => say("x") });
    const { store, agents } = h;
    const bot = store.bots.ensureDefault().id;
    for (let i = 0; i < 8; i++)
      agents.learning!.memory.remember(
        bot,
        {
          kind: "preference",
          subject: `rule:${i}`,
          body: `寫信第 ${i} 條規則`,
          quote: `寫信第 ${i} 條規則`,
          confidence: 1,
          appliesTo: ["send_message"],
        },
        {},
        { scope: "shared" },
      );
    agents.learning!.suppress(bot, "副業", "別再提副業");
    const items = mustFollowItems(store, bot, ["send_message"]);
    expect(items).toHaveLength(5);
    expect(items.some((x) => x.body.includes("副業"))).toBe(false);
    expect(mustFollowItems(store, bot, ["send_message"], "off")).toEqual([]);
    expect(mustFollowBlock([])).toBe("");
    expect(
      mustFollowBlock(items)
        .split("\n")
        .filter((l) => l.startsWith("- ")),
    ).toHaveLength(5);
  });
});
