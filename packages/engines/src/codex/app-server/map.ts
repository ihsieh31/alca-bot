import type { EngineEvent, PermissionRequest } from "../../types.ts";
import { CODEX_HOST_SERVER } from "../args.ts";
import { APP_SERVER_NOTIFICATIONS as N, APP_SERVER_REQUESTS as R } from "./rpc.ts";

/**
 * App-server notifications → engine events, and approval requests → the
 * host's permission prompt (plan §3.3). Item shapes from the v2 `ThreadItem`
 * union (`commandExecution`, `fileChange`, `mcpToolCall`, `agentMessage`).
 *
 * Native calls are named the way the host's gate already reads them:
 * - a command is `shell` with `{ command, cwd, kind: "execute" }` (the shell
 *   floor and the folder check read `command`);
 * - a file change is `apply_patch` with `{ kind: "edit" | "delete", paths,
 *   changes }` (`editTargets` reads `paths`: the undo snapshot and the
 *   outside-the-folder check);
 * - a host tool keeps its own name; another MCP server's tool is `mcp:s/t`.
 */

type Json = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const MAX_OUTPUT = 8000;
const clip = (s: string) => (s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}…` : s);

/** Per-turn state of the mapping. */
export interface MapState {
  threadId: string;
  turnId?: string;
  /** Agent message items that streamed deltas (their completion only closes the segment). */
  streamed: Set<string>;
  /** Native calls started (item id → host name and input), for results and approvals. */
  calls: Map<string, { name: string; input: Json }>;
  /** Last cumulative token total seen for the thread (usage is booked as deltas). */
  totals: { input: number; cached: number; output: number };
  textOpen: boolean;
  ended: boolean;
}

export function newMapState(threadId: string, totals?: MapState["totals"]): MapState {
  return {
    threadId,
    streamed: new Set(),
    calls: new Map(),
    totals: totals ?? { input: 0, cached: 0, output: 0 },
    textOpen: false,
    ended: false,
  };
}

/** `FileUpdateChange.kind`: a tagged object (`{ type: "add" | "delete" | "update" }`), or a string. */
function changeKind(c: Json): string {
  const k = c.kind;
  if (typeof k === "string") return k;
  if (k && typeof k === "object") return str((k as Json).type);
  return "update";
}

/** An update that moves a file also writes its new path (`kind.move_path`). */
function movePath(c: Json): string {
  const k = c.kind;
  if (!k || typeof k !== "object") return "";
  return str((k as Json).move_path) || str((k as Json).movePath);
}

/** The host's view of a native item; undefined = not a call (messages, reasoning, …). */
export function callOf(item: Json): { name: string; input: Json } | undefined {
  switch (item.type) {
    case "commandExecution":
      return { name: "shell", input: { command: str(item.command), cwd: str(item.cwd), kind: "execute" } };
    case "fileChange": {
      const changes = (Array.isArray(item.changes) ? item.changes : []) as Json[];
      const paths = changes.flatMap((c) => [str(c.path), movePath(c)]).filter(Boolean);
      const del = changes.some((c) => changeKind(c) === "delete");
      return {
        name: "apply_patch",
        input: {
          kind: del ? "delete" : "edit",
          paths: paths.slice(0, 20),
          changes: changes.slice(0, 20).map((c) => ({ path: str(c.path), kind: changeKind(c) })),
        },
      };
    }
    case "mcpToolCall": {
      const server = str(item.server);
      const tool = str(item.tool);
      const input = item.arguments && typeof item.arguments === "object" ? (item.arguments as Json) : {};
      return { name: server === CODEX_HOST_SERVER ? tool : `mcp:${server}/${tool}`, input };
    }
    case "webSearch":
      return { name: "web_search", input: { query: str(item.query) } };
    default:
      return undefined;
  }
}

function resultOf(item: Json): { ok: boolean; output: string } {
  const status = str(item.status);
  const failed = status === "failed" || status === "declined";
  switch (item.type) {
    case "commandExecution": {
      const code = item.exitCode;
      const ok = !failed && (code === undefined || code === null || code === 0);
      const out = clip(str(item.aggregatedOutput));
      return { ok, output: typeof code === "number" && code !== 0 ? `${out}\n[exit ${code}]` : out };
    }
    case "fileChange":
      return { ok: !failed, output: failed ? `沒有套用（${status}）` : "已套用" };
    case "mcpToolCall": {
      const err = item.error as Json | null | undefined;
      if (err) return { ok: false, output: str(err.message) || "失敗" };
      const r = item.result as Json | null | undefined;
      const content = Array.isArray(r?.content) ? (r?.content as Json[]) : [];
      return { ok: !failed, output: clip(content.map((c) => str(c.text)).join("\n")) };
    }
    default:
      return { ok: !failed, output: "" };
  }
}

const closeText = (s: MapState, out: EngineEvent[]) => {
  if (s.textOpen) {
    out.push({ type: "text.end" });
    s.textOpen = false;
  }
};

/** One notification → engine events (only those of this state's thread). */
export function mapNotification(method: string, p: Json, s: MapState): EngineEvent[] {
  const out: EngineEvent[] = [];
  if (p.threadId !== undefined && p.threadId !== s.threadId) return out;
  switch (method) {
    case N.agentDelta: {
      const delta = str(p.delta);
      if (!delta) break;
      s.streamed.add(str(p.itemId));
      s.textOpen = true;
      out.push({ type: "text.delta", text: delta });
      break;
    }
    case N.itemStarted: {
      const item = (p.item ?? {}) as Json;
      const call = callOf(item);
      if (!call) break;
      closeText(s, out);
      const id = str(item.id);
      if (!id || s.calls.has(id)) break;
      s.calls.set(id, call);
      out.push({ type: "tool.call", id, name: call.name, input: call.input });
      break;
    }
    case N.itemCompleted: {
      const item = (p.item ?? {}) as Json;
      const id = str(item.id);
      if (item.type === "agentMessage") {
        if (!s.streamed.has(id) && str(item.text)) out.push({ type: "text.delta", text: str(item.text) });
        s.textOpen = true;
        closeText(s, out);
        break;
      }
      const call = callOf(item);
      if (!call || !id) break;
      if (!s.calls.has(id)) {
        s.calls.set(id, call);
        out.push({ type: "tool.call", id, name: call.name, input: call.input });
      }
      out.push({ type: "tool.result", id, ...resultOf(item) });
      break;
    }
    case N.tokenUsage: {
      const total = ((p.tokenUsage ?? {}) as Json).total as Json | undefined;
      if (!total) break;
      const now = {
        input: num(total.inputTokens),
        cached: num(total.cachedInputTokens),
        output: num(total.outputTokens),
      };
      const d = {
        input: Math.max(0, now.input - s.totals.input),
        cached: Math.max(0, now.cached - s.totals.cached),
        output: Math.max(0, now.output - s.totals.output),
      };
      s.totals = now;
      if (d.input || d.output)
        out.push({
          type: "usage",
          inputTokens: d.input,
          outputTokens: d.output,
          cachedInputTokens: d.cached,
        });
      break;
    }
    case N.error: {
      if (p.willRetry === true) break;
      const e = (p.error ?? {}) as Json;
      out.push({
        type: "error",
        code: "engine.codex",
        message: str(e.message) || "Codex 錯誤",
        retryable: true,
      });
      break;
    }
    case N.turnCompleted: {
      const turn = (p.turn ?? {}) as Json;
      if (s.turnId && str(turn.id) && str(turn.id) !== s.turnId) break;
      closeText(s, out);
      s.ended = true;
      const status = str(turn.status);
      if (status === "interrupted") out.push({ type: "done", stop: "interrupted" });
      else if (status === "failed") {
        const e = (turn.error ?? {}) as Json;
        out.push({
          type: "error",
          code: "engine.codex",
          message: str(e.message) || "Codex 這個回合失敗了",
          retryable: true,
        });
        out.push({ type: "done", stop: "error" });
      } else out.push({ type: "done", stop: "end_turn" });
      break;
    }
    default:
      break;
  }
  return out;
}

/** An approval request → the host's permission prompt; undefined = not an approval we route. */
export function permissionOf(method: string, p: Json, s: MapState): PermissionRequest | undefined {
  const itemId = str(p.itemId);
  if (method === R.commandApproval) {
    const known = s.calls.get(itemId)?.input ?? {};
    const net = p.networkApprovalContext as Json | null | undefined;
    const command = net
      ? `network access ${str(net.protocol)}://${str(net.host)}`
      : str(p.command) || str(known.command);
    return {
      toolName: "shell",
      input: {
        command,
        cwd: str(p.cwd) || str(known.cwd),
        kind: "execute",
        ...(p.reason ? { reason: str(p.reason) } : {}),
      },
      ...(itemId ? { toolUseId: itemId } : {}),
    };
  }
  if (method === R.fileChangeApproval) {
    const known = s.calls.get(itemId)?.input ?? { kind: "edit", paths: [] };
    const paths = [...((known.paths as string[] | undefined) ?? [])];
    // A request for write access under another root: that root is what would be written.
    if (typeof p.grantRoot === "string" && p.grantRoot) paths.push(p.grantRoot);
    return {
      toolName: "apply_patch",
      input: {
        ...known,
        paths,
        ...(p.reason ? { reason: str(p.reason) } : {}),
        ...(p.grantRoot ? { grantRoot: str(p.grantRoot) } : {}),
      },
      ...(itemId ? { toolUseId: itemId } : {}),
    };
  }
  return undefined;
}
