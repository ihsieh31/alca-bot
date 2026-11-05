import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { PermissionBridge } from "../claude/bridge.ts";
import { type SessionMemory, toolsFingerprint } from "../claude/engine.ts";
import { engineEnv } from "../env.ts";
import { HARNESS_MATRIX } from "../harness-matrix.ts";
import {
  conversationKey,
  type Engine,
  type EngineCapabilities,
  type EngineEvent,
  type EngineLaunchConfig,
  type EngineTurnRequest,
  EventQueue,
  type HostToolCallRequest,
  launchConfigHash,
  type ToolSpec,
  withTurnCwd,
} from "../types.ts";
import { buildCodexArgs, type CodexMcpServer } from "./args.ts";
import { prepareCodexHome } from "./home.ts";
import { CodexStreamParser } from "./parse.ts";

export const CODEX_CAPABILITIES: EngineCapabilities = Object.freeze({
  kind: "cli",
  // One `codex exec` process per turn; the conversation lives on through `resume`.
  persistentProcess: false,
  // Text arrives per message item, not token by token.
  streaming: false,
  resume: true,
  interrupt: true,
  ownsToolLoop: true,
  nativeToolsReadOnly: true,
  nativePermissionModes: ["read-only", "workspace-write", "danger-full-access"],
  // Codex's own tools stay in its read-only sandbox with approvals off; every
  // change goes through the host tools, which the gateway decides on.
  permissionPrompt: "none",
  systemPromptAtLaunch: true,
  supportsPromptCache: true,
  supportsImages: false,
  // Plan §3.1: read-only natively, changes only through host tools; native commands never ask.
  harness: HARNESS_MATRIX.codexExec,
});

export interface CodexEngineOptions {
  /** Command and leading args, e.g. ["codex"] or [process.execPath, "fake-codex.ts"]. */
  command?: readonly string[];
  launch: (key: string) => EngineLaunchConfig;
  sessions: SessionMemory;
  baseEnv?: NodeJS.ProcessEnv;
  /**
   * Alca's own CODEX_HOME (S1, codex/home.ts): no MCP servers or profiles from
   * the person's ~/.codex/config.toml. Default: a per-user folder in the temp
   * folder; the desktop passes `<data>/engines/codex`. `false` = the person's
   * own home (tests of the old behaviour only).
   */
  home?: string | false;
  /** Expose the turn's host tools over MCP (default true). */
  hostTools?: boolean;
  interruptGraceMs?: number;
}

const HOST_TOOLS_SCRIPT = fileURLToPath(new URL("../claude/tools-mcp.ts", import.meta.url));

/** The stable layer goes at the top of a conversation's first message (Codex has no system prompt flag). */
export function composeCodexPrompt(
  req: Pick<EngineTurnRequest, "system" | "userMessage">,
  withInstructions: boolean,
): string {
  const parts: string[] = [];
  if (withInstructions && req.system.stable.trim())
    parts.push(`<alca:instructions>\n${req.system.stable.trim()}\n</alca:instructions>`);
  if (req.system.volatile.trim()) parts.push(req.system.volatile.trim());
  parts.push(req.userMessage);
  return parts.join("\n\n");
}

/**
 * OpenAI Codex CLI as an engine: each turn is one `codex exec --json`
 * process (resumed with the stored session id), its JSONL mapped onto engine
 * events. Same fake-CLI test approach as ClaudeCodeEngine.
 */
export class CodexEngine implements Engine {
  readonly id = "codex";
  readonly capabilities = CODEX_CAPABILITIES;
  private readonly o: CodexEngineOptions;
  private readonly bridge = new PermissionBridge();
  private readonly running = new Map<string, ChildProcessWithoutNullStreams>();
  /** Launch hash a conversation's instructions were given under. */
  private readonly given = new Map<string, string>();
  private dir: string | undefined;
  readonly launches = new Map<string, number>();

  constructor(o: CodexEngineOptions) {
    this.o = o;
  }

  private homeEnv(): Record<string, string> {
    if (this.o.home === false) return {};
    const uid = typeof process.getuid === "function" ? process.getuid() : "u";
    return { CODEX_HOME: prepareCodexHome(this.o.home ?? join(tmpdir(), `alca-codex-home-${uid}`)) };
  }

  private workDir(): string {
    this.dir ??= mkdtempSync(join(tmpdir(), "alca-codex-"));
    return this.dir;
  }

  private async hostServer(key: string, tools: readonly ToolSpec[]): Promise<CodexMcpServer | undefined> {
    if (this.o.hostTools === false || tools.length === 0) return undefined;
    const url = await this.bridge.start();
    const dir = this.workDir();
    const bridgeFile = join(dir, "bridge.json");
    writeFileSync(bridgeFile, JSON.stringify({ url, token: this.bridge.token }), { mode: 0o600 });
    const toolsFile = join(dir, `${toolsFingerprint(tools).slice(0, 16)}.json`);
    writeFileSync(
      toolsFile,
      JSON.stringify(
        tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      ),
      { mode: 0o600 },
    );
    return {
      command: process.execPath,
      args: ["--disable-warning=ExperimentalWarning", HOST_TOOLS_SCRIPT],
      env: { ALCA_BRIDGE_FILE: bridgeFile, ALCA_TOOLS_FILE: toolsFile, ALCA_THREAD_ID: key },
    };
  }

  async *turn(req: EngineTurnRequest): AsyncIterable<EngineEvent> {
    const key = conversationKey(req);
    const tools = this.o.hostTools === false ? [] : (req.tools ?? []);
    const cfg = withTurnCwd(this.o.launch(key), req);
    const hash = `${launchConfigHash(cfg)}:${toolsFingerprint(tools)}`;
    const resume = this.o.sessions.get(key);
    const server = await this.hostServer(key, tools);
    const [command, ...lead] = this.o.command ?? ["codex"];
    if (!command) throw new Error("empty codex command");
    const args = [
      ...lead,
      ...buildCodexArgs(cfg, {
        ...(resume ? { resumeSessionId: resume } : {}),
        ...(server ? { hostTools: server } : {}),
      }),
    ];
    const exposed = new Set(tools.map((t) => t.name));
    const run = req.onToolCall;
    const toolHandler = async (c: HostToolCallRequest) => {
      if (!exposed.has(c.toolName)) return { ok: false, output: `沒有這個主機工具：${c.toolName}` };
      if (!run) return { ok: false, output: "這個回合不能執行主機工具" };
      return await run(c);
    };
    this.bridge.registerTools(key, toolHandler);

    const q = new EventQueue<EngineEvent>();
    const parser = new CodexStreamParser();
    let stderr = "";
    let interrupted = false;
    const child = spawn(command, args, {
      cwd: cfg.cwd,
      // M6: an allow-listed environment; S1: Codex reads Alca's own home, not ~/.codex.
      env: { ...engineEnv(process.env, "codex"), ...this.o.baseEnv, ...cfg.env, ...this.homeEnv() },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.running.set(key, child);
    this.launches.set(key, (this.launches.get(key) ?? 0) + 1);
    child.stdin.on("error", () => undefined);
    child.stderr.on("data", (c: Buffer) => {
      stderr = (stderr + c.toString("utf8")).slice(-2000);
    });
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (!line.trim()) return;
      let m: unknown;
      try {
        m = JSON.parse(line);
      } catch {
        return;
      }
      if (!m || typeof m !== "object") return;
      for (const e of parser.push(m as Record<string, unknown>)) {
        if (e.type === "session") this.o.sessions.set(key, e.sessionId);
        q.push(e);
      }
    });
    const exited = new Promise<number | null>((resolve) => {
      child.on("exit", (code) => resolve(code));
      child.on("error", (err) => {
        stderr += String(err);
        resolve(-1);
      });
    });
    void exited.then((code) => {
      if (!parser.ended) {
        if (interrupted) q.push({ type: "done", stop: "interrupted" });
        else {
          q.push({
            type: "error",
            code: code === -1 ? "engine.not_found" : "engine.crashed",
            message:
              code === -1
                ? `找不到 Codex CLI（${command}）`
                : `Codex 結束了（${code}）：${stderr.trim().slice(-300)}`,
            retryable: code !== -1,
          });
          q.push({ type: "done", stop: "error" });
        }
      }
      q.close();
    });
    const withInstructions = !resume || this.given.get(key) !== hash;
    child.stdin.end(composeCodexPrompt(req, withInstructions));
    this.given.set(key, hash);
    const onAbort = () => {
      interrupted = true;
      this.stop(child);
    };
    req.signal.addEventListener("abort", onAbort, { once: true });
    if (req.signal.aborted) onAbort();
    try {
      for await (const e of q) {
        yield e;
        if (e.type === "done") break;
      }
    } finally {
      req.signal.removeEventListener("abort", onAbort);
      this.bridge.unregisterTools(key, toolHandler);
      if (this.running.get(key) === child) this.running.delete(key);
      if (child.exitCode === null) this.stop(child);
    }
  }

  private stop(child: ChildProcessWithoutNullStreams) {
    if (child.exitCode !== null) return;
    child.kill("SIGINT");
    const t = setTimeout(
      () => child.exitCode === null && child.kill("SIGKILL"),
      this.o.interruptGraceMs ?? 3000,
    );
    t.unref();
  }

  async interrupt(key: string): Promise<void> {
    const c = this.running.get(key);
    if (c) this.stop(c);
  }

  async dispose(): Promise<void> {
    for (const c of this.running.values()) this.stop(c);
    this.running.clear();
    await this.bridge.stop();
    if (this.dir) rmSync(this.dir, { recursive: true, force: true });
    this.dir = undefined;
  }
}
