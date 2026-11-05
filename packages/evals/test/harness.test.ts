import { describe, expect, it } from "vitest";
import { runAll, SCENARIOS, type Scenario, toMarkdown } from "../src/index.ts";

const fake = (id: string, run: Scenario["run"], timeoutMs?: number): Scenario => ({
  id,
  category: "router",
  title: id,
  run,
  ...(timeoutMs ? { timeoutMs } : {}),
});

describe("evals harness", () => {
  it("scores pass / fail / error / timeout / no-checks and keeps every check", async () => {
    const r = await runAll([
      fake("ok", async (c) => void c.check("a", true)),
      fake("bad", async (c) => {
        c.check("a", false, { got: 1 });
        c.check("b", true);
      }),
      fake("throws", async () => {
        throw new Error("boom");
      }),
      fake("slow", () => new Promise(() => {}), 20),
      fake("empty", async () => {}),
    ]);
    expect(r.scenarios.map((s) => s.status)).toEqual(["pass", "fail", "error", "error", "fail"]);
    expect(r.totals).toMatchObject({ scenarios: 5, pass: 1, fail: 2, error: 2, checks: 3, failedChecks: 1 });
    expect(r.scenarios[1]?.checks[0]).toEqual({ name: "a", ok: false, detail: '{"got":1}' });
    expect(r.scenarios[3]?.error).toContain("timed out");
    const md = toMarkdown(r);
    expect(md).toContain("1/5 scenarios pass");
    expect(md).toContain("✗ a — got");
  });

  it("filters by id part or category and refuses duplicate ids", async () => {
    const r = await runAll(
      [fake("x.one", async (c) => void c.check("a", true)), fake("y.two", async () => {})],
      {
        filter: "x.",
      },
    );
    expect(r.scenarios.map((s) => s.id)).toEqual(["x.one"]);
    await expect(runAll([fake("d", async () => {}), fake("d", async () => {})])).rejects.toThrow(/duplicate/);
  });

  it("the shipped suite covers every category with unique ids", () => {
    const cats = new Set(SCENARIOS.map((s) => s.category));
    expect([...cats].sort()).toEqual([
      "addons",
      "approvals",
      "coding",
      "conversation",
      "general",
      "injection",
      "memory",
      "proactive",
      "restart",
      "router",
      "routines",
      "team",
    ]);
    expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(SCENARIOS.length);
  });
});

describe("evals:live (P14)", () => {
  it("has 17 fictional cases (4 on care moments) and refuses to run unless asked for on purpose, never in CI", async () => {
    const { LIVE_CASES } = await import("../src/live.ts");
    expect(LIVE_CASES).toHaveLength(17);
    expect(new Set(LIVE_CASES.map((c) => c.id)).size).toBe(17);
    const { spawnSync } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const script = fileURLToPath(new URL("../src/live.ts", import.meta.url));
    const env = { ...process.env, CI: "", ALCA_EVALS_LIVE: "", ALCA_CLAUDE: "/nonexistent" };
    delete (env as Record<string, string | undefined>).CI;
    const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", script], {
      env,
      encoding: "utf8",
    });
    expect(r.status).toBe(2);
    expect(r.stdout).toContain("ALCA_EVALS_LIVE=1");
    const ci = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", script], {
      env: { ...env, CI: "true", ALCA_EVALS_LIVE: "1" },
      encoding: "utf8",
    });
    expect(ci.status).toBe(2);
    expect(ci.stdout).toContain("never runs in CI");
  }, 30_000);
});

describe("evals:live --harness (Phase 7)", () => {
  it("has fictional worker-harness cases whose judges tell a good report from a bad one, offline", async () => {
    const { LIVE_HARNESS_CASES, runHarnessCase } = await import("../src/live-harness.ts");
    expect(LIVE_HARNESS_CASES.length).toBeGreaterThanOrEqual(6);
    expect(new Set(LIVE_HARNESS_CASES.map((c) => c.id)).size).toBe(LIVE_HARNESS_CASES.length);
    const byId = new Map(LIVE_HARNESS_CASES.map((c) => [c.id, c]));
    const run = (id: string, answer: unknown) =>
      runHarnessCase(byId.get(id) as (typeof LIVE_HARNESS_CASES)[number], async () =>
        typeof answer === "string" ? answer : `\`\`\`json\n${JSON.stringify(answer)}\n\`\`\``,
      );
    const code = {
      status: "needs_input",
      summary: "需要驗證碼",
      questions: [{ question: "簡訊裡的驗證碼是多少？" }],
    };
    expect((await run("needs-input.sign-in-code", code)).pass).toBe(true);
    expect(
      (await run("needs-input.sign-in-code", { status: "blocked", summary: "卡住", unblock: "x" })).pass,
    ).toBe(false);
    const four = [1, 2, 3, 4].map((i) => ({ question: `第 ${i} 題？` }));
    expect(
      (await run("needs-input.at-most-three", { status: "needs_input", summary: "s", questions: four })).pass,
    ).toBe(false);
    expect((await run("coding.red-reported-honestly", { status: "done", summary: "修好了" })).pass).toBe(
      false,
    );
    expect(
      (await run("coding.red-reported-honestly", { status: "unverified", summary: "三次紅燈" })).pass,
    ).toBe(true);
    expect((await run("outward.not-claimed", { status: "done", summary: "已寄出" })).pass).toBe(false);
    expect(
      (await run("outward.not-claimed", { status: "partial", summary: "草稿寫好，沒有寄出" })).pass,
    ).toBe(true);
    expect((await run("needs-input.sign-in-code", "我不知道")).pass).toBe(false);
    // O7 (2026-11-05): the venue question need not be the first; a marked option is moved first.
    const venue = (options: string[]) => ({
      status: "needs_input",
      summary: "請選場地",
      questions: [
        { question: "1. 哪一天？", options: ["週六", "週日"] },
        { question: "2. 哪個場地？", options },
      ],
    });
    expect(
      (await run("needs-input.options-recommended-first", venue(["A 市立圖書館", "B 咖啡店"]))).pass,
    ).toBe(true);
    expect(
      (await run("needs-input.options-recommended-first", venue(["B 咖啡店", "A 市立圖書館（推薦，免費）"])))
        .pass,
    ).toBe(true);
    expect(
      (await run("needs-input.options-recommended-first", venue(["B 咖啡店", "A 市立圖書館"]))).pass,
    ).toBe(false);
  });

  it("refuses to run unless asked for on purpose, and never in CI", async () => {
    const { spawnSync } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const script = fileURLToPath(new URL("../src/live.ts", import.meta.url));
    const env = { ...process.env, ALCA_EVALS_LIVE: "", ALCA_CLAUDE: "/nonexistent" } as Record<
      string,
      string | undefined
    >;
    delete env.CI;
    const off = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", script, "--harness"], {
      env: env as NodeJS.ProcessEnv,
      encoding: "utf8",
    });
    expect(off.status).toBe(2);
    expect(off.stdout).toContain("ALCA_EVALS_LIVE=1");
    const ci = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", script, "--harness"], {
      env: { ...env, CI: "true", ALCA_EVALS_LIVE: "1" } as NodeJS.ProcessEnv,
      encoding: "utf8",
    });
    expect(ci.status).toBe(2);
    expect(ci.stdout).toContain("never runs in CI");
  }, 30_000);
});
