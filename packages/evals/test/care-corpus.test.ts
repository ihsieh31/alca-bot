import { describe, expect, it } from "vitest";
import { CARE_CASES, CARE_GATES, CARE_MIN_CASES, runCareCorpus } from "../src/index.ts";

// Care moments (docs/design/CARE-MOMENTS.md §6): the labeled corpus through the
// real pipeline with a scripted router, in both modes, with CI gates.

describe("care moments corpus", () => {
  it("has positives, a false-positive set and every gate covered", () => {
    expect(CARE_CASES.length).toBeGreaterThanOrEqual(CARE_MIN_CASES);
    expect(new Set(CARE_CASES.map((c) => c.id)).size).toBe(CARE_CASES.length);
    for (const tag of [
      "positive",
      "negative",
      "mid-task",
      "ack",
      "question",
      "dedupe",
      "heavy",
      "suppressed",
      "window",
      "english",
      "lingering",
    ])
      expect(
        CARE_CASES.some((c) => c.tags.includes(tag)),
        tag,
      ).toBe(true);
  });

  for (const mode of ["obedient", "tempted"] as const)
    it(`${mode} model: every positive lands, zero false care lines`, async () => {
      const { metrics } = await runCareCorpus(CARE_CASES, mode);
      console.log(`care corpus (${mode}): ${JSON.stringify(metrics)}`);
      expect(metrics.falseCare).toBe(CARE_GATES.falseCare);
      expect(metrics.recall).toBeGreaterThanOrEqual(CARE_GATES.recall);
      expect(metrics.failed).toEqual([]);
    }, 120_000);
});
