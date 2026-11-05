import type { ScriptContext, ScriptStep } from "@alca/engines";
import { ScriptedEngine } from "@alca/engines";
import { afterEach, describe, expect, it } from "vitest";
import { type DecideState, decideNext, rulePassCompact } from "../src/agents/harness-run/decide.ts";
import { SUMMARY_SECTIONS } from "../src/harness/context.ts";
import { freshRetryBudget } from "../src/index.ts";
import { call, type Harness, lastLine, makeAgents, say, until } from "./agents-helpers.ts";
import { tool } from "./helpers.ts";

/**
 * Research audit A5: compaction between passes of a turn, and the summary
 * written ahead at ~70 % of the ceiling. Scripted API workers with a 20k
 * window (ceiling 17k, prepare from 11.9k). Fictional tasks only.
 */

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const routerFor = ({ req, pass }: ScriptContext): ScriptStep[] => {
  if (req.userMessage.includes("<alca:worker")) return say("收到回報");
  return pass === 0
    ? call("s", "worker_start", { title: "查資料", goal: lastLine(req.userMessage), harness: "general" })
    : say("派了");
};

const summary = (mark: string) => SUMMARY_SECTIONS.map((s, i) => `## ${i + 1}. ${s}\n${mark}`).join("\n");
const usage = (n: number): ScriptStep => ({ type: "usage", inputTokens: n, outputTokens: 10 });

const reportTo = (threadId: string) =>
  until(
    () =>
      h?.store.threads
        .messages(threadId)
        .find((m) => m.role === "system" && m.content.includes("<alca:worker")),
    20_000,
  );

const engineOf = (worker: (c: ScriptContext) => ScriptStep[]) =>
  new ScriptedEngine(worker, { id: "worker", capabilities: { maxContextTokens: 20_000 } });

describe("compaction between passes", () => {
  it("a full context between passes winds the turn up, compacts and goes on in a fresh session", async () => {
    const seen = { nudge: "", handover: "", summaries: 0 };
    const worker = ({ req, pass }: ScriptContext): ScriptStep[] => {
      if (req.userMessage.includes("<alca:handover>")) {
        if (pass === 0) {
          seen.handover = req.userMessage;
          return call("rep", "report_result", { status: "done", summary: "查完了" });
        }
        return say("完成");
      }
      if (!req.tools?.length) {
        seen.summaries++;
        return say(summary("現場摘要"));
      }
      if (pass === 0) return [usage(18_000), ...call("l1", "lookup", { q: "a" })];
      const out = req.toolResults?.at(-1)?.output ?? "";
      if (pass === 1 && out.includes("結果 a")) {
        seen.nudge = out;
        return say("進度：查了一半，下一步查 b");
      }
      return say("完成");
    };
    h = makeAgents({
      router: routerFor,
      worker,
      tools: [tool("lookup", "read", () => "結果 a")],
      level: "autonomous",
      system: { workerEngine: engineOf(worker) },
    });
    const t = h.core.createThread();
    await h.core.send(t.id, "查資料").done;
    const rep = await reportTo(t.id);
    expect(seen.nudge).toContain("結果 a");
    expect(seen.nudge).toContain("先不要再呼叫工具");
    expect(seen.summaries).toBe(1);
    expect(seen.handover).toContain("現場摘要");
    expect(seen.handover).toContain("請照上面的交接摘要接著做");
    expect(seen.handover).not.toContain("你還沒有呼叫 report_result");
    expect(rep.content).toContain("查完了");
  }, 30_000);

  it("a summary written ahead at ~70 % is what the compaction uses (no second summary)", async () => {
    const seen = { handover: "", summaries: 0 };
    const worker = ({ req, pass }: ScriptContext): ScriptStep[] => {
      if (req.userMessage.includes("<alca:handover>")) {
        if (pass === 0) {
          seen.handover = req.userMessage;
          return call("rep", "report_result", { status: "done", summary: "做完了" });
        }
        return say("完成");
      }
      if (!req.tools?.length) {
        seen.summaries++;
        return say(summary("預先摘要"));
      }
      if (req.userMessage.includes("report_result")) return [usage(18_000), ...say("做到一半，還差最後一段")];
      return [usage(13_000), ...say("先看一下")];
    };
    h = makeAgents({
      router: routerFor,
      worker,
      level: "autonomous",
      system: { workerEngine: engineOf(worker) },
    });
    const t = h.core.createThread();
    await h.core.send(t.id, "查資料").done;
    await reportTo(t.id);
    expect(seen.summaries).toBe(1);
    expect(seen.handover).toContain("預先摘要");
    expect(seen.handover).toContain("摘要寫好之後的進展");
    expect(seen.handover).toContain("做到一半，還差最後一段");
  }, 30_000);

  it("under 70 % nothing is prepared and nothing compacts", async () => {
    const seen = { summaries: 0 };
    const worker = ({ req, pass }: ScriptContext): ScriptStep[] => {
      if (!req.tools?.length) {
        seen.summaries++;
        return say(summary("x"));
      }
      if (pass === 0) return [usage(5_000), ...call("l1", "lookup", { q: "a" })];
      if (pass === 1) return call("rep", "report_result", { status: "done", summary: "好了" });
      return say("完成");
    };
    h = makeAgents({
      router: routerFor,
      worker,
      tools: [tool("lookup", "read", () => "結果")],
      level: "autonomous",
      system: { workerEngine: engineOf(worker) },
    });
    const t = h.core.createThread();
    await h.core.send(t.id, "查資料").done;
    await reportTo(t.id);
    expect(seen.summaries).toBe(0);
  }, 30_000);
});

describe("rulePassCompact", () => {
  const base = (over: Partial<DecideState> = {}): DecideState => ({
    harness: "general",
    stopping: false,
    awaiting: false,
    finish: { reason: "completed" },
    ownsToolLoop: false,
    retry: freshRetryBudget(),
    overflowCompacted: false,
    passCompactPending: true,
    budgetHit: false,
    budgetPass: false,
    handedOff: false,
    verifyStale: false,
    verifyRounds: 0,
    checksAvailable: false,
    inbox: 0,
    reminders: 0,
    ...over,
  });
  it("compacts and resumes a wound-up turn without a report", () => {
    expect(decideNext(base())).toEqual({ kind: "compactResume" });
  });
  it("stays out of the way with a report, a CLI, a plain worker or nothing pending", () => {
    expect(rulePassCompact(base({ report: "done" }))).toBeUndefined();
    expect(rulePassCompact(base({ ownsToolLoop: true }))).toBeUndefined();
    const { harness: _h, ...plain } = base();
    expect(rulePassCompact(plain)).toBeUndefined();
    expect(rulePassCompact(base({ passCompactPending: false }))).toBeUndefined();
    expect(decideNext(base({ report: "done" }))).toEqual({ kind: "end", why: "done" });
  });
});
