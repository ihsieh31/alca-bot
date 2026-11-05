import type { ScriptContext } from "@alca/engines";
import { WorkerState } from "@alca/protocol";
import { openStore, type WorkerRecord } from "@alca/store";
import { afterEach, describe, expect, it } from "vitest";
import { WorkerLedger } from "../src/agents/harness-run/ledger.ts";
import { harnessView } from "../src/agents/harness-run/view.ts";
import { call, type Harness, lastLine, makeAgents, say, until } from "./agents-helpers.ts";
import { tool } from "./helpers.ts";

/**
 * Phase 6: the harness part of a worker's state that the worker panels show
 * (phase, verification, budget, questions, reviewer gaps, 完全授權 log),
 * read only from the store. Fictional data only.
 */

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

/** A store with one bot, thread, job, dispatch and harness worker. */
function bench(kind: "coding" | "general" = "coding") {
  const store = openStore(":memory:");
  const bot = store.bots.ensureDefault();
  const t = store.threads.create("thr_01M6FS56CMD82Z8TY2D17VNKX0", "t", new Date(), bot.id);
  store.db
    .prepare("INSERT INTO jobs (id, kind, created_at, updated_at) VALUES ('j1','subagent','x','x')")
    .run();
  const d = store.dispatches.open({ botId: bot.id, threadId: t.id, harness: kind, level: "autonomous" });
  const w = store.workers.create({
    botId: bot.id,
    threadId: t.id,
    jobId: "j1",
    title: "修測試",
    goal: "讓測試通過",
    initiator: { kind: "user", id: "me" },
    budget: { maxSteps: 40, maxRunMs: 600_000, maxTokens: 90_000 },
    grants: { harness: kind, dispatchId: d.id, doneWhen: "pnpm test 全綠", checks: ["pnpm test"] },
  });
  const ledger = new WorkerLedger(store, () => new Date(10_000));
  const token = `${w.id}:a1`;
  store.dispatches.begin(d.id, w.id, token);
  const get = () => store.workers.get(w.id) as WorkerRecord;
  return { store, w, d, ledger, token, get };
}

describe("harnessView (Phase 6)", () => {
  it("a plain worker has no harness part", () => {
    const b = bench();
    const plain = { ...b.get(), grants: {} };
    expect(harnessView(b.store, plain, undefined)).toBeUndefined();
  });

  it("shows the kind, doneWhen and the budget against its caps", () => {
    const b = bench("general");
    b.store.workers.setStatus(b.w.id, "running");
    const v = harnessView(b.store, b.get(), undefined);
    expect(v).toMatchObject({
      kind: "general",
      phase: "running",
      dispatchId: b.d.id,
      doneWhen: "pnpm test 全綠",
      budget: { steps: 0, maxSteps: 40, tokens: 0, maxTokens: 90_000, maxRunMs: 600_000, waitedMs: 0 },
    });
    expect(v?.verification).toBeUndefined();
  });

  it("a verification round in progress is 驗證中; its result shows each check red or green", () => {
    const b = bench();
    b.store.workers.setStatus(b.w.id, "running");
    b.ledger.verifying(b.get(), b.token, 1);
    let v = harnessView(b.store, b.get(), undefined);
    expect(v?.phase).toBe("verifying");
    expect(v?.verification).toMatchObject({ state: "running", round: 1, checks: [] });
    b.ledger.verified(b.get(), b.token, 1, false, [
      { command: "pnpm lint", exitCode: 0, output: "ok" },
      { command: "pnpm test", exitCode: 1, output: `${"x".repeat(900)}\n1 failed` },
    ]);
    v = harnessView(b.store, b.get(), undefined);
    expect(v?.phase).toBe("running");
    expect(v?.verification?.state).toBe("failed");
    expect(v?.verification?.checks.map((c) => [c.command, c.ok])).toEqual([
      ["pnpm lint", true],
      ["pnpm test", false],
    ]);
    // the end of the output is kept (where the error usually is), cut short
    const red = v?.verification?.checks[1]?.summary ?? "";
    expect(red.endsWith("1 failed")).toBe(true);
    expect(red.length).toBeLessThanOrEqual(401);
    b.ledger.verifying(b.get(), b.token, 2);
    b.ledger.verified(b.get(), b.token, 2, true, [{ command: "pnpm test", exitCode: 0, output: "ok" }]);
    expect(harnessView(b.store, b.get(), undefined)?.verification).toMatchObject({
      state: "passed",
      round: 2,
    });
  });

  it("a stopped check (no exit code) is never green", () => {
    const b = bench();
    b.ledger.verifying(b.get(), b.token, 1);
    b.ledger.verified(b.get(), b.token, 1, false, [{ command: "pnpm test", exitCode: null, output: "" }]);
    expect(harnessView(b.store, b.get(), undefined)?.verification?.checks[0]).toMatchObject({
      exitCode: null,
      ok: false,
    });
  });

  it("another worker's verification on the same dispatch is not this worker's", () => {
    const b = bench();
    b.ledger.verifying({ ...b.get(), id: "wkr_other" }, "wkr_other:z", 1);
    b.store.workers.setStatus(b.w.id, "running");
    expect(harnessView(b.store, b.get(), undefined)?.phase).toBe("running");
  });

  it("the settled outcome and the reviewer's gaps", () => {
    const b = bench();
    const result = {
      workerId: b.w.id,
      report: { status: "unverified" as const, summary: "改好了", changes: [], claims: [] },
      actions: {
        filesChanged: [],
        commands: [],
        pages: [],
        connector: [],
        testsRun: [],
        toolCalls: 0,
        okToolCalls: 0,
        errors: [],
        outward: [],
      },
      review: { met: false, gaps: ["沒有處理空字串"] },
    };
    b.store.dispatches.settle(b.d.id, b.token, "unverified", result, 20_000);
    b.store.workers.finish(b.w.id, "succeeded", new Date(20_000));
    const v = harnessView(b.store, b.get(), result);
    expect(v?.phase).toBe("unverified");
    expect(v?.gaps).toEqual(["沒有處理空字串"]);
  });

  it("calls that ran only at 完全授權 are listed for the worker whose run made them", () => {
    const b = bench();
    b.store.db
      .prepare(
        "INSERT INTO runs (id, thread_id, initiator_kind, initiator_id, started_at, worker_id) SELECT 'run_a', thread_id, 'user', 'me', 'x', id FROM workers WHERE id = ?",
      )
      .run(b.w.id);
    b.store.dispatches.event(b.d.id, "auto_allowed", 30_000, {
      detail: { reason: "full_access", tool: "bash", runId: "run_a", summary: "git push origin main" },
    });
    b.store.dispatches.event(b.d.id, "auto_allowed", 31_000, {
      detail: { reason: "full_access", tool: "bash", runId: "run_someone_else", summary: "rm x" },
    });
    expect(harnessView(b.store, b.get(), undefined)?.autoAllowed).toEqual([
      { at: new Date(30_000).toISOString(), tool: "bash", summary: "git push origin main" },
    ]);
  });
});

/** A general worker that asks one question and ends; its continuation reports done. */
const asker = ({ req, pass }: ScriptContext) => {
  if (req.userMessage.includes("回答（"))
    return pass === 0 ? call("d", "report_result", { status: "done", summary: "寄出了" }) : say("完成");
  if (pass === 0)
    return call("q", "report_result", {
      status: "needs_input",
      summary: "要先確定一件事",
      questions: [{ question: "寄平信還是掛號？", options: ["掛號", "平信"] }],
    });
  return say("等回答");
};

describe("answering a NEEDS_INPUT from the panel (Phase 6)", () => {
  it("the asking worker shows its questions; the person's answer starts the continuation", async () => {
    h = makeAgents({
      router: ({ req, pass }) => {
        if (req.userMessage.includes("<alca:worker")) return say("收到回報");
        return pass === 0
          ? call("s", "worker_start", {
              title: "寄卡片",
              goal: lastLine(req.userMessage),
              harness: "general",
              doneWhen: "卡片寄出",
            })
          : say("派了");
      },
      worker: asker,
      tools: [tool("note_step", "read")],
      level: "confirm_each_step",
    });
    const t = h.core.createThread();
    await h.core.send(t.id, "寄一張卡片").done;
    const first = await until(() => {
      const w = h?.store.workers.byThread(t.id)[0];
      return w && h?.store.dispatches.waitOf(w.id)?.state === "open" ? w : undefined;
    });
    const before = h.agents.workerStates(t.id)[0];
    expect(WorkerState.safeParse(before).success).toBe(true);
    expect(before?.harness).toMatchObject({
      kind: "general",
      phase: "waiting_input",
      doneWhen: "卡片寄出",
      questions: [{ question: "寄平信還是掛號？", options: ["掛號", "平信"], personOnly: false }],
    });
    // a question with options never expires
    expect(before?.harness?.questionsExpireAt).toBeUndefined();
    expect(() => h?.agents.answerWorker(first.id, [])).toThrow(/要回答 1 題/);
    const next = h.agents.answerWorker(first.id, ["掛號"]);
    expect(next.workerId).not.toBe(first.id);
    const after = h.agents.workerStates(t.id).find((w) => w.workerId === first.id);
    expect(after?.harness?.phase).toBe("continued");
    expect(after?.harness?.questions).toBeUndefined();
    expect(() => h?.agents.answerWorker(first.id, ["平信"])).toThrow(/已經回答過/);
    await until(() => h?.store.workers.get(next.workerId)?.status === "succeeded");
    const done = h.agents.workerStates(t.id).find((w) => w.workerId === next.workerId);
    expect(done?.harness?.phase).toBe("done");
    expect(WorkerState.safeParse(done).success).toBe(true);
  }, 30_000);
});
