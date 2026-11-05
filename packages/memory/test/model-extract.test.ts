import { describe, expect, it } from "vitest";
import {
  type Candidate,
  CombinedExtractor,
  type ExtractInput,
  extractionPrompt,
  ModelExtractor,
  parseModelCandidates,
  RuleExtractor,
} from "../src/index.ts";

const said = "我女兒叫小米，下個月要考會考。我比較喜歡早上開會";

describe("model-based memory extraction (P9)", () => {
  it("keeps only items whose quote is the person's own words", () => {
    const answer = `好的，以下是結果：
\`\`\`json
{"items":[
  {"kind":"person","subject":"女兒","body":"女兒叫小米","quote":"我女兒叫小米","confidence":0.97},
  {"kind":"preference","subject":"開會時間","body":"喜歡早上開會","quote":"我比較喜歡早上開會","confidence":0.8},
  {"kind":"fact","subject":"住處","body":"住在台北","quote":"我住在台北","confidence":0.9},
  {"kind":"project","subject":"x","body":"y","quote":"","confidence":0.9}
]}
\`\`\``;
    const got = parseModelCandidates(answer, said);
    expect(got.map((c) => [c.kind, c.body, c.quote])).toEqual([
      ["person", "女兒叫小米", "我女兒叫小米"],
      ["preference", "喜歡早上開會", "我比較喜歡早上開會"],
    ]);
    // Capped below a person's own confirmation.
    expect(got[0]?.confidence).toBe(0.9);
    expect(got[0]?.subject).toBe("m:person:女兒");
  });

  it("drops secrets, unknown kinds, junk and anything past three items", () => {
    const text = "我的密碼是 hunter2-Secret-99，我喜歡貓，我喜歡狗，我喜歡魚，我喜歡鳥";
    const items = [
      { kind: "fact", body: "密碼是 hunter2-Secret-99", quote: "我的密碼是 hunter2-Secret-99" },
      { kind: "hobby", body: "喜歡貓", quote: "我喜歡貓" },
      { kind: "preference", body: "喜歡狗", quote: "我喜歡狗" },
      { kind: "preference", body: "喜歡魚", quote: "我喜歡魚" },
      { kind: "preference", body: "喜歡鳥", quote: "我喜歡鳥" },
    ];
    const got = parseModelCandidates(JSON.stringify({ items }), text);
    expect(got.map((c) => c.body)).toEqual(["喜歡狗"]);
    expect(parseModelCandidates("我覺得沒有什麼要記的", text)).toEqual([]);
    expect(parseModelCandidates('{"items": "nope"}', text)).toEqual([]);
    expect(parseModelCandidates("{broken", text)).toEqual([]);
  });

  it("the prompt fences the person's words and asks for exact quotes", () => {
    const p = extractionPrompt(said);
    expect(p).toContain(`<said>\n${said}\n</said>`);
    expect(p).toContain("一字不差");
  });

  it("combined: the rules always count, the model only adds, and a failure leaves the rules", async () => {
    const input: ExtractInput = {
      userText: "我喜歡喝燕麥奶拿鐵。我女兒叫小米",
      botId: "bot_1",
      threadId: "t",
    };
    let calls = 0;
    const model = new ModelExtractor({
      complete: async () => {
        calls++;
        return JSON.stringify({
          items: [
            { kind: "preference", subject: "咖啡", body: "喜歡喝燕麥奶拿鐵", quote: "我喜歡喝燕麥奶拿鐵" },
            { kind: "person", subject: "女兒", body: "女兒叫小米", quote: "我女兒叫小米" },
          ],
        });
      },
    });
    let use = true;
    const both = new CombinedExtractor({ rules: new RuleExtractor(), model, useModel: () => use });
    const got: Candidate[] = await both.extract(input);
    expect(got.filter((c) => c.body.includes("燕麥奶"))).toHaveLength(1);
    expect(got.some((c) => c.body === "女兒叫小米" && c.kind === "person")).toBe(true);

    use = false;
    const rulesOnly = await both.extract(input);
    expect(calls).toBe(1);
    expect(rulesOnly.some((c) => c.body === "女兒叫小米")).toBe(false);

    const broken = new CombinedExtractor({
      rules: new RuleExtractor(),
      model: new ModelExtractor({ complete: async () => Promise.reject(new Error("engine down")) }),
      useModel: () => true,
    });
    const fallback = await broken.extract(input);
    expect(fallback.map((c) => c.body)).toEqual(
      (await new RuleExtractor().extract(input)).map((c) => c.body),
    );
    expect(broken.failures).toBe(1);
  });

  it("a model that does not answer in time is given up on", async () => {
    const slow = new ModelExtractor({
      timeoutMs: 50,
      complete: ({ signal }) =>
        new Promise((_res, rej) => signal.addEventListener("abort", () => rej(new Error("aborted")))),
    });
    await expect(slow.extract({ userText: "我喜歡貓", botId: "b", threadId: "t" })).rejects.toThrow();
  });
});
