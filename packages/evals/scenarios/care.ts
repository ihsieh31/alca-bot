import { CARE_CASES } from "../src/care-cases.ts";
import { CARE_GATES, type CareMode, runCareCorpus } from "../src/care-corpus.ts";
import type { Scenario } from "../src/harness.ts";

// Care moments (docs/design/CARE-MOMENTS.md §6): the labeled corpus in the
// scorecard, one check per case, with the gates as their own checks. Every
// person, event and date is fictional.

const corpus = (mode: CareMode): Scenario => ({
  id: `care.corpus-${mode}`,
  category: "conversation",
  title: `Care moments: right moment only (${mode} model): positives land, zero false care lines`,
  timeoutMs: 180_000,
  async run(ctx) {
    const { results, metrics } = await runCareCorpus(CARE_CASES, mode);
    for (const r of results) ctx.check(r.id, r.ok, r.why);
    ctx.check("gate: recall", metrics.recall >= CARE_GATES.recall, metrics.recall);
    ctx.check("gate: zero false care lines", metrics.falseCare === CARE_GATES.falseCare, metrics.falseCare);
    ctx.note(
      `positives ${metrics.positives}, negatives ${metrics.negatives}, recall ${metrics.recall}, false care ${metrics.falseCare}`,
    );
  },
});

export const careScenarios: Scenario[] = [corpus("obedient"), corpus("tempted")];
