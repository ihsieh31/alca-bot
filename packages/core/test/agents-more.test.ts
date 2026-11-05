import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSettings } from "@alca/config";
import type { ScriptContext } from "@alca/engines";
import { openStore, type WorkerRecord } from "@alca/store";
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectWorker,
  page,
  recallObject,
  ruleFilter,
  type SemanticJudge,
  shapeResult,
  summarize,
} from "../src/index.ts";
import { call, type Harness, lastLine, makeAgents, say, until } from "./agents-helpers.ts";
import { tool } from "./helpers.ts";

let h: Harness | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await h?.close();
  h = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const policy = parseSettings({}).engineering.workers;

describe("inline / spill and the recall chain", () => {
  it("keeps small results inline and spills large ones with a sentence-cut summary", () => {
    expect(shapeResult("短短的結果", policy)).toEqual({ mode: "inline", summary: "短短的結果", chars: 5 });
    const long = `${"資料。".repeat(600)}\n\n結論：選 B，因為它便宜又快。`;
    const s = shapeResult(long, policy);
    expect(s.mode).toBe("spill");
    expect(s.summary).toBe("結論：選 B，因為它便宜又快。");
    expect(summarize("一句。".repeat(200), 30).length).toBeLessThanOrEqual(31);
    expect(page("零一二三四五", 2, 3)).toEqual({ body: "二三四", total: 6, next: 5 });
    expect(page("零一二", 0, 10)).toEqual({ body: "零一二", total: 3 });
  });

  it("recalls by id, a page at a time, with neighbours — and only for the owning bot", () => {
    const store = openStore(":memory:");
    const bot = store.bots.ensureDefault();
    const other = store.bots.create("另一個");
    const t = store.threads.create("thr_01M6FS56CMD82Z8TY2D17VNKX0", "t", new Date(), bot.id);
    store.db
      .prepare("INSERT INTO jobs (id, kind, created_at, updated_at) VALUES ('j1','subagent','x','x')")
      .run();
    const w = store.workers.create({
      botId: bot.id,
      threadId: t.id,
      jobId: "j1",
      title: "長報告",
      goal: "寫長報告",
      initiator: { kind: "user", id: "me" },
    });
    const body = "甲".repeat(2000) + "乙".repeat(1000);
    const s = store.workers.addSpill({
      botId: bot.id,
      ownerKind: "worker",
      ownerId: w.id,
      title: "長報告",
      body,
    });
    const first = recallObject(store, bot.id, s.id);
    expect(first).toContain(`owner="${w.id}"`);
    expect(first).toContain(`recall {"id":"${s.id}","offset":1500}`);
    const second = recallObject(store, bot.id, s.id, 1500);
    expect(second).toContain("乙");
    expect(second).toContain("（到底了）");
    expect(recallObject(store, bot.id, w.id)).toContain(`全文 ${s.id}`);
    expect(recallObject(store, bot.id, t.id)).toContain(w.id);
    expect(recallObject(store, other.id, s.id)).toContain("找不到");
    expect(recallObject(store, bot.id, "foo_1")).toContain("不認得");
  });
});

describe("watchdog checks", () => {
  const base = {
    id: "wkr_X",
    botId: "bot_X",
    status: "running",
    steps: 1,
    tokens: 0,
    budget: { maxSteps: 10, maxRunMs: 60_000, maxTokens: 1000 },
    startedAt: "2026-11-03T00:00:00.000Z",
    lastActivityAt: "2026-11-03T00:00:00.000Z",
    waitingSince: null,
    waitedMs: 0,
  } as unknown as WorkerRecord;
  const p = { ...policy, stuckSec: 30, loopWindow: 6, loopRepeats: 4 };
  const at = (s: number) => new Date(Date.parse("2026-11-03T00:00:00.000Z") + s * 1000);

  it("flags stuck, looping and over-budget workers, and not one waiting for a person", () => {
    expect(inspectWorker(base, [], p, at(10))).toBeUndefined();
    expect(inspectWorker(base, [], p, at(40))?.kind).toBe("stuck");
    expect(
      inspectWorker({ ...base, status: "waiting", waitingSince: base.startedAt }, [], p, at(40)),
    ).toBeUndefined();
    expect(inspectWorker(base, ["a", "b", "a", "a", "c", "a"], p, at(1))?.kind).toBe("looping");
    expect(inspectWorker(base, ["a", "b", "a", "c", "d", "a"], p, at(1))).toBeUndefined();
    expect(inspectWorker({ ...base, steps: 11 }, [], p, at(1))?.kind).toBe("over_budget");
    expect(inspectWorker({ ...base, tokens: 5000 }, [], p, at(1))?.detail).toContain("tokens");
    expect(inspectWorker({ ...base, lastActivityAt: at(65).toISOString() }, [], p, at(70))?.kind).toBe(
      "over_budget",
    );
    // Time spent waiting for a person does not count against the running-time budget.
    expect(
      inspectWorker({ ...base, lastActivityAt: at(65).toISOString(), waitedMs: 30_000 }, [], p, at(70)),
    ).toBeUndefined();
    expect(inspectWorker({ ...base, status: "succeeded" }, ["a", "a", "a", "a"], p, at(99))).toBeUndefined();
  });
});

describe("triggers: two-stage filter, pass-through", () => {
  it("stage 1 is plain code: ignore / allow / block / keywords / explicit", () => {
    expect(ruleFilter({ mode: "ignore" }, { text: "@alca 幫忙" })).toBe("drop");
    expect(ruleFilter({}, { text: "週報" })).toBe("candidate");
    expect(ruleFilter({ mode: "explicit" }, { text: "週報" })).toBe("drop");
    expect(ruleFilter({ mode: "explicit" }, { text: "@Alca 幫我看" })).toBe("explicit");
    expect(ruleFilter({ mode: "explicit" }, { text: "x", explicit: true })).toBe("explicit");
    expect(ruleFilter({ allow: ["boss@x.tw"] }, { text: "hi", from: "spam@y" })).toBe("drop");
    expect(ruleFilter({ allow: ["boss@x.tw"] }, { text: "hi", from: "Boss@x.tw" })).toBe("candidate");
    expect(ruleFilter({ block: ["spam@y"] }, { text: "@alca", from: "spam@y" })).toBe("drop");
    expect(ruleFilter({ keywords: ["發票"] }, { text: "會議" })).toBe("drop");
  });

  const judge = (seen: string[]): SemanticJudge => ({
    judge: async ({ event, rule }) => {
      seen.push(rule);
      return { wake: event.text.includes("急"), reason: event.text.includes("急") ? "急件" : "不重要" };
    },
  });

  it("drops at stage 1 with no model call, asks the model for candidates, and wakes the router only on yes", async () => {
    const seen: string[] = [];
    h = makeAgents({
      router: ({ req }) => say(req.userMessage.includes("<alca:trigger") ? "收到觸發" : "嗯"),
      worker: () => say("x"),
      judge: judge(seen),
    });
    const t = h.core.createThread();
    const trg = h.agents.triggers.create({
      threadId: t.id,
      name: "信箱",
      source: "manual",
      rule: { block: ["ads@shop"] },
      semantic: "只有急件才叫醒",
    });
    expect((await h.agents.triggers.fire(trg.id, { text: "特價", from: "ads@shop" })).outcome).toBe(
      "dropped",
    );
    expect(seen).toHaveLength(0);
    const skip = await h.agents.triggers.fire(trg.id, { text: "週報", from: "me" });
    expect(skip).toMatchObject({ outcome: "dropped", ruleVerdict: "candidate", judged: "skip" });
    expect(seen).toEqual(["只有急件才叫醒"]);
    const wake = await h.agents.triggers.fire(trg.id, { text: "急：伺服器掛了", from: "me" });
    expect(wake).toMatchObject({ outcome: "router", judged: "wake" });
    await until(() => h!.store.threads.messages(t.id).some((m) => m.content === "收到觸發"));
    const note = h.store.threads.messages(t.id).find((m) => m.role === "system");
    expect(note?.content).toContain(`event="${wake.id}"`);
    expect(note?.content).toContain('trust="untrusted"');
    // An explicit request skips the model.
    expect((await h.agents.triggers.fire(trg.id, { text: "@alca 幫我看" })).judged).toBeNull();
    expect(seen).toHaveLength(2);
    expect(h.agentEvents.filter((e) => e.type === "trigger.fired")).toHaveLength(4);
  }, 30_000);

  it("passes follow-up events of a subscribed stream straight to the worker, not the router", async () => {
    const seenByRouter: string[] = [];
    const wait = tool("wait_reply", "read", () => "等到了");
    let gate!: () => void;
    const held = new Promise<void>((r) => {
      gate = r;
    });
    h = makeAgents({
      router: ({ req, pass }: ScriptContext) => {
        seenByRouter.push(req.userMessage);
        if (pass === 0 && !req.userMessage.includes("<alca:"))
          return call("s", "worker_start", { title: "跟進 PR", goal: "follow", subscribe: ["github:pr/7"] });
        return say("好");
      },
      worker: ({ req, pass }: ScriptContext) => {
        if (req.userMessage.includes("<alca:stream-events>"))
          return say(`看到新事件：${lastLine(req.userMessage.split("</alca:stream-events>")[0] ?? "")}`);
        if (pass === 0) return [{ type: "wait", ms: 1 }, ...call("w", "wait_reply", {})];
        return say("先等著");
      },
      tools: [
        {
          ...wait,
          run: async (a) => {
            await held;
            return wait.run(a, new AbortController().signal);
          },
        },
      ],
      level: "autonomous",
      judge: judge([]),
    });
    const t = h.core.createThread();
    await h.core.send(t.id, "幫我盯著 PR 7").done;
    const w = h.store.workers.byThread(t.id)[0]!;
    const trg = h.agents.triggers.create({ threadId: t.id, name: "GitHub", source: "manual" });
    const ev = await h.agents.triggers.fire(trg.id, {
      text: "審查者留言：請改測試",
      streamKey: "github:pr/7",
    });
    expect(ev.outcome).toBe("workers");
    gate();
    await until(() => h!.store.workers.get(w.id)?.status === "succeeded");
    expect(h.store.workers.get(w.id)?.result?.summary).toContain("審查者留言：請改測試");
    // The router heard the worker's report, never the stream event itself.
    expect(seenByRouter.some((m) => m.includes("<alca:trigger"))).toBe(false);
  }, 30_000);
});

describe("restart", () => {
  const routerScript = ({ req, pass }: ScriptContext) =>
    pass === 0 && !req.userMessage.includes("<alca:")
      ? call("s", "worker_start", { title: "長工作", goal: lastLine(req.userMessage) })
      : say(req.userMessage.includes("<alca:worker") ? "回報收到" : "派了");

  it("resumes an unfinished worker after a restart, and parks one that already paid", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alca-agents-"));
    dirs.push(dir);
    const path = join(dir, "state.sqlite");
    const pay = tool("pay", "payment");
    let resumedWith = "";
    const workerScript = ({ req, pass }: ScriptContext) => {
      if (req.userMessage.includes("重新啟動過")) resumedWith = req.userMessage;
      if (pass > 0 && req.toolResults?.[0]?.id === "p") return [{ type: "wait" as const, ms: 60_000 }];
      const goal = lastLine(req.userMessage);
      if (goal === "slow" && !resumedWith) return [{ type: "wait" as const, ms: 60_000 }];
      if (goal === "pay") return call("p", "pay", {});
      return say("接著做完了");
    };
    h = makeAgents({ router: routerScript, worker: workerScript, tools: [pay], store: openStore(path) });
    const t = h.core.createThread();
    await h.core.send(t.id, "slow").done;
    await h.core.send(t.id, "pay").done;
    const [slow, paid] = h.store.workers.byThread(t.id) as [WorkerRecord, WorkerRecord];
    const card = await until(() => h!.store.human.pendingApprovals()[0]);
    h.core.answerApproval(card.id, "approved");
    await until(() => pay.calls.length === 1);
    await until(() => h!.store.workers.get(slow.id)?.status === "running");
    await h.close(); // the process goes away mid-work
    h.store.close();
    h = undefined;
    const reopened = openStore(path);
    expect(reopened.workers.get(slow.id)?.status).toBe("running");

    h = makeAgents({ router: routerScript, worker: workerScript, tools: [pay], store: reopened });
    h.core.recover();
    const r = h.agents.recover();
    expect(r).toMatchObject({ resumed: 1, review: 1 });
    h.agents.start();
    await until(() => h!.store.workers.get(slow.id)?.status === "succeeded");
    expect(resumedWith).toContain("請從停下的地方接著做");
    expect(h.store.workers.get(paid.id)?.status).toBe("needs_review");
    expect(pay.calls).toHaveLength(1); // never paid twice
    await until(() =>
      h!.store.threads
        .messages(t.id)
        .some((m) => m.role === "system" && m.content.includes("需要使用者確認")),
    );
  }, 30_000);
});
