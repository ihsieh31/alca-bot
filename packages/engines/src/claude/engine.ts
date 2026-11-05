import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { engineEnv } from "../env.ts";
import { HARNESS_MATRIX } from "../harness-matrix.ts";
import { type IdleOptions, IdleReaper } from "../idle.ts";
import {
  conversationKey,
  type Engine,
  type EngineCapabilities,
  type EngineEvent,
  type EngineLaunchConfig,
  type EngineTurnRequest,
  type HarnessCaps,
  type HostToolCallRequest,
  launchConfigHash,
  type ToolSpec,
  withTurnCwd,
} from "../types.ts";
import { buildClaudeArgs, hostToolName, type PermissionServerLaunch } from "./args.ts";
import { PermissionBridge } from "./bridge.ts";
import { ClaudeProcess } from "./process.ts";

export const CLAUDE_CODE_CAPABILITIES: EngineCapabilities = Object.freeze({
  kind: "cli",
  persistentProcess: true,
  streaming: true,
  resume: true,
  interrupt: true,
  ownsToolLoop: true,
  nativePermissionModes: ["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"],
  permissionPrompt: "mcp_tool",
  systemPromptAtLaunch: true,
  supportsPromptCache: true,
  supportsImages: true,
  // Plan §3.1: default mode + the permission tool — every native write and command asks the host.
  harness: HARNESS_MATRIX.claudeCoding,
});

/** Where the engine keeps the CLI session id per thread (backed by the store in core). */
export interface SessionMemory {
  get(key: string): string | undefined;
  set(key: string, sessionId: string): void;
  /** Review 2026-11-05 #4: forget a session that can no longer be resumed (the next turn starts fresh). */
  clear?(key: string): void;
}

/** Review 2026-11-05 #4: the stored session could not be resumed; this turn runs in a fresh one. */
export const CONTEXT_RESET = "engine.context_reset";
export const CONTEXT_RESET_NOTE =
  "之前的對話脈絡無法還原（引擎的工作階段已不存在），這一回合從新的工作階段開始。";

/** Claude Code's words when `--resume` names a session it does not have (its own jsonl was cleaned, or another cwd). */
export const RESUME_MISSING =
  /no conversation found|(?:session|conversation)[^\n]{0,60}(?:not found|does not exist)/iu;

export interface ClaudeCodeEngineOptions {
  /** Command and leading args, e.g. ["claude"] or [process.execPath, "fake-claude.ts"]. */
  command?: readonly string[];
  /** Launch config for a conversation (thread, router or worker key); called before every turn so changes are noticed. */
  launch: (key: string) => EngineLaunchConfig;
  sessions: SessionMemory;
  /** Disable the MCP permission tool (then the CLI's own permission mode alone decides). */
  permissionTool?: boolean;
  interruptGraceMs?: number;
  /** Alca's data folder: deny rules for its keys / database go on the command line (S2.1). */
  protectedDataDir?: string;
  /** Extra environment for the CLI process (merged over process.env and the launch env). */
  baseEnv?: NodeJS.ProcessEnv;
  /**
   * Expose the turn's host tools (`EngineTurnRequest.tools`) to the CLI as MCP
   * tools routed back to `onToolCall` (default true). Needs the permission tool.
   */
  hostTools?: boolean;
  /**
   * P15 E: check what the CLI reports as in effect (its init message) against
   * what this launch asked for. A reason refuses the turn: the process is
   * interrupted and the turn ends with `engine.mode_mismatch`, nothing runs.
   */
  verifyInit?: (init: { tools?: string[]; permissionMode?: string }) => string | undefined;
  /** Plan §3.1: this instance's harness capabilities (one instance per harness, a fixed tool list). */
  harness?: HarnessCaps;
  /**
   * B4: this instance is launched with no built-in tools (`--tools ""`) and
   * refuses a turn whose init still offers one, so its native tools are
   * read-only by construction (capabilities.nativeToolsReadOnly).
   */
  noNativeTools?: boolean;
  /**
   * Item 10: release a conversation's process after it has sat idle (not
   * mid-turn) this long; its next turn resumes the stored session. Default
   * 10 minutes (`ALCA_ENGINE_IDLE_MINUTES`).
   */
  idle?: IdleOptions;
}

/** Built-in Claude Code tools that write, run or fetch (names from the public CLI docs). */
export const CLAUDE_WRITE_TOOLS: readonly string[] = Object.freeze([
  "Bash",
  "BashOutput",
  "KillShell",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
]);

/**
 * B4: the reviewer's launch: no built-in tools at all (`--tools ""`, an
 * allowlist of nothing), the write tools named again in `--disallowedTools`
 * as a second layer, one turn, and no stable prompt (the review prompt is
 * the whole message). A role's own `--tools` / `--max-turns` are dropped.
 */
export function readOnlyLaunch(cfg: EngineLaunchConfig): EngineLaunchConfig {
  const kept: string[] = [];
  const extra = cfg.extraArgs ?? [];
  for (let i = 0; i < extra.length; i++) {
    const a = extra[i] as string;
    if (a === "--tools" || a === "--max-turns") {
      i++;
      continue;
    }
    kept.push(a);
  }
  return {
    ...cfg,
    stablePrompt: "",
    extraArgs: [
      ...kept,
      "--tools",
      "",
      "--max-turns",
      "1",
      "--disallowedTools",
      CLAUDE_WRITE_TOOLS.join(","),
    ],
  };
}

/** B4: a no-tools launch whose init still lists a built-in (non-MCP) tool must not run. */
export function noNativeToolsProblem(init: { tools?: string[] }): string | undefined {
  const offered = init.tools?.filter((t) => !t.startsWith("mcp__")) ?? [];
  return offered.length ? `審查不能有任何原生工具，但 CLI 仍然提供 ${offered.join("、")}` : undefined;
}

const PERMISSION_SCRIPT = fileURLToPath(new URL("./permission-mcp.ts", import.meta.url));
const HOST_TOOLS_SCRIPT = fileURLToPath(new URL("./tools-mcp.ts", import.meta.url));

/** Stable fingerprint of a tool list: a changed list means a new launch (the CLI reads tools/list once). */
export function toolsFingerprint(tools: readonly ToolSpec[]): string {
  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

/** Volatile context rides inside the user message: the CLI's system prompt is fixed at launch. */
export function composeClaudeUserText(req: Pick<EngineTurnRequest, "system" | "userMessage">): string {
  const v = req.system.volatile.trim();
  return v ? `${v}\n\n${req.userMessage}` : req.userMessage;
}

/**
 * Claude Code CLI as a persistent per-thread engine. A thread keeps one
 * process; it is restarted only when the hash of its launch config changes
 * (or it died), and then resumed with the stored session id.
 */
export class ClaudeCodeEngine implements Engine {
  readonly id = "claude-code";
  readonly capabilities: EngineCapabilities;
  private readonly o: ClaudeCodeEngineOptions;
  private readonly procs = new Map<string, ClaudeProcess>();
  private readonly bridge = new PermissionBridge();
  private toolsDir: string | undefined;
  /** Number of processes spawned, per thread (observability and tests). */
  readonly launches = new Map<string, number>();

  private readOnly: ClaudeCodeEngine | undefined;
  /** Review 2026-11-05 #4: processes launched with `--resume` that have not answered a turn yet. */
  private readonly resumedProcs = new WeakSet<ClaudeProcess>();
  /**
   * Review 2026-11-05 #13: a released process still exiting (it may be flushing
   * its session file); the next launch of that key waits for it, so two CLIs
   * never write one session.
   */
  private readonly stopping = new Map<string, Promise<void>>();
  /** Keys whose stored session failed to resume (when `sessions.clear` is absent, it is not used again). */
  private readonly noResume = new Set<string>();
  /** Item 10: idle processes are released on a sweep and resumed on the next turn. */
  readonly idle: IdleReaper;

  constructor(opts: ClaudeCodeEngineOptions) {
    this.o = opts;
    this.idle = new IdleReaper((key) => this.release(key), opts.idle);
    this.capabilities =
      opts.harness || opts.noNativeTools
        ? Object.freeze({
            ...CLAUDE_CODE_CAPABILITIES,
            ...(opts.harness ? { harness: opts.harness } : {}),
            ...(opts.noNativeTools ? { nativeToolsReadOnly: true } : {}),
          })
        : CLAUDE_CODE_CAPABILITIES;
  }

  /** B4: the same CLI and model, started with no tools at all (one instance, made on first use). */
  readOnlyVariant(): ClaudeCodeEngine {
    if (this.o.noNativeTools) return this;
    const launch = this.o.launch;
    this.readOnly ??= new ClaudeCodeEngine({
      ...this.o,
      hostTools: false,
      launch: (key) => readOnlyLaunch(launch(key)),
      verifyInit: noNativeToolsProblem,
      noNativeTools: true,
    });
    return this.readOnly;
  }

  /**
   * Mac test 2026-11-04b E1: the bridge token rode in `--mcp-config`'s JSON, so
   * `ps -ef` showed it to every user of the machine. The MCP servers now get a
   * 0600 file (ALCA_BRIDGE_FILE, in a 0700 temp folder) holding the url and the
   * token; the command line names only the file.
   */
  private async permissionServer(key: string): Promise<PermissionServerLaunch | undefined> {
    if (this.o.permissionTool === false) return undefined;
    const url = await this.bridge.start();
    this.toolsDir ??= mkdtempSync(join(tmpdir(), "alca-tools-"));
    const bridgeFile = join(this.toolsDir, "bridge.json");
    writeFileSync(bridgeFile, JSON.stringify({ url, token: this.bridge.token }), { mode: 0o600 });
    return {
      command: process.execPath,
      args: ["--disable-warning=ExperimentalWarning", PERMISSION_SCRIPT],
      env: { ALCA_BRIDGE_FILE: bridgeFile, ALCA_THREAD_ID: key },
    };
  }

  /**
   * The host tools server: the tool list goes into a 0600 file (names,
   * descriptions and schemas only; never a secret), the calls go to the bridge.
   */
  private hostToolsServer(
    perm: PermissionServerLaunch | undefined,
    tools: readonly ToolSpec[],
    fingerprint: string,
  ): PermissionServerLaunch | undefined {
    if (!perm || this.o.hostTools === false || tools.length === 0) return undefined;
    this.toolsDir ??= mkdtempSync(join(tmpdir(), "alca-tools-"));
    const file = join(this.toolsDir, `${fingerprint.slice(0, 16)}.json`);
    const specs = tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
    writeFileSync(file, JSON.stringify(specs), { mode: 0o600 });
    return {
      command: process.execPath,
      args: ["--disable-warning=ExperimentalWarning", HOST_TOOLS_SCRIPT],
      env: { ...perm.env, ALCA_TOOLS_FILE: file },
    };
  }

  private exposedTools(req: Pick<EngineTurnRequest, "tools">): readonly ToolSpec[] {
    if (this.o.permissionTool === false || this.o.hostTools === false) return [];
    return req.tools ?? [];
  }

  /** Get the thread's process, (re)starting it when the launch config hash changed. */
  private async processFor(
    key: string,
    tools: readonly ToolSpec[],
    turn: Pick<EngineTurnRequest, "cwd" | "confine"> = {},
  ): Promise<ClaudeProcess> {
    await this.stopping.get(key);
    const cfg = withTurnCwd(this.o.launch(key), turn);
    const fingerprint = toolsFingerprint(tools);
    const hash = tools.length ? `${launchConfigHash(cfg)}:${fingerprint}` : launchConfigHash(cfg);
    const existing = this.procs.get(key);
    if (existing?.alive && existing.hash === hash) return existing;
    if (existing) {
      if (existing.sessionId) this.o.sessions.set(key, existing.sessionId);
      await existing.stop();
      this.procs.delete(key);
    }
    const resume = this.noResume.has(key) ? undefined : this.o.sessions.get(key);
    const server = await this.permissionServer(key);
    const toolServer = this.hostToolsServer(server, tools, fingerprint);
    const [command, ...lead] = this.o.command ?? ["claude"];
    if (!command) throw new Error("empty claude command");
    const args = [
      ...lead,
      ...buildClaudeArgs(cfg, {
        ...(resume ? { resumeSessionId: resume } : {}),
        ...(server ? { permissionServer: server } : {}),
        ...(toolServer ? { hostToolsServer: toolServer } : {}),
        ...(this.o.protectedDataDir ? { protectedDataDir: this.o.protectedDataDir } : {}),
      }),
    ];
    const proc = new ClaudeProcess({
      command,
      args,
      cwd: cfg.cwd,
      env: {
        // M6: only PATH / HOME / locale / proxies and Claude Code's own variables, never ALCA_*.
        ...engineEnv(process.env, "claude-code"),
        ...this.o.baseEnv,
        // Claude Code ≥ 2.1 defers MCP tools behind its ToolSearch tool; Alca's tools must be
        // loaded up front so a router can dispatch at once (an explicit engine env may opt back in).
        ENABLE_TOOL_SEARCH: "false",
        ...cfg.env,
        // Approvals wait for a person; do not let the CLI time the permission tool out.
        MCP_TOOL_TIMEOUT: process.env.MCP_TOOL_TIMEOUT ?? String(24 * 3600 * 1000),
      },
      hash,
      interruptGraceMs: this.o.interruptGraceMs ?? 5000,
    });
    this.procs.set(key, proc);
    if (resume) this.resumedProcs.add(proc);
    this.launches.set(key, (this.launches.get(key) ?? 0) + 1);
    return proc;
  }

  /**
   * Review 2026-11-05 #4: a `--resume` launch whose first answer is its exit,
   * saying it has no such conversation, or exiting silently before any init:
   * the session is gone (Claude Code's `cleanupPeriodDays`, or it lives under
   * another cwd). Any other early exit (a login problem, a crash with a
   * reason) keeps the session: a fresh launch would fail the same way.
   */
  private resumeFailed(proc: ClaudeProcess, first: EngineEvent): boolean {
    if (first.type !== "error" || first.code !== "engine.exited") return false;
    return RESUME_MISSING.test(`${first.message}\n${proc.stderr}`) || (!proc.init && !proc.stderr.trim());
  }

  /** Forget the session that would not resume, so this turn and the next start fresh. */
  private async dropSession(key: string, proc: ClaudeProcess): Promise<void> {
    this.o.sessions.clear?.(key);
    this.noResume.add(key);
    if (this.procs.get(key) === proc) this.procs.delete(key);
    await this.stopOf(key, proc);
  }

  private remember(key: string, sessionId: string): void {
    this.noResume.delete(key);
    this.o.sessions.set(key, sessionId);
  }

  async *turn(req: EngineTurnRequest): AsyncIterable<EngineEvent> {
    const tools = this.exposedTools(req);
    // One process (and one CLI session) per conversation: the thread, a bot's router, or a worker.
    const key = conversationKey(req);
    this.idle.begin(key);
    try {
      yield* this.runTurn(req, key, tools);
    } finally {
      this.idle.end(key);
    }
  }

  private async *runTurn(
    req: EngineTurnRequest,
    key: string,
    tools: readonly ToolSpec[],
  ): AsyncIterable<EngineEvent> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const proc = await this.processFor(key, tools, req);
      const resumed = this.resumedProcs.has(proc);
      this.resumedProcs.delete(proc);
      const r = yield* this.turnOn(proc, req, key, tools, resumed && attempt === 0);
      if (r !== "resume_failed") return;
      await this.dropSession(key, proc);
      yield { type: "notice", code: CONTEXT_RESET, message: CONTEXT_RESET_NOTE };
    }
  }

  /** One turn on one process; `"resume_failed"` = nothing was yielded and the turn should run again fresh. */
  private async *turnOn(
    proc: ClaudeProcess,
    req: EngineTurnRequest,
    key: string,
    tools: readonly ToolSpec[],
    checkResume: boolean,
  ): AsyncGenerator<EngineEvent, "resume_failed" | undefined> {
    const exposed = new Set(tools.map((t) => t.name));
    const bare = (name: string): string => {
      const n = hostToolName(name);
      return n && exposed.has(n) ? n : name;
    };
    const ask = req.onPermission;
    const handler = ask
      ? (p: Parameters<typeof ask>[0]) => {
          const name = bare(p.toolName);
          return ask(name !== p.toolName ? { ...p, toolName: name, hostTool: true } : p);
        }
      : async () => ({ behavior: "deny" as const, message: "no approval handler" });
    const run = req.onToolCall;
    const toolHandler = async (c: HostToolCallRequest) => {
      if (!exposed.has(c.toolName)) return { ok: false, output: `沒有這個主機工具：${c.toolName}` };
      if (!run) return { ok: false, output: "這個回合不能執行主機工具" };
      return await run(c);
    };
    this.bridge.register(key, handler);
    this.bridge.registerTools(key, toolHandler);
    const onAbort = () => proc.interrupt();
    req.signal.addEventListener("abort", onAbort, { once: true });
    try {
      const events = proc.send(composeClaudeUserText(req));
      if (req.signal.aborted) proc.interrupt();
      let verified = !this.o.verifyInit;
      let first = checkResume;
      for await (const e of events) {
        if (first) {
          first = false;
          if (this.resumeFailed(proc, e)) return "resume_failed";
        }
        if (!verified && proc.init) {
          verified = true;
          const why = this.o.verifyInit?.(proc.init);
          if (why) {
            proc.interrupt();
            yield { type: "error", code: "engine.mode_mismatch", message: why, retryable: false };
            yield { type: "done", stop: "error" };
            return undefined;
          }
        }
        if (e.type === "session") this.remember(key, e.sessionId);
        // The host knows its tools by their own names; drop the CLI's MCP prefix.
        yield e.type === "tool.call" ? { ...e, name: bare(e.name) } : e;
      }
      if (proc.sessionId) this.remember(key, proc.sessionId);
      return undefined;
    } finally {
      req.signal.removeEventListener("abort", onAbort);
      this.bridge.unregister(key, handler);
      this.bridge.unregisterTools(key, toolHandler);
    }
  }

  async interrupt(key: string): Promise<void> {
    this.procs.get(key)?.interrupt();
  }

  /** Stop a conversation's process (a finished worker); its session id stays, so it can be resumed. */
  async release(key: string): Promise<void> {
    const p = this.procs.get(key);
    this.idle.forget(key);
    if (!p) return;
    if (p.sessionId) this.o.sessions.set(key, p.sessionId);
    this.procs.delete(key);
    await this.stopOf(key, p);
  }

  /** Stop `p`, recorded as the key's `stopping` until it has exited. */
  private stopOf(key: string, p: ClaudeProcess): Promise<void> {
    const done: Promise<void> = p.stop().finally(() => {
      if (this.stopping.get(key) === done) this.stopping.delete(key);
    });
    this.stopping.set(key, done);
    return done;
  }

  /** Is a live process held for this conversation (for tests and the status UI)? */
  hasProcess(key: string): boolean {
    return this.procs.get(key)?.alive ?? false;
  }

  async dispose(): Promise<void> {
    this.idle.stop();
    await this.readOnly?.dispose();
    this.readOnly = undefined;
    await Promise.all([...this.procs.values()].map((p) => p.stop()));
    this.procs.clear();
    await this.bridge.stop();
    if (this.toolsDir) rmSync(this.toolsDir, { recursive: true, force: true });
    this.toolsDir = undefined;
  }
}
