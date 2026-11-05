import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type {
  HostToolCallRequest,
  HostToolCallResult,
  PermissionAnswer,
  PermissionRequest,
} from "../types.ts";

export type PermissionHandler = (req: PermissionRequest) => Promise<PermissionAnswer>;
export type HostToolHandler = (req: HostToolCallRequest) => Promise<HostToolCallResult>;

const MAX_BODY = 1 << 20;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Loopback HTTP endpoint our MCP servers call back into: `POST /permission`
 * (permission prompts) and `POST /tool` (host tool calls).
 * Bound to 127.0.0.1 on a random port, guarded by a random bearer token, and
 * fail-closed: no handler for the thread, a bad token or a handler error all
 * answer "deny" (permission) or a failed call (tool).
 */
export class PermissionBridge {
  readonly token = randomBytes(32).toString("hex");
  private server: Server | undefined;
  private readonly handlers = new Map<string, PermissionHandler>();
  private readonly toolHandlers = new Map<string, HostToolHandler>();
  private urlValue: string | undefined;

  get url(): string {
    if (!this.urlValue) throw new Error("bridge not started");
    return this.urlValue;
  }

  async start(): Promise<string> {
    if (this.urlValue) return this.urlValue;
    const server = createServer({ requestTimeout: 0 }, (req, res) => {
      const isTool = req.url === "/tool";
      const work: Promise<unknown> = isTool ? this.handleTool(req) : this.handle(req);
      void work.then(
        (answer) => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(answer));
        },
        () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify(
              isTool
                ? { ok: false, output: "Alca 主機執行工具時出錯" }
                : { behavior: "deny", message: "approval bridge error" },
            ),
          );
        },
      );
    });
    server.headersTimeout = 10_000;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    this.server = server;
    const addr = server.address() as AddressInfo;
    this.urlValue = `http://127.0.0.1:${addr.port}/permission`;
    return this.urlValue;
  }

  private authorized(req: IncomingMessage): boolean {
    const got = Buffer.from(String(req.headers.authorization ?? ""));
    const want = Buffer.from(`Bearer ${this.token}`);
    return got.length === want.length && timingSafeEqual(got, want);
  }

  private async handle(req: IncomingMessage): Promise<PermissionAnswer> {
    if (req.method !== "POST" || req.url !== "/permission" || !this.authorized(req)) {
      return { behavior: "deny", message: "unauthorized approval request" };
    }
    const body = JSON.parse(await readBody(req)) as {
      threadId?: unknown;
      toolName?: unknown;
      input?: unknown;
      toolUseId?: unknown;
    };
    const handler = typeof body.threadId === "string" ? this.handlers.get(body.threadId) : undefined;
    if (!handler || typeof body.toolName !== "string") {
      return { behavior: "deny", message: "no active turn is waiting for this approval" };
    }
    const input =
      typeof body.input === "object" && body.input !== null ? (body.input as Record<string, unknown>) : {};
    return await handler({
      toolName: body.toolName,
      input,
      ...(typeof body.toolUseId === "string" ? { toolUseId: body.toolUseId } : {}),
    });
  }

  private async handleTool(req: IncomingMessage): Promise<HostToolCallResult> {
    if (req.method !== "POST" || !this.authorized(req))
      return { ok: false, output: "unauthorized tool call" };
    const body = JSON.parse(await readBody(req)) as {
      threadId?: unknown;
      toolName?: unknown;
      input?: unknown;
    };
    const handler = typeof body.threadId === "string" ? this.toolHandlers.get(body.threadId) : undefined;
    if (!handler || typeof body.toolName !== "string") {
      return { ok: false, output: "沒有進行中的回合可以執行這個工具" };
    }
    const input =
      typeof body.input === "object" && body.input !== null ? (body.input as Record<string, unknown>) : {};
    return await handler({ toolName: body.toolName, input });
  }

  registerTools(threadId: string, handler: HostToolHandler): void {
    this.toolHandlers.set(threadId, handler);
  }

  unregisterTools(threadId: string, handler?: HostToolHandler): void {
    if (!handler || this.toolHandlers.get(threadId) === handler) this.toolHandlers.delete(threadId);
  }

  register(threadId: string, handler: PermissionHandler): void {
    this.handlers.set(threadId, handler);
  }

  unregister(threadId: string, handler?: PermissionHandler): void {
    if (!handler || this.handlers.get(threadId) === handler) this.handlers.delete(threadId);
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = undefined;
    this.urlValue = undefined;
    if (s) {
      s.closeAllConnections();
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
  }
}
