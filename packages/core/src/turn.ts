import type { PermissionLevelT } from "@alca/config";
import type { Engine, ToolResultInput } from "@alca/engines";
import type { JobRuntime } from "@alca/jobs";
import type { ActionClass, ActionGateway, Authorization } from "@alca/policy";
import type { ActorT, AlcaEvent, EventData, EventType, FinishReasonT, InitiatorT } from "@alca/protocol";
import type { Store } from "@alca/store";
import type { HostTool, LoopGuardPolicy, PathClaims, RegisteredTool } from "@alca/tools";
import type { RetryBudget } from "./harness/retry.ts";
import type { LoopGuard } from "./loop-guard.ts";
import type { PhaseContext } from "./pipeline.ts";
import type { PromptLayers, PromptProfile, RecallItem } from "./prompt.ts";
import type { ConfinePlan } from "./workspace/sandbox.ts";

/** A tool the host runs itself: the contract lives in `@alca/tools` (P13), re-exported here. */
export type { HostTool } from "@alca/tools";

/** Adapt registry tools (`@alca/tools`) to host tools. */
export function hostToolsFrom(tools: readonly RegisteredTool[]): HostTool[] {
  return tools.map((t) => ({
    spec: { name: t.name, description: t.summary, inputSchema: t.inputSchema },
    actionClass: t.actionClass,
    ...(t.inspect ? { inspect: t.inspect.bind(t) } : {}),
    run: (args, signal, ctx) =>
      t.run(args, {
        signal,
        actionClass: ctx?.actionClass ?? t.actionClass,
        ...(ctx ? { threadId: ctx.threadId, runId: ctx.runId, botId: ctx.botId } : {}),
        ...(ctx?.workerId ? { workerId: ctx.workerId } : {}),
      }),
  }));
}

/** The built-in tool a host-loop engine calls to put a question card in front of the user. */
export const ASK_USER_TOOL = "ask_user";

export type CallStatus = "planned" | "awaiting" | "asking" | "allowed" | "denied" | "done";

export interface PlannedCall {
  callId: string;
  /** The engine's own id for the call (what its tool result must reference). */
  engineCallId: string;
  tool: string;
  args: Record<string, unknown>;
  actionClass: ActionClass;
  claims: PathClaims;
  status: CallStatus;
  /** From the tool's `inspect`, shown on the approval card. */
  summary?: string;
  target?: string;
  auth?: Authorization;
  approvalId?: string;
  questionId?: string;
  denyReason?: string;
  result?: { ok: boolean; output: string };
}

export interface TurnState {
  userText: string;
  /** Engine passes so far in this run (host-loop engines loop infer → execute → infer). */
  pass: number;
  prompt?: PromptLayers;
  recalled: RecallItem[];
  userMessage?: string;
  assistantTexts: string[];
  calls: PlannedCall[];
  batches: string[][];
  /** Results to hand the engine on the next pass. */
  toolResults: ToolResultInput[];
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number };
  finish?: { reason: FinishReasonT; error?: { code: string; message: string } };
}

/** How a run ended (its reason, and the error when it failed). */
export type FinishT = NonNullable<TurnState["finish"]>;

export function initialState(userText: string): TurnState {
  return {
    userText,
    pass: 0,
    recalled: [],
    assistantTexts: [],
    calls: [],
    batches: [],
    toolResults: [],
    usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
  };
}

export type Emit = <T extends EventType>(type: T, data: EventData<T>, actor?: ActorT) => AlcaEvent;

/** Resolves when a human answered an approval or question card (by id). */
export interface HumanWaits {
  wait(id: string, signal: AbortSignal): Promise<void>;
  notify(id: string): void;
}

export interface TurnDeps {
  store: Store;
  jobs: JobRuntime;
  gateway: ActionGateway;
  engine: Engine;
  tools: ReadonlyMap<string, HostTool>;
  human: HumanWaits;
  emit: Emit;
  now: () => Date;
  timeZone: string;
  profile: PromptProfile;
  recall: (
    text: string,
    info: { botId: string; threadId: string; role: TurnRole },
  ) => RecallItem[] | Promise<RecallItem[]>;
  loopGuardPolicy: LoopGuardPolicy;
  maxPasses: number;
  /** Plan §2.1: run tool calls through the harness executor (fair read/write lock, ordered results, abort placeholders). */
  harnessExec?: boolean;
  /** Plan §2.6: the retry allowance of a harness worker's model calls (API engines). */
  retry?: RetryBudget;
  /** Plan §2.3: usage as it arrives. */
  onUsage?: (u: { inputTokens: number; outputTokens: number; cachedInputTokens?: number }) => void;
  /**
   * Research audit A5: asked between two passes of a turn (reflect, before the
   * next engine pass). A note is appended to the last tool result, so the
   * model winds the turn up and the outer loop can compact before it ends.
   */
  passBoundary?: () => string | undefined;
  /** P13 host checks around tool calls (work folder, shell review, undo snapshots, background runs). */
  guards?: TurnGuards;
  /** P14: the must-follow memories an approval card for this call names (已套用). */
  applied?: (info: { botId: string; actionClass: string; tool: string }) => string[];
  /** P14: a reason this worker may not run the call at all (a read-only research worker). */
  restrict?: (info: {
    botId: string;
    workerId?: string;
    actionClass: string;
    tool: string;
  }) => string | undefined;
}

/** One tool call as the P13 guards see it. */
export interface GuardCall {
  botId: string;
  threadId: string;
  runId: string;
  workerId?: string;
  /** The call's id in this run (pairs `beforeRun` with `afterRun`). */
  callId?: string;
  tool: string;
  args: Record<string, unknown>;
  actionClass: ActionClass;
  /** The level the call runs under (the bot's, narrowed by a delegation chain). */
  level: PermissionLevelT;
  signal: AbortSignal;
}

/**
 * P13 host checks around tool calls. Each one may only make a call stricter
 * (or keep a copy of what it is about to change); none can loosen the gate.
 */
export interface TurnGuards {
  /** The bot's working folder: engines start there; undefined = the engine's own. */
  workDir?(botId: string): string | undefined;
  /**
   * Called before the gate decides a call the rules and level would allow:
   * a reason turns the allow into a card (e.g. a risky shell command, an edit
   * outside the bot's folder). Must fail closed: an error is a reason.
   */
  review?(call: GuardCall): Promise<string | undefined>;
  /**
   * Where a call reaches outside the bot's working folder, said so a card can
   * show it (with the path). Asked whenever the call is not denied, also when
   * it would ask anyway (每步確認), so that card names the target too (mac test
   * 2026-11-04: the card only said 「Write」). Must not throw.
   */
  folder?(call: GuardCall): string | undefined;
  /** Mac test 2026-11-04b A9: a card that goes up anyway names the outside paths a command uses (wording only). */
  outsideNote?(call: GuardCall): string | undefined;
  /**
   * Review 2026-11-04b S2.1: a reason DENIES the call at every level (a native
   * read / edit / shell command that reaches Alca's data folder). Also asked
   * for calls an engine ran without asking (infer's native-breach check).
   * Must not throw.
   */
  forbid?(call: GuardCall): string | undefined;
  /** The run has nobody to answer a card (提前做): a reason denies what would ask. */
  noAsk?(info: { runId: string; workerId?: string }): string | undefined;
  /** The call is cleared and about to run: keep what it will change (undo). Never throws. */
  beforeRun?(call: GuardCall): void;
  /** The call reported back (or the turn ended without its result): finish what `beforeRun` began. Never throws. */
  afterRun?(info: { runId: string; callId: string }): void;
  /**
   * Next-round §5.4: whether a bot's commands run in the OS sandbox at this
   * level (and the spec, unless `withSpec` is false). Never throws.
   */
  confine?(botId: string, level: PermissionLevelT, withSpec?: boolean): ConfinePlan;
}

/**
 * Who a run is (P3). `thread`: the thread's own turn with every host tool
 * (direct mode, tests). `router`: a bot's resident router — talks to people
 * and dispatches, has only the router tools, never a native shell or file
 * tool. `worker`: one task in its own engine conversation with the full
 * tools; it reports to the router and does not ask people questions.
 */
export type TurnRole = "thread" | "router" | "worker";

export interface TurnContext extends PhaseContext {
  deps: TurnDeps;
  initiator: InitiatorT;
  /** The `turn` job this run executes as. */
  jobId: string;
  /** The bot running this turn (owner of the thread). */
  botId: string;
  /** The worker session running this turn (role `worker`); carried to tools, the audit row and the card. */
  workerId?: string;
  role: TurnRole;
  /** Engine conversation this run continues (default: the thread id). */
  sessionKey?: string;
  /** A worker preparing ahead of a request (plan v4 提前做): its cards say so; outbound is still always confirmed. */
  speculative?: boolean;
  /** Extra lines for the volatile context layer of this run. */
  contextLines?: readonly string[];
  /** What this message's 記住／忘記 did (P5); goes into the user message, never the system prompt. */
  memoryNotes?: readonly string[];
  /** P14: the person's standing instructions for the action this message is about (fenced, user message). */
  mustFollow?: readonly string[];
  /** False when someone else settles the job at the end (a worker's job spans several runs). */
  ownsJob: boolean;
  guard: LoopGuard;
}

/** The engine conversation key of a run. */
export function sessionKeyOf(ctx: Pick<TurnContext, "sessionKey" | "threadId">): string {
  return ctx.sessionKey ?? ctx.threadId;
}
