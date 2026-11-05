import { type ScriptContext, ScriptedEngine } from "@alca/engines";
import { afterEach, describe, expect, it } from "vitest";
import { type AddonCompletion, parseReplyVerdict, ruleIssues } from "../src/index.ts";
import { type Harness, lastLine, makeAgents, say } from "./agents-helpers.ts";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const router = ({ req, pass }: ScriptContext) => {
  if (pass > 0) return say("好");
  const t = lastLine(req.userMessage);
  if (t.includes("兩個問題")) return say("你想去哪裡？什麼時候去？");
  if (t.includes("來源")) return say("我在你的信裡看到你下週要考試。");
  return say("好的，已經記下了。");
};

function harness(answers: Array<string | "timeout">) {
  const calls: Array<{ purpose: string; prompt: string }> = [];
  const complete: AddonCompletion = async ({ prompt, purpose, signal }) => {
    calls.push({ purpose, prompt });
    const a = answers.shift() ?? '{"ok":true}';
    if (a === "timeout")
      await new Promise((_, rej) => signal.addEventListener("abort", () => rej(new Error("timeout"))));
    return { text: a, inputTokens: 300, outputTokens: 30 };
  };
  h = makeAgents({ router, worker: () => say("x"), system: { addonComplete: complete } });
  const bot = h.store.bots.ensureDefault().id;
  return { h, bot, calls };
}

describe("P14 D: 回覆檢查", () => {
  it("off → no check and no spend", async () => {
    const { h, calls } = harness([]);
    const t = h.core.createThread();
    await h.core.send(t.id, "問我兩個問題").done;
    await h.agents.replyCheck.settle();
    expect(calls).toHaveLength(0);
  });

  it("two questions → rewritten once; the stored reply is replaced and reply.revised goes out", async () => {
    const { h, bot, calls } = harness(['{"ok":false,"issues":["問了兩個問題"]}', "你想什麼時候去？"]);
    h.agents.addons.set(bot, "reply-check", { enabled: true });
    const t = h.core.createThread();
    await h.core.send(t.id, "問我兩個問題").done;
    await h.agents.replyCheck.settle();
    expect(calls.map((c) => c.purpose)).toEqual(["reply-check", "reply-rewrite"]);
    expect(calls[0]?.prompt).toContain("<reply>\n你想去哪裡？什麼時候去？");
    const msgs = h.store.threads.messages(t.id).filter((m) => m.role === "assistant");
    expect(msgs.at(-1)?.content).toBe("你想什麼時候去？");
    const ev = h.agentEvents.find((e) => e.type === "reply.revised");
    expect(ev?.data).toMatchObject({ threadId: t.id, text: "你想什麼時候去？" });
    expect(h.agents.addons.usage(bot, "reply-check")).toMatchObject({ runs: 2, tokens: 660 });
  });

  it("a rewrite that still breaks a rule keeps the original; ok keeps it; a timeout keeps it", async () => {
    const { h, bot } = harness([
      '{"ok":true}',
      "我在你的信裡看到你要考試，要我幫你排嗎？還是不用？",
      "timeout",
    ]);
    h.agents.addons.set(bot, "reply-check", { enabled: true, settings: { timeoutSec: 1 } });
    const t = h.core.createThread();
    // The model says ok, but the rule check sees the source talk → one rewrite, which still fails.
    await h.core.send(t.id, "說說來源").done;
    await h.agents.replyCheck.settle();
    expect(
      h.store.threads
        .messages(t.id)
        .filter((m) => m.role === "assistant")
        .at(-1)?.content,
    ).toBe("我在你的信裡看到你下週要考試。");
    const started = Date.now();
    await h.core.send(t.id, "記一下").done;
    await h.agents.replyCheck.settle();
    expect(Date.now() - started).toBeLessThan(3000);
    expect(
      h.store.threads
        .messages(t.id)
        .filter((m) => m.role === "assistant")
        .at(-1)?.content,
    ).toBe("好的，已經記下了。");
    expect(h.agentEvents.some((e) => e.type === "reply.revised")).toBe(false);
  });

  it("the picked model: choices come from the host, the pair is checked, and the check runs on that engine", async () => {
    const asked: string[] = [];
    const small = new ScriptedEngine(
      ({ req }: ScriptContext) => {
        asked.push(req.userMessage.slice(0, 20));
        return say('{"ok":true}');
      },
      { id: "small" },
    );
    const picked: Array<[string, string]> = [];
    h = makeAgents({
      router,
      worker: () => say("x"),
      system: {
        addonEnv: {
          modelChoices: () => [
            { engine: "cheap", model: null, label: "Cheap · 預設模型" },
            { engine: "cheap", model: "mini", label: "Cheap · mini" },
          ],
        },
        engines: {
          addon: (botId, addonId) => {
            picked.push([botId, addonId]);
            const s = h?.agents.addons.settingsOf<{ engine: string | null }>(botId, addonId);
            return s?.engine === "cheap" ? small : undefined;
          },
        },
      },
    });
    const bot = h.store.bots.ensureDefault().id;
    const view = h.agents.addons.view(bot, "reply-check");
    expect(view.settings).toMatchObject({ engine: null, model: null });
    expect(view.modelChoices?.map((c) => c.label)).toEqual([
      "跟這個 bot 的總機模型一樣（預設）",
      "Cheap · 預設模型",
      "Cheap · mini",
    ]);
    // Other add-ons do not pick a model.
    expect(h.agents.addons.view(bot, "proactive").modelChoices).toBeUndefined();
    expect(() =>
      h?.agents.addons.set(bot, "reply-check", { settings: { engine: "nope", model: null } }),
    ).toThrow(/沒有設定這個模型/);
    expect(() =>
      h?.agents.addons.set(bot, "reply-check", { settings: { engine: "cheap", model: "big" } }),
    ).toThrow(/沒有設定這個模型/);
    // A model with no engine means the router model (the model is dropped).
    expect(
      h.agents.addons.set(bot, "reply-check", { settings: { engine: null, model: "mini" } }).settings,
    ).toMatchObject({ engine: null, model: null });
    const v = h.agents.addons.set(bot, "reply-check", {
      enabled: true,
      settings: { engine: "cheap", model: "mini" },
    });
    expect(v.settings).toMatchObject({ engine: "cheap", model: "mini" });
    const t = h.core.createThread();
    await h.core.send(t.id, "記一下").done;
    await h.agents.replyCheck.settle();
    expect(picked).toContainEqual([bot, "reply-check"]);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("回覆檢查員");
  });

  it("rules and verdict parsing", () => {
    expect(ruleIssues("要訂哪天？幾個人？")).toEqual(["一則訊息裡問了不只一個問題"]);
    expect(ruleIssues("好的。要我訂嗎？")).toEqual([]);
    expect(parseReplyVerdict('{"ok":true}')).toEqual({ ok: true, issues: [] });
    expect(parseReplyVerdict('xx {"ok":false,"issues":["a"]}')).toEqual({ ok: false, issues: ["a"] });
    expect(parseReplyVerdict("nope")).toBeUndefined();
  });
});
