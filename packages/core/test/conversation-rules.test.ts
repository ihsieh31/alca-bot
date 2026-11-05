import { describe, expect, it } from "vitest";
import {
  botLanguage,
  buildStablePrompt,
  CONVERSATION_RULES,
  DEFAULT_PROFILE,
  workerProfile,
} from "../src/index.ts";
import { lastLine, makeAgents, say } from "./agents-helpers.ts";

describe("conversation rules in the stable layer (P14 B1)", () => {
  it("nine rules per language, each with a good and a bad example", () => {
    for (const lang of ["zh", "en"] as const) {
      const text = CONVERSATION_RULES[lang];
      expect(text.match(/^\d+\. /gmu)).toHaveLength(9);
      expect(text.match(lang === "zh" ? /正例：/gu : /Good: /gu)).toHaveLength(9);
      expect(text.match(lang === "zh" ? /反例：/gu : /Bad: /gu)).toHaveLength(9);
    }
    expect(CONVERSATION_RULES.zh).toContain("一則最多一個問題");
    expect(CONVERSATION_RULES.en).toContain("at most one question per message");
  });

  it("is part of the router / thread layer, byte-identical, and never in a worker's", () => {
    const a = buildStablePrompt(DEFAULT_PROFILE, ["b", "a"]);
    const b = buildStablePrompt(DEFAULT_PROFILE, ["a", "b"]);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    expect(a).toContain(CONVERSATION_RULES.zh);
    expect(a).toContain("<alca:must-follow>");
    expect(buildStablePrompt({ ...DEFAULT_PROFILE, language: "en" })).toContain(CONVERSATION_RULES.en);
    expect(buildStablePrompt(workerProfile())).not.toContain(CONVERSATION_RULES.zh);
  });

  it("picks the bot's language from its instructions", () => {
    expect(botLanguage(null)).toBe("zh");
    expect(botLanguage("回覆一律用繁體中文")).toBe("zh");
    expect(botLanguage("Always reply in English, short sentences.")).toBe("en");
    expect(botLanguage("請用英文回覆")).toBe("en");
    expect(botLanguage("用中文，但專有名詞保留 English")).toBe("zh");
  });

  it("an English bot's router turn carries the English copy, stable across turns", async () => {
    const h = makeAgents({ router: () => say("ok"), worker: () => say("done") });
    try {
      const bot = h.store.bots.create("Scout", { instructions: "Reply in English." });
      const t = h.core.createThread("x", bot.id);
      await h.core.send(t.id, "hi").done;
      await h.core.send(t.id, "again").done;
      const engine = h.core.engine as unknown as {
        requests: Array<{ system: { stable: string }; userMessage: string }>;
      };
      const reqs = engine.requests.filter((r) => ["hi", "again"].includes(lastLine(r.userMessage)));
      expect(reqs).toHaveLength(2);
      expect(reqs[0]?.system.stable).toContain(CONVERSATION_RULES.en);
      expect(reqs[0]?.system.stable).toBe(reqs[1]?.system.stable);
    } finally {
      await h.close();
    }
  });
});
