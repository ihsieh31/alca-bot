import type { EngineEvent } from "@alca/engines";
import { describe, expect, it } from "vitest";
import {
  actionsFrom,
  answerRefusal,
  ceiling,
  changesFiles,
  classifyError,
  compactionStalled,
  estimateText,
  expiresAt,
  freshRetryBudget,
  isOutwardCall,
  keepTokens,
  nextRetry,
  noteProgress,
  parseReport,
  parseRetryAfter,
  passCap,
  resolveBudget,
  retryDelayMs,
  routerMayAnswer,
  shouldAutoCompact,
  shouldPrepareSummary,
  sleepAbortable,
  TEXT_QUESTION_TTL_MS,
  ToolExecutor,
  withOutwardLedger,
  withVerification,
} from "../src/index.ts";
import { retryingTurn } from "../src/phases/infer-retry.ts";

describe("retry", () => {
  it("classifies provider errors", () => {
    expect(classifyError({ message: "HTTP 429 rate limited" })).toBe("retryable");
    expect(classifyError({ message: "maximum context length exceeded" })).toBe("overflow");
    expect(classifyError({ message: "insufficient_quota" })).toBe("quota");
    expect(classifyError({ status: 401 })).toBe("auth");
    expect(classifyError({ message: "request timed out" })).toBe("timeout");
    expect(classifyError({ code: "engine.network", message: "socket hang up" })).toBe("retryable");
    expect(classifyError({ status: 400 })).toBe("bad_request");
  });

  it("back-off: doubling with jitter, capped, retry-after as the floor", () => {
    const mid = () => 0.5;
    expect(retryDelayMs(1, {}, mid)).toBe(2000);
    expect(retryDelayMs(3, {}, mid)).toBe(8000);
    expect(retryDelayMs(9, {}, mid)).toBe(30_000);
    expect(retryDelayMs(1, { headers: { "retry-after": "12" } }, mid)).toBe(12_000);
    expect(parseRetryAfter({ message: "please try again in 1.5s" })).toBe(1500);
  });

  it("spends at most 4 retries, at most 2 timeouts, and progress gives the allowance back", () => {
    const b = freshRetryBudget();
    const busy = { message: "HTTP 503 overloaded" };
    const got = Array.from({ length: 5 }, () => nextRetry(b, busy, () => 0.5));
    expect(got.slice(0, 4).every((d) => typeof d === "number")).toBe(true);
    expect(got[4]).toBeUndefined();
    noteProgress(b);
    expect(nextRetry(b, busy, () => 0.5)).toBe(2000);
    const t = freshRetryBudget();
    const slow = { message: "timed out" };
    expect([nextRetry(t, slow), nextRetry(t, slow), nextRetry(t, slow)].map((d) => d !== undefined)).toEqual([
      true,
      true,
      false,
    ]);
    expect(nextRetry(freshRetryBudget(), { status: 401 })).toBeUndefined();
  });

  it("the back-off sleep ends when the run is stopped", async () => {
    const c = new AbortController();
    const p = sleepAbortable(60_000, c.signal);
    c.abort();
    await expect(p).rejects.toBeDefined();
  });

  const collect = async (it: AsyncIterable<EngineEvent>) => {
    const out: EngineEvent[] = [];
    for await (const e of it) out.push(e);
    return out;
  };

  it("retries a call that failed before streaming, never one that already streamed", async () => {
    let n = 0;
    const flaky = async function* (): AsyncIterable<EngineEvent> {
      n++;
      if (n === 1) {
        yield { type: "error", code: "engine.network", message: "ECONNRESET", retryable: true };
        yield { type: "done", stop: "error" };
        return;
      }
      yield { type: "text.delta", text: "ok" };
      yield { type: "done", stop: "end_turn" };
    };
    const b = freshRetryBudget();
    const out = await collect(retryingTurn(flaky, b, new AbortController().signal));
    expect(n).toBe(2);
    expect(out.map((e) => e.type)).toEqual(["text.delta", "done"]);

    const late = async function* (): AsyncIterable<EngineEvent> {
      yield { type: "text.delta", text: "half" };
      yield { type: "error", code: "engine.network", message: "ECONNRESET", retryable: true };
      yield { type: "done", stop: "error" };
    };
    const out2 = await collect(retryingTurn(late, freshRetryBudget(), new AbortController().signal));
    expect(out2.map((e) => e.type)).toEqual(["text.delta", "error", "done"]);
  }, 10_000);
});

describe("context", () => {
  it("estimates CJK one token per character", () => {
    expect(estimateText("你好世界")).toBe(4);
    expect(estimateText("abcdefgh")).toBe(2);
  });

  it("ceiling, kept tail and the triggers", () => {
    expect(ceiling(200_000)).toBe(170_000);
    expect(ceiling(32_000)).toBe(16_000);
    expect(keepTokens(200_000)).toBe(20_000);
    expect(keepTokens(10_000)).toBe(8000);
    expect(shouldAutoCompact({ tokens: 171_000, measured: true, window: 200_000 })).toBe(true);
    expect(shouldAutoCompact({ tokens: 100_000, measured: true, window: 200_000 })).toBe(false);
    expect(shouldPrepareSummary(0.75 * 170_000, 200_000)).toBe(true);
    expect(shouldPrepareSummary(0.5 * 170_000, 200_000)).toBe(false);
    expect(compactionStalled(1)).toBe(false);
    expect(compactionStalled(2)).toBe(true);
  });

  it("section 9 of a summary is the host's outward ledger", () => {
    const s = withOutwardLedger("## 1. 目標\nx\n## 9. 已執行的外部動作\n- 模型亂寫", ["send：app_mail_send"]);
    expect(s).toContain("- send：app_mail_send");
    expect(s).not.toContain("模型亂寫");
  });
});

describe("report contract", () => {
  it("takes the five statuses and checks needs_input questions", () => {
    expect(parseReport({ status: "done", summary: "ok", changes: ["a.ts"] })).toMatchObject({
      status: "done",
      changes: ["a.ts"],
    });
    expect(parseReport({ status: "unverified", summary: "ok" })).toMatchObject({ status: "unverified" });
    expect(typeof parseReport({ status: "needs_input", summary: "?" })).toBe("string");
    const four = Array.from({ length: 4 }, (_, i) => ({ question: `q${i}` }));
    expect(parseReport({ status: "needs_input", summary: "?", questions: four })).toContain("最多");
    const r = parseReport({
      status: "needs_input",
      summary: "?",
      questions: [{ question: "用哪個色系？", options: ["藍", "綠"] }, { question: "請提供登入密碼" }],
    });
    expect(r).toMatchObject({
      questions: [
        { question: "用哪個色系？", options: ["藍", "綠"], personOnly: false },
        { question: "請提供登入密碼", personOnly: true },
      ],
    });
    expect(
      parseReport({ status: "needs_input", summary: "?", questions: [{ question: "要不要繼續？" }] }),
    ).toContain("要不要繼續");
  });

  it("no fresh green check turns done into unverified", () => {
    const r = parseReport({ status: "done", summary: "fixed" });
    if (typeof r === "string") throw new Error(r);
    expect(withVerification(r, true).status).toBe("done");
    expect(withVerification(r, false, "1 failed").status).toBe("unverified");
    expect(withVerification({ ...r, status: "blocked" }, false).status).toBe("blocked");
  });
});

describe("NEEDS_INPUT policy", () => {
  const plain = [{ question: "哪個顏色", options: ["藍", "綠"], personOnly: false }];
  const secret = [{ question: "密碼", personOnly: true }];
  it("the router answers only non-person-only questions at the autonomous level", () => {
    expect(routerMayAnswer(plain, "autonomous")).toBe(true);
    expect(routerMayAnswer(plain, "confirm_each_step")).toBe(false);
    expect(routerMayAnswer(secret, "autonomous")).toBe(false);
    expect(answerRefusal(plain, ["藍"], "agent", "autonomous")).toBeUndefined();
    expect(answerRefusal(plain, ["藍"], "agent", "confirm_each_step")).toBeDefined();
    expect(answerRefusal(secret, ["x"], "agent", "autonomous")).toBeDefined();
    expect(answerRefusal(secret, ["x"], "user", "confirm_each_step")).toBeUndefined();
    expect(answerRefusal(plain, [], "user", "autonomous")).toContain("1 題");
  });
  it("Phase 5: at full access the router answers for the worker, but person-only questions still go to the person", () => {
    expect(routerMayAnswer(plain, "full_access")).toBe(true);
    expect(routerMayAnswer(secret, "full_access")).toBe(false);
    expect(routerMayAnswer([...plain, ...secret], "full_access")).toBe(false);
    expect(answerRefusal(plain, ["藍"], "agent", "full_access")).toBeUndefined();
    expect(answerRefusal(secret, ["x"], "agent", "full_access")).toBeDefined();
  });
  it("text questions expire after 72 hours; questions with options never", () => {
    expect(expiresAt(plain, 1000)).toBeNull();
    expect(expiresAt([...plain, { question: "地址？", personOnly: false }], 1000)).toBe(
      1000 + TEXT_QUESTION_TTL_MS,
    );
  });
});

describe("actions and budgets", () => {
  it("counts edits, check commands and outward calls from events", () => {
    const a = actionsFrom([
      { tool: "file_edit", args: { path: "src/a.ts" }, ok: true, output: "ok" },
      { tool: "shell", args: { command: "pnpm test" }, ok: false, output: "exit code 1" },
      { tool: "browser_open", args: { url: "https://example.com/x?token=1" }, ok: true, output: "" },
    ]);
    expect(a.filesChanged).toEqual(["src/a.ts"]);
    expect(a.testsRun).toHaveLength(1);
    expect(a.pages).toEqual(["https://example.com/x"]);
    expect(changesFiles("file_write", {}, true)).toBe(true);
    expect(changesFiles("shell", { command: "sed -i s/a/b/ x.ts" }, true)).toBe(true);
    expect(changesFiles("shell", { command: "pnpm test" }, true)).toBe(false);
    expect(changesFiles("shell", { command: "ls -la" }, true)).toBe(false);
    expect(isOutwardCall({ tool: "shell", args: { command: "git push origin x" }, ok: true })).toBe(true);
    expect(isOutwardCall({ tool: "app_mail_send", args: {}, ok: true, actionClass: "send" })).toBe(true);
  });

  it("a bot and a dispatch can only lower the harness default", () => {
    expect(resolveBudget("coding", undefined, undefined, 400_000)).toMatchObject({
      maxSteps: 120,
      maxRunMs: 3_600_000,
    });
    expect(resolveBudget("general", { maxSteps: 500 }, undefined, 400_000).maxSteps).toBe(60);
    expect(resolveBudget("general", { maxSteps: 30 }, { maxSteps: 50 }, 400_000).maxSteps).toBe(30);
    expect(resolveBudget("general", { maxSteps: 30 }, { maxSteps: 10 }, 400_000).maxSteps).toBe(10);
    expect(passCap(60)).toBe(120);
  });

  it("the executor keeps results in call order and runs writes alone", async () => {
    const log: string[] = [];
    const spec = (name: string, concurrency: "shared" | "exclusive", ms: number) => ({
      name,
      concurrency,
      run: async () => {
        log.push(`start ${name}`);
        await new Promise((r) => setTimeout(r, ms));
        log.push(`end ${name}`);
        return name;
      },
    });
    const tools = new Map([
      ["r1", spec("r1", "shared", 20)],
      ["w", spec("w", "exclusive", 5)],
      ["r2", spec("r2", "shared", 1)],
    ]);
    const ex = new ToolExecutor({ tools, signal: new AbortController().signal });
    ["r1", "w", "r2"].forEach((name, index) => {
      ex.start({ id: `c${index}`, name, args: {}, index });
    });
    await ex.waitAll();
    expect(ex.resultsInOrder().map((r) => r.content)).toEqual(["r1", "w", "r2"]);
    expect(log.indexOf("end r1")).toBeLessThan(log.indexOf("start w"));
    expect(log.indexOf("end w")).toBeLessThan(log.indexOf("start r2"));
  });
});
