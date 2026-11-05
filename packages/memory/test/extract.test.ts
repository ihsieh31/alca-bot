import { describe, expect, it } from "vitest";
import { candidateFromRemember, parseCommands, RuleExtractor, ruleExtract } from "../src/index.ts";

describe("rule extraction (inferred)", () => {
  it("finds first-person preferences, people, facts and projects", () => {
    const c = ruleExtract("我喜歡喝燕麥奶拿鐵。我對花生過敏！我的媽媽是護理師，我住在高雄");
    expect(c.map((x) => [x.kind, x.subject, x.body])).toEqual([
      ["preference", "pref:喝", "喜歡喝燕麥奶拿鐵"],
      ["fact", "allergy:花生", "對花生過敏"],
      ["person", "person:媽媽", "媽媽：護理師"],
      ["fact", "home", "住在高雄"],
    ]);
    expect(c.every((x) => x.confidence < 1)).toBe(true);
    expect(c[0]?.quote).toBe("我喜歡喝燕麥奶拿鐵");
    expect(ruleExtract("我最近在開發一個記帳 App")[0]).toMatchObject({
      kind: "project",
      body: "正在開發一個記帳 App",
    });
    expect(ruleExtract("I really like jazz piano")[0]).toMatchObject({
      kind: "preference",
      body: "likes jazz piano",
    });
  });

  it("marks corrections with the same subject", () => {
    const [c] = ruleExtract("不對，我現在改喝豆漿了");
    expect(c).toMatchObject({ subject: "pref:喝", body: "現在喝豆漿", correction: true });
  });

  it("skips questions, hypotheticals, code and third-person sentences", () => {
    expect(ruleExtract("我喜歡這樣嗎？")).toEqual([]);
    expect(ruleExtract("如果我住在台北會比較方便")).toEqual([]);
    expect(ruleExtract("```\n我喜歡 bug\n```")).toEqual([]);
    expect(ruleExtract("住在台北的朋友說要來")).toEqual([]);
    expect(ruleExtract("幫我在示範商店結帳")).toEqual([]);
  });
});

describe("explicit commands", () => {
  it("parses 記住 / 忘記 and English forms", () => {
    expect(parseCommands("請記住我喜歡靠窗的座位")).toEqual([
      { kind: "remember", text: "我喜歡靠窗的座位", quote: "請記住我喜歡靠窗的座位" },
    ]);
    expect(parseCommands("忘記我喜歡燕麥奶拿鐵這件事")).toEqual([
      { kind: "forget", text: "喜歡燕麥奶拿鐵", quote: "忘記我喜歡燕麥奶拿鐵這件事" },
    ]);
    expect(parseCommands("remember that my sister is Amy")[0]).toMatchObject({
      kind: "remember",
      text: "my sister is Amy",
    });
    expect(parseCommands("forget about my old address")[0]).toMatchObject({ kind: "forget" });
  });

  it("does not treat tasks or questions as commands", () => {
    expect(parseCommands("刪除購物清單")).toEqual([]);
    expect(parseCommands("忘記帶傘了怎麼辦？")).toEqual([]);
    expect(parseCommands("我忘記帶傘了")).toEqual([]);
    expect(parseCommands("你記住了嗎？")).toEqual([]);
  });

  it("a remembered text gets a kind and subject when the rules know it", () => {
    expect(candidateFromRemember({ text: "喜歡靠窗的座位", quote: "q" })).toMatchObject({
      kind: "preference",
      confidence: 1,
      body: "喜歡靠窗的座位",
    });
    expect(candidateFromRemember({ text: "下週三要繳房租", quote: "q" })).toMatchObject({
      kind: "fact",
      subject: "",
    });
    // How answers should look is a preference (mac test 2026-11-04), said either way.
    for (const text of ["我喜歡答案先給結論", "我希望回答先給結論", "回答時先給結論"])
      expect(candidateFromRemember({ text, quote: "q" }).kind, text).toBe("preference");
    expect(ruleExtract("我希望回答簡短一點")[0]).toMatchObject({
      kind: "preference",
      subject: "answer-style",
    });
    expect(ruleExtract("我希望明天不要下雨")).toEqual([]);
  });

  it("the rule extractor ignores sentences that were commands", async () => {
    const r = await new RuleExtractor().extract({
      userText: "記住我喜歡貓。我住在新竹",
      botId: "b",
      threadId: "t",
    });
    expect(r.map((c) => c.body)).toEqual(["住在新竹"]);
  });
});

describe("corrections", () => {
  it("a lone 不對 marks the next clause as a correction", () => {
    expect(ruleExtract("不對，我喜歡喝豆漿")[0]).toMatchObject({ body: "喜歡喝豆漿", correction: true });
    expect(ruleExtract("我喜歡喝豆漿")[0]?.correction).toBeUndefined();
  });
});
