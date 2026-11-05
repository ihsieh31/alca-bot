import type { Readable, Writable } from "node:stream";
import type { ConfineSpec } from "@alca/os";
import { JsonRpcPeer, type RpcHandlers } from "../../acp/rpc.ts";

/**
 * The Codex app-server wire (plan §3.3), written from the openai/codex
 * repository: `codex-rs/app-server/README.md`, the published app-server page
 * (developers.openai.com/codex/app-server) and the v2 protocol types in
 * `codex-rs/app-server-protocol/src/protocol/{common.rs,v2/*.rs}`, read
 * 2026-11-04. JSON-RPC 2.0 over stdio, one JSON message per line, the
 * `"jsonrpc":"2.0"` member omitted on the wire. NOT verified against a real
 * `codex app-server` here (no Codex on the test machines); only against
 * `testing/fake-codex-app-server.ts`. Field names are the v2 camelCase ones.
 */

/** Client → server requests used here. */
export const APP_SERVER_METHODS = Object.freeze({
  initialize: "initialize",
  /** Notification acknowledging the handshake. */
  initialized: "initialized",
  threadStart: "thread/start",
  threadResume: "thread/resume",
  turnStart: "turn/start",
  turnInterrupt: "turn/interrupt",
});

/** Server → client requests (approvals and elicitations). */
export const APP_SERVER_REQUESTS = Object.freeze({
  commandApproval: "item/commandExecution/requestApproval",
  fileChangeApproval: "item/fileChange/requestApproval",
  permissionsApproval: "item/permissions/requestApproval",
  userInput: "item/tool/requestUserInput",
  elicitation: "mcpServer/elicitation/request",
});

/** Server notifications mapped onto engine events. */
export const APP_SERVER_NOTIFICATIONS = Object.freeze({
  itemStarted: "item/started",
  itemCompleted: "item/completed",
  agentDelta: "item/agentMessage/delta",
  tokenUsage: "thread/tokenUsage/updated",
  turnCompleted: "turn/completed",
  error: "error",
});

/** `AskForApproval` (kebab-case on the wire). */
export type AppServerApprovalPolicy = "untrusted" | "on-request" | "never";
/** `SandboxMode` (thread/start `sandbox`). */
export type AppServerSandbox = "read-only" | "workspace-write";

/** `CommandExecutionApprovalDecision` / `FileChangeApprovalDecision` (the two used here). */
export type AppServerDecision = "accept" | "decline";

/** A connection to one `codex app-server` process (no `jsonrpc` member). */
export function appServerPeer(input: Readable, out: Writable, h: RpcHandlers): JsonRpcPeer {
  return new JsonRpcPeer(input, out, h, { header: false });
}

/**
 * `initialize` params: who we are, nothing else — the stable API surface only
 * (as in the docs' getting-started example). Notifications we do not map
 * (reasoning, output deltas, plan / diff updates) are ignored.
 */
export function initializeParams(version: string): Record<string, unknown> {
  return { clientInfo: { name: "alca", title: "Alca", version } };
}

/**
 * `turn/start` `sandboxPolicy` for a sandbox mode, writes limited to the work
 * folder. Next round §5.5: with the bot's OS sandbox on, the writable roots
 * are the spec's work folder alone and `networkAccess` follows its network
 * (`open` by default, the person's decision 2026-11-05; network actions are
 * still asked under `untrusted`). Codex's sandbox reads the whole machine:
 * the data folder and ~/.ssh are NOT hidden from it (SECURITY.md).
 * Field names not verified against a real Codex.
 */
export function sandboxPolicy(
  sandbox: AppServerSandbox,
  cwd: string,
  confine?: Pick<ConfineSpec, "workDir" | "network">,
): Record<string, unknown> {
  if (sandbox !== "workspace-write") return { type: "readOnly" };
  return confine
    ? { type: "workspaceWrite", writableRoots: [confine.workDir], networkAccess: confine.network === "open" }
    : { type: "workspaceWrite", writableRoots: [cwd], networkAccess: false };
}
