import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";

/**
 * Next round R8: a small MCP client for the person's own servers. JSON-RPC
 * 2.0 over one of two transports:
 *
 * - stdio: the server is a program Alca starts (`command` + `args`), one
 *   JSON message per line each way. Its environment is a short allowlist
 *   plus that server's own secrets; nothing else of Alca's leaks into it. A
 *   crashed server is started again on the next call, with a growing wait,
 *   at most five times, and the handshake runs again first.
 * - Streamable HTTP: every message is a POST to the server's URL; the answer
 *   is JSON or an SSE stream carrying it. The session id the server gives at
 *   initialize goes with every later request; redirects are refused.
 *
 * Calls: initialize (+ notifications/initialized), tools/list (every page),
 * tools/call. A notifications/tools/list_changed from the server drops the
 * cached list. Answers are read up to a size cap; a slow call times out.
 * Remote MCP OAuth is not part of this round (a header token only).
 */

export const MCP_PROTOCOL_VERSION = "2025-06-18";
export const MCP_LIMITS = { maxBytes: 4 * 1024 * 1024, timeoutMs: 60_000, restarts: 5, pages: 20 } as const;

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, unknown>;
}

export interface McpCallResult {
  isError: boolean;
  content: unknown;
  structured?: unknown;
}

export class McpError extends Error {
  readonly code: number | string;
  constructor(code: number | string, message: string) {
    super(message);
    this.name = "McpError";
    this.code = code;
  }
}

type Json = Record<string, unknown>;

export interface McpTransport {
  /** Send a request and wait for its answer. */
  request(method: string, params: Json, signal: AbortSignal): Promise<unknown>;
  notify(method: string, params?: Json): Promise<void>;
  /** Called for a notification the server sends. */
  onNotification?: (method: string) => void;
  close(): Promise<void>;
}

/** Environment variables a stdio server inherits; everything else is left out. */
export const STDIO_ENV_ALLOW = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "TZ",
  "SYSTEMROOT",
  "APPDATA",
  "LOCALAPPDATA",
] as const;

export function stdioEnv(
  secrets: Record<string, string>,
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of STDIO_ENV_ALLOW) if (base[k]) env[k] = base[k] as string;
  return { ...env, ...secrets };
}

export type SpawnFn = (
  command: string,
  args: string[],
  o: { cwd?: string; env: Record<string, string> },
) => ChildProcess;

const defaultSpawn: SpawnFn = (command, args, o) =>
  nodeSpawn(command, args, { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "pipe"], shell: false });

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

export interface StdioOptions {
  command: string;
  args: string[];
  cwd?: string;
  /** Read right before each start (the server's secrets are not kept in this object). */
  env: () => Promise<Record<string, string>>;
  spawn?: SpawnFn;
  /** Runs after a restart, before the call that restarted it (the handshake). */
  onStart?: () => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}

/** One stdio server, started on first use and again after a crash (bounded). */
export class StdioTransport implements McpTransport {
  onNotification?: (method: string) => void;
  private child: ChildProcess | undefined;
  private buf = "";
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private restarts = 0;
  private closed = false;
  private readonly o: StdioOptions;

  constructor(o: StdioOptions) {
    this.o = o;
  }

  /** How many times the server was started again after it stopped. */
  get restartCount(): number {
    return this.restarts;
  }

  /** The running child, started (again) when needed; `handshake` runs onStart after a restart. */
  private async ensure(handshake: boolean): Promise<ChildProcess> {
    if (this.closed) throw new McpError("closed", "這個 MCP server 已經關閉");
    if (this.child && this.child.exitCode === null && this.child.signalCode === null && !this.child.killed)
      return this.child;
    const again = !!this.child;
    if (again) {
      if (this.restarts >= MCP_LIMITS.restarts)
        throw new McpError("crashed", `MCP server 一直停止（已重啟 ${MCP_LIMITS.restarts} 次），請檢查設定`);
      const wait = 500 * 2 ** this.restarts;
      this.restarts++;
      await (this.o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(wait);
    }
    const env = await this.o.env();
    const child = (this.o.spawn ?? defaultSpawn)(this.o.command, this.o.args, {
      ...(this.o.cwd ? { cwd: this.o.cwd } : {}),
      env,
    });
    this.child = child;
    this.buf = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => this.onData(d));
    child.stderr?.on("data", () => undefined); // drained, never shown to the model
    child.on("error", (e) => this.fail(new McpError("spawn", `MCP server 啟動失敗：${e.message}`)));
    child.on("exit", () => this.fail(new McpError("exit", "MCP server 停止了")));
    if (again && handshake && this.o.onStart) await this.o.onStart();
    return child;
  }

  private fail(e: Error): void {
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
  }

  private onData(d: string): void {
    this.buf += d;
    if (this.buf.length > MCP_LIMITS.maxBytes) {
      this.buf = "";
      this.fail(new McpError("too_big", "MCP server 的回應太大"));
      this.child?.kill();
      return;
    }
    let i = this.buf.indexOf("\n");
    while (i >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (line) this.onMessage(line);
      i = this.buf.indexOf("\n");
    }
  }

  private onMessage(line: string): void {
    let m: Json;
    try {
      m = JSON.parse(line) as Json;
    } catch {
      return; // a log line on stdout: not ours
    }
    if (typeof m.id === "number" && this.pending.has(m.id)) {
      const p = this.pending.get(m.id) as Pending;
      this.pending.delete(m.id);
      if (m.error && typeof m.error === "object") {
        const e = m.error as { code?: number; message?: unknown };
        p.reject(new McpError(e.code ?? "error", String(e.message ?? "MCP 錯誤").slice(0, 300)));
      } else p.resolve(m.result);
      return;
    }
    if (typeof m.method === "string" && m.id === undefined) this.onNotification?.(m.method);
    else if (typeof m.method === "string" && m.id !== undefined)
      // A request from the server (sampling, roots…): not supported, and said so.
      this.write({
        jsonrpc: "2.0",
        id: m.id,
        error: { code: -32601, message: "not supported by this client" },
      });
  }

  private write(m: Json): void {
    this.child?.stdin?.write(`${JSON.stringify(m)}\n`);
  }

  async request(method: string, params: Json, signal: AbortSignal): Promise<unknown> {
    // initialize itself only needs a running child (it is the handshake onStart would run).
    await this.ensure(method !== "initialize");
    const id = this.nextId++;
    const timeout = AbortSignal.timeout(MCP_LIMITS.timeoutMs);
    const sig = AbortSignal.any([signal, timeout]);
    return new Promise((resolve, reject) => {
      const stop = () => {
        this.pending.delete(id);
        reject(new McpError("timeout", timeout.aborted ? "MCP server 沒有回應（逾時）" : "已取消"));
      };
      if (sig.aborted) return stop();
      sig.addEventListener("abort", stop, { once: true });
      this.pending.set(id, {
        resolve: (v) => {
          sig.removeEventListener("abort", stop);
          resolve(v);
        },
        reject: (e) => {
          sig.removeEventListener("abort", stop);
          reject(e);
        },
      });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  async notify(method: string, params: Json = {}): Promise<void> {
    this.write({ jsonrpc: "2.0", method, params });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.fail(new McpError("closed", "已關閉"));
    this.child?.kill();
  }
}

/** Streamable HTTP: one POST per message; JSON or an SSE stream back. */
export class HttpTransport implements McpTransport {
  onNotification?: (method: string) => void;
  private session: string | undefined;
  private nextId = 1;
  private readonly o: { url: string; headers: () => Promise<Record<string, string>>; fetch?: typeof fetch };

  constructor(o: { url: string; headers: () => Promise<Record<string, string>>; fetch?: typeof fetch }) {
    this.o = o;
  }

  private async post(body: Json, signal: AbortSignal): Promise<Response> {
    const res = await (this.o.fetch ?? fetch)(this.o.url, {
      method: "POST",
      redirect: "manual",
      headers: {
        ...(await this.o.headers()),
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": MCP_PROTOCOL_VERSION,
        ...(this.session ? { "mcp-session-id": this.session } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(MCP_LIMITS.timeoutMs)]),
    });
    if (res.status >= 300 && res.status < 400) throw new McpError(res.status, "MCP server 要求轉址，不跟");
    if (res.status === 401 || res.status === 403)
      throw new McpError(res.status, `MCP server 拒絕存取（HTTP ${res.status}），請檢查權杖`);
    if (!res.ok) throw new McpError(res.status, `MCP server 回應 HTTP ${res.status}`);
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.session = sid;
    return res;
  }

  private static async text(res: Response): Promise<string> {
    const reader = res.body?.getReader();
    if (!reader) return "";
    const parts: Uint8Array[] = [];
    let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.length;
      if (n > MCP_LIMITS.maxBytes) {
        await reader.cancel();
        throw new McpError("too_big", "MCP server 的回應太大");
      }
      parts.push(value);
    }
    return Buffer.concat(parts).toString("utf8");
  }

  async request(method: string, params: Json, signal: AbortSignal): Promise<unknown> {
    const id = this.nextId++;
    const res = await this.post({ jsonrpc: "2.0", id, method, params }, signal);
    const ct = res.headers.get("content-type") ?? "";
    const raw = await HttpTransport.text(res);
    const messages: Json[] = [];
    if (/text\/event-stream/i.test(ct)) {
      for (const block of raw.split(/\r?\n\r?\n/)) {
        const data = block
          .split(/\r?\n/)
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n");
        if (!data) continue;
        try {
          messages.push(JSON.parse(data) as Json);
        } catch {
          // not JSON: skip
        }
      }
    } else {
      try {
        const j = JSON.parse(raw) as Json | Json[];
        messages.push(...(Array.isArray(j) ? j : [j]));
      } catch {
        throw new McpError("format", "MCP server 的回應不是 JSON");
      }
    }
    for (const m of messages)
      if (typeof m.method === "string" && m.id === undefined) this.onNotification?.(m.method);
    const answer = messages.find((m) => m.id === id);
    if (!answer) throw new McpError("format", "MCP server 沒有回答這個請求");
    if (answer.error && typeof answer.error === "object") {
      const e = answer.error as { code?: number; message?: unknown };
      throw new McpError(e.code ?? "error", String(e.message ?? "MCP 錯誤").slice(0, 300));
    }
    return answer.result;
  }

  async notify(method: string, params: Json = {}): Promise<void> {
    const res = await this.post(
      { jsonrpc: "2.0", method, params },
      AbortSignal.timeout(MCP_LIMITS.timeoutMs),
    );
    await res.body?.cancel();
  }

  async close(): Promise<void> {
    this.session = undefined;
  }
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** The client over one transport: initialize once, cache the tool list until the server says it changed. */
export class McpClient {
  private readonly t: McpTransport;
  private ready: Promise<void> | undefined;
  private tools: McpToolInfo[] | undefined;
  serverName = "";

  constructor(t: McpTransport) {
    this.t = t;
    t.onNotification = (m) => {
      if (m === "notifications/tools/list_changed") this.tools = undefined;
    };
  }

  /** The handshake (again after a stdio restart: the transport's onStart calls it). */
  async initialize(signal: AbortSignal = AbortSignal.timeout(MCP_LIMITS.timeoutMs)): Promise<void> {
    const r = (await this.t.request(
      "initialize",
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "alca-agent", version: "0.2" },
      },
      signal,
    )) as { serverInfo?: { name?: unknown } } | undefined;
    this.serverName = str(r?.serverInfo?.name).slice(0, 80);
    await this.t.notify("notifications/initialized");
    this.tools = undefined;
  }

  private start(): Promise<void> {
    this.ready ??= this.initialize().catch((e) => {
      this.ready = undefined;
      throw e;
    });
    return this.ready;
  }

  /** Every tool (all pages), cached until list_changed. */
  async listTools(signal: AbortSignal = AbortSignal.timeout(MCP_LIMITS.timeoutMs)): Promise<McpToolInfo[]> {
    await this.start();
    if (this.tools) return this.tools;
    const out: McpToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MCP_LIMITS.pages; page++) {
      const r = (await this.t.request("tools/list", cursor ? { cursor } : {}, signal)) as
        | { tools?: unknown; nextCursor?: unknown }
        | undefined;
      for (const x of Array.isArray(r?.tools) ? r.tools : []) {
        if (!x || typeof x !== "object") continue;
        const t = x as Json;
        if (!str(t.name)) continue;
        out.push({
          name: str(t.name).slice(0, 128),
          description: str(t.description),
          inputSchema: t.inputSchema && typeof t.inputSchema === "object" ? (t.inputSchema as Json) : {},
          annotations: t.annotations && typeof t.annotations === "object" ? (t.annotations as Json) : {},
        });
      }
      cursor = str(r?.nextCursor) || undefined;
      if (!cursor) break;
    }
    this.tools = out;
    return out;
  }

  async callTool(
    name: string,
    args: Json,
    signal: AbortSignal = AbortSignal.timeout(MCP_LIMITS.timeoutMs),
  ): Promise<McpCallResult> {
    await this.start();
    const r = (await this.t.request("tools/call", { name, arguments: args }, signal)) as
      | { content?: unknown; structuredContent?: unknown; isError?: unknown }
      | undefined;
    return {
      isError: r?.isError === true,
      content: r?.content ?? null,
      ...(r?.structuredContent !== undefined ? { structured: r.structuredContent } : {}),
    };
  }

  close(): Promise<void> {
    return this.t.close();
  }
}
