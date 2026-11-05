import { ClaudeStreamParser, type ScriptContext, type ScriptStep } from "@alca/engines";
import type { WorkerRecord } from "@alca/store";
import { afterEach, describe, expect, it } from "vitest";
import { budgetUsage, CACHE_READ_WEIGHT, tokenBudgetDue } from "../src/harness/usage.ts";
import { call, type Harness, lastLine, makeAgents, say, until } from "./agents-helpers.ts";
import { tool } from "./helpers.ts";

/**
 * Mac test B3: a worker's token budget counts new tokens (input + cache
 * writes + output) and prompt-cache reads at a tenth; cache reads are booked
 * apart; a harness worker ends its turn before the next call would cross the
 * cap, so it stops close to it rather than 18–19 % over. Scripted engines and
 * made-up numbers only.
 */

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe("what the budget counts", () => {
  it("new tokens in full, cache reads at a tenth, never more cache than input", () => {
    expect(CACHE_READ_WEIGHT).toBe(0.1);
    expect(budgetUsage({ inputTokens: 28_000, cachedInputTokens: 25_000, outputTokens: 1_000 })).toEqual({
      counted: 4_000 + 2_500,
      fresh: 4_000,
      cached: 25_000,
    });
    expect(budgetUsage({ inputTokens: 500, outputTokens: 20 })).toEqual({
      counted: 520,
      fresh: 520,
      cached: 0,
    });
    // a reading that claims more cache than input counts the input as cached, never negative
    expect(budgetUsage({ inputTokens: 100, cachedInputTokens: 900, outputTokens: 0 })).toEqual({
      counted: 10,
      fresh: 0,
      cached: 100,
    });
  });

  it("Claude Code stream-json: input + cache writes + output are new; cache reads are cached", () => {
    const p = new ClaudeStreamParser();
    const events = p.feed({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "s1",
      result: "ok",
      usage: {
        input_tokens: 40,
        cache_creation_input_tokens: 1_200,
        cache_read_input_tokens: 21_771,
        output_tokens: 300,
      },
    });
    const u = events.find((e) => e.type === "usage");
    if (u?.type !== "usage") throw new Error("no usage event");
    expect(u.cachedInputTokens).toBe(21_771);
    expect(budgetUsage(u)).toEqual({ counted: 1_540 + 2_178, fresh: 1_540, cached: 21_771 });
  });

  it("the next call is estimated from what was booked; unbooked steps of a CLI turn count too", () => {
    // nothing booked yet: no estimate
    expect(tokenBudgetDue({ tokens: 0, maxTokens: 10_000, steps: 3, stepsAtUsage: 0, readings: 0 })).toBe(
      false,
    );
    // at or over the cap
    expect(
      tokenBudgetDue({ tokens: 10_000, maxTokens: 10_000, steps: 0, stepsAtUsage: 0, readings: 1 }),
    ).toBe(true);
    // 4 readings of 1.5k: room for two more under 10k; at 8.2k there is not
    expect(tokenBudgetDue({ tokens: 6_000, maxTokens: 10_000, steps: 3, stepsAtUsage: 3, readings: 4 })).toBe(
      false,
    );
    expect(tokenBudgetDue({ tokens: 8_200, maxTokens: 10_000, steps: 4, stepsAtUsage: 4, readings: 4 })).toBe(
      true,
    );
    // a CLI booked one turn of 4 steps (1.6k a call); 3 steps since, 2 of them not booked yet
    expect(tokenBudgetDue({ tokens: 8_000, maxTokens: 14_500, steps: 7, stepsAtUsage: 4, readings: 1 })).toBe(
      false,
    );
    expect(tokenBudgetDue({ tokens: 8_000, maxTokens: 14_000, steps: 7, stepsAtUsage: 4, readings: 1 })).toBe(
      true,
    );
  });
});

/** One model call: 25k read from the cache, 3k new (2k input + 1k output). */
const callUsage: ScriptStep = {
  type: "usage",
  inputTokens: 27_000,
  cachedInputTokens: 25_000,
  outputTokens: 1_000,
};
const PER_CALL = 3_000 + 2_500;

const routerFor =
  (maxTokens: number) =>
  ({ req, pass }: ScriptContext): ScriptStep[] => {
    if (req.userMessage.includes("<alca:worker")) return say("收到回報");
    return pass === 0
      ? call("s", "worker_start", {
          title: "查資料",
          goal: lastLine(req.userMessage),
          harness: "general",
          budget: { maxTokens },
        })
      : say("派了");
  };

const finished = (x: Harness, threadId: string) =>
  until(() => {
    const w = x.store.workers.byThread(threadId)[0];
    return w && w.status !== "running" && w.status !== "queued" ? w : undefined;
  }, 20_000);

describe("a harness worker against its token budget (scripted engine)", () => {
  it("10 calls of 25k cache reads + 3k new tokens fit a 70k budget; cache reads are booked apart", async () => {
    const look = tool("look_up", "read", () => "一筆資料");
    const worker = ({ pass }: ScriptContext): ScriptStep[] => {
      if (pass < 10) return [callUsage, ...call(`c${pass}`, "look_up", { q: String(pass) })];
      if (pass === 10) return call("r", "report_result", { status: "done", summary: "十筆都查完了" });
      return say("完成");
    };
    // Counted in full (before B3) the same calls are 280k.
    h = makeAgents({ router: routerFor(70_000), worker, tools: [look], level: "autonomous" });
    const t = h.core.createThread();
    await h.core.send(t.id, "查十筆資料").done;
    const w = (await finished(h, t.id)) as WorkerRecord;
    expect(look.calls).toHaveLength(10);
    expect(w.budget.maxTokens).toBe(70_000);
    expect(w.tokens).toBe(10 * PER_CALL);
    expect(w.tokens).toBeLessThanOrEqual(70_000);
    expect(w.cachedTokens).toBe(10 * 25_000);
    expect(w.result?.summary ?? "").toContain("十筆都查完了");
  }, 30_000);

  it("a worker that would go on forever stops close to the cap, not past it by much", async () => {
    const look = tool("look_up", "read", () => "還有更多");
    let reportPass = false;
    const worker = ({ req, pass }: ScriptContext): ScriptStep[] => {
      const reportOnly = !req.tools?.some((x) => x.name === "look_up");
      if (reportOnly) {
        reportPass = true;
        return [callUsage, ...call("r", "report_result", { status: "partial", summary: "預算用完，先回報" })];
      }
      return [callUsage, ...call(`c${pass}`, "look_up", { q: String(pass) })];
    };
    const max = 200_000;
    h = makeAgents({ router: routerFor(max), worker, tools: [look], level: "autonomous" });
    const t = h.core.createThread();
    await h.core.send(t.id, "一直查").done;
    const w = (await finished(h, t.id)) as WorkerRecord;
    expect(reportPass).toBe(true);
    expect(look.calls.length).toBeGreaterThan(0);
    expect(look.calls.length).toBeLessThan(40);
    // stopped within a few percent of the cap (before B3: 18–19 % over)
    expect(w.tokens / max - 1).toBeLessThanOrEqual(0.03);
    expect(w.result?.summary ?? "").toContain("預算用完");
  }, 30_000);

  it("N4: a call that uses up the budget ends the worker without the report-only pass", async () => {
    // Mac device test 2026-11-05: a proactive worker with 20k went on to 74k (usage booked late,
    // then a report pass after the stop). Once the booked tokens reach the cap no call is left.
    const look = tool("look_up", "read", () => "還有更多");
    let reportPass = false;
    const worker = ({ req, pass }: ScriptContext): ScriptStep[] => {
      if (!req.tools?.some((x) => x.name === "look_up")) {
        reportPass = true;
        return [callUsage, ...call("r", "report_result", { status: "partial", summary: "預算用完" })];
      }
      return [callUsage, ...call(`c${pass}`, "look_up", { q: String(pass) })];
    };
    // One call (5.5k counted) already crosses a 5k budget.
    h = makeAgents({ router: routerFor(5_000), worker, tools: [look], level: "autonomous" });
    const t = h.core.createThread();
    await h.core.send(t.id, "一直查").done;
    const w = (await finished(h, t.id)) as WorkerRecord;
    expect(reportPass).toBe(false);
    expect(look.calls.length).toBeLessThanOrEqual(1);
    expect(w.tokens).toBe(PER_CALL);
    expect(w.status).not.toBe("succeeded");
  }, 30_000);
});
