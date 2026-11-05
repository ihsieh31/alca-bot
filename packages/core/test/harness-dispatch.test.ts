import { HARNESS_MATRIX, type ScriptContext, ScriptedEngine, type ScriptStep } from "@alca/engines";
import { afterEach, describe, expect, it } from "vitest";
import { routerProfile } from "../src/agents/router.ts";
import { guessHarness, HARNESS_CHOICE_RULES, readHarnessDispatch } from "../src/harness/dispatch.ts";
import { parseBotHarness } from "../src/harness/kinds.ts";
import { buildStablePrompt } from "../src/prompt.ts";
import { call, type Harness, lastLine, makeAgents, say, until } from "./agents-helpers.ts";

/**
 * Phase 5 (plan §6): the router's `worker_start` — harness optional; default
 * order bot setting → heuristic → general; the host's capability check; the
 * choice rules in both languages, byte-stable. Made-up tasks only.
 */
describe("choosing the harness of a dispatch", () => {
  it("named by the router: taken as is; a third kind is refused", () => {
    expect(readHarnessDispatch({ harness: "coding", goal: "比價" })).toMatchObject({
      harness: "coding",
      source: "router",
      defaulted: false,
    });
    expect(() => readHarnessDispatch({ harness: "browser" })).toThrow(/coding.*general/);
  });

  it("unnamed: the bot's default wins over the heuristic", () => {
    expect(readHarnessDispatch({ goal: "修好 parser 的測試" }, { botDefault: "general" })).toMatchObject({
      harness: "general",
      source: "bot",
      defaulted: true,
    });
    expect(readHarnessDispatch({ goal: "查天氣" }, { botDefault: "coding" }).harness).toBe("coding");
  });

  it("unnamed, no bot default: a workdir or a code-ish goal → coding, else general", () => {
    expect(readHarnessDispatch({ goal: "整理", workdir: "pkg" })).toMatchObject({
      harness: "coding",
      source: "heuristic",
      workdir: "pkg",
    });
    expect(readHarnessDispatch({ goal: "修好 src/parser.ts 的 bug" }).source).toBe("heuristic");
    expect(readHarnessDispatch({ goal: "幫我比價三家飯店" })).toMatchObject({
      harness: "general",
      source: "default",
    });
    for (const g of [
      "跑測試看哪裡壞了",
      "fix the failing test in the repo",
      "重構這個函式",
      "build the project",
    ])
      expect(guessHarness(g, undefined), g).toBe("coding");
    for (const g of ["整理會議記錄", "查明天天氣再擬一封信", "draft an email to the landlord"])
      expect(guessHarness(g, undefined), g).toBe("general");
  });

  it("a goal about a connected app or MCP server → general, even about files (BUG-3)", () => {
    for (const g of [
      "用我連接的 MCP 檔案伺服器讀 note.txt，再用 write_file 建 new.txt",
      "use my connected MCP file server to read note.txt",
      "用已連接的 GitHub 帳號看 repo 的 issue",
    ])
      expect(guessHarness(g, undefined), g).toBe("general");
    expect(readHarnessDispatch({ goal: "用 MCP 讀檔案" })).toMatchObject({
      harness: "general",
      source: "default",
    });
    expect(guessHarness("用 MCP 讀檔案", "pkg")).toBe("coding"); // a workdir still means coding
  });

  it("coding-only fields are dropped for general; budget and handoffFrom are kept", () => {
    const d = readHarnessDispatch({
      harness: "general",
      workdir: "x",
      ownsPaths: ["src"],
      checks: ["pnpm test"],
      budget: { maxSteps: 5 },
      handoffFrom: "wkr_1",
      doneWhen: "表格做好",
    });
    expect(d).toMatchObject({ budget: { maxSteps: 5 }, handoffFrom: "wkr_1", doneWhen: "表格做好" });
    expect(d).not.toHaveProperty("workdir");
    expect(d).not.toHaveProperty("ownsPaths");
    expect(d).not.toHaveProperty("checks");
  });

  it("the bot's default harness is read from its settings; anything else is dropped", () => {
    expect(parseBotHarness({ default: "coding" }).default).toBe("coding");
    expect(parseBotHarness({ default: "browser" }).default).toBeUndefined();
  });
});

describe("HARNESS_CHOICE_RULES", () => {
  it("one copy per language, in the router's stable layer, byte-stable", () => {
    const zh = buildStablePrompt(routerProfile(), ["worker_start"]);
    const en = buildStablePrompt({ ...routerProfile(), language: "en" }, ["worker_start"]);
    for (const line of HARNESS_CHOICE_RULES.zh) expect(zh).toContain(line);
    for (const line of HARNESS_CHOICE_RULES.en) expect(en).toContain(line);
    expect(zh).not.toContain(HARNESS_CHOICE_RULES.en[0]);
    expect(en).not.toContain(HARNESS_CHOICE_RULES.zh[0]);
    expect(HARNESS_CHOICE_RULES.zh).toHaveLength(HARNESS_CHOICE_RULES.en.length);
    expect(buildStablePrompt(routerProfile(), ["worker_start"])).toBe(zh);
    expect(Object.isFrozen(HARNESS_CHOICE_RULES.zh)).toBe(true);
  });
});

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const routerWith =
  (args: Record<string, unknown>, out: string[]) =>
  ({ req, pass }: ScriptContext): ScriptStep[] => {
    if (req.userMessage.includes("<alca:worker")) return say("收到");
    if (pass === 0)
      return call("s", "worker_start", { title: "工作", goal: lastLine(req.userMessage), ...args });
    for (const r of req.toolResults ?? []) out.push(r.output);
    return say("好");
  };

const doneWorker = ({ pass }: ScriptContext): ScriptStep[] =>
  pass === 0 ? call("r", "report_result", { status: "done", summary: "好了" }) : say("結束");

describe("worker_start on the formal path", () => {
  it("an unnamed general task runs under the general harness; worker_answer stays a router tool", async () => {
    const out: string[] = [];
    h = makeAgents({ router: routerWith({}, out), worker: doneWorker });
    const t = h.core.createThread();
    await h.core.send(t.id, "幫我比價三家飯店").done;
    const w = await until(() => h?.store.workers.byThread(t.id)[0]);
    expect(w.grants.harness).toBe("general");
    expect(h.store.dispatches.get(w.grants.dispatchId ?? "")?.harness).toBe("general");
    expect(out.join("\n")).toContain("harness：general");
    expect(h.agents.router.tools().map((x) => x.spec.name)).toContain("worker_answer");
  });

  it("the bot's own default applies when the router names none", async () => {
    const out: string[] = [];
    h = makeAgents({ router: routerWith({ checks: ["true"] }, out), worker: doneWorker });
    const bot = h.store.bots.default();
    h.store.bots.update(bot?.id as string, { harness: JSON.stringify({ default: "coding" }) });
    const t = h.core.createThread();
    await h.core.send(t.id, "整理一下").done;
    const w = await until(() => h?.store.workers.byThread(t.id)[0]);
    expect(w.grants.harness).toBe("coding");
  });

  it("a guessed coding task on an engine that cannot code falls back to general; a named one is refused", async () => {
    const unfit = new ScriptedEngine(() => say("x"), {
      id: "ro",
      capabilities: { harness: HARNESS_MATRIX.acpAtLevel },
    });
    const out: string[] = [];
    h = makeAgents({
      router: routerWith({}, out),
      worker: doneWorker,
      system: { workerHarnessEngines: { coding: unfit } },
    });
    const t = h.core.createThread();
    await h.core.send(t.id, "修好 src/parser.ts 的 bug").done;
    const w = await until(() => h?.store.workers.byThread(t.id)[0]);
    expect(w.grants.harness).toBe("general");
    expect(out.join("\n")).toContain("不能做 coding 工作，改用 general");

    await h.close();
    const named: string[] = [];
    h = makeAgents({
      router: routerWith({ harness: "coding" }, named),
      worker: doneWorker,
      system: { workerHarnessEngines: { coding: unfit } },
    });
    const t2 = h.core.createThread();
    await h.core.send(t2.id, "修好 src/parser.ts 的 bug").done;
    expect(h.store.workers.byThread(t2.id)).toHaveLength(0);
    const refused = h.events.find((e) => e.type === "tool.completed" && !e.data.ok);
    expect(refused?.type === "tool.completed" && String(refused.data.error)).toContain("不能做 coding 工作");
  });

  it("budget from worker_start can only tighten the bot's cap", async () => {
    h = makeAgents({
      router: routerWith({ budget: { maxSteps: 9999, maxWallSec: 30 } }, []),
      worker: doneWorker,
    });
    const t = h.core.createThread();
    await h.core.send(t.id, "比價").done;
    const w = await until(() => h?.store.workers.byThread(t.id)[0]);
    expect(w.budget.maxSteps).toBe(60); // the general default; 9999 cannot raise it
    expect(w.budget.maxRunMs).toBe(30_000);
  });
});
