import { describe, expect, it } from "vitest";
import {
  isPersonOnly,
  orderOptions,
  parseQuestions,
  questionsFromText,
  withoutQuestionNumber,
  withoutRecommendedMark,
} from "../src/harness/contract.ts";
import { HARNESS_CHOICE_RULES } from "../src/harness/dispatch.ts";

/** Mac test 2026-11 B11: small contract and router-rule fixes. Fictional data only. */

describe("NEEDS_INPUT options (B11)", () => {
  it("the model's own recommended mark is taken off; options[0] stays the recommendation", () => {
    expect(withoutRecommendedMark("週日（Recommended）")).toBe("週日");
    expect(withoutRecommendedMark("下午 (recommended)")).toBe("下午");
    expect(withoutRecommendedMark("（建議）掛號")).toBe("掛號");
    expect(withoutRecommendedMark("推薦的那家")).toBe("推薦的那家");
    const qs = parseQuestions([{ question: "哪一天？", options: ["週日（Recommended）", "週六"] }]);
    expect(qs).toEqual([{ question: "哪一天？", personOnly: false, options: ["週日", "週六"] }]);
  });
});

describe("NEEDS_INPUT normalised by the host (mac device test 2026-11-05 BUG-6 / BUG-13)", () => {
  it("a mark with more words counts; the marked option moves first and loses the mark", () => {
    expect(withoutRecommendedMark("中式（推薦，選擇最多）")).toBe("中式");
    expect(withoutRecommendedMark("今晚 19:00 (recommended: most tables free)")).toBe("今晚 19:00");
    expect(withoutRecommendedMark("2 人［建議］")).toBe("2 人");
    expect(orderOptions(["日式", "中式（推薦，選擇最多）", "西式"])).toEqual(["中式", "日式", "西式"]);
    expect(orderOptions(["A", "B (Suggested)"])).toEqual(["B", "A"]);
    expect(orderOptions(["A", "B"])).toEqual(["A", "B"]);
    expect(orderOptions(["我建議的那家", "推薦的那家"])).toEqual(["我建議的那家", "推薦的那家"]);
    expect(orderOptions(["週六", "週日 - recommended"])).toEqual(["週日", "週六"]);
    const qs = parseQuestions([
      { question: "1. 今晚想吃哪一類？", options: ["日式", "中式（推薦，選擇最多）"] },
      { question: "(2) 幾個人？", options: ["1 人", "2 人 建議"] },
    ]);
    expect(qs).toEqual([
      { question: "今晚想吃哪一類？", personOnly: false, options: ["中式", "日式"] },
      { question: "幾個人？", personOnly: false, options: ["2 人", "1 人"] },
    ]);
  });

  it("the model's own question number is taken off; numbers in the text stay", () => {
    for (const [q, want] of [
      ["1. 哪一天？", "哪一天？"],
      ["2、哪個時段？", "哪個時段？"],
      ["（3）幾點？", "幾點？"],
      ["Q1: Which day?", "Which day?"],
      ["1.5 公斤可以嗎？", "1.5 公斤可以嗎？"],
      ["2026 年要去嗎？", "2026 年要去嗎？"],
      ["3 個人夠嗎？", "3 個人夠嗎？"],
    ])
      expect(withoutQuestionNumber(q as string), q).toBe(want);
    expect(questionsFromText("NEEDS_INPUT: 1. 哪一天？")?.[0]?.question).toBe("哪一天？");
  });
});

describe("person_only (B11)", () => {
  it("a time-slot preference is not person-only; sign-in, codes and payment still are", () => {
    expect(isPersonOnly("你想要週六還是週日、上午還是下午？", false)).toBe(false);
    expect(isPersonOnly("Which blog in the list do you prefer?", false)).toBe(false);
    expect(isPersonOnly("Is the design in blue OK?", false)).toBe(false);
    for (const q of [
      "請登入你的帳號",
      "驗證碼是多少？",
      "要用哪張信用卡付款？",
      "Please log in",
      "sign-in code?",
      "login?",
    ])
      expect(isPersonOnly(q, false), q).toBe(true);
  });

  it("the worker's own flag always counts (the host only makes it stricter)", () => {
    expect(isPersonOnly("你想要哪一天？", true)).toBe(true);
    const qs = parseQuestions([{ question: "哪一天？", options: ["週日", "週六"], person_only: true }]);
    expect(Array.isArray(qs) && qs[0]?.personOnly).toBe(true);
  });
});

describe("router harness rule (B11)", () => {
  it("an explicit request for a coding worker is dispatched as coding, in both languages", () => {
    expect(HARNESS_CHOICE_RULES.zh.some((l) => l.includes("程式工人") && l.includes("harness=coding"))).toBe(
      true,
    );
    expect(
      HARNESS_CHOICE_RULES.en.some((l) => l.includes("coding worker") && l.includes("harness=coding")),
    ).toBe(true);
  });
});
