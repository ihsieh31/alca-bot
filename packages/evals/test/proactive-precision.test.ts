import { describe, expect, it } from "vitest";
import { CORPUS_GATES, MIN_CASES, PROACTIVE_CASES, runCorpus } from "../src/index.ts";

// Gap analysis 2026-11 §4.6: the labeled 主動留意 corpus through the real
// pipeline (scripted candidate step, no live model), with CI gates.

describe("主動留意 precision corpus", () => {
  it("meets the gates: precision ≥ 0.9, recall ≥ 0.8, no false interrupt, no duplicate", async () => {
    expect(PROACTIVE_CASES.length).toBeGreaterThanOrEqual(MIN_CASES);
    expect(new Set(PROACTIVE_CASES.map((c) => c.id)).size).toBe(PROACTIVE_CASES.length);
    for (const tag of [
      "surface",
      "quiet",
      "dedupe",
      "quiet-hours",
      "suppressed",
      "near-due",
      "cancelled",
      "promo",
    ])
      expect(
        PROACTIVE_CASES.some((c) => c.tags.includes(tag)),
        tag,
      ).toBe(true);
    const { results, metrics } = await runCorpus(PROACTIVE_CASES);
    const wrong = results.filter((r) => !r.ok).map((r) => ({ id: r.id, shown: r.shown, missed: r.missed }));
    console.log(
      `proactive corpus: ${JSON.stringify(metrics)}${wrong.length ? `\nwrong: ${JSON.stringify(wrong)}` : ""}`,
    );
    expect(metrics.precision).toBeGreaterThanOrEqual(CORPUS_GATES.precision);
    expect(metrics.recall).toBeGreaterThanOrEqual(CORPUS_GATES.recall);
    expect(metrics.falseInterrupts).toBe(CORPUS_GATES.falseInterrupts);
    expect(metrics.duplicates).toBe(CORPUS_GATES.duplicates);
  }, 60_000);
});
