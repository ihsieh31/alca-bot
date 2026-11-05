import { type ExecCall, type ExecToolSpec, ToolExecutor } from "../harness/executor.ts";
import type { PlannedCall, TurnContext, TurnState } from "../turn.ts";

/**
 * Plan §2.1: a harness worker's tool calls run through the harness executor
 * instead of the plain batches: reads share a fair read/write lock, anything
 * that changes something runs alone (so two writes to one file queue), at
 * most 8 run at once, results stay in call order, and on an abort every call
 * without a result gets an "aborted" one so the history stays valid.
 * The gateway decision, the guards and the events are the same `runOne`.
 */
export async function executeHarness(
  state: TurnState,
  ctx: TurnContext,
  byId: Map<string, PlannedCall>,
  runOne: (c: PlannedCall) => Promise<void>,
): Promise<void> {
  const order = state.batches.flat();
  const tools = new Map<string, ExecToolSpec>();
  const calls: ExecCall[] = [];
  order.forEach((id, index) => {
    const c = byId.get(id);
    if (!c) return;
    tools.set(id, {
      name: id,
      concurrency: c.status === "allowed" && c.actionClass !== "read" ? "exclusive" : "shared",
      run: async () => {
        await runOne(c);
        const r = c.result ?? { ok: false, output: "沒有結果" };
        if (!r.ok) throw new Error(r.output);
        return r.output;
      },
    });
    calls.push({ id, name: id, args: {}, index });
  });
  const exec = new ToolExecutor({
    tools,
    signal: ctx.signal,
    onEnd: (call, r) => {
      const c = byId.get(call.id);
      if (!c || c.result) return;
      // Never ran (cancelled before dispatch, or cut off by the abort): a placeholder result.
      c.result = { ok: false, output: r.content };
      (c as { placed?: boolean }).placed = true;
      c.status = "done";
      ctx.deps.emit("tool.completed", { callId: c.callId, ok: false, error: r.content, durationMs: 0 });
      ctx.deps.jobs.record(ctx.jobId, "tool.completed", { callId: c.callId, ok: false });
    },
  });
  for (const c of calls) exec.start(c);
  if (ctx.signal.aborted) await exec.settleAll();
  else {
    const aborted = new Promise<void>((resolve) =>
      ctx.signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    await Promise.race([exec.waitAll(), aborted]);
    if (ctx.signal.aborted) await exec.settleAll();
  }
}
