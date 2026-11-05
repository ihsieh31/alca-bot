import { isAlwaysConfirm } from "@alca/config";
import type { HostToolCallResult } from "@alca/engines";
import { type ActionClass, isActionClass, PolicyDeniedError } from "@alca/policy";
import type { TurnContext } from "../turn.ts";
import {
  afterRun,
  authorizeGuarded,
  beforeRun,
  emitApprovalRequested,
  noteOutbound,
  settleApproval,
  waitForHuman,
} from "./human.ts";

/**
 * Host tools called by a tool-owning engine (the Claude Code CLI reaches them
 * through our `alcatools` MCP server). The call runs here, in the host, through
 * exactly the steps a host-loop call takes in `plan_tools` → `gate` →
 * `execute`: the tool's `inspect` (escalate only) → gateway (deny > ask >
 * allow, always-confirm classes forced to ask, audit row first) → approval
 * card and wait → `gateway.execute` with the class that was authorized, as the
 * thread's bot. Nothing is retried; a denial never runs the tool.
 */

/** Order-independent JSON for matching an MCP call to the engine's observed tool_use. */
export function canonicalArgs(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalArgs).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalArgs(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

export async function runEngineHostCall(
  ctx: TurnContext,
  call: { callId: string; tool: string; args: Record<string, unknown> },
): Promise<HostToolCallResult> {
  const { deps } = ctx;
  const tool = deps.tools.get(call.tool);
  if (!tool) return { ok: false, output: `沒有這個工具：${call.tool}` };
  if (ctx.signal.aborted) return { ok: false, output: "回合已中斷，沒有執行" };

  let actionClass: ActionClass = tool.actionClass;
  let summary: string | undefined;
  let target: string | undefined;
  if (tool.inspect) {
    try {
      const r = await tool.inspect(call.args, {
        signal: ctx.signal,
        threadId: ctx.threadId,
        botId: ctx.botId,
        ...(ctx.workerId ? { workerId: ctx.workerId } : {}),
      });
      const found = isActionClass(r.actionClass) ? r.actionClass : undefined;
      if (
        found &&
        found !== actionClass &&
        (isAlwaysConfirm(found) || (actionClass === "read" && found !== "read"))
      )
        actionClass = found;
      if (r.summary) summary = r.summary.slice(0, 500);
      if (r.target) target = r.target;
    } catch {
      // keep the declared class
    }
  }

  const asked = {
    callId: call.callId,
    tool: call.tool,
    args: call.args,
    actionClass,
    ...(summary ? { summary } : {}),
    ...(target ? { target } : {}),
  };
  const auth = await authorizeGuarded(ctx, asked);
  if (auth.decision.effect === "deny") return { ok: false, output: `主機政策拒絕：${auth.decision.reason}` };
  if (auth.decision.effect === "ask") {
    if (!auth.approvalId) return { ok: false, output: "需要批准，但沒有建立批准卡" };
    emitApprovalRequested(ctx, auth, call.callId);
    try {
      await waitForHuman(ctx, [auth.approvalId], "approval");
    } catch {
      return { ok: false, output: "回合已中斷，沒有執行" };
    }
    const outcome = settleApproval(ctx, auth.approvalId);
    if (outcome !== "approved")
      return {
        ok: false,
        output:
          outcome === "expired" ? "批准已過期，沒有執行。" : "使用者沒有同意這個動作，沒有執行；請不要重試。",
      };
  }

  const granted = auth.request.actionClass;
  try {
    noteOutbound(ctx, granted, { callId: call.callId, tool: call.tool });
    if (deps.gateway.isAuthorized(auth)) beforeRun(ctx, asked, granted);
    const output = await deps.gateway.execute(auth, () =>
      tool.run(call.args, ctx.signal, {
        actionClass: granted,
        threadId: ctx.threadId,
        runId: ctx.runId,
        botId: ctx.botId,
        ...(ctx.workerId ? { workerId: ctx.workerId } : {}),
      }),
    );
    return { ok: true, output };
  } catch (err) {
    return {
      ok: false,
      output:
        err instanceof PolicyDeniedError
          ? `未授權：${err.decision.reason}`
          : String((err as Error)?.message ?? err),
    };
  } finally {
    afterRun(ctx, call.callId);
  }
}
