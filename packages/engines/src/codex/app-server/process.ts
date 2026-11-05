import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { type JsonRpcPeer, methodNotFound } from "../../acp/rpc.ts";
import type { EngineEvent, EventQueue, PermissionAnswer, PermissionRequest } from "../../types.ts";
import { ALCA_VERSION } from "../../version.ts";
import { type MapState, mapNotification, permissionOf } from "./map.ts";
import {
  type AppServerDecision,
  appServerPeer,
  initializeParams,
  APP_SERVER_METHODS as M,
  APP_SERVER_REQUESTS as R,
} from "./rpc.ts";

/**
 * One long-lived `codex app-server` process (plan §3.3) for one conversation
 * key: started, `initialize` + `initialized`, then the engine opens or resumes
 * a thread and runs one turn at a time. Approval requests go to the current
 * turn's permission handler (the host's gate) and are answered `accept` or
 * `decline` — never `acceptForSession`, so every later call asks again.
 */

type Json = Record<string, unknown>;

/** The turn currently running on this process. */
export interface TurnSink {
  state: MapState;
  q: EventQueue<EngineEvent>;
  aborted: boolean;
  onPermission?: (req: PermissionRequest) => Promise<PermissionAnswer>;
}

export interface AppServerSpawn {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Launch hash: a different one means a new process. */
  hash: string;
  setupTimeoutMs: number;
}

export class AppServerProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly rpc: JsonRpcPeer;
  readonly hash: string;
  threadId: string | undefined;
  totals = { input: 0, cached: 0, output: 0 };
  sink: TurnSink | undefined;
  stderr = "";
  private exited = false;

  private constructor(s: AppServerSpawn) {
    this.hash = s.hash;
    this.child = spawn(s.command, [...s.args], { cwd: s.cwd, env: s.env, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr.on("data", (c: Buffer) => {
      this.stderr = (this.stderr + c.toString("utf8")).slice(-2000);
    });
    this.child.stdin.on("error", () => undefined);
    this.rpc = appServerPeer(this.child.stdout, this.child.stdin, {
      onNotification: (method, params) => this.onNotification(method, params),
      onRequest: (method, params) => this.onRequest(method, params),
    });
    this.child.on("exit", (code) => {
      this.exited = true;
      this.rpc.close(new Error(`Codex app-server 結束了（${code}）：${this.stderr.trim().slice(-300)}`));
      const sink = this.sink;
      if (!sink || sink.state.ended) return;
      sink.state.ended = true;
      if (sink.aborted) sink.q.push({ type: "done", stop: "interrupted" });
      else {
        sink.q.push({
          type: "error",
          code: "engine.crashed",
          message: `Codex app-server 結束了（${code}）：${this.stderr.trim().slice(-300)}`,
          retryable: true,
        });
        sink.q.push({ type: "done", stop: "error" });
      }
      sink.q.close();
    });
  }

  /** Spawn and handshake. Throws `{ code: "engine.not_found" | "engine.app_server_unavailable" }`. */
  static async start(s: AppServerSpawn): Promise<AppServerProcess> {
    const p = new AppServerProcess(s);
    const spawned = new Promise<void>((resolve, reject) => {
      p.child.once("spawn", () => resolve());
      p.child.once("error", (e) => reject(e));
    });
    try {
      await spawned;
    } catch (err) {
      p.rpc.close();
      throw Object.assign(new Error(`找不到 Codex CLI（${s.command}）`), {
        code: "engine.not_found",
        cause: err,
      });
    }
    try {
      await p.rpc.request(M.initialize, initializeParams(ALCA_VERSION), s.setupTimeoutMs);
      p.rpc.notify(M.initialized, {});
    } catch (err) {
      p.kill();
      const why = String((err as Error)?.message ?? err).slice(0, 200);
      throw Object.assign(new Error(`Codex app-server 沒有完成 initialize：${why}`), {
        code: "engine.app_server_unavailable",
      });
    }
    return p;
  }

  get alive(): boolean {
    return !this.exited && !this.rpc.isClosed;
  }

  private onNotification(method: string, params: Json): void {
    const sink = this.sink;
    if (!sink || sink.state.ended) return;
    for (const e of mapNotification(method, params, sink.state)) sink.q.push(e);
    this.totals = sink.state.totals;
    if (sink.state.ended) sink.q.close();
  }

  private async onRequest(method: string, params: Json): Promise<unknown> {
    if (method === R.commandApproval || method === R.fileChangeApproval) {
      const decline: { decision: AppServerDecision } = { decision: "decline" };
      const sink = this.sink;
      if (!sink || sink.aborted || params.threadId !== this.threadId) return decline;
      const ask = permissionOf(method, params, sink.state);
      if (!ask || !sink.onPermission) return decline;
      const answer = await sink.onPermission(ask).catch(() => undefined);
      if (sink.aborted) return decline;
      return { decision: answer?.behavior === "allow" ? "accept" : "decline" };
    }
    // Extra sandbox permissions are never granted: the work stays inside the sandbox the host chose.
    if (method === R.permissionsApproval) return { permissions: {}, scope: "turn" };
    // Questions go through the worker's report (NEEDS_INPUT), not a side channel.
    if (method === R.elicitation) return { action: "decline", content: null };
    if (method === R.userInput) return { answers: {} };
    throw methodNotFound(method);
  }

  /** Ask the running turn to stop (the conversation survives). */
  interruptTurn(): void {
    const turnId = this.sink?.state.turnId;
    if (!this.threadId || !turnId || !this.alive) return;
    this.rpc.request(M.turnInterrupt, { threadId: this.threadId, turnId }, 10_000).catch(() => undefined);
  }

  kill(): void {
    this.rpc.close();
    if (this.child.exitCode === null) {
      this.child.kill("SIGTERM");
      const t = setTimeout(() => this.child.exitCode === null && this.child.kill("SIGKILL"), 2000);
      t.unref();
    }
  }
}
