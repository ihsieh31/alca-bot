import type { EngineEvent } from "../types.ts";

/**
 * Stateful translator from the Claude Code CLI `stream-json` output (one JSON
 * object per stdout line, documented in the CLI's headless / Agent SDK docs)
 * into our engine events. Unknown message types are ignored so a newer CLI
 * that adds fields or types keeps working.
 */
export class ClaudeStreamParser {
  sessionId: string | undefined;
  model: string | undefined;
  /** P15 E: what the CLI says is in effect (from its init message): built-in + MCP tool names, permission mode. */
  init: { tools?: string[]; permissionMode?: string } | undefined;
  /** Set by the process wrapper when an interrupt was requested for this turn. */
  interrupted = false;
  private partialText = "";
  private textOpen = false;
  /**
   * Mac device test 2026-11-05 N4: usage is booked per model message, not
   * only at the turn's end, so a token budget can stop a long CLI turn while
   * it runs. Per message id, the highest reading of each field (a message is
   * streamed in several lines that repeat or grow its usage); `booked` is the
   * sum already sent, which the turn's `result` total is reconciled against.
   */
  private seen = new Map<string, UsageFields>();
  private booked: UsageFields = zeroUsage();
  /** The message being streamed (stream_event message_start → message_delta). */
  private streamingId: string | undefined;

  /** Reset per-turn state (the session id survives). */
  beginTurn(): void {
    this.partialText = "";
    this.textOpen = false;
    this.interrupted = false;
    this.seen.clear();
    this.booked = zeroUsage();
    this.streamingId = undefined;
  }

  /** Book what one message's usage reading adds over what was seen of it; an event when it adds anything. */
  private messageUsage(id: string | undefined, raw: unknown): EngineEvent[] {
    const r = readUsage(raw);
    if (!id || !r) return [];
    const old = this.seen.get(id) ?? zeroUsage();
    const now: UsageFields = {
      input: Math.max(old.input, r.input),
      cacheRead: Math.max(old.cacheRead, r.cacheRead),
      cacheCreate: Math.max(old.cacheCreate, r.cacheCreate),
      output: Math.max(old.output, r.output),
    };
    this.seen.set(id, now);
    return this.book({
      input: now.input - old.input,
      cacheRead: now.cacheRead - old.cacheRead,
      cacheCreate: now.cacheCreate - old.cacheCreate,
      output: now.output - old.output,
    });
  }

  private book(d: UsageFields): EngineEvent[] {
    if (d.input + d.cacheRead + d.cacheCreate + d.output <= 0) return [];
    this.booked = {
      input: this.booked.input + d.input,
      cacheRead: this.booked.cacheRead + d.cacheRead,
      cacheCreate: this.booked.cacheCreate + d.cacheCreate,
      output: this.booked.output + d.output,
    };
    return [usageEvent(d)];
  }

  feed(raw: unknown): EngineEvent[] {
    if (typeof raw !== "object" || raw === null) return [];
    const msg = raw as Record<string, unknown>;
    // Messages from sub-agents carry the parent tool call id; the main thread has null.
    if (typeof msg.parent_tool_use_id === "string") return [];
    switch (msg.type) {
      case "system":
        return this.system(msg);
      case "stream_event":
        return this.streamEvent(msg.event);
      case "assistant":
        return this.assistant(msg.message);
      case "user":
        return this.user(msg.message);
      case "result":
        return this.result(msg);
      default:
        return [];
    }
  }

  private system(msg: Record<string, unknown>): EngineEvent[] {
    if (msg.subtype !== "init" || typeof msg.session_id !== "string") return [];
    this.sessionId = msg.session_id;
    if (typeof msg.model === "string") this.model = msg.model;
    this.init = {
      ...(Array.isArray(msg.tools)
        ? { tools: msg.tools.filter((t): t is string => typeof t === "string") }
        : {}),
      ...(typeof msg.permissionMode === "string" ? { permissionMode: msg.permissionMode } : {}),
    };
    return [{ type: "session", sessionId: msg.session_id, ...(this.model ? { model: this.model } : {}) }];
  }

  private streamEvent(ev: unknown): EngineEvent[] {
    if (typeof ev !== "object" || ev === null) return [];
    const e = ev as { type?: unknown; delta?: { type?: unknown; text?: unknown } };
    if (e.type === "message_start") {
      this.partialText = "";
      const m = (ev as { message?: { id?: unknown; usage?: unknown } }).message;
      this.streamingId = typeof m?.id === "string" ? m.id : undefined;
      return this.messageUsage(this.streamingId, m?.usage);
    }
    if (e.type === "message_delta") {
      // Output tokens so far for the streaming message (cumulative in the API's events).
      const u = (ev as { usage?: unknown }).usage;
      return this.messageUsage(this.streamingId, u);
    }
    if (
      e.type === "content_block_delta" &&
      e.delta?.type === "text_delta" &&
      typeof e.delta.text === "string"
    ) {
      this.partialText += e.delta.text;
      this.textOpen = true;
      return [{ type: "text.delta", text: e.delta.text }];
    }
    return [];
  }

  private closeText(out: EngineEvent[]): void {
    if (this.textOpen) out.push({ type: "text.end" });
    this.textOpen = false;
  }

  private assistant(message: unknown): EngineEvent[] {
    const m = message as { id?: unknown; usage?: unknown; content?: unknown } | null;
    const out: EngineEvent[] = this.messageUsage(typeof m?.id === "string" ? m.id : undefined, m?.usage);
    const content = m?.content;
    if (!Array.isArray(content)) return out;
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === "text" && typeof block.text === "string" && block.text !== "") {
        // With partial messages on, the text already arrived as deltas.
        if (this.partialText === "") out.push({ type: "text.delta", text: block.text });
        this.partialText = "";
        this.textOpen = true;
      } else if (
        block.type === "tool_use" &&
        typeof block.id === "string" &&
        typeof block.name === "string"
      ) {
        this.closeText(out);
        const input =
          typeof block.input === "object" && block.input !== null
            ? (block.input as Record<string, unknown>)
            : {};
        out.push({ type: "tool.call", id: block.id, name: block.name, input });
      }
    }
    return out;
  }

  private user(message: unknown): EngineEvent[] {
    const content = (message as { content?: unknown } | null)?.content;
    if (!Array.isArray(content)) return [];
    const out: EngineEvent[] = [];
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
      out.push({
        type: "tool.result",
        id: block.tool_use_id,
        ok: block.is_error !== true,
        output: stringifyContent(block.content),
      });
    }
    return out;
  }

  private result(msg: Record<string, unknown>): EngineEvent[] {
    const out: EngineEvent[] = [];
    this.closeText(out);
    if (typeof msg.session_id === "string") this.sessionId = msg.session_id;
    // The turn's total: book only what the per-message readings have not (sub-agents, a missed line).
    const r = readUsage(msg.usage);
    if (r)
      out.push(
        ...this.book({
          input: Math.max(0, r.input - this.booked.input),
          cacheRead: Math.max(0, r.cacheRead - this.booked.cacheRead),
          cacheCreate: Math.max(0, r.cacheCreate - this.booked.cacheCreate),
          output: Math.max(0, r.output - this.booked.output),
        }),
      );
    const subtype = msg.subtype;
    if (this.interrupted) {
      out.push({ type: "done", stop: "interrupted" });
    } else if (subtype === "success" && msg.is_error !== true) {
      out.push({ type: "done", stop: "end_turn" });
    } else if (subtype === "error_max_turns") {
      out.push({ type: "done", stop: "max_turns" });
    } else {
      const text = typeof msg.result === "string" && msg.result ? msg.result : String(subtype ?? "error");
      out.push({
        type: "error",
        code: `claude.${String(subtype ?? "error")}`,
        message: text,
        retryable: false,
      });
      out.push({ type: "done", stop: "error" });
    }
    return out;
  }
}

interface UsageFields {
  input: number;
  cacheRead: number;
  cacheCreate: number;
  output: number;
}

const zeroUsage = (): UsageFields => ({ input: 0, cacheRead: 0, cacheCreate: 0, output: 0 });

/** The API's usage object (any of its fields may be missing), or undefined when it is not one. */
function readUsage(raw: unknown): UsageFields | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const u = raw as Record<string, unknown>;
  const n = (k: string) =>
    typeof u[k] === "number" && Number.isFinite(u[k]) ? Math.max(0, u[k] as number) : 0;
  return {
    input: n("input_tokens"),
    cacheRead: n("cache_read_input_tokens"),
    cacheCreate: n("cache_creation_input_tokens"),
    output: n("output_tokens"),
  };
}

function usageEvent(d: UsageFields): EngineEvent {
  return {
    type: "usage",
    inputTokens: d.input + d.cacheRead + d.cacheCreate,
    outputTokens: d.output,
    ...(d.cacheRead > 0 ? { cachedInputTokens: d.cacheRead } : {}),
  };
}

function stringifyContent(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((b) =>
        typeof b === "object" && b && (b as { type?: unknown }).type === "text"
          ? String((b as { text?: unknown }).text ?? "")
          : "",
      )
      .join("");
  }
  return c === undefined ? "" : JSON.stringify(c);
}

/** The stdin line that sends one user turn. */
export function userMessageLine(text: string): string {
  return `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } })}\n`;
}

/** The stdin line that asks the CLI to stop the current turn (stream-json control channel). */
export function interruptLine(requestId: string): string {
  return `${JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "interrupt" } })}\n`;
}
