import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

/**
 * JSON-RPC 2.0 over stdio, one JSON object per line, as the Agent Client
 * Protocol uses it (written from the public ACP spec): both sides send
 * requests, responses and notifications. Requests from the agent (permission
 * prompts, file reads) go to `onRequest`; an unknown method answers -32601.
 */

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

export class AcpRpcError extends Error {
  readonly code: number;
  constructor(e: RpcError) {
    super(e.message);
    this.code = e.code;
  }
}

type Json = Record<string, unknown>;

export interface RpcHandlers {
  onRequest(method: string, params: Json): Promise<unknown>;
  onNotification(method: string, params: Json): void;
}

/** Most bytes a single line may have before the peer is treated as broken. */
const MAX_LINE = 8 << 20;

export class JsonRpcPeer {
  private next = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private closed = false;
  private readonly out: Writable;
  private readonly h: RpcHandlers;

  /** Write the `"jsonrpc": "2.0"` member (ACP: yes; Codex app-server omits it on the wire). */
  private readonly header: boolean;

  constructor(input: Readable, out: Writable, h: RpcHandlers, o: { header?: boolean } = {}) {
    this.out = out;
    this.h = h;
    this.header = o.header !== false;
    const rl = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
    rl.on("line", (line) => this.onLine(line));
    rl.on("close", () => this.close(new Error("agent closed its output")));
    out.on("error", () => undefined);
  }

  private write(msg: Json): void {
    if (this.closed) return;
    this.out.write(`${JSON.stringify(this.header ? { jsonrpc: "2.0", ...msg } : msg)}\n`);
  }

  private onLine(line: string): void {
    if (!line.trim() || line.length > MAX_LINE) return;
    let m: Json;
    try {
      m = JSON.parse(line) as Json;
    } catch {
      return;
    }
    if (!m || typeof m !== "object") return;
    const params = (m.params && typeof m.params === "object" ? m.params : {}) as Json;
    if (typeof m.method === "string") {
      if (m.id === undefined || m.id === null) {
        this.h.onNotification(m.method, params);
        return;
      }
      const id = m.id as number | string;
      void this.h.onRequest(m.method, params).then(
        (result) => this.write({ id, result: result ?? null }),
        (err: unknown) =>
          this.write({
            id,
            error:
              err instanceof AcpRpcError
                ? { code: err.code, message: err.message }
                : { code: -32603, message: String((err as Error)?.message ?? err).slice(0, 300) },
          }),
      );
      return;
    }
    if (typeof m.id === "number") {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error && typeof m.error === "object") p.reject(new AcpRpcError(m.error as RpcError));
      else p.resolve(m.result);
    }
  }

  request<T = Json>(method: string, params: Json, timeoutMs?: number): Promise<T> {
    if (this.closed) return Promise.reject(new Error("agent is not running"));
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      if (timeoutMs)
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`${method} timed out`));
        }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          if (timer) clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          if (timer) clearTimeout(timer);
          reject(e);
        },
      });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params: Json): void {
    this.write({ method, params });
  }

  close(err = new Error("agent stopped")): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

export const methodNotFound = (method: string) =>
  new AcpRpcError({ code: -32601, message: `method not found: ${method}` });
