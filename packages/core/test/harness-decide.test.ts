import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  checkCommands,
  checksFromInstructions,
  type DecideState,
  decideNext,
  freshRetryBudget,
  MAX_VERIFY_ROUNDS,
  ruleAwait,
  ruleBudget,
  ruleFollowUp,
  ruleOverflow,
  ruleRemind,
  ruleRetry,
  ruleStop,
  ruleVerify,
  runChecks,
  verifyStale,
} from "../src/index.ts";

const base = (over: Partial<DecideState> = {}): DecideState => ({
  harness: "coding",
  stopping: false,
  awaiting: false,
  finish: { reason: "completed" },
  ownsToolLoop: false,
  retry: freshRetryBudget(),
  overflowCompacted: false,
  budgetHit: false,
  budgetPass: false,
  report: "done",
  handedOff: false,
  verifyStale: false,
  verifyRounds: 0,
  checksAvailable: true,
  inbox: 0,
  reminders: 0,
  ...over,
});

const failed = (message: string): NonNullable<DecideState["finish"]> => ({
  reason: "failed",
  error: { code: "engine.error", message },
});

describe("decideNext: one rule each, in the plan's order", () => {
  it("1. a stop ends the run before anything else", () => {
    expect(ruleStop(base({ stopping: true }))).toEqual({ kind: "end", why: "stopped" });
    expect(decideNext(base({ stopping: true, inbox: 3, verifyStale: true }))).toEqual({
      kind: "end",
      why: "stopped",
    });
    expect(ruleStop(base())).toBeUndefined();
  });

  it("2. an event wait ends the turn", () => {
    expect(ruleAwait(base({ awaiting: true }))).toEqual({ kind: "end", why: "awaiting" });
  });

  it("3. an overflow compacts once (API engines only)", () => {
    const s = base({ finish: failed("prompt is too long: maximum context length exceeded") });
    expect(ruleOverflow(s)).toEqual({ kind: "compact" });
    expect(ruleOverflow({ ...s, overflowCompacted: true })).toBeUndefined();
    expect(ruleOverflow({ ...s, ownsToolLoop: true })).toBeUndefined();
    const { harness: _k, ...plain } = s;
    expect(ruleOverflow(plain)).toBeUndefined();
  });

  it("4. a retryable CLI failure retries; API engines already retried in infer", () => {
    const s = base({ ownsToolLoop: true, finish: failed("HTTP 503 overloaded") });
    expect(ruleRetry(s)).toEqual({ kind: "retry" });
    expect(ruleRetry({ ...s, retry: { retries: 4, timeouts: 0 } })).toBeUndefined();
    expect(ruleRetry({ ...s, ownsToolLoop: false })).toBeUndefined();
    expect(ruleRetry({ ...s, finish: failed("HTTP 401 unauthorized") })).toBeUndefined();
  });

  it("5. budget spent without a report → one report-only pass, then the end", () => {
    const s = base({ budgetHit: true, finish: { reason: "interrupted" } });
    const { report: _r, ...noReport } = s;
    expect(ruleBudget(noReport)).toEqual({ kind: "budgetReport" });
    expect(ruleBudget({ ...noReport, budgetPass: true })).toEqual({ kind: "end", why: "budget" });
    expect(ruleBudget(s)).toEqual({ kind: "end", why: "done" });
    expect(ruleBudget({ ...s, verifyStale: true })).toEqual({ kind: "end", why: "unverified" });
    const { report: _x, ...capped } = base({ finish: { reason: "max_turns" } });
    expect(ruleBudget(capped)).toEqual({ kind: "budgetReport" });
    // N4 (Mac device test 2026-11-05): no tokens left → no report-only pass, the worker ends on its budget
    expect(ruleBudget({ ...noReport, tokensSpent: true })).toEqual({ kind: "end", why: "budget" });
    expect(ruleBudget({ ...s, tokensSpent: true })).toEqual({ kind: "end", why: "done" });
  });

  it("6. coding with a stale or red check verifies, at most 3 rounds", () => {
    const s = base({ verifyStale: true });
    expect(ruleVerify(s)).toEqual({ kind: "verify" });
    expect(ruleVerify({ ...s, verifyRounds: MAX_VERIFY_ROUNDS })).toBeUndefined();
    expect(ruleVerify({ ...s, harness: "general" })).toBeUndefined();
    expect(ruleVerify({ ...s, report: "needs_input" })).toBeUndefined();
    expect(ruleVerify({ ...s, checksAvailable: false })).toBeUndefined();
    expect(ruleVerify(base())).toBeUndefined();
    // after the rounds are spent the report stands, as unverified
    expect(decideNext({ ...s, verifyRounds: MAX_VERIFY_ROUNDS })).toEqual({ kind: "end", why: "unverified" });
  });

  it("7. stream events waiting → follow up", () => {
    expect(ruleFollowUp(base({ inbox: 2 }))).toEqual({ kind: "followUp" });
    expect(ruleFollowUp(base({ inbox: 2, finish: failed("x") }))).toBeUndefined();
  });

  it("8. no report → remind at most twice", () => {
    const { report: _r, ...s } = base();
    expect(ruleRemind(s)).toEqual({ kind: "remind" });
    expect(ruleRemind({ ...s, reminders: 2 })).toBeUndefined();
    expect(decideNext({ ...s, reminders: 2 })).toEqual({ kind: "end", why: "done" });
    expect(ruleRemind({ ...s, handedOff: true })).toBeUndefined();
  });

  it("9. otherwise the end; a plain worker skips every harness rule", () => {
    expect(decideNext(base())).toEqual({ kind: "end", why: "done" });
    const { harness: _h, report: _r, ...plain } = base({ verifyStale: true });
    expect(decideNext(plain)).toEqual({ kind: "end", why: "done" });
    expect(decideNext({ ...plain, finish: failed("boom") })).toEqual({ kind: "end", why: "failed" });
    expect(decideNext(base({ handedOff: true }))).toEqual({ kind: "end", why: "handoff" });
  });
});

describe("verification", () => {
  it("is stale when the last change came after the last passing check", () => {
    expect(verifyStale(0, undefined)).toBe(false);
    expect(verifyStale(3, undefined)).toBe(true);
    expect(verifyStale(3, 5)).toBe(false);
    expect(verifyStale(6, 5)).toBe(true);
  });

  it("reads check commands from AGENTS.md sections and check: lines", () => {
    const md = [
      "# 專案",
      "說明 `pnpm dev` 不是檢查",
      "## 檢查",
      "改完一定要跑 `pnpm typecheck` 與 `pnpm test`。",
      "```sh",
      "pnpm lint",
      "```",
      "## 其他",
      "- check: `cargo test`",
    ].join("\n");
    expect(checksFromInstructions(md)).toEqual(["pnpm typecheck", "pnpm test", "pnpm lint", "cargo test"]);
  });

  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("takes the sources in order: dispatch checks, AGENTS.md, project files", () => {
    const dir = mkdtempSync(join(tmpdir(), "alca-verify-"));
    dirs.push(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest", lint: "biome" } }));
    writeFileSync(join(dir, "pnpm-lock.yaml"), "");
    expect(checkCommands(undefined, dir)).toEqual(["pnpm lint", "pnpm test"]);
    writeFileSync(join(dir, "AGENTS.md"), "## Checks\n`pnpm check`\n");
    expect(checkCommands(undefined, dir)).toEqual(["pnpm check"]);
    expect(checkCommands(["make verify"], dir)).toEqual(["make verify"]);
    mkdirSync(join(dir, "go"));
    writeFileSync(join(dir, "go", "go.mod"), "module x");
    expect(checkCommands(undefined, join(dir, "go"))).toEqual(["go test ./..."]);
    expect(checkCommands(undefined, undefined)).toEqual([]);
  });

  it("runs the checks in the folder, stops at the first red one and can be stopped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alca-verify-"));
    dirs.push(dir);
    const green = await runChecks(['node -e "console.log(1)"'], dir);
    expect(green.ok).toBe(true);
    const red = await runChecks(["node -e \"console.error('boom'); process.exit(3)\"", 'node -e "1"'], dir);
    expect(red.ok).toBe(false);
    expect(red.results).toHaveLength(1);
    expect(red.feedback).toContain("boom");
    expect(red.feedback).toContain("[exit 3]");
    const c = new AbortController();
    const slow = runChecks(['node -e "setTimeout(() => {}, 60000)"'], dir, c.signal);
    setTimeout(() => c.abort(), 100);
    const r = await slow;
    expect(r.ok).toBe(false);
    expect(r.results[0]?.exitCode).toBeNull();
  }, 20_000);
});
