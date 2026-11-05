// Model-based memory extraction end to end in the core (P9): the bot's own
// engine (a ScriptedEngine here) proposes items after a turn; only quoted,
// secret-free, not-forgotten ones are stored, as inferred memories.
import { ScriptedEngine, streamText } from "@alca/engines";
import { CombinedExtractor, ModelExtractor, RuleExtractor } from "@alca/memory";
import { describe, expect, it } from "vitest";
import { engineCompletion, Learning } from "../src/index.ts";
import { makeCore } from "./helpers.ts";

function setup(answer: (prompt: string) => string, useModel = true) {
  const chat = new ScriptedEngine(() => streamText("好的"));
  const extractorEngine = new ScriptedEngine(({ req }) => streamText(answer(req.userMessage), 2));
  const { core, store } = makeCore(chat);
  const learning = new Learning({
    store,
    extractor: new CombinedExtractor({
      rules: new RuleExtractor(),
      model: new ModelExtractor({ complete: engineCompletion(() => extractorEngine) }),
      useModel: () => useModel,
    }),
  });
  core.useHooks(learning);
  return { core, store, learning, chat, extractorEngine };
}

describe("model-based memory extraction (core, ScriptedEngine)", () => {
  it("stores what the model found with the person's words; drops what it made up", async () => {
    const { core, store, learning, extractorEngine } = setup(() =>
      JSON.stringify({
        items: [
          { kind: "person", subject: "女兒", body: "女兒叫小米", quote: "我女兒叫小米", confidence: 0.8 },
          { kind: "fact", subject: "工作", body: "在台積電上班", quote: "我在台積電上班", confidence: 0.9 },
        ],
      }),
    );
    const t = core.createThread();
    await core.send(t.id, "我女兒叫小米，她下週生日").done;
    await learning.settle();
    const all = store.memory.list();
    expect(all.map((m) => [m.kind, m.body, m.origin, m.quote])).toEqual([
      ["person", "女兒叫小米", "inferred", "我女兒叫小米"],
    ]);
    expect(all[0]?.confidence).toBeLessThan(1);
    // The extraction ran in its own conversation, with no tools, not in the person's thread.
    const req = extractorEngine.requests.at(-1);
    expect(req?.sessionKey).toMatch(/^memx:/);
    expect(req?.tools).toEqual([]);
    expect(req?.userMessage).toContain("<said>\n我女兒叫小米，她下週生日\n</said>");
  });

  it("a secret or a forgotten item is not stored even when the model proposes it", async () => {
    const { core, store, learning } = setup((p) =>
      p.includes("hunter")
        ? JSON.stringify({
            items: [
              { kind: "fact", body: "密碼是 hunter2-Secret-99", quote: "我的密碼是 hunter2-Secret-99" },
            ],
          })
        : JSON.stringify({
            items: [{ kind: "preference", subject: "飲料", body: "喜歡喝珍奶", quote: "珍奶是我每天必喝的" }],
          }),
    );
    const t = core.createThread();
    await core.send(t.id, "我的密碼是 hunter2-Secret-99").done;
    await learning.settle();
    expect(store.memory.count()).toBe(0);
    await core.send(t.id, "珍奶是我每天必喝的").done;
    await learning.settle();
    expect(store.memory.list().map((m) => m.body)).toEqual(["喜歡喝珍奶"]);
    await core.send(t.id, "忘記我喜歡喝珍奶").done;
    await learning.settle();
    expect(store.memory.count()).toBe(0);
    await core.send(t.id, "珍奶是我每天必喝的").done;
    await learning.settle();
    expect(store.memory.count()).toBe(0);
  });

  it("off by default per bot: with the switch off the engine is never asked", async () => {
    const { core, learning, extractorEngine } = setup(() => '{"items":[]}', false);
    const t = core.createThread();
    await core.send(t.id, "我喜歡靠窗的座位").done;
    await learning.settle();
    expect(extractorEngine.requests).toHaveLength(0);
  });
});
