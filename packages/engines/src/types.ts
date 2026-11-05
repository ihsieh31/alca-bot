import { createHash } from "node:crypto";
import type { ConfineSpec } from "@alca/os";

export type EngineKind = "cli" | "acp" | "api" | "scripted";

/**
 * Declarative capability descriptor: what an engine can do, so core never
 * special-cases an engine by name. Plain JSON so it can live in config or be
 * shown in the 模型 settings page.
 */
export interface EngineCapabilities {
  kind: EngineKind;
  /** Keeps one long-lived process per thread. */
  persistentProcess: boolean;
  /** Emits text deltas while the answer is generated. */
  streaming: boolean;
  /** Can continue an earlier conversation from a stored session id. */
  resume: boolean;
  /** Can stop the current turn without killing the conversation. */
  interrupt: boolean;
  /**
   * true: the engine runs its own tools (CLI agents) and asks the host for
   * permission; false: the engine returns tool calls for the host to run.
   */
  ownsToolLoop: boolean;
  /** Native permission modes the engine understands (informational). */
  nativePermissionModes: readonly string[];
  /** How permission prompts reach the host. */
  permissionPrompt: "mcp_tool" | "host_loop" | "none";
  /** System prompt is fixed at launch (volatile context must go in the user message). */
  systemPromptAtLaunch: boolean;
  supportsPromptCache: boolean;
  supportsImages: boolean;
  /**
   * The engine's own tools can only read (e.g. Codex in its read-only
   * sandbox): a native call it reports cannot change anything. Absent = a
   * native call may write, run or send, and a router turn that runs one is
   * stopped by the core.
   */
  nativeToolsReadOnly?: boolean;
  maxContextTokens?: number;
  /**
   * Plan §3.1: what this engine instance can do for a worker harness (the
   * host checks it before dispatching, `checkHarnessFit`). Absent = derived
   * from the fields above (`harnessCapsOf`).
   */
  harness?: HarnessCaps;
}

/**
 * Plan §3.1: one engine instance's harness capabilities.
 * - `loop`: who runs the tool loop (Alca's own, or the CLI's);
 * - `writes`: how the engine changes files — its own native tools, only
 *   through the host's (gated) tools, or not at all;
 * - `asksBeforeWrite` / `asksBeforeExec`: whether a native write / command
 *   always reaches the host's gate first (`every`), sometimes, or never;
 * - `nativeStepCap`: the engine's own turn cap (a backstop; the watchdog's
 *   step count is the real one), null = none;
 * - `interrupt`, `usageStreaming` (usage per message / per turn / none), `resume`.
 */
export interface HarnessCaps {
  loop: "own" | "cli";
  writes: "native" | "host_tools" | "none";
  asksBeforeWrite: "every" | "some" | "never";
  asksBeforeExec: "every" | "some" | "never";
  nativeStepCap: number | null;
  interrupt: boolean;
  usageStreaming: "per_message" | "per_turn" | "none";
  resume: boolean;
  /** One sentence added to a refusal (why this engine cannot take the work now, what would change it). */
  note?: string;
}

/** Everything that, when changed, requires restarting a persistent engine process. */
export interface EngineLaunchConfig {
  engineId: string;
  model?: string;
  cwd: string;
  /** Stable system prompt layer (cache friendly, byte-identical across turns). */
  stablePrompt: string;
  env: Readonly<Record<string, string>>;
  approvalMode: string;
  extraArgs?: readonly string[];
  /**
   * Next round §5.5: the OS sandbox for the commands the CLI runs itself
   * (Claude Code's own sandbox block in `--settings`, Codex's writable roots
   * and network, an ACP agent's whole process). Unset = no sandbox. Part of
   * the launch hash: a changed setting restarts the resident process.
   */
  confine?: ConfineSpec;
}

/**
 * Hash of everything that requires restarting a persistent engine process.
 * Volatile context is excluded on purpose: it changes every turn.
 */
export function launchConfigHash(c: EngineLaunchConfig): string {
  const env = Object.keys(c.env)
    .sort()
    .map((k) => [k, c.env[k]]);
  return createHash("sha256")
    .update(
      JSON.stringify([
        c.engineId,
        c.model ?? null,
        c.cwd,
        c.stablePrompt,
        c.approvalMode,
        env,
        c.extraArgs ?? [],
        // Appended only when set, so the hash of an unsandboxed launch is what it always was.
        ...(c.confine ? [confineKey(c.confine)] : []),
      ]),
    )
    .digest("hex");
}

/** A sandbox spec as a stable value (sorted lists) for the launch hash. */
function confineKey(c: ConfineSpec): unknown[] {
  const sorted = (a: readonly string[]) => [...a].sort();
  return [
    "confine",
    c.kind,
    c.workDir,
    c.tmpDir,
    sorted(c.extraWritable),
    sorted(c.denyRead),
    sorted(c.denyWriteInside),
    c.network,
    c.corePort ?? null,
  ];
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolResultInput {
  /** The engine's own id for the call it asked for. */
  id: string;
  ok: boolean;
  output: string;
}

/** A permission prompt from an engine that runs its own tools. */
export interface PermissionRequest {
  toolName: string;
  input: Record<string, unknown>;
  /** The engine's id for the tool call this permission is for, when it gives one. */
  toolUseId?: string;
  /** Set by the engine: `toolName` is one of the host's own tools (from `tools`), not an engine-native tool. */
  hostTool?: boolean;
}

export type PermissionAnswer = { behavior: "allow" } | { behavior: "deny"; message: string };

/** A tool-owning engine asks the host to run one of the host's own tools (`EngineTurnRequest.tools`). */
export interface HostToolCallRequest {
  /** Host tool name, without any engine-side prefix (e.g. "browser_click"). */
  toolName: string;
  input: Record<string, unknown>;
}

export interface HostToolCallResult {
  ok: boolean;
  output: string;
}

/** What one engine turn produces. Core maps these onto Alca Event Protocol events. */
export type EngineEvent =
  | { type: "session"; sessionId: string; model?: string }
  | { type: "text.delta"; text: string }
  /** The current assistant text segment ended (a tool call follows, or the turn ends). */
  | { type: "text.end" }
  /** Tool call. For host-loop engines the host must run it; for tool-owning engines it is an observation. */
  | { type: "tool.call"; id: string; name: string; input: Record<string, unknown> }
  /** Observed result of a tool the engine ran itself. */
  | { type: "tool.result"; id: string; ok: boolean; output: string }
  | { type: "usage"; inputTokens: number; outputTokens: number; cachedInputTokens?: number }
  | { type: "error"; code: string; message: string; retryable: boolean }
  /**
   * Review 2026-11-05 #4: something the person should know that does not fail
   * the turn (the stored session could not be resumed, so this turn starts
   * fresh). `code` is stable (the host words it in the bot's language);
   * `message` is a Chinese default for hosts that do not.
   */
  | { type: "notice"; code: string; message: string }
  | { type: "done"; stop: "end_turn" | "tool_use" | "interrupted" | "error" | "max_turns" };

export interface EngineTurnRequest {
  threadId: string;
  runId: string;
  /**
   * Which engine conversation this turn continues (default: `threadId`).
   * A bot's router keeps one conversation across threads, and every worker
   * has its own (P3); persistent engines keep one process per key.
   */
  sessionKey?: string;
  /**
   * P13: the bot's working folder. Engines that run their own tools start
   * (or restart) the conversation's process there; unset = the launch config's.
   */
  cwd?: string;
  /**
   * Next round §5.5: the OS sandbox this turn's own commands run in (the
   * bot's setting at its level, from the core's guards). Engines that run
   * their own tools put it in their launch (`withTurnCwd`); unset = none.
   */
  confine?: ConfineSpec;
  system: { stable: string; volatile: string };
  /** User message as composed by core (recalled memory already inside, never in the system prompt). */
  userMessage: string;
  /** Results for the tool calls of the previous pass (host-loop engines only). */
  toolResults?: readonly ToolResultInput[];
  tools?: readonly ToolSpec[];
  signal: AbortSignal;
  /** Called when a tool-owning engine needs a yes/no from the host. Absent → deny. */
  onPermission?: (req: PermissionRequest) => Promise<PermissionAnswer>;
  /**
   * Tool-owning engines that expose the host's `tools` to their model call
   * this to run one; the host gates, runs and answers. Absent → the call fails.
   */
  onToolCall?: (req: HostToolCallRequest) => Promise<HostToolCallResult>;
}

export interface Engine {
  readonly id: string;
  readonly capabilities: EngineCapabilities;
  turn(req: EngineTurnRequest): AsyncIterable<EngineEvent>;
  /** Stop the current turn of a conversation (its `sessionKey`, default the thread id); the conversation survives. */
  interrupt(key: string): Promise<void>;
  /** Optional: free a conversation's resources (e.g. a finished worker's process); it can still be resumed later. */
  release?(key: string): Promise<void>;
  /**
   * Mac test 2026-11 B4: the same engine started so that it cannot change
   * anything (no native tools at all), for the independent reviewer. Absent =
   * no such variant; an engine whose own tools are already read-only (or that
   * owns no tool loop) is used as it is.
   */
  readOnlyVariant?(): Engine | undefined;
  dispose(): Promise<void>;
}

/** A small async queue: producers push, one consumer iterates. */
export class EventQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private waiters: Array<(r: IteratorResult<T>) => void> = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value: item, done: false });
    else this.items.push(item);
  }

  close(): void {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

/** The launch config with the turn's working folder (P13), when the turn names one. */
export function withTurnCwd(
  cfg: EngineLaunchConfig,
  req: Pick<EngineTurnRequest, "cwd" | "confine">,
): EngineLaunchConfig {
  const cwd = req.cwd && req.cwd !== cfg.cwd ? { cwd: req.cwd } : {};
  const confine = req.confine ? { confine: req.confine } : {};
  return req.confine || (req.cwd && req.cwd !== cfg.cwd) ? { ...cfg, ...cwd, ...confine } : cfg;
}

/** The conversation key a turn runs under. */
export function conversationKey(req: Pick<EngineTurnRequest, "threadId" | "sessionKey">): string {
  return req.sessionKey ?? req.threadId;
}
