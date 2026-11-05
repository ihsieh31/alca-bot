// A minimal stdio MCP server loop (JSON-RPC 2.0, one message per line), written
// from the public Model Context Protocol specification: `initialize`, `ping`,
// `tools/list`, `tools/call`. Shared by our in-house servers that the Claude
// Code CLI launches from --mcp-config. Imports only Node built-ins on purpose:
// the servers run as standalone scripts with type stripping.
import { createInterface } from "node:readline";

type Json = Record<string, unknown>;

export interface StdioToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface StdioToolResult {
  text: string;
  isError: boolean;
}

export interface StdioMcpServer {
  info: { name: string; version: string };
  /** Short guidance the client may show the model (MCP `instructions`). */
  instructions?: string;
  tools(): readonly StdioToolSpec[];
  call(name: string, args: Json): Promise<StdioToolResult>;
}

const DEFAULT_PROTOCOL = "2025-06-18";

function send(msg: Json): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
}

async function handle(server: StdioMcpServer, msg: Json): Promise<void> {
  const id = msg.id;
  const isRequest = id !== undefined && id !== null;
  switch (msg.method) {
    case "initialize": {
      const params = (msg.params ?? {}) as { protocolVersion?: unknown };
      send({
        id,
        result: {
          protocolVersion:
            typeof params.protocolVersion === "string" ? params.protocolVersion : DEFAULT_PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: server.info,
          ...(server.instructions ? { instructions: server.instructions } : {}),
        },
      });
      return;
    }
    case "ping":
      if (isRequest) send({ id, result: {} });
      return;
    case "tools/list":
      send({ id, result: { tools: server.tools() } });
      return;
    case "tools/call": {
      const params = (msg.params ?? {}) as { name?: unknown; arguments?: unknown };
      const name = typeof params.name === "string" ? params.name : "";
      if (!server.tools().some((t) => t.name === name)) {
        send({ id, error: { code: -32602, message: `unknown tool ${name}` } });
        return;
      }
      const args =
        typeof params.arguments === "object" && params.arguments !== null ? (params.arguments as Json) : {};
      let r: StdioToolResult;
      try {
        r = await server.call(name, args);
      } catch (err) {
        r = { text: `tool failed: ${String((err as Error)?.message ?? err)}`, isError: true };
      }
      send({ id, result: { content: [{ type: "text", text: r.text }], isError: r.isError } });
      return;
    }
    default:
      // Notifications (no id) are ignored; unknown requests get "method not found".
      if (isRequest)
        send({ id, error: { code: -32601, message: `method not found: ${String(msg.method)}` } });
  }
}

/** Serve on stdin/stdout until stdin closes. */
export function serveStdioMcp(server: StdioMcpServer): void {
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg: Json;
    try {
      msg = JSON.parse(line) as Json;
    } catch {
      send({ id: null, error: { code: -32700, message: "parse error" } });
      return;
    }
    void handle(server, msg);
  });
  rl.on("close", () => process.exit(0));
}

/** POST JSON to the host bridge with the bearer token; throws on transport errors. */
export async function postBridge(path: string, body: Json): Promise<Json> {
  let url = process.env.ALCA_BRIDGE_URL;
  let token = process.env.ALCA_BRIDGE_TOKEN;
  // A CLI that only takes its MCP server's env on the command line (Codex) gets
  // a 0600 file path instead, so the token never shows in a process list.
  const file = process.env.ALCA_BRIDGE_FILE;
  if (file && (!url || !token)) {
    const { readFileSync } = await import("node:fs");
    const j = JSON.parse(readFileSync(file, "utf8")) as { url?: string; token?: string };
    url = j.url;
    token = j.token;
  }
  if (!url || !token) throw new Error("Alca bridge is not configured");
  const res = await fetch(new URL(path, url), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return (await res.json()) as Json;
}
