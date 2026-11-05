import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PermissionBridge } from "../../claude/bridge.ts";
import {
  CONTEXT_RESET,
  CONTEXT_RESET_NOTE,
  type SessionMemory,
  toolsFingerprint,
} from "../../claude/engine.ts";
import { engineEnv } from "../../env.ts";
import { HARNESS_MATRIX } from "../../harness-matrix.ts";
import { type IdleOptions, IdleReaper } from "../../idle.ts";
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
  type ToolSpec,
  withTurnCwd,
} from "../../types.ts";
import { type CodexMcpServer, hostToolsOverrides } from "../args.ts";
import { CODEX_CAPABILITIES } from "../engine.ts";
import { prepareCodexHome } from "../home.ts";
import { newMapState } from "./map.ts";
import { AppServerProcess, type TurnSink } from "./process.ts";
import {
  type AppServerApprovalPolicy,
  type AppServerSandbox,
  APP_SERVER_METHODS as M,
  sandboxPolicy,
} from "./rpc.ts";

/**
 * Codex through `codex app-server` (plan §3.3): one resident process per
 * conversation, JSON-RPC over stdio. initialize → `thread/start` (or
 * `thread/resume` with the stored thread id) → `turn/start` per turn; command
 * and file-change approvals go to the host's gate; `turn/interrupt` stops a
 * turn and the thread survives.
 *
 * - coding: `workspace-write` (writes only under the work folder) with
 *   `approvalPolicy: "untrusted"`. The plan said `on-request`, but in Codex's
 *   own source (`core/src/exec_policy.rs`, `core/src/safety.rs`) on-request
 *   runs in-sandbox commands and in-root patches WITHOUT asking; untrusted
 *   asks for every patch and every command that is not a known-safe read. With
 *   `on-request` the matrix says `some` and coding is refused.
 * - general / reviewer: `read-only` with approvals `never` (changes only
 *   through host tools, gated by the host).
 *
 * `untrusted` retired upstream (openai/codex#39630, Aug 2026; docs: "Codex
 * … no longer support approval_policy = \"untrusted\""): a current CLI refuses
 * it. When thread/start, thread/resume or turn/start refuses the policy, the
 * engine switches to `on-request` for good (this process's life), says so
 * in a clear error for that turn (nothing ran), and its harness row becomes
 * `codexAppServerOnRequest`: Alca's own gate (`checkHarnessFit`) then refuses
 * coding below 完全授權, where every turn gets a git snapshot first. When
 * `on-request` is refused too, the turn ends with that error.
 *
 * Capability probe: the first turn (or `probe()`) starts the server; when it
 * cannot start or does not answer `initialize`, the engine is marked
 * unavailable and falls back to `fallback` (the read-only `codex exec`
 * engine) when it has one, else refuses the turn. Its harness capabilities
 * then become the fallback's (read-only), so a coding dispatch is refused.
 * NOT verified against a real Codex CLI (only `fake-codex-app-server`).
 */

export interface CodexAppServerOptions {
  /** Command and leading args, e.g. ["codex"] or [node, "fake-codex-app-server.ts"]. */
  command?: readonly string[];
  launch: (key: string) => EngineLaunchConfig;
  sessions: SessionMemory;
  sandbox: AppServerSandbox;
  /** Default: `untrusted` for workspace-write, `never` for read-only. */
  approvalPolicy?: AppServerApprovalPolicy;
  /** Alca's own CODEX_HOME (codex/home.ts); `false` = the person's own (tests). */
  home?: string | false;
  baseEnv?: NodeJS.ProcessEnv;
  /** Expose the turn's host tools over MCP (default true). */
  hostTools?: boolean;
  /** Used when the app-server is unavailable (the read-only `codex exec` engine). */
  fallback?: Engine;
  setupTimeoutMs?: number;
  /**
   * Item 10: release a conversation's app-server after it has sat idle (not
   * mid-turn) this long; its next turn resumes the stored thread
   * (`thread/resume`). Default 10 minutes (`ALCA_ENGINE_IDLE_MINUTES`).
   */
  idle?: IdleOptions;
}

const HOST_TOOLS_SCRIPT = fileURLToPath(new URL("../../claude/tools-mcp.ts", import.meta.url));

/** The matrix row for a sandbox + approval policy. */
export function appServerHarness(sandbox: AppServerSandbox, policy: AppServerApprovalPolicy): HarnessCaps {
  if (sandbox === "read-only") return HARNESS_MATRIX.codexAppServerReadOnly;
  return policy === "untrusted"
    ? HARNESS_MATRIX.codexAppServerCoding
    : HARNESS_MATRIX.codexAppServerOnRequest;
}

/**
 * True for a JSON-RPC refusal of the approval policy we sent (the CLI's own
 * words vary by version). Review 2026-11-05 #11: "untrusted" alone is not
 * enough (an untrusted project or directory message is no policy refusal, and
 * a false match drops the engine to `on-request` for good): the error must
 * name the approval policy, or be serde's `unknown variant `untrusted``.
 */
export function isPolicyRejection(err: unknown): boolean {
  const m = String((err as Error)?.message ?? err);
  return (
    /unknown variant\W{0,3}untrusted/iu.test(m) ||
    (/approval/iu.test(m) &&
      /untrusted|unknown variant|invalid|not supported|unsupported|no longer|retired|not allowed/iu.test(m))
  );
}

export const UNTRUSTED_RETIRED_NOTE =
  "（這個版本的 Codex CLI 已移除 untrusted 審批模式，Codex 改用 on-request：沙盒內的指令與檔案修改不會逐一詢問；要讓 Codex 做 coding，請把這個 bot 設成完全授權，每回合會先做 git 快照。）";

/**
 * Item 5: what `probePolicy` found. `retired` = the CLI refused `untrusted`
 * (the engine now runs `on-request`); `skipped` = this engine does not send
 * `untrusted`; `unavailable` = the app-server did not start; `unknown` =
 * another error (nothing changed).
 */
export type PolicyProbe = "ok" | "retired" | "skipped" | "unavailable" | "unknown";

const UNAVAILABLE: HarnessCaps = Object.freeze({ ...HARNESS_MATRIX.codexExec, writes: "none" as const });

export class CodexAppServerEngine implements Engine {
  readonly id = "codex";
  private readonly o: CodexAppServerOptions;
  private policy: AppServerApprovalPolicy;
  /** The CLI refused `untrusted`; the engine runs `on-request` from then on. */
  policyRetired = false;
  private readonly bridge = new PermissionBridge();
  private readonly procs = new Map<string, AppServerProcess>();
  private readonly starting = new Map<string, Promise<AppServerProcess>>();
  private dir: string | undefined;
  /** undefined = not probed yet; false = the app-server could not start (fallback in use). */
  available: boolean | undefined;
  readonly launches = new Map<string, number>();
  private readonly caps: EngineCapabilities;
  /** Item 10: idle processes are released on a sweep and resumed on the next turn. */
  readonly idle: IdleReaper;

  constructor(o: CodexAppServerOptions) {
    this.o = o;
    this.idle = new IdleReaper((key) => this.releaseProcess(key), o.idle);
    this.policy = o.approvalPolicy ?? (o.sandbox === "workspace-write" ? "untrusted" : "never");
    this.caps = Object.freeze({
      ...CODEX_CAPABILITIES,
      persistentProcess: true,
      streaming: true,
      permissionPrompt: "host_loop" as const,
      nativeToolsReadOnly: o.sandbox === "read-only",
      nativePermissionModes: ["read-only", "workspace-write"],
      harness: appServerHarness(o.sandbox, this.policy),
    });
  }

  /** Plan §3.1: what the host reads; after a failed probe, the fallback's (read-only) or none. */
  get capabilities(): EngineCapabilities {
    if (this.available !== false && this.policyRetired)
      return {
        ...this.caps,
        harness: { ...appServerHarness(this.o.sandbox, this.policy), note: UNTRUSTED_RETIRED_NOTE },
      };
    if (this.available !== false) return this.caps;
    return this.o.fallback?.capabilities ?? { ...this.caps, harness: UNAVAILABLE };
  }

  private homeEnv(): Record<string, string> {
    if (this.o.home === false) return {};
    const uid = typeof process.getuid === "function" ? process.getuid() : "u";
    return { CODEX_HOME: prepareCodexHome(this.o.home ?? join(tmpdir(), `alca-codex-home-${uid}`)) };
  }

  private workDir(): string {
    this.dir ??= mkdtempSync(join(tmpdir(), "alca-codex-as-"));
    return this.dir;
  }

  private async hostServer(key: string, tools: readonly ToolSpec[]): Promise<CodexMcpServer | undefined> {
    if (this.o.hostTools === false || tools.length === 0) return undefined;
    const url = await this.bridge.start();
    const dir = this.workDir();
    const bridgeFile = join(dir, "bridge.json");
    writeFileSync(bridgeFile, JSON.stringify({ url, token: this.bridge.token }), { mode: 0o600 });
    const toolsFile = join(dir, `${toolsFingerprint(tools).slice(0, 16)}.json`);
    const specs = tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
    writeFileSync(toolsFile, JSON.stringify(specs), { mode: 0o600 });
    return {
      command: process.execPath,
      args: ["--disable-warning=ExperimentalWarning", HOST_TOOLS_SCRIPT],
      env: { ALCA_BRIDGE_FILE: bridgeFile, ALCA_TOOLS_FILE: toolsFile, ALCA_THREAD_ID: key },
    };
  }

  private async spawnFor(
    key: string,
    cfg: EngineLaunchConfig,
    tools: readonly ToolSpec[],
    hash: string,
  ): Promise<AppServerProcess> {
    const [command, ...lead] = this.o.command ?? ["codex"];
    if (!command) throw new Error("empty codex command");
    const server = await this.hostServer(key, tools);
    // Root-level `-c` overrides come before the subcommand.
    const args = [
      ...lead,
      ...(server ? hostToolsOverrides(server) : []),
      ...(cfg.extraArgs ?? []),
      "app-server",
    ];
    const p = await AppServerProcess.start({
      command,
      args,
      cwd: cfg.cwd,
      // M6: an allow-listed environment; S1: Codex reads Alca's own home, not ~/.codex.
      env: { ...engineEnv(process.env, "codex"), ...this.o.baseEnv, ...cfg.env, ...this.homeEnv() },
      hash,
      setupTimeoutMs: this.o.setupTimeoutMs ?? 30_000,
    });
    this.launches.set(key, (this.launches.get(key) ?? 0) + 1);
    return p;
  }

  private async proc(
    key: string,
    cfg: EngineLaunchConfig,
    tools: readonly ToolSpec[],
  ): Promise<AppServerProcess> {
    const hash = `${launchConfigHash(cfg)}:${toolsFingerprint(tools)}:${this.o.sandbox}:${this.policy}`;
    const have = this.procs.get(key);
    if (have?.alive && have.hash === hash) return have;
    if (have) {
      have.kill();
      this.procs.delete(key);
    }
    const pending = this.starting.get(key);
    if (pending) return await pending;
    const p = this.spawnFor(key, cfg, tools, hash);
    this.starting.set(key, p);
    try {
      const proc = await p;
      this.available = true;
      this.procs.set(key, proc);
      return proc;
    } finally {
      this.starting.delete(key);
    }
  }

  /** Capability probe: can `codex app-server` start and answer `initialize`? */
  async probe(cwd = process.cwd()): Promise<boolean> {
    if (this.available !== undefined) return this.available;
    const cfg: EngineLaunchConfig = {
      engineId: "codex",
      cwd,
      stablePrompt: "",
      env: {},
      approvalMode: "probe",
    };
    try {
      const p = await this.spawnFor("__probe__", cfg, [], "probe");
      p.kill();
      this.available = true;
    } catch {
      this.available = false;
    }
    return this.available;
  }

  private policyCheck: Promise<PolicyProbe> | undefined;

  /**
   * Item 5: ask the CLI once, before any turn, whether it still takes the
   * approval policy this engine would send. Only `untrusted` (the coding
   * worker's default, retired in newer Codex CLIs) is checked: a short-lived
   * app-server is started, `thread/start` is sent with that policy (an
   * ephemeral thread in Alca's own CODEX_HOME — no turn, no model call), and
   * the process is stopped. A refusal switches the engine to `on-request` as
   * a refused turn would, so the coding fit check already says why
   * (UNTRUSTED_RETIRED_NOTE) before anything is dispatched. A failure to
   * start says nothing about the policy and changes nothing (the first turn
   * still probes availability). Runs once per engine; later calls share it.
   */
  probePolicy(cwd = process.cwd()): Promise<PolicyProbe> {
    if (this.policyRetired) return Promise.resolve("retired");
    if (this.policy !== "untrusted") return Promise.resolve("skipped");
    this.policyCheck ??= this.runPolicyProbe(cwd);
    return this.policyCheck;
  }

  private async runPolicyProbe(cwd: string): Promise<PolicyProbe> {
    const cfg: EngineLaunchConfig = {
      engineId: "codex",
      cwd,
      stablePrompt: "",
      env: {},
      approvalMode: "probe",
    };
    let p: AppServerProcess;
    try {
      p = await this.spawnFor("__policy_probe__", cfg, [], "policy-probe");
    } catch {
      return "unavailable";
    }
    try {
      await p.rpc.request(
        M.threadStart,
        { cwd, approvalPolicy: "untrusted", sandbox: this.o.sandbox, ephemeral: true, serviceName: "alca" },
        this.o.setupTimeoutMs ?? 30_000,
      );
      return "ok";
    } catch (err) {
      if (!isPolicyRejection(err) || this.policy !== "untrusted") return "unknown";
      this.policy = "on-request";
      this.policyRetired = true;
      // A process started under the old policy would send it again: drop the idle ones.
      // Review 2026-11-05 #12: not one whose turn is still setting up (in `thread()`,
      // before its sink is set) — the reaper counts that turn as busy from its start.
      for (const [k, proc] of this.procs)
        if (!proc.sink && !this.idle.isBusy(k)) {
          proc.kill();
          this.procs.delete(k);
        }
      return "retired";
    } finally {
      p.kill();
    }
  }

  /**
   * Open (or resume) the conversation's thread on this process. `lost` = a
   * stored thread would not resume (review 2026-11-05 #4): it is forgotten and
   * a fresh thread started, and the turn says so.
   */
  private async thread(
    key: string,
    proc: AppServerProcess,
    cfg: EngineLaunchConfig,
  ): Promise<{ id: string; lost: boolean }> {
    if (proc.threadId) return { id: proc.threadId, lost: false };
    const common = {
      cwd: cfg.cwd,
      approvalPolicy: this.policy,
      sandbox: this.o.sandbox,
      ...(cfg.model ? { model: cfg.model } : {}),
      ...(cfg.stablePrompt.trim() ? { developerInstructions: cfg.stablePrompt.trim() } : {}),
    };
    const stored = this.o.sessions.get(key);
    const t = this.o.setupTimeoutMs ?? 30_000;
    let id: string | undefined;
    let lost = false;
    if (stored) {
      const r = await proc.rpc
        .request<{ thread?: { id?: string } }>(
          M.threadResume,
          { threadId: stored, excludeTurns: true, ...common },
          t,
        )
        .catch((err: unknown) => {
          // A refused policy says nothing about the thread: keep it, refuse the turn.
          if (isPolicyRejection(err))
            throw Object.assign(err as Error, {
              code: "engine.codex_policy_rejected",
              sentPolicy: common.approvalPolicy,
            });
          return undefined;
        });
      id = r?.thread?.id;
      if (!id) {
        lost = true;
        this.o.sessions.clear?.(key);
      }
    }
    if (!id) {
      const r = await proc.rpc
        .request<{ thread?: { id?: string } }>(M.threadStart, { ...common, serviceName: "alca" }, t)
        .catch((err: unknown) => {
          throw isPolicyRejection(err)
            ? Object.assign(err as Error, {
                code: "engine.codex_policy_rejected",
                sentPolicy: common.approvalPolicy,
              })
            : err;
        });
      id = r?.thread?.id;
    }
    if (!id) throw new Error("Codex app-server 沒有給 thread id");
    proc.threadId = id;
    this.o.sessions.set(key, id);
    return { id, lost };
  }

  async *turn(req: EngineTurnRequest): AsyncIterable<EngineEvent> {
    const key = conversationKey(req);
    if (this.available === false && this.o.fallback) {
      yield* this.o.fallback.turn(req);
      return;
    }
    this.idle.begin(key);
    try {
      yield* this.runTurn(req, key);
    } finally {
      this.idle.end(key);
    }
  }

  private async *runTurn(req: EngineTurnRequest, key: string): AsyncIterable<EngineEvent> {
    const tools = this.o.hostTools === false ? [] : (req.tools ?? []);
    const cfg = withTurnCwd(this.o.launch(key), req);
    let proc: AppServerProcess;
    let threadId: string;
    let lost = false;
    try {
      proc = await this.proc(key, cfg, tools);
      ({ id: threadId, lost } = await this.thread(key, proc, cfg));
    } catch (err) {
      const e = err as Error & { code?: string; sentPolicy?: AppServerApprovalPolicy };
      if (e?.code === "engine.codex_policy_rejected") {
        yield* this.policyRefused(key, e, e.sentPolicy);
        return;
      }
      if (e?.code === "engine.not_found" || e?.code === "engine.app_server_unavailable") {
        this.available = false;
        if (this.o.fallback) {
          yield* this.o.fallback.turn(req);
          return;
        }
      }
      const coding =
        this.o.sandbox === "workspace-write" ? "（Codex 不能改檔，這件 coding 工作沒有開始）" : "";
      yield {
        type: "error",
        code: e?.code ?? "engine.crashed",
        message: `${String(e?.message ?? err).slice(0, 300)}${coding}`,
        retryable: e?.code !== "engine.not_found" && e?.code !== "engine.app_server_unavailable",
      };
      yield { type: "done", stop: "error" };
      return;
    }
    yield { type: "session", sessionId: threadId, ...(cfg.model ? { model: cfg.model } : {}) };
    if (lost) yield { type: "notice", code: CONTEXT_RESET, message: CONTEXT_RESET_NOTE };

    const exposed = new Set(tools.map((t) => t.name));
    const run = req.onToolCall;
    const toolHandler = async (c: HostToolCallRequest) => {
      if (!exposed.has(c.toolName)) return { ok: false, output: `沒有這個主機工具：${c.toolName}` };
      if (!run) return { ok: false, output: "這個回合不能執行主機工具" };
      return await run(c);
    };
    this.bridge.registerTools(key, toolHandler);
    const sink: TurnSink = {
      state: newMapState(threadId, proc.totals),
      q: new EventQueue<EngineEvent>(),
      aborted: false,
      ...(req.onPermission ? { onPermission: req.onPermission } : {}),
    };
    proc.sink = sink;
    const onAbort = () => {
      if (sink.aborted) return;
      sink.aborted = true;
      proc.interruptTurn();
    };
    req.signal.addEventListener("abort", onAbort, { once: true });
    const v = req.system.volatile.trim();
    const text = v ? `${v}\n\n${req.userMessage}` : req.userMessage;
    const sent = this.policy;
    proc.rpc
      .request<{ turn?: { id?: string } }>(M.turnStart, {
        threadId,
        input: [{ type: "text", text, text_elements: [] }],
        cwd: cfg.cwd,
        approvalPolicy: this.policy,
        sandboxPolicy: sandboxPolicy(this.o.sandbox, cfg.cwd, cfg.confine),
        ...(cfg.model ? { model: cfg.model } : {}),
      })
      .then(
        (r) => {
          const id = r?.turn?.id;
          if (!sink.state.turnId && id) sink.state.turnId = id;
          if (sink.aborted) proc.interruptTurn();
        },
        (err: unknown) => {
          if (sink.state.ended) return;
          sink.state.ended = true;
          const refused = isPolicyRejection(err) ? this.refusal(key, err as Error, sent) : undefined;
          sink.q.push(
            refused ?? {
              type: "error",
              code: "engine.codex",
              message: `turn/start 失敗：${String((err as Error)?.message ?? err).slice(0, 300)}`,
              retryable: true,
            },
          );
          sink.q.push({ type: "done", stop: "error" });
          sink.q.close();
        },
      );
    if (req.signal.aborted) onAbort();
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

  /**
   * The CLI refused the approval policy. `untrusted` → switch to `on-request`
   * (this process is dropped; the next turn starts one with the new policy)
   * and refuse this turn clearly: nothing ran. `on-request` refused → say so.
   */
  private refusal(key: string, err: Error, sent: AppServerApprovalPolicy = this.policy): EngineEvent {
    const said = String(err?.message ?? err).slice(0, 200);
    // `sent`: the policy this request carried (the probe may have switched the engine since).
    if (sent === "untrusted") {
      if (this.policy === "untrusted") {
        this.policy = "on-request";
        this.policyRetired = true;
      }
      this.procs.get(key)?.kill();
      this.procs.delete(key);
      const coding =
        this.o.sandbox === "workspace-write" ? "這件 coding 工作沒有開始。" : "這個回合沒有執行任何東西。";
      return {
        type: "error",
        code: "engine.codex_untrusted_retired",
        message: `${coding}${UNTRUSTED_RETIRED_NOTE}（Codex：${said}）`,
        retryable: false,
      };
    }
    return {
      type: "error",
      code: "engine.codex_policy_rejected",
      message: `Codex app-server 不接受審批模式「${sent}」，這個回合沒有執行任何東西（Codex：${said}）。請更新 Codex CLI 或檢查它的 requirements.toml（allowed_approval_policies）。`,
      retryable: false,
    };
  }

  private *policyRefused(key: string, err: Error, sent?: AppServerApprovalPolicy): Iterable<EngineEvent> {
    yield this.refusal(key, err, sent);
    yield { type: "done", stop: "error" };
  }

  async interrupt(key: string): Promise<void> {
    const p = this.procs.get(key);
    if (p?.sink && !p.sink.aborted) {
      p.sink.aborted = true;
      p.interruptTurn();
    }
    await this.o.fallback?.interrupt(key);
  }

  /** Stop a finished conversation's process; its thread id stays, so it can be resumed. */
  async release(key: string): Promise<void> {
    await this.releaseProcess(key);
    await this.o.fallback?.release?.(key);
  }

  /** Kill the conversation's app-server unless a turn is on it; the thread id stays in `sessions`. */
  private async releaseProcess(key: string): Promise<void> {
    this.idle.forget(key);
    const p = this.procs.get(key);
    if (p && !p.sink) {
      p.kill();
      this.procs.delete(key);
    }
  }

  hasProcess(key: string): boolean {
    return this.procs.get(key)?.alive ?? false;
  }

  async dispose(): Promise<void> {
    this.idle.stop();
    for (const p of this.procs.values()) p.kill();
    this.procs.clear();
    await this.bridge.stop();
    await this.o.fallback?.dispose();
    if (this.dir) rmSync(this.dir, { recursive: true, force: true });
    this.dir = undefined;
  }
}
