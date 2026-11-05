import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ScriptContext, ScriptedEngine, type ScriptStep } from "@alca/engines";
import type { AlcaEvent } from "@alca/protocol";
import type { WorkerRecord } from "@alca/store";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { codingToolsFor, ownCodingLoop } from "../src/agents/harness-run/coding.ts";
import { BotWorkDirs, CodingTools, WorkspaceGuards } from "../src/index.ts";
import { call, type Harness, lastLine, makeAgents, say, until } from "./agents-helpers.ts";

/**
 * Plan §4 acceptance: the coding inner layer on the formal path — `makeAgents`
 * (router + workers + store + gate) with a scripted API engine (Alca owns the
 * tool loop). A small fictional TypeScript repo with a bug: the worker plans
 * with todo, reads, runs the tests (red), fixes the bug with edit, runs the
 * tests again (green) and reports; the host's own check (from AGENTS.md)
 * passes and the router gets a verified `done`.
 */

let h: Harness | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await h?.close();
  h = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "alca-coding-run-"));
  dirs.push(d);
  return d;
};

/** A fictional TS package: `sum` skips the first number; `node --test` finds the .ts test. */
function miniRepo(dir: string): void {
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "test"), { recursive: true });
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "mini-sum", private: true, type: "module", scripts: { test: "node --test" } }),
  );
  writeFileSync(
    join(dir, "AGENTS.md"),
    "# mini-sum\n\n這是虛構的範例專案。\n\n## Checks\n\n- `node --test`\n",
  );
  writeFileSync(
    join(dir, "src", "sum.ts"),
    "export function sum(xs: number[]): number {\n  let total = 0;\n  for (let i = 1; i < xs.length; i++) total += xs[i] as number;\n  return total;\n}\n",
  );
  writeFileSync(
    join(dir, "test", "sum.test.ts"),
    'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { sum } from "../src/sum.ts";\n\ntest("sum adds every number", () => {\n  assert.equal(sum([1, 2, 3]), 6);\n});\n',
  );
}

const routerFor =
  (args: Record<string, unknown>) =>
  ({ req, pass }: ScriptContext): ScriptStep[] => {
    if (req.userMessage.includes("<alca:worker")) return say("收到回報");
    return pass === 0
      ? call("s", "worker_start", {
          title: "修 sum",
          goal: lastLine(req.userMessage),
          harness: "coding",
          ...args,
        })
      : say("派了");
  };

type Completed = Extract<AlcaEvent, { type: "tool.completed" }>;
const completed = (events: AlcaEvent[]) => events.filter((e): e is Completed => e.type === "tool.completed");
const requested = (events: AlcaEvent[]) =>
  events.filter((e): e is Extract<AlcaEvent, { type: "tool.requested" }> => e.type === "tool.requested");
const outputOf = (e: Completed | undefined) =>
  typeof e?.data.result === "string" ? e.data.result : JSON.stringify(e?.data.result ?? e?.data.error ?? "");

/** Every event of the workers' runs (they go to `worker:<id>`, not to the thread). */
function workerEvents(x: Harness): AlcaEvent[] {
  const out: AlcaEvent[] = [];
  const bus = x.core.bus;
  const publishTo = bus.publishTo.bind(bus);
  bus.publishTo = (key, e) => {
    if (key.startsWith("worker:")) out.push(e);
    publishTo(key, e);
  };
  return out;
}

const reportTo = (threadId: string) =>
  until(
    () =>
      h?.store.threads
        .messages(threadId)
        .find((m) => m.role === "system" && m.content.includes("<alca:worker")),
    25_000,
  );

describe("coding inner layer on the formal path (scripted API engine)", () => {
  it("fix a bug in a small TS repo: todo → read → test red → edit → test green → report, verified by the host", async () => {
    const dir = tmp();
    miniRepo(dir);
    const seen: { task?: string; tools?: string[] } = {};
    const worker = ({ req, pass }: ScriptContext): ScriptStep[] => {
      if (pass === 0) {
        seen.task = req.userMessage;
        seen.tools = (req.tools ?? []).map((t) => t.name);
      }
      switch (pass) {
        case 0:
          return call("t1", "todo", {
            todos: [
              { content: "重現失敗的測試", status: "in_progress" },
              { content: "修正 sum", status: "pending" },
              { content: "測試轉綠", status: "pending" },
            ],
          });
        case 1:
          return call("r1", "read", { path: "src/sum.ts" });
        case 2:
          return call("b1", "bash", { command: "node --test" });
        case 3:
          return call("e1", "edit", {
            path: "src/sum.ts",
            edits: [{ old: "let i = 1; i < xs.length", new: "let i = 0; i < xs.length" }],
          });
        case 4:
          return call("b2", "bash", { command: "node --test" });
        case 5:
          return call("rep", "report_result", {
            status: "done",
            summary: "sum 從索引 1 開始加，漏了第一個數；改成從 0 開始，node --test 全綠。",
            changes: ["src/sum.ts"],
            claims: [{ text: "測試通過", evidenceRef: "b2" }],
          });
        default:
          return say("完成");
      }
    };
    h = makeAgents({ router: routerFor({}), worker, level: "autonomous", system: { workDir: () => dir } });
    const events = workerEvents(h);
    const t = h.core.createThread();
    await h.core.send(t.id, "src/sum.ts 的 sum 算錯了，請修好並讓測試通過").done;
    const msg = await reportTo(t.id);

    // The worker got the coding tools and the project's AGENTS.md (from the repo root).
    expect(seen.tools).toEqual(
      expect.arrayContaining(["read", "edit", "write", "apply_patch", "grep", "glob", "bash", "todo"]),
    );
    expect(seen.task).toContain("這是虛構的範例專案");

    // Red, then green, as structured results (a red test is not a tool error).
    // The host renames call ids: find the calls by tool.
    const byTool = (tool: string) => requested(events).filter((e) => e.data.tool === tool);
    const bashIds = byTool("bash").map((e) => e.data.callId);
    const runs = completed(events).filter((e) => bashIds.includes(e.data.callId));
    expect(runs.map((e) => e.data.ok)).toEqual([true, true]);
    expect(outputOf(runs[0])).toContain("exit_code: 1");
    expect(outputOf(runs[1])).toContain("exit_code: 0");
    // `node --test` is a development command: no "cannot read" card under 自主.
    expect(h.events.some((e) => e.type === "approval.requested")).toBe(false);
    expect(byTool("edit")[0]?.data.actionClass).toBe("write");
    // The gate's class stays the tool's declared `execute` (an inspection only ever escalates);
    // the command is a development command, so no shell-floor card (policy: classified `write`).
    expect(byTool("bash").map((e) => e.data.actionClass)).toEqual(["execute", "execute"]);
    expect(byTool("todo")).toHaveLength(1);

    expect(readFileSync(join(dir, "src", "sum.ts"), "utf8")).toContain("let i = 0;");
    const w = h.store.workers.byThread(t.id)[0] as WorkerRecord;
    expect(w.status).toBe("succeeded");
    const row = h.store.dispatches.get(w.grants.dispatchId ?? "");
    expect(row).toMatchObject({ status: "settled", outcome: "done" });
    expect((row?.report as { verified?: boolean } | undefined)?.verified).toBe(true);
    expect(msg?.content).toContain('ok="true"');
    expect(msg?.content).toContain("node --test（結束碼 1）；node --test（結束碼 0）");
    expect(msg?.content).toContain("通過");
  }, 40_000);

  it("ownsPaths: a write outside the assigned paths asks first, even under 自主; inside it does not", async () => {
    const dir = tmp();
    const data = tmp();
    mkdirSync(join(dir, "src"), { recursive: true });
    const worker = ({ pass }: ScriptContext): ScriptStep[] => {
      if (pass === 0) return call("w1", "write", { path: "README.md", content: "不在指派範圍\n" });
      if (pass === 1)
        return call("w2", "write", { path: "src/inside.ts", content: "export const ok = 1;\n" });
      if (pass === 2) return call("rep", "report_result", { status: "done", summary: "寫好了" });
      return say("完成");
    };
    h = makeAgents({
      router: routerFor({ ownsPaths: ["src"], checks: ["true"] }),
      worker,
      level: "autonomous",
    });
    const store = h.store;
    h.core.useGuards(
      new WorkspaceGuards({ store, workDirs: new BotWorkDirs({ dataDir: data, store, defaultDir: dir }) }),
    );
    const t = h.core.createThread();
    await h.core.send(t.id, "在 src 底下加一個檔案").done;
    const card = await until(
      () =>
        h?.events.find(
          (e): e is Extract<AlcaEvent, { type: "approval.requested" }> => e.type === "approval.requested",
        ),
      15_000,
    );
    expect(card.data.summary).toMatch(/ownsPaths/);
    expect(card.data.summary).toContain("README.md");
    h.core.answerApproval(card.data.approvalId, "denied");
    await reportTo(t.id);
    expect(() => readFileSync(join(dir, "README.md"))).toThrow();
    expect(readFileSync(join(dir, "src", "inside.ts"), "utf8")).toContain("ok = 1");
    expect(h.events.filter((e) => e.type === "approval.requested")).toHaveLength(1);
  }, 40_000);

  it("before a compaction the todo list is flushed into the handover", async () => {
    const dir = tmp();
    let handover = "";
    const worker = ({ req, pass }: ScriptContext): ScriptStep[] => {
      if (req.userMessage.includes("<alca:handover>")) {
        if (pass === 0) {
          handover = req.userMessage;
          return call("rep", "report_result", { status: "done", summary: "接著做完了" });
        }
        return say("完成");
      }
      if (!req.tools?.length) return say("## 1. 目標\n修 sum\n## 2. 進度\n做了一半");
      if (pass === 0)
        return [
          { type: "usage", inputTokens: 18_000, outputTokens: 10 },
          ...call("t1", "todo", {
            todos: [
              { content: "讀程式", status: "completed" },
              { content: "修正", status: "in_progress" },
            ],
          }),
        ];
      return say("還在做");
    };
    h = makeAgents({
      router: routerFor({}),
      worker,
      level: "autonomous",
      system: {
        workDir: () => dir,
        workerEngine: new ScriptedEngine(worker, {
          id: "worker",
          capabilities: { maxContextTokens: 20_000 },
        }),
      },
    });
    const t = h.core.createThread();
    await h.core.send(t.id, "修 sum").done;
    await reportTo(t.id);
    expect(handover).toContain("壓縮前的待辦清單（todo）");
    expect(handover).toContain("[>] 修正");
    expect(handover).toContain("[x] 讀程式");
  }, 40_000);
});

describe("which engines get the coding tools", () => {
  const w = { id: "wkr_x", grants: { harness: "coding" } } as unknown as WorkerRecord;
  const engine = (ownsToolLoop: boolean) =>
    new ScriptedEngine([], { id: "e", capabilities: { ownsToolLoop } });
  const tools = new CodingTools({ dirFor: () => "/nowhere" });
  afterAll(() => tools.closeAll());

  it("an API engine (Alca's loop) on a coding dispatch gets them; a CLI keeps its own", () => {
    expect(ownCodingLoop(w, engine(false))).toBe(true);
    expect(codingToolsFor(tools, w, engine(false), () => undefined).map((t) => t.spec.name)).toContain(
      "bash",
    );
    expect(codingToolsFor(tools, w, engine(true), () => undefined)).toEqual([]);
    const general = { ...w, grants: { harness: "general" } } as unknown as WorkerRecord;
    expect(codingToolsFor(tools, general, engine(false), () => undefined)).toEqual([]);
  });
});
