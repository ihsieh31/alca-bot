import { ScriptedEngine, type ScriptStep, streamText } from "@alca/engines";
import { ToolRegistryImpl } from "@alca/tools";
import { describe, expect, it } from "vitest";
import { hostToolsFrom } from "../src/index.ts";
import { isType, makeCore, waitFor } from "./helpers.ts";

const clickThen = new ScriptedEngine(({ pass, req }): ScriptStep[] =>
  pass === 0
    ? [
        { type: "tool.call", id: "e1", name: "browser_click", input: { ref: "@3" } },
        { type: "done", stop: "tool_use" },
      ]
    : streamText(req.toolResults?.map((r) => `${r.ok}:${r.output}`).join(",") ?? ""),
);

function registryWith(found: "payment" | "read" | "throw") {
  const seen: { actionClass: string; threadId?: string }[] = [];
  const reg = new ToolRegistryImpl().register({
    name: "browser_click",
    summary: "點擊元素",
    inputSchema: { type: "object" },
    actionClass: "write",
    source: "builtin",
    inspect: async () => {
      if (found === "throw") throw new Error("no page");
      return { actionClass: found, summary: "在 shop.test 按下「確認付款」", target: "http://shop.test/pay" };
    },
    run: async (_a, ctx) => {
      seen.push({ actionClass: ctx.actionClass, ...(ctx.threadId ? { threadId: ctx.threadId } : {}) });
      return "clicked";
    },
  });
  return { tools: hostToolsFrom(reg.list()), seen };
}

describe("tool inspection before the gate", () => {
  it("escalates to an always-confirm class even in autonomous mode, with the tool's summary", async () => {
    const { tools, seen } = registryWith("payment");
    const { core, events } = makeCore(clickThen, { tools, level: "autonomous" });
    const t = core.createThread();
    const { done } = core.send(t.id, "買");
    const req = await waitFor(events, isType("approval.requested"));
    expect(req.data).toMatchObject({ actionClass: "payment", summary: "在 shop.test 按下「確認付款」" });
    expect(events.find(isType("tool.requested"))?.data.actionClass).toBe("payment");
    core.answerApproval(req.data.approvalId, "approved");
    await done;
    expect(seen).toEqual([{ actionClass: "payment", threadId: t.id }]);
  });

  it("never lowers the declared class, and a failing inspection keeps it", async () => {
    for (const found of ["read", "throw"] as const) {
      const { tools } = registryWith(found);
      const { core, events } = makeCore(clickThen, { tools, level: "confirm_each_step" });
      const t = core.createThread();
      const { done } = core.send(t.id, "點");
      const req = await waitFor(events, isType("approval.requested"));
      expect(req.data.actionClass).toBe("write");
      core.answerApproval(req.data.approvalId, "denied");
      await done;
    }
  });
});

describe("bots", () => {
  it("threads, turn jobs, actors and approval cards carry the owning bot", async () => {
    const { tools } = registryWith("payment");
    const { core, events, store } = makeCore(clickThen, { tools, level: "autonomous" });
    const other = store.bots.create("研究員");
    const t = core.createThread(undefined, other.id);
    expect(t.botId).toBe(other.id);
    expect(core.createThread().botId).toBe(store.bots.default()?.id);
    const { runId, done } = core.send(t.id, "買");
    const req = await waitFor(events, isType("approval.requested"));
    expect(req.data.botId).toBe(other.id);
    expect(req.actor).toEqual({ kind: "agent", id: other.id });
    expect(store.human.approval(req.data.approvalId)?.botId).toBe(other.id);
    const job = store.db.prepare("SELECT bot_id FROM jobs WHERE run_id = ?").get(runId) as { bot_id: string };
    expect(job.bot_id).toBe(other.id);
    core.answerApproval(req.data.approvalId, "denied");
    await done;
  });
});
