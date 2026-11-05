// Host tools called by the Claude Code engine (fake CLI over real MCP stdio):
// the same inspect → gateway → card → execute path as host-loop calls.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeEngine, FAKE_CLAUDE_SCRIPT } from "@alca/engines";
import { checkSequence } from "@alca/protocol";
import { openStore } from "@alca/store";
import { ToolRegistryImpl } from "@alca/tools";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalArgs, hostToolsFrom } from "../src/index.ts";
import { isType, makeCore, tool, waitFor } from "./helpers.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function payTool() {
  const runs: { actionClass: string; botId?: string; threadId?: string }[] = [];
  const reg = new ToolRegistryImpl().register({
    name: "browser_click",
    summary: "點擊元素",
    inputSchema: { type: "object", properties: { ref: { type: "string" } } },
    actionClass: "write",
    source: "builtin",
    inspect: async (a) =>
      a.ref === "@9"
        ? { actionClass: "payment", summary: "在 shop.test 按下「確認付款」", target: "http://shop.test/pay" }
        : { summary: `點 ${String(a.ref)}` },
    run: async (_a, ctx) => {
      runs.push({
        actionClass: ctx.actionClass,
        ...(ctx.botId ? { botId: ctx.botId } : {}),
        ...(ctx.threadId ? { threadId: ctx.threadId } : {}),
      });
      return "已點擊";
    },
  });
  return { tools: hostToolsFrom(reg.list()), runs };
}

function claudeCore(
  level: "autonomous" | "confirm_each_step",
  tools: ReturnType<typeof payTool>["tools"],
  env: NodeJS.ProcessEnv = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "alca-cc-tools-core-"));
  const store = openStore(":memory:");
  const engine = new ClaudeCodeEngine({
    command: [process.execPath, "--disable-warning=ExperimentalWarning", FAKE_CLAUDE_SCRIPT],
    launch: () => ({
      engineId: "claude-code",
      cwd: dir,
      stablePrompt: "穩定層",
      env: {},
      approvalMode: "default",
    }),
    sessions: {
      get: (t) => store.threads.getSession(t, "claude-code"),
      set: (t, s) => store.threads.setSession(t, "claude-code", s),
    },
    baseEnv: env,
  });
  const h = makeCore(engine, { store, level, tools });
  cleanups.push(
    () => h.core.close(),
    () => rmSync(dir, { recursive: true, force: true }),
  );
  return h;
}

describe("core × Claude Code × host tools", () => {
  it("canonical args ignore key order", () => {
    expect(canonicalArgs({ b: 1, a: [{ y: 2, x: 1 }] })).toBe(canonicalArgs({ a: [{ x: 1, y: 2 }], b: 1 }));
  });

  it("a payment click escalates to a payment card even in autonomous mode; denied → never runs", async () => {
    const { tools, runs } = payTool();
    const { core, events, store } = claudeCore("autonomous", tools);
    const t = core.createThread();
    const { done } = core.send(t.id, '[mcp:browser_click {"ref":"@9"}]');
    const card = await waitFor(events, isType("approval.requested"), 8000);
    expect(card.data).toMatchObject({
      actionClass: "payment",
      summary: "在 shop.test 按下「確認付款」",
      botId: store.bots.default()!.id,
    });
    const req = events.filter(isType("tool.requested"));
    expect(req).toHaveLength(1);
    expect(req[0]!.data).toMatchObject({ tool: "browser_click", args: { ref: "@9" } });
    expect(card.data.callId).toBe(req[0]!.data.callId);
    // Nothing runs while the card is open.
    await new Promise((r) => setTimeout(r, 150));
    expect(runs).toEqual([]);
    core.answerApproval(card.data.approvalId, "denied");
    expect(await done).toBe("completed");
    expect(runs).toEqual([]);
    expect(core.messages(t.id).at(-1)?.content).toContain("沒有執行");
    const completed = events.filter(isType("tool.completed"));
    expect(completed).toHaveLength(1);
    expect(completed[0]!.data).toMatchObject({ callId: req[0]!.data.callId, ok: false });
    expect(checkSequence(events).ok).toBe(true);
    const audit = store.db.prepare("SELECT action, action_class FROM audit_log").all() as Array<{
      action: string;
      action_class: string;
    }>;
    expect(audit.some((a) => a.action === "browser_click" && a.action_class === "payment")).toBe(true);
  });

  it("approved → runs once with the authorized class and the thread's bot", async () => {
    const { tools, runs } = payTool();
    const { core, events, store } = claudeCore("autonomous", tools);
    const bot = store.bots.create("採購員");
    const t = core.createThread(undefined, bot.id);
    const { done, runId } = core.send(t.id, '[mcp:browser_click {"ref":"@9"}]');
    const card = await waitFor(events, isType("approval.requested"), 8000);
    expect(card.data.botId).toBe(bot.id);
    core.answerApproval(card.data.approvalId, "approved");
    expect(await done).toBe("completed");
    expect(runs).toEqual([{ actionClass: "payment", botId: bot.id, threadId: t.id }]);
    expect(core.messages(t.id).at(-1)?.content).toBe("完成：已點擊");
    const job = store.db.prepare("SELECT outbound_observed FROM jobs WHERE run_id = ?").get(runId) as {
      outbound_observed: number;
    };
    expect(job.outbound_observed).toBe(1);
  });

  it("an ordinary click under autonomous runs without a card; under 每步確認 it asks (write)", async () => {
    {
      const { tools, runs } = payTool();
      const { core, events } = claudeCore("autonomous", tools);
      const t = core.createThread();
      expect(await core.send(t.id, '[mcp:browser_click {"ref":"@1"}]').done).toBe("completed");
      expect(events.filter(isType("approval.requested"))).toEqual([]);
      expect(runs).toEqual([expect.objectContaining({ actionClass: "write" })]);
    }
    {
      const { tools, runs } = payTool();
      const { core, events } = claudeCore("confirm_each_step", tools);
      const t = core.createThread();
      const { done } = core.send(t.id, '[mcp:browser_click {"ref":"@1"}]');
      const card = await waitFor(events, isType("approval.requested"), 8000);
      expect(card.data).toMatchObject({ actionClass: "write", summary: "點 @1" });
      core.answerApproval(card.data.approvalId, "approved");
      await done;
      expect(runs).toHaveLength(1);
    }
  });

  it("if the CLI prompts for a host tool anyway, the prompt is allowed blind and the call itself is gated once", async () => {
    const { tools, runs } = payTool();
    const { core, events } = claudeCore("autonomous", tools, { FAKE_CLAUDE_ASK_HOST_TOOLS: "1" });
    const t = core.createThread();
    const { done } = core.send(t.id, '[mcp:browser_click {"ref":"@9"}]');
    const card = await waitFor(events, isType("approval.requested"), 8000);
    core.answerApproval(card.data.approvalId, "approved");
    await done;
    expect(events.filter(isType("approval.requested"))).toHaveLength(1);
    expect(runs).toHaveLength(1);
  });

  it("a native CLI tool with a host tool's name is not waved through", async () => {
    const bash = tool("Bash", "execute");
    const { core, events } = claudeCore("confirm_each_step", [bash]);
    const t = core.createThread();
    const { done } = core.send(t.id, "[bash:ls]");
    const card = await waitFor(events, isType("approval.requested"), 8000);
    core.answerApproval(card.data.approvalId, "denied");
    await done;
    expect(bash.calls).toEqual([]); // the CLI's Bash is not ours either way
  });
});
