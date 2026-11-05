import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BUDGET_FILE, compareBudget, lowered, measure } from "../../../scripts/check-prompt-budget.ts";

/** Next-round design §0.2.6: the prompt budget only ratchets down (also run by `pnpm check`). */
describe("prompt budget ratchet", () => {
  const budget = JSON.parse(readFileSync(BUDGET_FILE, "utf8")) as Record<string, number>;

  it("every fixed prompt piece and tool spec is within scripts/prompt-budget.json", () => {
    expect(compareBudget(measure(), budget)).toEqual([]);
  });

  it("measures the router, worker and both harness prompts in both languages", () => {
    const names = Object.keys(measure());
    for (const who of ["router", "worker", "coding", "general"])
      for (const lang of ["zh", "en"]) expect(names).toContain(`stable.${who}.${lang}`);
    expect(names).toEqual(expect.arrayContaining(["tools.router", "tools.coding", "tools.report_result"]));
  });

  it("one byte over fails; more than 5% under fails; a new or vanished piece fails", () => {
    expect(compareBudget({ a: 101 }, { a: 100 })).toEqual([
      { name: "a", now: 101, budget: 100, why: "over" },
    ]);
    expect(compareBudget({ a: 96 }, { a: 100 })).toEqual([]);
    expect(compareBudget({ a: 94 }, { a: 100 })[0]?.why).toBe("under");
    expect(compareBudget({ a: 1, b: 2 }, { a: 1 })[0]).toMatchObject({ name: "b", why: "unknown" });
    expect(compareBudget({}, { a: 1 })[0]).toMatchObject({ name: "a", why: "gone" });
  });

  it("--update only lowers numbers, never raises one", () => {
    expect(lowered({ a: 90, b: 120, c: 5 }, { a: 100, b: 100, d: 7 })).toEqual({ a: 90, b: 100, c: 5 });
  });
});
