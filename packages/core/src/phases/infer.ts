import { isAlwaysConfirm } from "@alca/config";
import type {
  EngineEvent,
  HostToolCallRequest,
  HostToolCallResult,
  PermissionAnswer,
  PermissionRequest,
} from "@alca/engines";
import { type ActionClass, classifyToolCall, isActionClass, shellCommandOf, shellLooks } from "@alca/policy";
import { newId } from "@alca/protocol";
import { appendAudit } from "@alca/store";
import { botPromptLanguage } from "../conversation-rules.ts";
import { noteProgress } from "../harness/retry.ts";
import type { PhaseVerdict } from "../pipeline.ts";
import { abortedFinish } from "../run-limits.ts";
import { ASK_USER_TOOL, type PlannedCall, sessionKeyOf, type TurnContext, type TurnState } from "../turn.ts";
import { type ConfineBox, confineBox } from "../workspace/sandbox.ts";
import { ENGINE_NOTICES } from "./engine-notices.ts";
import { canonicalArgs, runEngineHostCall } from "./engine-tools.ts";
import {
  afterRun,
  askAndWait,
  authorizeGuarded,
  BACKGROUND_TOOLS,
  beforeRun,
  emitApprovalRequested,
  forbidden,
  noteOutbound,
  questionFromToolInput,
  requestOf,
  settleApproval,
  WORKER_CANNOT_ASK,
  waitForHuman,
} from "./human.ts";
import { retryingTurn } from "./infer-retry.ts";

const MAX_RESULT_CHARS = 4000;

export const ROUTER_NATIVE_TOOL = "router.native_tool";
/** Review 2026-11-04b S1.3: a worker's (or a direct turn's) engine ran a native tool it should have asked about. */
export const ENGINE_NATIVE_TOOL = "engine.native_tool";
/** ACP tool kinds that only look (spec: read, search, think); every other kind may change something. */
const LOOK_KINDS = new Set(["read", "search", "think"]);

/**
 * Engine meta tools a router may call itself: they ask the person or load tool
 * schemas and change nothing (Claude Code ≥ 2.1 calls ToolSearch to load
 * deferred MCP tools before the first dispatch; mac test 2026-11-04).
 */
export const ROUTER_META_TOOLS: ReadonlySet<string> = new Set(["AskUserQuestion", "ToolSearch"]);

/** Another MCP server's tool, as Claude Code (`mcp__s__t`) or Codex (`mcp:s/t`) names it. */
const isMcp = (tool: string) => tool.startsWith("mcp__") || tool.startsWith("mcp:");

/** An engine's own file tools: a failed call returned no file content and changed nothing. */
const NATIVE_FILE_TOOLS = new Set([
  "Read",
  "Edit",
  "MultiEdit",
  "Write",
  "NotebookEdit",
  "Grep",
  "Glob",
  "LS",
]);

/**
 * Mac device test 2026-11-05 M2: Claude Code refuses a read of Alca's data
 * folder with its own deny rules (args.ts dataDenyRules), before the
 * permission tool is asked, so the call reaches Alca only as a failed result
 * with the CLI's words. A failed file tool on the data folder did not run:
 * the person is told why in Alca's words, and it is not a breach. A shell
 * command is never excused this way (it may have run and then failed).
 */
function refusedOnDataFolder(
  ctx: TurnContext,
  tool: string,
  args: Record<string, unknown>,
): string | undefined {
  if (!ctx.deps.engine.capabilities.ownsToolLoop || !NATIVE_FILE_TOOLS.has(tool)) return undefined;
  if (BACKGROUND_TOOLS.has(tool) || shellCommandOf(tool, args) !== undefined) return undefined;
  return forbidden(ctx, { callId: "", tool, args, actionClass: declaredClass(ctx, tool, args) });
}

/** A native (engine-owned) tool call in a router turn that could change something. */
export function routerBreach(ctx: TurnContext, tool: string, args: Record<string, unknown>): boolean {
  const { deps } = ctx;
  if (ctx.role !== "router" || !deps.engine.capabilities.ownsToolLoop) return false;
  if (deps.tools.has(tool) || tool === ASK_USER_TOOL || ROUTER_META_TOOLS.has(tool)) return false;
  // A read-only sandbox (Codex) covers its shell and files, never another server's MCP tool.
  if (deps.engine.capabilities.nativeToolsReadOnly && !isMcp(tool)) return false;
  const kind = args.kind;
  if (typeof kind === "string") return !LOOK_KINDS.has(kind);
  return declaredClass(ctx, tool, args) !== "read";
}

/**
 * Review 2026-11-04b S1.3: a native call that ran WITHOUT asking, in any role,
 * that Alca would not have let run unasked. The engine's own configuration
 * (an allow rule, an auto mode, a profile, a misbehaving CLI) skipped the
 * permission prompt; the run is stopped and the person told. Returns why.
 *
 * - router: anything that is not a look (routerBreach);
 * - worker / thread: what the gate would refuse or ask about right now —
 *   an always-confirm class, a deny, a shell command the floor cannot vouch
 *   for — except a plain look (`ls`, `git status`) the CLI's own read-only
 *   list lets through, and the shell / files of a read-only sandbox (Codex);
 * - every role: anything that reaches Alca's data folder (S2.1), even a read
 *   inside a read-only sandbox.
 */
export function nativeBreach(
  ctx: TurnContext,
  tool: string,
  args: Record<string, unknown>,
): string | undefined {
  const { deps } = ctx;
  if (!deps.engine.capabilities.ownsToolLoop) return undefined;
  if (deps.tools.has(tool) || tool === ASK_USER_TOOL || ROUTER_META_TOOLS.has(tool)) return undefined;
  const call = { callId: "", tool, args, actionClass: declaredClass(ctx, tool, args) };
  const refused = forbidden(ctx, call);
  if (refused) return refused;
  if (ctx.role === "router") return routerBreach(ctx, tool, args) ? "總機不能自己動手" : undefined;
  if (deps.engine.capabilities.nativeToolsReadOnly && !isMcp(tool)) return undefined;
  if (call.actionClass === "read") return undefined;
  if (typeof args.kind === "string" && LOOK_KINDS.has(args.kind)) return undefined;
  const pre = deps.gateway.preview(requestOf(ctx, call), {
    botId: ctx.botId,
    threadId: ctx.threadId,
    ...(ctx.workerId ? { workerId: ctx.workerId } : {}),
  });
  if (pre.effect === "allow") return undefined;
  const command = shellCommandOf(tool, args);
  if (
    pre.effect === "ask" &&
    !isAlwaysConfirm(call.actionClass) &&
    command !== undefined &&
    shellLooks(command)
  )
    return undefined;
  return pre.reason;
}

/** Engine-side tool call bookkeeping for engines that run their own tools. */
interface ObservedCall {
  callId: string;
  tool: string;
  args: Record<string, unknown>;
  startedAt: number;
}

function claimsFor(_tool: string, args: Record<string, unknown>, actionClass: ActionClass) {
  const path = [args.path, args.file_path, args.target].find((p): p is string => typeof p === "string");
  if (!path) return { reads: [], writes: [] };
  return actionClass === "read" ? { reads: [path], writes: [] } : { reads: [], writes: [path] };
}

function declaredClass(ctx: TurnContext, tool: string, args: Record<string, unknown>): ActionClass {
  const host = ctx.deps.tools.get(tool);
  if (host) return host.actionClass;
  if (tool === ASK_USER_TOOL) return "read";
  const c = classifyToolCall(tool, args);
  return isActionClass(c) ? c : "execute";
}

/**
 * Phase 3: the engine streams one pass. Text becomes message.delta /
 * message.completed. Host-loop engines hand back tool calls for plan_tools;
 * tool-owning engines report their own calls (observed here) and ask for
 * permission through `onPermission`, which runs the same gateway as `gate`.
 */
export async function infer(state: TurnState, ctx: TurnContext): Promise<PhaseVerdict<TurnState>> {
  const { deps } = ctx;
  const owns = deps.engine.capabilities.ownsToolLoop;
  const texts = [...state.assistantTexts];
  const planned: PlannedCall[] = [];
  const observed = new Map<string, ObservedCall>();
  const closed = new Set<string>();
  const usage = { ...state.usage };
  let finish = state.finish;
  let stop: EngineEvent & { type: "done" } = { type: "done", stop: "end_turn" };
  let msgId: string | undefined;
  let buf = "";
  let endProcess = false;

  const endText = () => {
    if (!msgId) return;
    deps.emit("message.completed", { messageId: msgId, role: "assistant", text: buf });
    deps.store.threads.addMessage(
      {
        id: msgId,
        threadId: ctx.threadId,
        runId: ctx.runId,
        role: "assistant",
        content: buf,
      },
      deps.now(),
    );
    texts.push(buf);
    msgId = undefined;
    buf = "";
  };

  // Host tools the engine runs through `onToolCall`: the engine reports the
  // tool_use on its stream and calls us on a separate channel, in either order.
  // `waitingHost`: observed on the stream, not yet called; `earlyHost`: called
  // before the stream reported it. Matched by tool name + canonical args.
  const waitingHost: ObservedCall[] = [];
  const earlyHost: ObservedCall[] = [];
  const takeMatch = (list: ObservedCall[], tool: string, args: Record<string, unknown>) => {
    const key = canonicalArgs(args);
    const i = list.findIndex((o) => o.tool === tool && canonicalArgs(o.args) === key);
    return i >= 0 ? list.splice(i, 1)[0] : undefined;
  };

  const observe = (engineId: string, tool: string, args: Record<string, unknown>): ObservedCall => {
    const existing = observed.get(engineId);
    if (existing) return existing;
    if (owns && deps.tools.has(tool)) {
      const early = takeMatch(earlyHost, tool, args);
      if (early) {
        observed.set(engineId, early);
        return early;
      }
    }
    const o: ObservedCall = { callId: newId("call"), tool, args, startedAt: Date.now() };
    observed.set(engineId, o);
    if (owns && deps.tools.has(tool)) waitingHost.push(o);
    deps.emit("tool.requested", {
      callId: o.callId,
      tool,
      args,
      actionClass: declaredClass(ctx, tool, args),
    });
    deps.jobs.record(ctx.jobId, "tool.requested", { callId: o.callId, tool });
    return o;
  };

  const onToolCall = async (c: HostToolCallRequest): Promise<HostToolCallResult> => {
    let o = takeMatch(waitingHost, c.toolName, c.input);
    if (!o) {
      o = observe(`host_${newId("call")}`, c.toolName, c.input);
      takeMatch(waitingHost, c.toolName, c.input); // just added by observe
      earlyHost.push(o);
    }
    return await runEngineHostCall(ctx, { callId: o.callId, tool: c.toolName, args: c.input });
  };

  /** Engine call ids the engine asked permission for (a native call that ran unasked is a router breach). */
  const asked = new Set<string>();

  const onPermission = async (p: PermissionRequest): Promise<PermissionAnswer> => {
    // Host tools are gated when the call reaches the host (onToolCall), with
    // the tool's live inspection; approving the bare intent here would be blind.
    if (p.hostTool && deps.tools.has(p.toolName)) return { behavior: "allow" };
    // The router only talks and dispatches: no engine-native tool (shell, files, web) ever runs there.
    if (p.toolUseId) asked.add(p.toolUseId);
    if (ctx.role === "router" && p.toolName !== "AskUserQuestion" && p.toolName !== ASK_USER_TOOL)
      return { behavior: "deny", message: "總機不能自己執行工具；請用 worker_start 派給工人。" };
    if ((p.toolName === "AskUserQuestion" || p.toolName === ASK_USER_TOOL) && ctx.role === "worker")
      return { behavior: "deny", message: WORKER_CANNOT_ASK };
    if (p.toolName === "AskUserQuestion" || p.toolName === ASK_USER_TOOL) {
      const q = questionFromToolInput(p.input);
      const answer = await askAndWait(ctx, q.prompt, q.choices);
      // Deny-with-message hands the answer to the model without running the CLI's own prompt UI.
      return { behavior: "deny", message: `使用者的回答：${answer}` };
    }
    const o = observe(p.toolUseId ?? `perm_${newId("call")}`, p.toolName, p.input);
    const actionClass = declaredClass(ctx, p.toolName, p.input);
    const call = { callId: o.callId, tool: p.toolName, args: p.input, actionClass };
    const auth = await authorizeGuarded(ctx, call);
    if (auth.decision.effect === "deny")
      return { behavior: "deny", message: `主機政策拒絕：${auth.decision.reason}` };
    if (auth.decision.effect === "ask" && auth.approvalId) {
      emitApprovalRequested(ctx, auth, o.callId);
      await waitForHuman(ctx, [auth.approvalId], "approval");
      const outcome = settleApproval(ctx, auth.approvalId);
      if (outcome !== "approved")
        return { behavior: "deny", message: "使用者沒有同意這個動作，請不要重試。" };
    }
    noteOutbound(ctx, auth.request.actionClass, { callId: o.callId, tool: p.toolName });
    beforeRun(ctx, call, auth.request.actionClass);
    return { behavior: "allow" };
  };

  // Next round §5.5: the sandbox an engine that runs its own commands starts in.
  // `mode: on` without a usable sandbox fails closed here (host-loop engines
  // refuse in the bash tool instead, call by call).
  const box = owns ? confineOf(ctx) : {};
  if (box.refuse) {
    deps.emit("error", { code: SANDBOX_REQUIRED, message: box.refuse, retryable: false });
    return {
      kind: "halt",
      reason: "failed",
      state: {
        ...state,
        finish: { reason: "failed", error: { code: SANDBOX_REQUIRED, message: box.refuse } },
      },
    };
  }

  // Plan §2.6: progress (a successful tool result) gives the retry allowance back.
  if (deps.retry && state.toolResults.some((r) => r.ok)) noteProgress(deps.retry);
  const retry = owns ? undefined : deps.retry;
  try {
    for await (const e of retryingTurn(
      () =>
        deps.engine.turn({
          threadId: ctx.threadId,
          runId: ctx.runId,
          ...(ctx.sessionKey ? { sessionKey: ctx.sessionKey } : {}),
          ...workDirOf(ctx),
          ...(box.spec ? { confine: box.spec } : {}),
          system: state.prompt ?? { stable: "", volatile: "" },
          userMessage: state.pass === 0 ? (state.userMessage ?? state.userText) : "",
          ...(state.pass > 0 ? { toolResults: state.toolResults } : {}),
          tools: [...deps.tools.values()].map((t) => t.spec),
          signal: ctx.signal,
          onPermission,
          ...(owns ? { onToolCall } : {}),
        }),
      retry,
      ctx.signal,
    )) {
      switch (e.type) {
        case "text.delta":
          if (!msgId) msgId = newId("message");
          buf += e.text;
          deps.emit("message.delta", { messageId: msgId, role: "assistant", delta: e.text });
          break;
        case "text.end":
          endText();
          break;
        case "tool.call": {
          endText();
          if (owns) {
            observe(e.id, e.name, e.input);
          } else {
            const actionClass = declaredClass(ctx, e.name, e.input);
            planned.push({
              callId: newId("call"),
              engineCallId: e.id,
              tool: e.name,
              args: e.input,
              actionClass,
              claims: claimsFor(e.name, e.input, actionClass),
              status: "planned",
            });
          }
          break;
        }
        case "tool.result": {
          const o = observed.get(e.id) ?? observe(e.id, "unknown", {});
          const output = e.output.slice(0, MAX_RESULT_CHARS);
          if (closed.has(o.callId)) break;
          closed.add(o.callId);
          afterRun(ctx, o.callId);
          const refused = e.ok ? undefined : refusedOnDataFolder(ctx, o.tool, o.args);
          deps.emit("tool.completed", {
            callId: o.callId,
            ok: e.ok,
            ...(e.ok
              ? { result: output }
              : {
                  error: refused ? `${refused}（${output.slice(0, 200) || "引擎拒絕"}）` : output || "failed",
                }),
            durationMs: Math.max(0, Date.now() - o.startedAt),
          });
          const breach = asked.has(e.id) || refused ? undefined : nativeBreach(ctx, o.tool, o.args);
          if (breach) {
            // P13 (router) and review 2026-11-04b S1.3 (every role): a native tool ran without
            // asking that Alca would not have let run unasked. Stop the turn, say so, keep a record.
            const router = ctx.role === "router";
            const code = router ? ROUTER_NATIVE_TOOL : ENGINE_NATIVE_TOOL;
            deps.emit("error", {
              code,
              message: BACKGROUND_TOOLS.has(o.tool)
                ? `「${o.tool.slice(0, 60)}」是引擎內建的排程或子代理工具，沒有經過 Alca 就執行了。已停止這一輪並結束那個引擎程序，它排的工作不會執行。要定時做事請用「例行工作」。`
                : router
                  ? `總機不能自己動手（「${o.tool.slice(0, 60)}」沒有經過確認就執行了），已停止這一輪；要做事請讓總機派給工人。`
                  : `引擎沒有經過確認就執行了「${o.tool.slice(0, 60)}」（${breach.slice(0, 120)}），已停止這一輪。請檢查這個引擎自己的設定（自動核准、允許清單、MCP）。`,
              retryable: false,
            });
            recordBreach(ctx, o.tool, o.args, code, breach);
            if (!finish) finish = { reason: "failed", error: { code, message: o.tool.slice(0, 200) } };
            void deps.engine.interrupt(sessionKeyOf(ctx));
            // A8: a schedule or a sub-agent lives in the engine's process; end the process so it cannot fire.
            if (BACKGROUND_TOOLS.has(o.tool)) endProcess = true;
          }
          const v = ctx.guard.observe({ tool: o.tool, args: o.args, ok: e.ok, output });
          if (v.kind !== "ok" && v.fresh) {
            deps.emit("error", {
              code: `loop_guard.${v.kind}`,
              message: `偵測到可能的迴圈（${v.pattern}，重複 ${v.repeats} 次）`,
              retryable: v.kind === "warn",
            });
          }
          if (v.kind === "stop" && !finish) {
            finish = { reason: "failed", error: { code: "loop_guard.stop", message: String(v.pattern) } };
            void deps.engine.interrupt(sessionKeyOf(ctx));
          }
          break;
        }
        case "usage":
          usage.inputTokens += e.inputTokens;
          usage.outputTokens += e.outputTokens;
          usage.cachedInputTokens += e.cachedInputTokens ?? 0;
          try {
            deps.onUsage?.({
              inputTokens: e.inputTokens,
              outputTokens: e.outputTokens,
              ...(e.cachedInputTokens ? { cachedInputTokens: e.cachedInputTokens } : {}),
            });
          } catch {
            // booking tokens must not break the turn
          }
          break;
        case "error":
          deps.emit("error", { code: e.code, message: e.message, retryable: e.retryable });
          if (!finish) finish = { reason: "failed", error: { code: e.code, message: e.message } };
          break;
        case "notice":
          // Review 2026-11-05 #4: visible, in the bot's language, and the turn goes on.
          deps.emit("error", { code: e.code, message: noticeText(ctx, e), retryable: true });
          break;
        case "done":
          stop = e;
          break;
        case "session":
          break;
      }
    }
  } finally {
    endText();
  }
  if (endProcess) await deps.engine.release?.(sessionKeyOf(ctx)).catch(() => undefined);

  // Calls that never reported back were cut off (interrupt / crash): close them honestly.
  for (const o of observed.values()) {
    if (closed.has(o.callId)) continue;
    afterRun(ctx, o.callId);
    deps.emit("tool.completed", {
      callId: o.callId,
      ok: false,
      error: "未完成（回合已中斷）",
      durationMs: Math.max(0, Date.now() - o.startedAt),
    });
  }

  const next: TurnState = { ...state, assistantTexts: texts, calls: planned, usage, pass: state.pass + 1 };
  if (finish && finish.error?.code === "loop_guard.stop")
    return { kind: "halt", reason: "loop_guard", state: { ...next, finish } };
  if (ctx.signal.aborted || stop.stop === "interrupted") {
    return {
      kind: "halt",
      reason: "interrupted",
      state: {
        ...next,
        finish: finish ?? (ctx.signal.aborted ? abortedFinish(ctx.signal) : { reason: "interrupted" }),
      },
    };
  }
  if (stop.stop === "error" || finish) {
    return { kind: "halt", reason: "failed", state: { ...next, finish: finish ?? { reason: "failed" } } };
  }
  if (stop.stop === "max_turns")
    return { kind: "halt", reason: "max_turns", state: { ...next, finish: { reason: "max_turns" } } };
  if (planned.length > 0) return { kind: "continue", state: next };
  return { kind: "jump", to: "reflect", state: next };
}

/** An engine notice in the bot's language (a code the core knows, else the engine's own words). */
function noticeText(ctx: TurnContext, e: { code: string; message: string }): string {
  const words = ENGINE_NOTICES[e.code];
  if (!words) return e.message;
  try {
    return words[botPromptLanguage(ctx.deps.store.bots.get(ctx.botId))];
  } catch {
    return words.zh;
  }
}

/** The audit row for a native call that ran unasked (the gate never saw it). */
function recordBreach(
  ctx: TurnContext,
  tool: string,
  args: Record<string, unknown>,
  code: string,
  reason: string,
): void {
  try {
    appendAudit(ctx.deps.store.db, {
      ts: new Date().toISOString(),
      initiator: ctx.initiator,
      actor: { kind: "agent", id: ctx.botId },
      action: tool.slice(0, 200),
      actionClass: declaredClass(ctx, tool, args),
      decision: "deny",
      detail: {
        reason: `ran without asking: ${reason}`.slice(0, 300),
        code,
        runId: ctx.runId,
        ...(ctx.workerId ? { workerId: ctx.workerId } : {}),
        args,
      },
    });
  } catch {
    // the error event and the stopped run are the record the person sees
  }
}

export const SANDBOX_REQUIRED = "sandbox.required";

/** Next round §5.5: the OS sandbox for an engine's own commands (the bot's setting at this level). */
function confineOf(ctx: TurnContext): ConfineBox {
  try {
    const level = ctx.deps.gateway.levelOf({ botId: ctx.botId, threadId: ctx.threadId });
    return confineBox(ctx.deps.guards?.confine?.(ctx.botId, level));
  } catch {
    return {};
  }
}

/** P13: the bot's working folder for the engine (none when the guards have none or it fails). */
function workDirOf(ctx: TurnContext): { cwd?: string } {
  try {
    const cwd = ctx.deps.guards?.workDir?.(ctx.botId);
    return cwd ? { cwd } : {};
  } catch {
    return {};
  }
}
