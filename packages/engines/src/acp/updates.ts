import type { EngineEvent } from "../types.ts";

/**
 * `session/update` notifications (ACP spec) → engine events. Agent message
 * chunks stream as text; a tool call the agent runs itself is an observation
 * (`tool.call`, then `tool.result` when its status turns completed / failed).
 * Thoughts, plans, command lists and mode changes are not shown.
 */

interface SinkState {
  textOpen: boolean;
  openCalls: Set<string>;
}

type Json = Record<string, unknown>;

/** The text of a tool call's content list (text blocks, diffs as a one-line note). */
export function toolOutput(content: unknown, raw?: unknown): string {
  const parts: string[] = [];
  for (const c of Array.isArray(content) ? (content as Json[]) : []) {
    if (c.type === "content") {
      const inner = (c.content ?? {}) as Json;
      if (inner.type === "text" && typeof inner.text === "string") parts.push(inner.text);
    } else if (c.type === "diff" && typeof c.path === "string") parts.push(`（修改了 ${c.path}）`);
    else if (c.type === "terminal") parts.push("（終端機輸出）");
  }
  if (!parts.length && raw !== undefined) parts.push(typeof raw === "string" ? raw : JSON.stringify(raw));
  return parts.join("\n").slice(0, 8000);
}

export function describeUpdate(u: Json, s: SinkState): EngineEvent[] {
  const out: EngineEvent[] = [];
  const kind = u.sessionUpdate;
  const closeText = () => {
    if (s.textOpen) {
      out.push({ type: "text.end" });
      s.textOpen = false;
    }
  };
  if (kind === "agent_message_chunk") {
    const c = (u.content ?? {}) as Json;
    if (c.type === "text" && typeof c.text === "string" && c.text) {
      s.textOpen = true;
      out.push({ type: "text.delta", text: c.text });
    }
  } else if (kind === "tool_call") {
    closeText();
    const id = String(u.toolCallId ?? "");
    if (!id) return out;
    s.openCalls.add(id);
    const input = u.rawInput && typeof u.rawInput === "object" ? (u.rawInput as Json) : {};
    out.push({
      type: "tool.call",
      id,
      name: String(u.title ?? u.kind ?? "tool").slice(0, 200),
      input: { ...input, ...(u.kind ? { kind: u.kind } : {}) },
    });
    if (u.status === "completed" || u.status === "failed") out.push(...finish(u, s, id));
  } else if (kind === "tool_call_update") {
    const id = String(u.toolCallId ?? "");
    if (id && s.openCalls.has(id) && (u.status === "completed" || u.status === "failed"))
      out.push(...finish(u, s, id));
  }
  return out;
}

function finish(u: Json, s: SinkState, id: string): EngineEvent[] {
  s.openCalls.delete(id);
  return [
    { type: "tool.result", id, ok: u.status === "completed", output: toolOutput(u.content, u.rawOutput) },
  ];
}

/** ACP tool kinds that act natively; such a request is never taken for a host tool. */
export const NATIVE_KINDS: ReadonlySet<string> = new Set(["execute", "edit", "delete", "move"]);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The host tool a permission title names, by exact shape only: `name`,
 * `mcp__alcatools__name` / `alcatools__name`, `alcatools/name` (or `.` / `:`),
 * or `name (alcatools MCP Server)`. A title that merely mentions both (a shell
 * command line, say) is not a host tool.
 */
export function hostToolOf(title: string, exposed: Iterable<string>): string | undefined {
  const t = title.trim();
  for (const n of exposed) {
    const e = escapeRe(n);
    const re = new RegExp(
      `^(?:(?:mcp__)?alcatools__${e}|alcatools[/.:]${e}|${e}(?: \\(alcatools[^()]*\\))?)$`,
    );
    if (re.test(t)) return n;
  }
  return undefined;
}

/**
 * The option to answer a permission request with: allow once, else reject
 * once (or always). Never `allow_always`: that would let the agent skip the
 * host's gate for the rest of the session, so an allow with no `allow_once`
 * on offer is cancelled instead.
 */
export function pickOption(
  options: Array<{ optionId?: string; kind?: string }>,
  allow: boolean,
): string | undefined {
  const order = allow ? ["allow_once"] : ["reject_once", "reject_always"];
  for (const k of order) {
    const o = options.find((x) => x.kind === k && x.optionId);
    if (o) return o.optionId;
  }
  return undefined;
}
