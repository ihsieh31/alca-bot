// Minimal stdio MCP server exposing one tool, `approve`, for the Claude Code
// CLI's --permission-prompt-tool. It forwards each permission prompt to the
// Alca bridge on loopback and returns the host's decision.
//
// Run as a standalone script: `node permission-mcp.ts` (Node ≥ 22.18 strips
// types). It imports only Node built-ins (and our built-ins-only loop) on purpose.
//
// Environment: ALCA_BRIDGE_FILE (a 0600 file with the bridge url and token; or ALCA_BRIDGE_URL +
// ALCA_BRIDGE_TOKEN), ALCA_THREAD_ID.

import { ALCA_VERSION } from "../version.ts";
import { postBridge, serveStdioMcp } from "./stdio-mcp.ts";

type Json = Record<string, unknown>;

const APPROVE_TOOL = {
  name: "approve",
  description: "Ask the Alca host (and through it, the user) whether a tool call may run.",
  inputSchema: {
    type: "object",
    properties: {
      tool_name: { type: "string" },
      input: { type: "object" },
      tool_use_id: { type: "string" },
    },
    required: ["tool_name", "input"],
  },
};

async function decide(args: Json): Promise<Json> {
  const input = typeof args.input === "object" && args.input !== null ? (args.input as Json) : {};
  try {
    const answer = await postBridge("/permission", {
      threadId: process.env.ALCA_THREAD_ID,
      toolName: args.tool_name,
      input,
      toolUseId: args.tool_use_id,
    });
    if (answer.behavior === "allow") return { behavior: "allow", updatedInput: input };
    return {
      behavior: "deny",
      message: typeof answer.message === "string" ? answer.message : "Denied by the user",
    };
  } catch {
    // Fail closed: if we cannot reach the host, nothing runs.
    return { behavior: "deny", message: "Alca approval bridge is unreachable" };
  }
}

serveStdioMcp({
  info: { name: "alca-permission", version: ALCA_VERSION },
  tools: () => [APPROVE_TOOL],
  call: async (_name, args) => ({ text: JSON.stringify(await decide(args)), isError: false }),
});
