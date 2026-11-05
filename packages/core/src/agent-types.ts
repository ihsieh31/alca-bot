/** Error classes and option / spec interfaces of `AlcaCore` (split out of agent.ts; re-exported there). */
import type { Settings } from "@alca/config";
import type { Engine } from "@alca/engines";
import type { AlcaEvent, FinishReasonT, InitiatorT } from "@alca/protocol";
import type { ApprovalRecord, QuestionRecord, Store, Thread } from "@alca/store";
import type { RetryBudget } from "./harness/retry.ts";
import type { TurnHooks } from "./learning.ts";
import type { TurnPipeline } from "./pipeline.ts";
import type { PromptProfile, RecallItem } from "./prompt.ts";
import type { Emit, HostTool, TurnContext, TurnGuards, TurnRole, TurnState } from "./turn.ts";

export class ThreadBusyError extends Error {
  constructor(threadId: string) {
    super(`thread ${threadId} already has a running turn`);
    this.name = "ThreadBusyError";
  }
}

/** A thread that routines, triggers or live workers still use cannot be deleted. */
export class ThreadInUseError extends Error {
  readonly uses: { routines: number; triggers: number; workers: number };
  constructor(threadId: string, uses: { routines: number; triggers: number; workers: number }) {
    const parts = [
      uses.routines ? `${uses.routines} 個例行工作` : "",
      uses.workers ? `${uses.workers} 個進行中的工作` : "",
      uses.triggers ? `${uses.triggers} 個觸發器` : "",
    ].filter(Boolean);
    super(`這個對話還有${parts.join("、")}，先停掉或刪除它們再刪對話（${threadId}）`);
    this.name = "ThreadInUseError";
    this.uses = uses;
  }
}

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`);
    this.name = "NotFoundError";
  }
}

export interface AlcaCoreOptions {
  store: Store;
  engine: Engine;
  settings?: () => Settings;
  rules?: () => readonly unknown[];
  tools?: readonly HostTool[];
  profile?: PromptProfile;
  now?: () => Date;
  timeZone?: string;
  recall?: (text: string) => RecallItem[];
  /** Memory + learning hooks around every turn (P5; `Learning` implements them). */
  hooks?: TurnHooks;
  maxPasses?: number;
  /** Bot that new threads belong to (default: the store's default bot, created on first launch). */
  botId?: string;
  /** Override phases (tests, evals). */
  pipeline?: TurnPipeline<TurnState, TurnContext>;
  /**
   * After a turn timed out and its engine was told to stop, how long to wait
   * for the pipeline to wind down before the core closes the run itself
   * (an engine that ignores its interrupt). Default 15 s.
   */
  forceCloseGraceMs?: number;
  /** P13 host checks around tool calls (work folder, shell review, undo); also `useGuards`. */
  guards?: TurnGuards;
}

/** @internal */
export interface ActiveRun {
  runId: string;
  controller: AbortController;
  emit: Emit;
  engine: Engine;
  /** Engine conversation key (thread id, or the bot's router key). */
  key: string;
  done: Promise<FinishReasonT>;
}

/** What `AgentSystem` hands the core for router mode. */
export interface RouterMode {
  engine: Engine;
  /** A bot's own router engine (P7: engine + model per bot); undefined = `engine`. */
  engineFor?: (botId: string) => Engine | undefined;
  tools: readonly HostTool[];
  profile: PromptProfile;
  /** The bot's resident router conversation key. */
  sessionKey(botId: string): string;
  contextLines(threadId: string, text: string, botId: string): string[];
  /** One router turn per bot at a time (its engine conversation is one session). */
  acquire(botId: string): Promise<void>;
  release(botId: string): void;
}

/** One run, as `AlcaCore.launch` starts it. */
export interface RunSpec {
  threadId: string;
  text: string;
  initiator?: InitiatorT;
  attended?: boolean;
  role?: TurnRole;
  engine?: Engine;
  tools?: readonly HostTool[];
  profile?: PromptProfile;
  botId?: string;
  sessionKey?: string;
  workerId?: string;
  /** Run as this existing (running) job instead of a new turn job; the caller settles it. */
  jobId?: string;
  parentRunId?: string;
  /** How the incoming text is stored and shown: a person's message, or a system note. */
  messageRole?: "user" | "system";
  /** Where the run's events go (default: the thread's subscribers on the bus). */
  publish?: (e: AlcaEvent) => void;
  maxPasses?: number;
  /** Plan §2.1: a harness worker's run — its tool calls go through the harness executor. */
  harnessExec?: boolean;
  /** Plan §2.6: retry a model call that failed before streaming anything (API engines), with this allowance. */
  retry?: RetryBudget;
  /** Plan §2.3: every usage report of the engine, as it arrives (tokens are booked at once). */
  onUsage?: (u: { inputTokens: number; outputTokens: number; cachedInputTokens?: number }) => void;
  /** Research audit A5: a note for the next pass when the context is full between passes. */
  passBoundary?: () => string | undefined;
  speculative?: boolean;
  contextLines?: readonly string[];
  /** Awaited before the pipeline starts; `after` runs when the run is over. */
  before?: () => Promise<void>;
  after?: () => void;
  /** Hold the thread busy while this run is open (thread / router turns; not workers). */
  track?: boolean;
}

export interface ThreadState {
  thread: Thread;
  activeRunId: string | null;
  pendingApprovals: ApprovalRecord[];
  pendingQuestions: QuestionRecord[];
}
