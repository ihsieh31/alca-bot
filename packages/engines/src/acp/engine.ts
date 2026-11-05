import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ConfineSpec, spawnConfined } from "@alca/os";
import { PermissionBridge } from "../claude/bridge.ts";
import { type SessionMemory, toolsFingerprint } from "../claude/engine.ts";
import { composeCodexPrompt } from "../codex/engine.ts";
import { engineEnv } from "../env.ts";
import {
  conversationKey,
  type Engine,
  type EngineCapabilities,
  type EngineEvent,
  type EngineLaunchConfig,
  type EngineTurnRequest,
  EventQueue,
  type HarnessCaps,
  type HostToolCallRequest,
  launchConfigHash,
  type PermissionRequest,
  type ToolSpec,
  withTurnCwd,
} from "../types.ts";
import { ALCA_VERSION } from "../version.ts";
import { AcpRpcError, JsonRpcPeer, methodNotFound } from "./rpc.ts";
import { describeUpdate, hostToolOf, NATIVE_KINDS, pickOption } from "./updates.ts";

/**
 * A generic Agent Client Protocol engine (P11), written from the public ACP
 * spec: the agent (Gemini CLI, OpenCode, Qwen Code, …) runs as a child
 * process speaking JSON-RPC over stdio. One process per conversation key:
 * `initialize` → `session/new` (or `session/load` with the stored id) →
 * `session/prompt` per turn, `session/update` notifications streamed as
 * engine events, `session/request_permission` answered by the host's gate,
 * `session/cancel` to interrupt. The host's own tools reach the agent as a
 * stdio MCP server (the same bridge Claude Code and Codex use), so every
 * host-tool call is still gated by the host. We advertise no file system or
 * terminal capability: the agent uses its own tools and asks permission.
 */

export const ACP_PROTOCOL_VERSION = 1;

export const ACP_CAPABILITIES: EngineCapabilities = Object.freeze({
  kind: "acp",
  persistentProcess: true,
  streaming: true,
  resume: true,
  interrupt: true,
  ownsToolLoop: true,
  nativePermissionModes: [],
  permissionPrompt: "host_loop",
  systemPromptAtLaunch: false,
  supportsPromptCache: false,
  supportsImages: false,
});

export interface AcpEngineOptions {
  /** Engine id (the provider id, e.g. "gemini-cli"). */
  id: string;
  /** Shown in messages ("Gemini CLI"). */
  label?: string;
  /** Binary and its ACP args, e.g. ["gemini", "--experimental-acp"]. */
  command: readonly string[];
  launch: (key: string) => EngineLaunchConfig;
  sessions: SessionMemory;
  baseEnv?: NodeJS.ProcessEnv;
  /** More variables of the person's environment this agent may see (its own key names). */
  envAllow?: readonly string[];
  /** Secret env (e.g. an API key from the vault), read when the process starts; never logged or hashed. */
  secretEnv?: () => Promise<Record<string, string>>;
  /** Expose the turn's host tools over MCP (default true). */
  hostTools?: boolean;
  /** Approval mode → session mode ids to try, first one the agent offers wins. */
  modes?: Readonly<Record<string, readonly string[]>>;
  /** Ask the agent to switch model with `session/set_model` when the launch names one (default true). */
  setModel?: boolean;
  /** One line on how to log in, for an auth error. */
  loginHint?: string;
  /**
   * P15 E: tool-call kinds refused without asking the host (the general
   * harness: `execute`, `edit`, `delete`, `move`). The agent gets a reject.
   */
  denyKinds?: readonly string[];
  /**
   * P15 E: the approval mode must take effect: when the agent offers the mode
   * this launch maps to and switching to it fails, the session is not used
   * (the turn fails with the reason) instead of running in another mode.
   */
  strictMode?: boolean;
  /**
   * Plan §3.4 (coding worker): always the agent's asking mode (the
   * `confirm_each_step` modes), never an auto-edit one, whatever the bot's
   * level; strict. A native edit / command the agent then runs without
   * asking (no snapshot was taken) stops the turn (`engine.unasked_native`).
   */
  askingMode?: boolean;
  /** Plan §3.1: this instance's harness capabilities (default: derived). */
  harness?: HarnessCaps;
  /**
   * Next round §5.5 (experimental): folders the agent writes itself (`~` =
   * home). With the bot's OS sandbox on (`EngineLaunchConfig.confine`), the
   * whole agent process runs in it, writable = the work folder + these; an
   * agent that declares none cannot run sandboxed and the turn fails.
   */
  stateDirs?: readonly string[];
  /** Timeout for initialize / session setup (default 30 s). */
  setupTimeoutMs?: number;
  interruptGraceMs?: number;
}

interface TurnSink {
  q: EventQueue<EngineEvent>;
  textOpen: boolean;
  aborted: boolean;
  exposed: Set<string>;
  onPermission?: (
    req: PermissionRequest,
  ) => Promise<{ behavior: "allow" } | { behavior: "deny"; message: string }>;
  openCalls: Set<string>;
  /** Tool calls the agent asked permission for (plan §3.4: a native write must have asked). */
  asked: Set<string>;
  /** Native kind of each call seen (tool_call / tool_call_update). */
  kinds: Map<string, string>;
  /** The turn was stopped for an unasked native call. */
  breached: boolean;
}

interface Proc {
  child: ChildProcessWithoutNullStreams;
  rpc: JsonRpcPeer;
  hash: string;
  sessionId: string;
  loadSession: boolean;
  instructed: boolean;
  sink: TurnSink | undefined;
  stderr: string;
}

const HOST_TOOLS_SCRIPT = fileURLToPath(new URL("../claude/tools-mcp.ts", import.meta.url));

export class AcpEngine implements Engine {
  readonly id: string;
  readonly capabilities: EngineCapabilities;
  private readonly o: AcpEngineOptions;
  private readonly bridge = new PermissionBridge();
  private readonly procs = new Map<string, Proc>();
  private readonly starting = new Map<string, Promise<Proc>>();
  private dir: string | undefined;
  /** Processes started per key (tests). */
  readonly launches = new Map<string, number>();

  constructor(o: AcpEngineOptions) {
    this.o = o;
    this.id = o.id;
    this.capabilities = o.harness
      ? Object.freeze({ ...ACP_CAPABILITIES, harness: o.harness })
      : ACP_CAPABILITIES;
  }

  private get label(): string {
    return this.o.label ?? this.o.id;
  }

  private workDir(): string {
    this.dir ??= mkdtempSync(join(tmpdir(), "alca-acp-"));
    return this.dir;
  }

  private async mcpServers(key: string, tools: readonly ToolSpec[]): Promise<unknown[]> {
    if (this.o.hostTools === false || tools.length === 0) return [];
    const url = await this.bridge.start();
    const dir = this.workDir();
    const bridgeFile = join(dir, "bridge.json");
    writeFileSync(bridgeFile, JSON.stringify({ url, token: this.bridge.token }), { mode: 0o600 });
    const toolsFile = join(dir, `${toolsFingerprint(tools).slice(0, 16)}.json`);
    writeFileSync(toolsFile, JSON.stringify(tools), { mode: 0o600 });
    const env = { ALCA_BRIDGE_FILE: bridgeFile, ALCA_TOOLS_FILE: toolsFile, ALCA_THREAD_ID: key };
    return [
      {
        name: "alcatools",
        command: process.execPath,
        args: ["--disable-warning=ExperimentalWarning", HOST_TOOLS_SCRIPT],
        env: Object.entries(env).map(([name, value]) => ({ name, value })),
      },
    ];
  }

  private async start(
    key: string,
    cfg: EngineLaunchConfig,
    tools: readonly ToolSpec[],
    hash: string,
  ): Promise<Proc> {
    const [command, ...args] = this.o.command;
    if (!command) throw new Error("empty ACP command");
    const secret = (await this.o.secretEnv?.().catch(() => ({}))) ?? {};
    const child = spawnConfined(
      acpConfine(cfg.confine, this.o.stateDirs),
      command,
      [...args, ...(cfg.extraArgs ?? [])],
      {
        cwd: cfg.cwd,
        // M6: an allow-listed environment (never ALCA_*); the agent's key comes from the vault below.
        env: {
          ...engineEnv(process.env, "acp", this.o.envAllow ?? []),
          ...this.o.baseEnv,
          ...cfg.env,
          ...secret,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    ) as ChildProcessWithoutNullStreams;
    this.launches.set(key, (this.launches.get(key) ?? 0) + 1);
    const proc: Proc = {
      child,
      rpc: undefined as unknown as JsonRpcPeer,
      hash,
      sessionId: "",
      loadSession: false,
      instructed: false,
      sink: undefined,
      stderr: "",
    };
    child.stderr.on("data", (c: Buffer) => {
      proc.stderr = (proc.stderr + c.toString("utf8")).slice(-2000);
    });
    const spawned = new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", (e) => reject(e));
    });
    proc.rpc = new JsonRpcPeer(child.stdout, child.stdin, {
      onNotification: (method, params) => {
        if (method !== "session/update" || params.sessionId !== proc.sessionId || !proc.sink) return;
        this.onUpdate(proc.sink, (params.update ?? {}) as Record<string, unknown>);
      },
      onRequest: async (method, params) => {
        if (method === "session/request_permission") return await this.onPermission(proc, params);
        throw methodNotFound(method);
      },
    });
    child.on("exit", () => {
      proc.rpc.close(new Error(`${this.label} 結束了：${proc.stderr.trim().slice(-300)}`));
      if (this.procs.get(key) === proc) this.procs.delete(key);
    });
    try {
      await spawned;
    } catch (err) {
      proc.rpc.close();
      throw Object.assign(new Error(`找不到 ${this.label}（${command}）`), {
        code: "engine.not_found",
        cause: err,
      });
    }
    const t = this.o.setupTimeoutMs ?? 30_000;
    const init = await proc.rpc.request<{
      protocolVersion?: number;
      agentCapabilities?: { loadSession?: boolean };
    }>(
      "initialize",
      {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "alca", version: ALCA_VERSION },
      },
      t,
    );
    proc.loadSession = init.agentCapabilities?.loadSession === true;
    const mcpServers = await this.mcpServers(key, tools);
    const stored = this.o.sessions.get(key);
    let setup: { sessionId?: string; modes?: unknown; models?: unknown } | null = null;
    if (stored && proc.loadSession) {
      try {
        setup = await proc.rpc.request("session/load", { sessionId: stored, cwd: cfg.cwd, mcpServers }, t);
        proc.sessionId = stored;
      } catch {
        setup = null;
      }
    }
    if (!proc.sessionId) {
      setup = await proc.rpc.request("session/new", { cwd: cfg.cwd, mcpServers }, t);
      if (!setup?.sessionId) throw new Error(`${this.label} 沒有給 session id`);
      proc.sessionId = setup.sessionId;
    }
    this.o.sessions.set(key, proc.sessionId);
    await this.configure(proc, cfg, setup ?? {});
    return proc;
  }

  /** Map the approval level onto one of the agent's own session modes, and pick the model. */
  private async configure(proc: Proc, cfg: EngineLaunchConfig, setup: { modes?: unknown; models?: unknown }) {
    const modes = setup.modes as
      | { availableModes?: Array<{ id?: string }>; currentModeId?: string }
      | undefined;
    const offered = new Set((modes?.availableModes ?? []).map((m) => m.id).filter(Boolean));
    // Plan §3.4: a coding worker always runs in the agent's asking mode, never auto-edit.
    const level = this.o.askingMode ? "confirm_each_step" : cfg.approvalMode;
    const want = (this.o.modes?.[level] ?? []).find((m) => offered.has(m));
    const strict = this.o.strictMode || this.o.askingMode;
    if (want && want !== modes?.currentModeId) {
      const ok = await proc.rpc
        .request("session/set_mode", { sessionId: proc.sessionId, modeId: want }, 10_000)
        .then(() => true)
        .catch(() => false);
      if (!ok && strict) throw new Error(`${this.label} 沒有切換到要求的模式 ${want}，不開始這個工作`);
    }
    // An agent that offers modes but none of the asking ones, and sits in an auto-edit one: refuse.
    const auto = new Set(this.o.modes?.autonomous ?? []);
    if (this.o.askingMode && !want && modes?.currentModeId && auto.has(modes.currentModeId))
      throw new Error(`${this.label} 停在自動改檔模式（${modes.currentModeId}），coding 工作不能這樣跑`);
    const models = setup.models as { availableModels?: Array<{ modelId?: string }> } | undefined;
    if (
      cfg.model &&
      this.o.setModel !== false &&
      models?.availableModels?.some((m) => m.modelId === cfg.model)
    )
      await proc.rpc
        .request("session/set_model", { sessionId: proc.sessionId, modelId: cfg.model }, 10_000)
        .catch(() => undefined);
  }

  private onUpdate(sink: TurnSink, u: Record<string, unknown>): void {
    if (sink.breached) return;
    for (const e of describeUpdate(u, sink)) sink.q.push(e);
    if (this.o.askingMode) this.checkAsked(sink, u);
  }

  /**
   * Plan §3.4: in the asking mode every native edit / command must have gone
   * through `session/request_permission` (where the host took the undo
   * snapshot and checked the folder). One that runs or finishes unasked stops
   * the turn: the host is told, and the agent is cancelled.
   */
  private checkAsked(sink: TurnSink, u: Record<string, unknown>): void {
    const id = String(u.toolCallId ?? "");
    if (!id || (u.sessionUpdate !== "tool_call" && u.sessionUpdate !== "tool_call_update")) return;
    if (typeof u.kind === "string") sink.kinds.set(id, u.kind);
    const kind = sink.kinds.get(id) ?? "";
    const ran = u.status === "in_progress" || u.status === "completed";
    if (!ran || !NATIVE_KINDS.has(kind) || sink.asked.has(id)) return;
    sink.breached = true;
    sink.q.push({
      type: "error",
      code: "engine.unasked_native",
      message: `${this.label} 沒有先問就執行了原生的 ${kind}（「${String(u.title ?? id).slice(0, 80)}」），沒有留下復原快照；已停止這一輪。`,
      retryable: false,
    });
    sink.aborted = true;
    const proc = [...this.procs.values()].find((p) => p.sink === sink);
    if (proc) proc.rpc.notify("session/cancel", { sessionId: proc.sessionId });
  }

  private async onPermission(proc: Proc, params: Record<string, unknown>): Promise<unknown> {
    const sink = proc.sink;
    const options = (Array.isArray(params.options) ? params.options : []) as Array<{
      optionId?: string;
      kind?: string;
    }>;
    const cancelled = { outcome: { outcome: "cancelled" } };
    if (!sink || sink.aborted || params.sessionId !== proc.sessionId) return cancelled;
    const tc = (params.toolCall ?? {}) as {
      toolCallId?: string;
      title?: string;
      kind?: string;
      rawInput?: unknown;
      locations?: unknown;
    };
    if (tc.kind && this.o.denyKinds?.includes(tc.kind)) {
      const reject = pickOption(options, false);
      return reject ? { outcome: { outcome: "selected", optionId: reject } } : cancelled;
    }
    if (tc.toolCallId) sink.asked.add(tc.toolCallId);
    const title = String(tc.title ?? tc.kind ?? "tool");
    // The title and kind are the agent's own words (a shell tool's title is
    // often its command line), so a host tool is recognised only by an exact
    // name shape and never for a kind that runs, edits or deletes natively:
    // a match skips the permission gate (the host gates the call itself).
    const host = NATIVE_KINDS.has(String(tc.kind ?? "")) ? undefined : hostToolOf(title, sink.exposed);
    const input =
      tc.rawInput && typeof tc.rawInput === "object" ? (tc.rawInput as Record<string, unknown>) : {};
    const ask: PermissionRequest = {
      toolName: host ?? title,
      input: host
        ? input
        : { ...input, ...(tc.kind ? { kind: tc.kind } : {}), ...locationPaths(tc.locations) },
      ...(tc.toolCallId ? { toolUseId: tc.toolCallId } : {}),
      ...(host ? { hostTool: true } : {}),
    };
    const answer = sink.onPermission ? await sink.onPermission(ask).catch(() => undefined) : undefined;
    if (sink.aborted) return cancelled;
    const optionId = pickOption(options, answer?.behavior === "allow");
    return optionId ? { outcome: { outcome: "selected", optionId } } : cancelled;
  }

  private async proc(key: string, cfg: EngineLaunchConfig, tools: readonly ToolSpec[]): Promise<Proc> {
    const hash = `${launchConfigHash(cfg)}:${toolsFingerprint(tools)}`;
    const have = this.procs.get(key);
    if (have && have.hash === hash && !have.rpc.isClosed) return have;
    if (have) this.kill(have);
    const pending = this.starting.get(key);
    if (pending) return await pending;
    const p = this.start(key, cfg, tools, hash);
    this.starting.set(key, p);
    try {
      const proc = await p;
      this.procs.set(key, proc);
      return proc;
    } finally {
      this.starting.delete(key);
    }
  }

  async *turn(req: EngineTurnRequest): AsyncIterable<EngineEvent> {
    const key = conversationKey(req);
    const tools = this.o.hostTools === false ? [] : (req.tools ?? []);
    const cfg = withTurnCwd(this.o.launch(key), req);
    let proc: Proc;
    try {
      proc = await this.proc(key, cfg, tools);
    } catch (err) {
      yield this.setupError(err);
      return yield { type: "done", stop: "error" };
    }
    const exposed = new Set(tools.map((t) => t.name));
    const run = req.onToolCall;
    const toolHandler = async (c: HostToolCallRequest) => {
      if (!exposed.has(c.toolName)) return { ok: false, output: `沒有這個主機工具：${c.toolName}` };
      if (!run) return { ok: false, output: "這個回合不能執行主機工具" };
      return await run(c);
    };
    this.bridge.registerTools(key, toolHandler);
    const sink: TurnSink = {
      q: new EventQueue<EngineEvent>(),
      textOpen: false,
      aborted: false,
      exposed,
      openCalls: new Set(),
      asked: new Set(),
      kinds: new Map(),
      breached: false,
      ...(req.onPermission ? { onPermission: req.onPermission } : {}),
    };
    proc.sink = sink;
    sink.q.push({ type: "session", sessionId: proc.sessionId, ...(cfg.model ? { model: cfg.model } : {}) });
    const text = composeCodexPrompt(req, !proc.instructed);
    proc.instructed = true;
    const onAbort = () => {
      if (sink.aborted) return;
      sink.aborted = true;
      proc.rpc.notify("session/cancel", { sessionId: proc.sessionId });
      const t = setTimeout(() => {
        if (proc.sink === sink) this.kill(proc);
      }, this.o.interruptGraceMs ?? 5000);
      t.unref();
    };
    req.signal.addEventListener("abort", onAbort, { once: true });
    if (req.signal.aborted) onAbort();
    proc.rpc
      .request<{ stopReason?: string }>("session/prompt", {
        sessionId: proc.sessionId,
        prompt: [{ type: "text", text }],
      })
      .then(
        (r) => {
          if (sink.textOpen) sink.q.push({ type: "text.end" });
          const stop = r?.stopReason ?? "end_turn";
          if (stop === "cancelled" || sink.aborted) sink.q.push({ type: "done", stop: "interrupted" });
          else if (stop === "max_turn_requests") sink.q.push({ type: "done", stop: "max_turns" });
          else if (stop === "refusal") {
            sink.q.push({
              type: "error",
              code: "engine.refusal",
              message: `${this.label} 拒絕了這個請求`,
              retryable: false,
            });
            sink.q.push({ type: "done", stop: "error" });
          } else sink.q.push({ type: "done", stop: "end_turn" });
        },
        (err: unknown) => {
          if (sink.aborted) sink.q.push({ type: "done", stop: "interrupted" });
          else {
            sink.q.push(this.promptError(err, proc));
            sink.q.push({ type: "done", stop: "error" });
          }
        },
      )
      .finally(() => sink.q.close());
    try {
      for await (const e of sink.q) {
        yield e;
        if (e.type === "done") break;
      }
    } finally {
      req.signal.removeEventListener("abort", onAbort);
      this.bridge.unregisterTools(key, toolHandler);
      if (proc.sink === sink) proc.sink = undefined;
    }
  }

  private setupError(err: unknown): EngineEvent {
    const e = err as Error & { code?: string | number };
    if (e?.code === "engine.not_found")
      return { type: "error", code: "engine.not_found", message: e.message, retryable: false };
    if (err instanceof AcpRpcError && (err.code === -32000 || /auth/i.test(err.message)))
      return {
        type: "error",
        code: "engine.auth",
        message: `${this.label} 需要登入${this.o.loginHint ? `：${this.o.loginHint}` : ""}`,
        retryable: false,
      };
    return {
      type: "error",
      code: "engine.crashed",
      message: `${this.label} 沒有啟動：${String(e?.message ?? err).slice(0, 300)}`,
      retryable: true,
    };
  }

  private promptError(err: unknown, proc: Proc): EngineEvent {
    if (err instanceof AcpRpcError && err.code === -32000) return this.setupError(err);
    return {
      type: "error",
      code: proc.rpc.isClosed ? "engine.crashed" : "engine.acp",
      message: String((err as Error)?.message ?? err).slice(0, 300),
      retryable: true,
    };
  }

  private kill(proc: Proc): void {
    proc.rpc.close();
    if (proc.child.exitCode === null) {
      proc.child.kill("SIGTERM");
      const t = setTimeout(() => proc.child.exitCode === null && proc.child.kill("SIGKILL"), 2000);
      t.unref();
    }
    for (const [k, p] of this.procs) if (p === proc) this.procs.delete(k);
  }

  async interrupt(key: string): Promise<void> {
    const p = this.procs.get(key);
    if (p?.sink && !p.sink.aborted) {
      p.sink.aborted = true;
      p.rpc.notify("session/cancel", { sessionId: p.sessionId });
    }
  }

  async release(key: string): Promise<void> {
    const p = this.procs.get(key);
    if (p && !p.sink) this.kill(p);
  }

  async dispose(): Promise<void> {
    for (const p of [...this.procs.values()]) this.kill(p);
    this.procs.clear();
    await this.bridge.stop();
    if (this.dir) rmSync(this.dir, { recursive: true, force: true });
    this.dir = undefined;
  }
}

/** ACP `locations` ({ path }) of a native tool call, so the host can snapshot the files an edit touches (P13). */
export function locationPaths(v: unknown): { paths?: string[] } {
  if (!Array.isArray(v)) return {};
  const paths = v
    .map((l) => (l && typeof l === "object" ? (l as { path?: unknown }).path : undefined))
    .filter((p): p is string => typeof p === "string" && p !== "")
    .slice(0, 20);
  return paths.length ? { paths } : {};
}

/** An ACP agent without declared state folders cannot run sandboxed (next round §5.5). */
export const ACP_NO_STATE_DIRS =
  "這個 ACP 引擎沒有宣告它自己要寫的資料夾（stateDirs），沙箱開著時不能用；請關掉這個 bot 的沙箱或改用其他引擎";

/**
 * Next round §5.5: the spec the whole ACP agent runs in — the turn's spec,
 * plus the agent's own state folders as writable. No spec → none (spawn as
 * before); a spec but no state folders → refused (thrown at start).
 */
export function acpConfine(
  spec: ConfineSpec | undefined,
  stateDirs: readonly string[] | undefined,
  home = homedir(),
): ConfineSpec | undefined {
  if (!spec) return undefined;
  if (!stateDirs?.length) throw new Error(ACP_NO_STATE_DIRS);
  const dirs = stateDirs.map((d) => (d === "~" ? home : d.startsWith("~/") ? `${home}/${d.slice(2)}` : d));
  return { ...spec, extraWritable: [...new Set([...spec.extraWritable, ...dirs])] };
}
