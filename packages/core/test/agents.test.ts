import type { ScriptContext } from "@alca/engines";
import type { AlcaEvent } from "@alca/protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { HostTool } from "../src/index.ts";
import { call, type Harness, lastLine, makeAgents, say, until } from "./agents-helpers.ts";
import { tool } from "./helpers.ts";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const LONG = `比價結果如下。\n\n${"第一家：價格 1,280 元，含運，七天鑑賞。".repeat(40)}\n\n結論：第二家最便宜，建議買第二家。`;

/** Router: dispatch two workers in one pass, then recall a spilled report. */
function routerScript({ req, pass }: ScriptContext) {
  const msg = req.userMessage;
  if (pass === 0 && msg.includes("<alca:worker")) {
    const spill = /全文：(spl_[0-9A-Z]+)/.exec(msg)?.[1];
    if (spill) return call("r-recall", "recall", { id: spill });
    return say(`工人回報了：${/title="([^"]+)"/.exec(msg)?.[1] ?? ""}`);
  }
  if (pass === 0)
    return [
      ...say("好，我分兩個工人去做。"),
      {
        type: "tool.call" as const,
        id: "r1",
        name: "worker_start",
        input: { title: "刪掉清單", goal: "delete" },
      },
      {
        type: "tool.call" as const,
        id: "r2",
        name: "worker_start",
        input: { title: "比價", goal: "compare" },
      },
      { type: "done" as const, stop: "tool_use" as const },
    ];
  const r = req.toolResults?.[0];
  if (r?.id === "r-recall")
    return say(r.output.includes("結論：第二家最便宜") ? "回想到全文了" : "沒有回想到");
  return say("已經開始了，好了會告訴你。");
}

function workerScript({ req, pass }: ScriptContext) {
  const r = req.toolResults?.[0];
  if (pass > 0 && r?.id === "w-del") return say("刪好了。");
  if (pass > 0 && r?.id.startsWith("w-loop")) return call(`w-loop-${pass}`, "check_inbox", {});
  const goal = lastLine(req.userMessage);
  if (goal === "delete") return call("w-del", "delete_note", { title: "購物清單" });
  if (goal === "compare") return say(LONG);
  if (goal === "loop") return call(`w-loop-${pass}`, "check_inbox", {});
  if (goal === "slow") return [{ type: "wait" as const, ms: 60_000 }, ...say("慢慢做完了")];
  return say(`做完：${goal}`);
}

const workerRuns = (h: Harness) =>
  h.store.db.prepare("SELECT id FROM runs WHERE worker_id IS NOT NULL").all() as Array<{ id: string }>;

describe("router / workers", () => {
  it("dispatches two workers in parallel; one hits an always-confirm card with bot + worker ids, the other is spilled and recalled", async () => {
    const del = tool("delete_note", "delete");
    h = makeAgents({
      router: routerScript,
      worker: workerScript,
      tools: [del],
      workers: { inlineChars: 400 },
    });
    const { core, agents, store, events } = h;
    const t = core.createThread("兩件事");
    await core.send(t.id, "幫我刪掉購物清單，順便比價").done;

    // Both workers exist right after the router turn; the router did not wait for them.
    const ws = store.workers.byThread(t.id);
    expect(ws.map((w) => w.title)).toEqual(["刪掉清單", "比價"]);
    expect(new Set(ws.map((w) => w.jobId)).size).toBe(2);

    // The delete worker's card reaches the thread, carrying the bot and the worker.
    const card = await until(() =>
      events.find(
        (e): e is Extract<AlcaEvent, { type: "approval.requested" }> => e.type === "approval.requested",
      ),
    );
    const deleter = ws[0]!;
    expect(card.data).toMatchObject({ actionClass: "delete", botId: deleter.botId, workerId: deleter.id });
    expect(store.human.approval(card.data.approvalId)?.workerId).toBe(deleter.id);
    expect(del.calls).toHaveLength(0);

    // The compare worker finishes meanwhile and is spilled; the router recalls the full text.
    const compare = await until(() => {
      const w = store.workers.get(ws[1]!.id);
      return w?.status === "succeeded" ? w : undefined;
    });
    expect(compare.result?.mode).toBe("spill");
    expect(compare.result?.summary.length).toBeLessThan(400);
    expect(store.workers.spill(compare.result!.spillId!)?.body).toContain("結論：第二家最便宜");
    await until(() => store.threads.messages(t.id).some((m) => m.content === "回想到全文了"));
    // The router's context got the summary + handle, never the whole text.
    const report = store.threads
      .messages(t.id)
      .find((m) => m.role === "system" && m.content.includes(compare.id));
    expect(report?.content).toContain(compare.result!.spillId!);
    expect(report?.content).not.toContain("第一家：價格 1,280 元，含運，七天鑑賞。第一家");

    // Approving lets the delete worker finish; its report comes back inline.
    core.answerApproval(card.data.approvalId, "approved");
    await until(() => store.workers.get(deleter.id)?.status === "succeeded");
    expect(del.calls).toHaveLength(1);
    await until(() => store.threads.messages(t.id).some((m) => m.content === "工人回報了：刪掉清單"));

    // Worker text stays out of the chat; the worker stream has it.
    expect(
      store.threads.messages(t.id).some((m) => m.role !== "system" && m.content.includes("刪好了")),
    ).toBe(false);
    expect(
      agents
        .workerEvents(deleter.id)
        .some((e) => e.type === "message.completed" && e.data.text === "刪好了。"),
    ).toBe(true);
    expect(workerRuns(h).length).toBeGreaterThanOrEqual(2);
  }, 30_000);

  it("streams a worker's run on its own channel, not on the thread's", async () => {
    h = makeAgents({ router: routerScript, worker: workerScript, workers: { inlineChars: 400 } });
    const { core, store, events } = h;
    const t = core.createThread();
    const seen: AlcaEvent[] = [];
    await core.send(t.id, "x").done;
    const w = store.workers.byThread(t.id)[1]!;
    const off = core.bus.subscribe(`worker:${w.id}`, (e) => seen.push(e));
    await until(() => store.workers.get(w.id)?.status === "succeeded");
    off();
    const workerRunIds = new Set(workerRuns(h).map((r) => r.id));
    expect(events.some((e) => workerRunIds.has(e.runId) && e.type === "message.delta")).toBe(false);
    expect(seen.length + h.agents.workerEvents(w.id).length).toBeGreaterThan(0);
    expect(h.agents.workerEvents(w.id).some((e) => e.type === "message.delta")).toBe(true);
  }, 30_000);

  it("gives the router no tool but its own: a host tool is unknown, a native tool is denied", async () => {
    const del = tool("delete_note", "delete");
    h = makeAgents({
      router: ({ pass }) => (pass === 0 ? call("x", "delete_note", { title: "a" }) : say("我沒有那個工具")),
      worker: workerScript,
      tools: [del],
      level: "autonomous",
    });
    const t = h.core.createThread();
    await h.core.send(t.id, "直接刪").done;
    const done = h.events.find((e) => e.type === "tool.completed");
    expect(done?.data).toMatchObject({ ok: false });
    expect(del.calls).toHaveLength(0);

    // A tool-owning router engine asking to run a native tool (a shell) is denied by the core.
    await h.close();
    h = makeAgents({
      router: [
        [{ type: "permission", call: { id: "b", name: "Bash", input: { command: "ls" } } }, ...say("好")],
      ],
      worker: workerScript,
      routerCapabilities: { capabilities: { ownsToolLoop: true } },
      level: "autonomous",
    });
    const t2 = h.core.createThread();
    await h.core.send(t2.id, "ls").done;
    const res = h.events.find((e) => e.type === "tool.completed");
    expect(res?.data).toMatchObject({ ok: false });
    expect(JSON.stringify(res?.data)).toContain("總機不能自己執行工具");
  }, 30_000);

  it("serializes one bot's router turns across threads (one resident session)", async () => {
    const keys: string[] = [];
    h = makeAgents({
      router: ({ req }) => {
        keys.push(req.sessionKey ?? "");
        return [{ type: "wait", ms: 30 }, ...say("ok")];
      },
      worker: workerScript,
    });
    const a = h.core.createThread();
    const b = h.core.createThread();
    const ra = h.core.send(a.id, "a");
    const rb = h.core.send(b.id, "b");
    await Promise.all([ra.done, rb.done]);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toMatch(/^router\.bot_/);
    const runs = [ra.runId, rb.runId].map((id) => h!.store.runs.get(id)!);
    expect(runs.every((r) => r.finishReason === "completed")).toBe(true);
  }, 30_000);

  it("the watchdog stops a looping worker and the router hears about it", async () => {
    const poll: HostTool = {
      spec: { name: "check_inbox", description: "看信箱", inputSchema: { type: "object" } },
      actionClass: "read",
      run: async () => {
        await new Promise((r) => setTimeout(r, 25)); // a real poll takes a moment
        return "還沒有新回覆"; // plan §2.4: a loop is the same call with the same result
      },
    };
    h = makeAgents({
      router: ({ req, pass }) => {
        if (pass === 0 && req.userMessage.includes("<alca:worker")) return say("看門狗停掉了它");
        return pass === 0 ? call("s", "worker_start", { title: "等回信", goal: "loop" }) : say("派了");
      },
      worker: workerScript,
      tools: [poll],
      level: "autonomous",
      workers: { loopWindow: 6, loopRepeats: 4 },
    });
    const t = h.core.createThread();
    await h.core.send(t.id, "一直檢查信箱").done;
    const w = h.store.workers.byThread(t.id)[0]!;
    await until(() => (h!.store.workers.get(w.id)?.steps ?? 0) >= 4);
    const found = await h.agents.watchdog.tick();
    expect(found.map((f) => f.kind)).toEqual(["looping"]);
    await until(() => h!.store.workers.get(w.id)?.status === "stopped");
    expect(h.store.workers.get(w.id)?.stopReason).toMatch(/^watchdog\.looping/);
    expect(h.store.triggers.watchdogEvents(w.id)).toHaveLength(1);
    expect(h.agentEvents.some((e) => e.type === "watchdog.flagged")).toBe(true);
    await until(() => h!.store.threads.messages(t.id).some((m) => m.content === "看門狗停掉了它"));
    expect(h.core.jobs.get(w.jobId)?.status).toBe("cancelled");
  }, 30_000);

  it("a stop from the person ends a worker that waits for approval; the card is never honoured", async () => {
    const del = tool("delete_note", "delete");
    h = makeAgents({ router: routerScript, worker: workerScript, tools: [del] });
    const t = h.core.createThread();
    await h.core.send(t.id, "x").done;
    const w = h.store.workers.byThread(t.id)[0]!;
    await until(() => h!.store.workers.get(w.id)?.status === "waiting");
    expect(await h.agents.workers.stop(w.id, "user")).toBe(true);
    expect(h.store.workers.get(w.id)).toMatchObject({ status: "stopped", stopReason: "user" });
    expect(del.calls).toHaveLength(0);
  }, 30_000);

  it("speculative work: an outbound step is still confirmed under 自主 and an allow rule", async () => {
    const send = tool("send_mail", "send");
    h = makeAgents({
      router: ({ pass, req }) =>
        pass === 0 && !req.userMessage.includes("<alca:worker")
          ? call("s", "worker_start", { title: "擬回信", goal: "mail", speculative: true })
          : say("好"),
      worker: ({ pass }) => (pass === 0 ? call("m", "send_mail", { to: "a@b.c" }) : say("草稿好了")),
      tools: [send],
      level: "autonomous",
      rules: [{ id: "allow-mail", effect: "allow", action: "send_mail" }],
    });
    const t = h.core.createThread();
    await h.core.send(t.id, "先擬好回信").done;
    const card = await until(() =>
      h!.events.find(
        (e): e is Extract<AlcaEvent, { type: "approval.requested" }> => e.type === "approval.requested",
      ),
    );
    expect(card.data.actionClass).toBe("send");
    expect(card.data.summary).toMatch(/^（提前準備）/);
    expect(send.calls).toHaveLength(0);
    expect(h.store.workers.byThread(t.id)[0]?.speculative).toBe(true);
  }, 30_000);

  it("a worker cannot ask the person directly", async () => {
    h = makeAgents({
      router: ({ pass, req }) =>
        pass === 0 && !req.userMessage.includes("<alca:worker")
          ? call("s", "worker_start", { title: "問", goal: "ask" })
          : say("好"),
      worker: ({ pass, req }) =>
        pass === 0
          ? call("q", "ask_user", { prompt: "要哪個？" })
          : say(`結果：${req.toolResults?.[0]?.output ?? ""}`),
    });
    const t = h.core.createThread();
    await h.core.send(t.id, "x").done;
    const w = h.store.workers.byThread(t.id)[0]!;
    await until(() => h!.store.workers.get(w.id)?.status === "succeeded");
    expect(h.store.human.pendingQuestions()).toHaveLength(0);
    expect(h.store.workers.get(w.id)?.result?.summary).toContain("工人不能直接問使用者");
  }, 30_000);
});
