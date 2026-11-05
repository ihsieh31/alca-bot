import { CLAUDE_BACKGROUND_TOOLS } from "@alca/engines";
import { outboundEventFor } from "@alca/jobs";
import { type ActionClass, type Authorization, FULL_ACCESS_REASON } from "@alca/policy";
import { newId } from "@alca/protocol";
import type { GuardCall, TurnContext } from "../turn.ts";

/**
 * Mac test 2026-11-04b A8: an engine's own scheduling / sub-agent tools
 * (`CronCreate`, `Agent`, …) act outside the turn and outside Alca's cards.
 * Denied in every role and at every level, asked or not; a scheduled run is
 * Alca's 例行工作.
 */
export const BACKGROUND_TOOLS: ReadonlySet<string> = new Set(CLAUDE_BACKGROUND_TOOLS);
export const BACKGROUND_REASON =
  "引擎內建的排程、喚醒或子代理工具不經過 Alca 的確認，一律不准；要定時做事請用 Alca 的「例行工作」";

/** Shared steps for approval and question cards, used by `gate` and by tool-owning engines in `infer`. */

export interface CallToAuthorize {
  callId: string;
  tool: string;
  args: Record<string, unknown>;
  actionClass: ActionClass;
  target?: string;
  summary?: string;
}

export function requestOf(ctx: TurnContext, call: CallToAuthorize) {
  return {
    initiator: ctx.initiator,
    actor: { kind: "agent" as const, id: ctx.botId },
    action: call.tool,
    actionClass: call.actionClass,
    ...(call.target ? { target: call.target } : {}),
    args: call.args,
  };
}

function contextOf(ctx: TurnContext, call: CallToAuthorize, extra: AuthorizeExtra = {}) {
  const summary = extra.escalate
    ? `${extra.escalate}：${call.summary ?? describeCall(call)}`.slice(0, 500)
    : call.summary;
  return {
    runId: ctx.runId,
    callId: call.callId,
    botId: ctx.botId,
    threadId: ctx.threadId,
    ...(ctx.workerId ? { workerId: ctx.workerId } : {}),
    ...(ctx.speculative
      ? { summary: `（提前準備）${summary ?? describeCall(call)}` }
      : summary
        ? { summary }
        : {}),
    ...(extra.escalate ? { escalate: extra.escalate } : {}),
    ...(extra.noAsk ? { noAsk: extra.noAsk } : {}),
    ...(extra.deny ? { deny: extra.deny } : {}),
  };
}

const describeCall = (call: CallToAuthorize) => {
  const cmd = typeof call.args.command === "string" ? `：${call.args.command}` : "";
  return `${call.tool}${call.target ? `（${call.target}）` : ""}${cmd}`.slice(0, 400);
};

/** P13: host checks that may only tighten the decision. */
export interface AuthorizeExtra {
  escalate?: string;
  noAsk?: string;
  deny?: string;
}

export function authorizeCall(
  ctx: TurnContext,
  call: CallToAuthorize,
  extra?: AuthorizeExtra,
): Authorization {
  const auth = ctx.deps.gateway.authorize(requestOf(ctx, call), contextOf(ctx, call, extra));
  if (auth.decision.grant === "full_access") ledgerFullAccess(ctx, call, auth);
  return auth;
}

/**
 * Phase 5: every call that runs only because the bot is at 完全授權 goes into
 * the worker's dispatch ledger (append-only), marked with its reason. The
 * audit row is written by the gateway either way.
 */
function ledgerFullAccess(ctx: TurnContext, call: CallToAuthorize, auth: Authorization): void {
  try {
    const store = ctx.deps.store;
    const dispatchId = ctx.workerId ? store.workers.get(ctx.workerId)?.grants.dispatchId : undefined;
    if (!dispatchId) return;
    store.dispatches.event(dispatchId, "auto_allowed", ctx.deps.now().getTime(), {
      detail: {
        reason: FULL_ACCESS_REASON,
        tool: call.tool,
        actionClass: auth.request.actionClass,
        auditId: auth.auditId,
        runId: ctx.runId,
        callId: call.callId,
        summary: (call.summary ?? describeCall(call)).slice(0, 300),
      },
    });
  } catch {
    // the audit row already holds the decision; the ledger line must never stop the call
  }
}

/** The call as the P13 guards see it. */
export function guardCall(
  ctx: TurnContext,
  call: CallToAuthorize,
  actionClass = call.actionClass,
): GuardCall {
  return {
    botId: ctx.botId,
    threadId: ctx.threadId,
    runId: ctx.runId,
    ...(ctx.workerId ? { workerId: ctx.workerId } : {}),
    ...(call.callId ? { callId: call.callId } : {}),
    tool: call.tool,
    args: call.args,
    actionClass,
    level: ctx.deps.gateway.levelOf({ botId: ctx.botId, threadId: ctx.threadId }),
    signal: ctx.signal,
  };
}

/**
 * `authorizeCall` with the P13 guards: a call the gate would allow is first
 * shown to `review` (a reason turns it into a card), and a run nobody can
 * answer (提前做) has its cards turned into denials. Without guards it is
 * exactly `authorizeCall`.
 */
export async function authorizeGuarded(ctx: TurnContext, call: CallToAuthorize): Promise<Authorization> {
  const g = ctx.deps.guards;
  // P14: a read-only research worker (主動留意) may not run anything but reads, whatever the level says.
  let restricted: string | undefined;
  try {
    restricted = ctx.deps.restrict?.({
      botId: ctx.botId,
      ...(ctx.workerId ? { workerId: ctx.workerId } : {}),
      actionClass: call.actionClass,
      tool: call.tool,
    });
  } catch {
    restricted = "主機檢查失敗，不執行";
  }
  if (restricted) return authorizeCall(ctx, call, { deny: restricted });
  // A8: an engine's own scheduling / sub-agent tools are refused with or without guards.
  if (BACKGROUND_TOOLS.has(call.tool)) return authorizeCall(ctx, call, { deny: BACKGROUND_REASON });
  if (!g) return authorizeCall(ctx, call);
  // S2.1: refused outright, whatever the rules, the level or a person would say.
  const deny = forbidden(ctx, call);
  if (deny) return authorizeCall(ctx, call, { deny });
  let noAsk: string | undefined;
  try {
    noAsk = g.noAsk?.({ runId: ctx.runId, ...(ctx.workerId ? { workerId: ctx.workerId } : {}) });
  } catch {
    noAsk = "背景工作不能請你批准";
  }
  let escalate: string | undefined;
  if (g.review || g.folder) {
    const pre = ctx.deps.gateway.preview(requestOf(ctx, call), contextOf(ctx, call));
    if (pre.effect === "allow" && g.review) {
      try {
        escalate = await g.review(guardCall(ctx, call));
      } catch (err) {
        escalate = `主機檢查失敗，改為先問你（${String((err as Error)?.message ?? err).slice(0, 120)}）`;
      }
    } else if (pre.effect !== "deny" && g.folder) {
      // It asks anyway: still say on the card that (and where) it reaches outside the folder.
      try {
        escalate = g.folder(guardCall(ctx, call)) ?? g.outsideNote?.(guardCall(ctx, call));
      } catch {
        // the card goes up either way; only its wording is missing
      }
    }
  }
  return authorizeCall(ctx, call, {
    ...(escalate ? { escalate } : {}),
    ...(noAsk ? { noAsk } : {}),
  });
}

/** S2.1: why the guards refuse this call outright (fails closed when the check throws). */
export function forbidden(ctx: TurnContext, call: CallToAuthorize): string | undefined {
  if (BACKGROUND_TOOLS.has(call.tool)) return BACKGROUND_REASON;
  const g = ctx.deps.guards;
  if (!g?.forbid) return undefined;
  try {
    return g.forbid(guardCall(ctx, call));
  } catch {
    return "主機檢查失敗，不執行";
  }
}

/** P13: the call is cleared; let the guards keep what it is about to change. */
export function beforeRun(ctx: TurnContext, call: CallToAuthorize, actionClass: ActionClass): void {
  try {
    ctx.deps.guards?.beforeRun?.(guardCall(ctx, call, actionClass));
  } catch {
    // a snapshot must never stop the call the person (or the level) allowed
  }
}

/** P13: the call reported back; let the guards finish (a shell command's changes are journaled). */
export function afterRun(ctx: TurnContext, callId: string): void {
  try {
    ctx.deps.guards?.afterRun?.({ runId: ctx.runId, callId });
  } catch {
    // undo bookkeeping never fails the call
  }
}

export function emitApprovalRequested(ctx: TurnContext, auth: Authorization, callId: string): void {
  const rec = auth.approvalId ? ctx.deps.gateway.approval(auth.approvalId) : undefined;
  if (!rec) return;
  // P14: the person's standing instructions for this kind of action, as the card shows them (已套用).
  let applied: string[] = [];
  try {
    applied = (
      ctx.deps.applied?.({
        botId: ctx.botId,
        actionClass: auth.request.actionClass,
        tool: auth.request.action,
      }) ?? []
    )
      .map((a) => a.slice(0, 200))
      .filter(Boolean)
      .slice(0, 5);
  } catch {
    applied = [];
  }
  ctx.deps.emit("approval.requested", {
    approvalId: rec.id,
    callId,
    ...(rec.botId ? { botId: rec.botId } : {}),
    ...(rec.workerId ? { workerId: rec.workerId } : {}),
    actionClass: auth.request.actionClass,
    summary: rec.summary,
    ...(applied.length ? { applied } : {}),
  });
}

/**
 * If the approval has been resolved, emit `approval.resolved` and report the outcome.
 * Returns undefined while it is still pending.
 */
export function settleApproval(
  ctx: TurnContext,
  approvalId: string,
): "approved" | "denied" | "expired" | undefined {
  const rec = ctx.deps.gateway.approval(approvalId);
  if (!rec || rec.status === "pending") return undefined;
  const by = rec.resolvedBy ?? { kind: "system", id: "unknown" };
  const kind = (["user", "agent", "tool", "system"] as const).find((k) => k === by.kind) ?? "system";
  ctx.deps.emit("approval.resolved", { approvalId, decision: rec.status, by: { kind, id: by.id } });
  return rec.status;
}

/** Mark the turn job outbound as soon as an outbound-class action is cleared to run. */
export function noteOutbound(
  ctx: TurnContext,
  actionClass: ActionClass,
  detail: Record<string, unknown>,
): void {
  const type = outboundEventFor(actionClass);
  if (type) ctx.deps.jobs.record(ctx.jobId, type, detail);
}

/** Block until the card is answered (or the run is interrupted), with run/job status kept honest. */
export async function waitForHuman(ctx: TurnContext, ids: readonly string[], reason: string): Promise<void> {
  const { deps } = ctx;
  deps.store.runs.setStatus(ctx.runId, "waiting");
  deps.jobs.wait(ctx.jobId, reason);
  try {
    await Promise.all(ids.map((id) => deps.human.wait(id, ctx.signal)));
  } finally {
    deps.store.runs.setStatus(ctx.runId, "running");
    deps.jobs.resume(ctx.jobId);
  }
}

/** Ask the user a question and wait for the answer (used by tool-owning engines). */
export async function askAndWait(ctx: TurnContext, prompt: string, choices?: string[]): Promise<string> {
  const id = newId("question");
  ctx.deps.store.human.askQuestion({ id, runId: ctx.runId, prompt, ...(choices?.length ? { choices } : {}) });
  ctx.deps.emit("question.asked", { questionId: id, prompt, ...(choices?.length ? { choices } : {}) });
  await waitForHuman(ctx, [id], "question");
  const answer = ctx.deps.store.human.question(id)?.answer ?? "";
  ctx.deps.emit("question.answered", { questionId: id, answer });
  return answer;
}

/** Put a question card up without waiting (host-loop `gate`). */
export function askQuestion(ctx: TurnContext, prompt: string, choices?: string[]): string {
  const id = newId("question");
  ctx.deps.store.human.askQuestion({ id, runId: ctx.runId, prompt, ...(choices?.length ? { choices } : {}) });
  ctx.deps.emit("question.asked", { questionId: id, prompt, ...(choices?.length ? { choices } : {}) });
  return id;
}

/** Shape of the CLI's built-in question tool input, read defensively. */
export function questionFromToolInput(input: Record<string, unknown>): { prompt: string; choices: string[] } {
  const qs = Array.isArray(input.questions) ? (input.questions as Array<Record<string, unknown>>) : [];
  const first = qs[0] ?? input;
  const prompt =
    typeof first.question === "string"
      ? first.question
      : typeof input.prompt === "string"
        ? input.prompt
        : "需要你的回答";
  const opts = Array.isArray(first.options)
    ? (first.options as unknown[])
    : Array.isArray(input.choices)
      ? (input.choices as unknown[])
      : [];
  const choices = opts
    .map((o) =>
      typeof o === "string"
        ? o
        : typeof o === "object" && o && typeof (o as { label?: unknown }).label === "string"
          ? (o as { label: string }).label
          : "",
    )
    .filter((s) => s !== "");
  return { prompt, choices };
}

/** Workers do not talk to people (plan v4): what they need goes into their result for the router. */
export const WORKER_CANNOT_ASK = "工人不能直接問使用者；請把需要使用者決定的事寫進你的結果，總機會去問。";
