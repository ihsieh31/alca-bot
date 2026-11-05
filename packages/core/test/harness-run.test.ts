import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScriptContext } from "@alca/engines";
import { openStore, type WorkerRecord } from "@alca/store";
import { afterEach, describe, expect, it } from "vitest";
import type { HostTool } from "../src/index.ts";
import { call, type Harness, lastLine, makeAgents, say, until } from "./agents-helpers.ts";
import { tool } from "./helpers.ts";

/**
 * Plan §2.10: the outer loop on the real path — `makeAgents` (router +
 * workers + store) with ScriptedEngine workers. Fictional tasks and data only.
 */

let h: Harness | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await h?.close();
  h = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "alca-harness-"));
  dirs.push(d);
  return d;
};

const workerIdIn = (s: string) => /<alca:worker id="(wkr_[^"]+)"/.exec(s)?.[1] ?? "";

/** The router dispatches the person's message to a harness; on a report it says so. */
const routerFor =
  (args: (text: string) => Record<string, unknown>) =>
  ({ req, pass }: ScriptContext) => {
    if (req.userMessage.includes("<alca:worker")) return say("收到回報");
    return pass === 0
      ? call("s", "worker_start", {
          title: "工作",
          goal: lastLine(req.userMessage),
          ...args(lastLine(req.userMessage)),
        })
      : say("派了");
  };

const fileEdit = (dir: string): HostTool & { calls: Record<string, unknown>[] } =>
  tool("file_edit", "write", (a) => {
    writeFileSync(join(dir, String(a.path)), String(a.content));
    return "已修改";
  });

const CHECK = `node -e "process.exit(require('fs').readFileSync('state.txt','utf8').trim()==='fixed'?0:1)"`;

/** A coding worker: edit, report done; after a red check it edits again (fixing it or not). */
const coder = (fixes: boolean) => {
  const reds = new Map<string, boolean>();
  return ({ req, pass }: ScriptContext) => {
    if (pass === 0) reds.set(req.runId, req.userMessage.includes("沒有通過"));
    const red = reds.get(req.runId) ?? false;
    if (pass === 0)
      return call("e", "file_edit", { path: "state.txt", content: red && fixes ? "fixed" : "broken" });
    if (pass === 1) return call("r", "report_result", { status: "done", summary: red ? "修好了" : "改好了" });
    return say("完成");
  };
};

const dispatchOf = (w: WorkerRecord | undefined) => {
  const id = w?.grants.dispatchId ?? "";
  return { row: h?.store.dispatches.get(id), events: h?.store.dispatches.events(id) ?? [] };
};

const reportTo = (threadId: string, needle: string) =>
  until(() =>
    h?.store.threads
      .messages(threadId)
      .find((m) => m.role === "system" && m.content.includes("<alca:worker") && m.content.includes(needle)),
  );

describe("收工驗證 on the real path", () => {
  it("edit → check red → fix → green → done", async () => {
    const dir = tmp();
    const edit = fileEdit(dir);
    h = makeAgents({
      router: routerFor(() => ({ harness: "coding", checks: [CHECK] })),
      worker: coder(true),
      tools: [edit],
      level: "autonomous",
      system: { workDir: () => dir },
    });
    const t = h.core.createThread();
    await h.core.send(t.id, "修好 state").done;
    const msg = await reportTo(t.id, "收工驗證");
    const w = h.store.workers.byThread(t.id)[0];
    expect(w?.status).toBe("succeeded");
    expect(edit.calls.map((c) => c.content)).toEqual(["broken", "fixed"]);
    const { row, events } = dispatchOf(w);
    expect(row).toMatchObject({ status: "settled", outcome: "done" });
    expect((row?.report as { verified?: boolean } | undefined)?.verified).toBe(true);
    expect(msg?.content).toContain('ok="true"');
    expect(msg?.content).toContain("通過");
    expect(events.filter((e) => e.kind === "turn.completed")).toHaveLength(2);
    expect(events.filter((e) => e.kind === "reported")).toHaveLength(1);
  }, 30_000);

  it("three red checks in a row → unverified, told honestly", async () => {
    const dir = tmp();
    h = makeAgents({
      router: routerFor(() => ({ harness: "coding", checks: [CHECK] })),
      worker: coder(false),
      tools: [fileEdit(dir)],
      level: "autonomous",
      system: { workDir: () => dir },
    });
    const t = h.core.createThread();
    await h.core.send(t.id, "修好 state").done;
    const msg = await reportTo(t.id, "unverified");
    const w = h.store.workers.byThread(t.id)[0];
    const { row } = dispatchOf(w);
    expect(row?.outcome).toBe("unverified");
    expect((row?.report as { report: { status: string } } | undefined)?.report.status).toBe("unverified");
    expect(msg?.content).toContain('ok="false"');
    const checks = h.core.jobs.get(w?.jobId ?? "") ? h.store.dispatches.events(row?.id ?? "") : [];
    expect(checks.filter((e) => e.kind === "turn.completed")).toHaveLength(4); // first turn + 3 red rounds
  }, 30_000);
});

/** A general worker that asks, then continues with the answer (and reads what the one before it did). */
const asker = (question: Record<string, unknown>, seen: { history?: string; goal?: string }) => {
  // Only pass 0 carries the message: remember per run whether it is the continuation.
  const continued = new Map<string, boolean>();
  return ({ req, pass }: ScriptContext) => {
    if (pass === 0) continued.set(req.runId, req.userMessage.includes("回答（"));
    if (!continued.get(req.runId)) {
      if (pass === 0) return call("m", "note_step", { marker: "first-step-marker" });
      if (pass === 1)
        return call("q", "report_result", {
          status: "needs_input",
          summary: "要先確定一件事",
          questions: [question],
        });
      return say("等回答");
    }
    if (pass === 0) {
      seen.goal = req.userMessage;
      return call("hs", "history_search", { query: "first-step-marker" });
    }
    if (pass === 1) {
      seen.history = req.toolResults?.[0]?.output ?? "";
      return call("d", "report_result", { status: "done", summary: "照回答做完了" });
    }
    return say("完成");
  };
};

describe("NEEDS_INPUT on the real path", () => {
  it("the router answers for an autonomous bot; the continuation sees its predecessor (B8)", async () => {
    const seen: { history?: string; goal?: string } = {};
    h = makeAgents({
      router: ({ req, pass }) => {
        if (req.userMessage.includes("NEEDS_INPUT"))
          return pass === 0
            ? call("a", "worker_answer", { workerId: workerIdIn(req.userMessage), answers: ["藍"] })
            : say("我先代答了");
        return routerFor(() => ({ harness: "general" }))({ req, pass } as ScriptContext);
      },
      worker: asker({ question: "用哪個色系？", options: ["藍", "綠"] }, seen),
      tools: [tool("note_step", "read")],
      level: "autonomous",
    });
    const t = h.core.createThread();
    await h.core.send(t.id, "做一張海報").done;
    await reportTo(t.id, "照回答做完了");
    const [first, second] = h.store.workers.byThread(t.id);
    expect(second?.grants.dispatchId).toBe(first?.grants.dispatchId);
    expect(seen.goal).toContain("總機代答");
    expect(seen.history).toContain("first-step-marker");
    const { row, events } = dispatchOf(second);
    expect(row).toMatchObject({ status: "settled", outcome: "done" });
    expect(events.filter((e) => e.kind === "answered")).toHaveLength(1);
    expect(h.store.dispatches.waitOf(first?.id ?? "")?.state).toBe("closed");
  }, 30_000);

  it("at 每步確認 the router cannot answer; the person's own words can, once", async () => {
    const seen: { history?: string; goal?: string } = {};
    const refusals: string[] = [];
    h = makeAgents({
      router: ({ req, pass }) => {
        if (pass > 0 && req.toolResults?.[0]?.id === "a") {
          refusals.push(req.toolResults[0].output);
          return say("請問你要哪個色系？");
        }
        if (req.userMessage.includes("NEEDS_INPUT"))
          return call("a", "worker_answer", { workerId: workerIdIn(req.userMessage), answers: ["藍"] });
        if (req.userMessage.includes("<alca:worker")) return say("收到回報");
        if (lastLine(req.userMessage) === "綠") {
          const w = h?.store.workers.byThread(req.threadId)[0];
          return pass === 0
            ? call("u", "worker_answer", { workerId: w?.id ?? "", answers: ["綠"] })
            : say("轉交了");
        }
        return routerFor(() => ({ harness: "general" }))({ req, pass } as ScriptContext);
      },
      worker: asker({ question: "用哪個色系？", options: ["藍", "綠"] }, seen),
      tools: [tool("note_step", "read")],
      level: "confirm_each_step",
    });
    const t = h.core.createThread();
    await h.core.send(t.id, "做一張海報").done;
    await until(() => refusals.length > 0);
    expect(refusals[0]).toContain("不是自主等級");
    await until(() => !h?.core.isBusy(t.id));
    await h.core.send(t.id, "綠").done;
    await reportTo(t.id, "照回答做完了");
    expect(seen.goal).toContain("使用者回答");
    expect(seen.goal).toContain("綠");
    const first = h.store.workers.byThread(t.id)[0] as WorkerRecord;
    expect(() => h?.agents.workers.answer(first.id, ["藍"], "user")).toThrow(/已經回答過/);
  }, 30_000);

  it("a text question expires after 72 hours and is reported once", async () => {
    let now = new Date("2026-11-04T09:00:00+08:00").getTime();
    h = makeAgents({
      router: ({ req, pass }) => {
        if (req.userMessage.includes('status="expired"')) return say("問題過期了");
        if (req.userMessage.includes("<alca:worker")) return say("請回答工人的問題");
        return routerFor(() => ({ harness: "general" }))({ req, pass } as ScriptContext);
      },
      worker: asker({ question: "收件地址是什麼？" }, {}),
      tools: [tool("note_step", "read")],
      level: "autonomous",
      system: { now: () => new Date(now) },
    });
    const t = h.core.createThread();
    await h.core.send(t.id, "寄一張卡片").done;
    await reportTo(t.id, "NEEDS_INPUT");
    await until(() => !h?.core.isBusy(t.id));
    const w = h.store.workers.byThread(t.id)[0] as WorkerRecord;
    now += 71 * 3600_000;
    expect(h.agents.sweep().expired).toBe(0);
    now += 2 * 3600_000;
    expect(h.agents.sweep().expired).toBe(1);
    expect(h.agents.sweep().expired).toBe(0);
    await until(() => h?.store.threads.messages(t.id).some((m) => m.content === "問題過期了"));
    expect(dispatchOf(w).row).toMatchObject({ status: "settled", outcome: "expired" });
    expect(() => h?.agents.workers.answer(w.id, ["台北"], "user")).toThrow(/過期/);
    // a question with options never expires
    expect(h.store.dispatches.waitOf(w.id)?.expiresAt).not.toBeNull();
  }, 30_000);
});

describe("ledger on the real path", () => {
  it("racing wakes open exactly one worker, and its report is taken (B4, B5)", async () => {
    h = makeAgents({
      router: routerFor(() => ({ harness: "general" })),
      worker: asker({ question: "哪一天？", options: ["週五", "週六"] }, {}),
      tools: [tool("note_step", "read")],
      level: "autonomous",
    });
    const t = h.core.createThread();
    await h.core.send(t.id, "訂一個時間").done;
    await reportTo(t.id, "NEEDS_INPUT");
    const first = h.store.workers.byThread(t.id)[0] as WorkerRecord;
    const wait = h.store.dispatches.waitOf(first.id);
    const woken = [1, 2, 3].map(() => h?.agents.workers.wake(wait?.id ?? "", "回答（事件）：週五"));
    expect(woken.filter(Boolean)).toHaveLength(1);
    expect(() => h?.agents.workers.answer(first.id, ["週六"], "user")).toThrow(/已經回答過/);
    const next = woken.find(Boolean) as WorkerRecord;
    await until(() => h?.store.workers.get(next.id)?.status === "succeeded");
    const sameTask = h.store.workers
      .byThread(t.id)
      .filter((w) => w.grants.dispatchId === first.grants.dispatchId);
    expect(sameTask).toHaveLength(2);
    expect(dispatchOf(next).row).toMatchObject({
      status: "settled",
      outcome: "done",
      activeWorkerId: next.id,
    });
    expect(h.store.dispatches.wait(wait?.id ?? "")?.state).toBe("closed");
  }, 30_000);

  it("a stop that races a completed turn is interrupted everywhere (B6)", async () => {
    let target = "";
    h = makeAgents({
      router: routerFor(() => ({ harness: "general" })),
      worker: ({ pass }) =>
        pass === 0 ? call("r", "report_result", { status: "done", summary: "好了" }) : say("完成"),
      level: "autonomous",
    });
    h.agents.subscribe((e) => {
      if (e.type !== "worker.updated" || target) return;
      target = e.data.worker.workerId;
      h?.core.bus.subscribe(`worker:${target}`, (ev) => {
        // the turn completed — and a stop lands before the loop looks at it
        if (ev.type === "run.finished" && ev.data.reason === "completed")
          void h?.agents.workers.stop(target, "person");
      });
    });
    const t = h.core.createThread();
    await h.core.send(t.id, "做一件小事").done;
    await until(() => h?.store.workers.get(target)?.finishedAt);
    const w = h.store.workers.get(target) as WorkerRecord;
    const { row, events } = dispatchOf(w);
    expect(w.status).toBe("stopped");
    expect(row?.outcome).toBe("stopped");
    expect(events.filter((e) => e.kind.startsWith("turn.")).map((e) => e.kind)).toEqual(["turn.interrupted"]);
    expect(h.core.jobs.get(w.jobId)?.status).toBe("cancelled");
  }, 30_000);

  it("restart reconciliation: requeue once, park after outward, fail the second time", async () => {
    const dir = tmp();
    const path = join(dir, "state.sqlite");
    let resumed = "";
    const pushes: string[] = [];
    const shell = tool("shell", "read", (a) => {
      pushes.push(String(a.command));
      return "pushed";
    });
    const turns = new Map<string, { goal: string; again: boolean }>();
    const worker = ({ req, pass }: ScriptContext) => {
      if (pass === 0)
        turns.set(req.runId, {
          goal: lastLine(req.userMessage),
          again: req.userMessage.includes("重啟切斷"),
        });
      const { goal, again } = turns.get(req.runId) ?? { goal: "", again: false };
      if (goal === "slow") {
        if (!again) return [{ type: "wait" as const, ms: 60_000 }];
        if (pass === 0) resumed = req.userMessage;
        return pass === 0
          ? call("r", "report_result", { status: "done", summary: "接著做完了" })
          : say("完成");
      }
      if (goal === "push")
        return pass === 0
          ? call("p", "shell", { command: "git push origin main" })
          : [{ type: "wait" as const, ms: 60_000 }];
      return [{ type: "wait" as const, ms: 60_000 }];
    };
    const router = routerFor((goal) => ({ harness: goal === "push" ? "coding" : "general" }));
    h = makeAgents({ router, worker, tools: [shell], level: "autonomous", store: openStore(path) });
    const t = h.core.createThread();
    for (const g of ["slow", "push", "again"]) await h.core.send(t.id, g).done;
    // A host tool named shell running git push is a publish (asks at 自主); the person allows it.
    const card = await until(() => h?.store.human.pendingApprovals()[0]);
    expect(card.actionClass).toBe("publish");
    h.core.answerApproval(card.id, "approved");
    await until(() => pushes.length === 1);
    await until(() => h?.store.workers.byThread(t.id).every((w) => w.status === "running"));
    const [slow, push, again] = h.store.workers.byThread(t.id) as [WorkerRecord, WorkerRecord, WorkerRecord];
    h.store.db.prepare("UPDATE dispatches SET requeues = 1 WHERE id = ?").run(again.grants.dispatchId ?? "");
    await h.close(); // the process goes away mid-work
    h.store.close();
    const reopened = openStore(path);
    h = makeAgents({ router, worker, tools: [shell], level: "autonomous", store: reopened });
    h.core.recover();
    const r = h.agents.recover();
    expect(r.ledger).toMatchObject({ requeued: 1, review: 1, failed: 1 });
    h.agents.start();
    await until(() => h?.store.workers.get(slow.id)?.status === "succeeded");
    expect(resumed).toContain("上個回合被重啟切斷");
    expect(dispatchOf(slow).row).toMatchObject({ status: "settled", outcome: "done", requeues: 1 });
    expect(h.store.workers.get(push.id)?.status).toBe("needs_review");
    expect(dispatchOf(push).row).toMatchObject({
      status: "needs_review",
      outcome: "interrupted_after_outward",
    });
    expect(pushes).toHaveLength(1); // never pushed twice
    expect(h.store.workers.get(again.id)?.status).toBe("failed");
    expect(dispatchOf(again).row).toMatchObject({ status: "settled", outcome: "failed" });
    for (const w of [slow, push, again])
      expect(dispatchOf(w).events.some((e) => e.kind === "turn.interrupted")).toBe(true);
  }, 40_000);
});
