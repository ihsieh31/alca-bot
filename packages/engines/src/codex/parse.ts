// `codex exec --json` prints one JSON object per line (JSONL), as in the
// public Codex CLI docs: thread.started, turn.started, item.started /
// item.updated / item.completed (agent_message, reasoning,
// command_execution, file_change, mcp_tool_call, web_search, todo_list,
// error), turn.completed (usage), turn.failed, error. This turns them into
// engine events; unknown lines are ignored.
import type { EngineEvent } from "../types.ts";
import { CODEX_HOST_SERVER } from "./args.ts";

type Json = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

const MAX_OUTPUT = 8000;
const clip = (s: string) => (s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}…` : s);

export class CodexStreamParser {
  sessionId: string | undefined;
  /** The turn ended (turn.completed / turn.failed). */
  ended = false;
  private started = new Set<string>();
  private texts = new Map<string, string>();

  /** One parsed line → zero or more engine events. */
  push(m: Json): EngineEvent[] {
    switch (m.type) {
      case "thread.started": {
        this.sessionId = str(m.thread_id) || this.sessionId;
        return this.sessionId ? [{ type: "session", sessionId: this.sessionId }] : [];
      }
      case "item.started":
      case "item.updated":
      case "item.completed":
        return this.item(m.type, (m.item ?? {}) as Json);
      case "turn.completed": {
        this.ended = true;
        const u = (m.usage ?? {}) as Json;
        return [
          {
            type: "usage",
            inputTokens: num(u.input_tokens),
            outputTokens: num(u.output_tokens),
            cachedInputTokens: num(u.cached_input_tokens),
          },
          { type: "done", stop: "end_turn" },
        ];
      }
      case "turn.failed": {
        this.ended = true;
        const e = (m.error ?? {}) as Json;
        return [
          {
            type: "error",
            code: "engine.codex",
            message: str(e.message) || "Codex 這個回合失敗了",
            retryable: true,
          },
          { type: "done", stop: "error" },
        ];
      }
      case "error":
        return [
          { type: "error", code: "engine.codex", message: str(m.message) || "Codex 錯誤", retryable: true },
        ];
      default:
        return [];
    }
  }

  private item(phase: string, it: Json): EngineEvent[] {
    const id = str(it.id) || `item_${this.started.size}`;
    const kind = str(it.type);
    if (kind === "agent_message") {
      // Text may arrive in updates; emit only what is new, end the segment on completion.
      const text = str(it.text);
      const before = this.texts.get(id) ?? "";
      this.texts.set(id, text);
      const out: EngineEvent[] = [];
      if (text.startsWith(before) && text.length > before.length)
        out.push({ type: "text.delta", text: text.slice(before.length) });
      else if (!text.startsWith(before)) out.push({ type: "text.delta", text });
      if (phase === "item.completed") out.push({ type: "text.end" });
      return out;
    }
    const call = this.callOf(kind, it);
    if (!call) {
      if (kind === "error" && phase === "item.completed")
        return [{ type: "error", code: "engine.codex", message: str(it.message), retryable: false }];
      return [];
    }
    const out: EngineEvent[] = [];
    if (!this.started.has(id)) {
      this.started.add(id);
      out.push({ type: "tool.call", id, name: call.name, input: call.input });
    }
    if (phase === "item.completed") out.push({ type: "tool.result", id, ...call.result() });
    return out;
  }

  private callOf(
    kind: string,
    it: Json,
  ): { name: string; input: Json; result: () => { ok: boolean; output: string } } | undefined {
    const failed = str(it.status) === "failed" || str(it.status) === "declined";
    switch (kind) {
      case "command_execution":
        return {
          name: "shell",
          input: { command: str(it.command) },
          result: () => ({
            ok: !failed && (it.exit_code === undefined || it.exit_code === 0),
            output: clip(str(it.aggregated_output)),
          }),
        };
      case "file_change":
        return {
          name: "apply_patch",
          input: { changes: Array.isArray(it.changes) ? it.changes : [] },
          result: () => ({ ok: !failed, output: failed ? "沒有套用" : "已套用" }),
        };
      case "mcp_tool_call": {
        const server = str(it.server);
        const tool = str(it.tool);
        const input = it.arguments && typeof it.arguments === "object" ? (it.arguments as Json) : {};
        return {
          // A host tool keeps its own name; other MCP tools are named as Codex shows them.
          name: server === CODEX_HOST_SERVER ? tool : `mcp:${server}/${tool}`,
          input,
          result: () => ({ ok: !failed && !it.error, output: clip(resultText(it)) }),
        };
      }
      case "web_search":
        return {
          name: "web_search",
          input: { query: str(it.query) },
          result: () => ({ ok: !failed, output: "" }),
        };
      default:
        return undefined;
    }
  }
}

function resultText(it: Json): string {
  const err = it.error as Json | undefined;
  if (err) return str(err.message) || "失敗";
  const r = it.result as Json | undefined;
  const content = Array.isArray(r?.content) ? (r?.content as Json[]) : [];
  return content.map((c) => str(c.text)).join("\n");
}
