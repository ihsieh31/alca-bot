import { conversationKey, type EngineEvent, type EngineTurnRequest } from "../types.ts";
import { HttpEngineBase, type HttpEngineOptions, resultText, streamError } from "./base.ts";
import { joinUrl, networkError, parseArgs, sseData } from "./common.ts";
import type { HistoryView } from "./compact.ts";

/**
 * Anthropic Messages API engine (P11): `POST {base}/v1/messages` with
 * `stream: true`, the key in `x-api-key`, `anthropic-version: 2023-06-01`,
 * tools as `{name, description, input_schema}`. Streaming follows the public
 * event list: message_start → content_block_start / _delta (text_delta,
 * input_json_delta) / _stop → message_delta (stop_reason, usage) →
 * message_stop. Host-loop: `tool_use` blocks go back to the core's gateway
 * and come in again as `tool_result` blocks. Written from the public API docs.
 */

export const ANTHROPIC_DEFAULT_BASE = "https://api.anthropic.com";
export const ANTHROPIC_VERSION = "2023-06-01";

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

interface Msg {
  role: "user" | "assistant";
  content: string | Block[];
}

export interface AnthropicOptions extends Omit<HttpEngineOptions, "baseUrl"> {
  baseUrl?: string;
  /** max_tokens per response (required by the API; default 8192). */
  maxTokens?: number;
}

const isToolResult = (m: Msg) =>
  m.role === "user" && Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result");

const textOf = (m: Msg) =>
  typeof m.content === "string"
    ? m.content
    : m.content
        .filter((b): b is Extract<Block, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("\n");

/** For the rolling summary (compact.ts): tool results are plumbing. */
const VIEW: HistoryView<Msg> = {
  read: (m) => (isToolResult(m) ? undefined : { role: m.role, text: textOf(m) }),
  isUserTurn: (m) => m.role === "user" && !isToolResult(m),
  user: (text) => ({ role: "user", content: text }),
  assistant: (text) => ({ role: "assistant", content: text }),
};

export class AnthropicEngine extends HttpEngineBase<Msg> {
  private readonly maxTokens: number;

  constructor(o: AnthropicOptions) {
    super({ ...o, baseUrl: o.baseUrl ?? ANTHROPIC_DEFAULT_BASE });
    this.maxTokens = o.maxTokens ?? 8192;
  }

  /** Answer every tool_use of the last assistant message that has no result yet. */
  private static answer(msgs: Msg[], results: Map<string, { ok: boolean; output: string }>): void {
    const last = msgs.at(-1);
    if (last?.role !== "assistant" || !Array.isArray(last.content)) return;
    const uses = last.content.filter((b) => b.type === "tool_use");
    if (!uses.length) return;
    msgs.push({
      role: "user",
      content: uses.map((u) => {
        const r = results.get(u.id);
        return {
          type: "tool_result" as const,
          tool_use_id: u.id,
          content: r ? resultText(r) : "（沒有執行：回合被中斷）",
          ...(r && !r.ok ? { is_error: true } : {}),
        };
      }),
    });
  }

  async *turn(req: EngineTurnRequest): AsyncIterable<EngineEvent> {
    const key = conversationKey(req);
    const msgs = this.load(key);
    const results = new Map((req.toolResults ?? []).map((r) => [r.id, r]));
    AnthropicEngine.answer(msgs, results);
    if (!req.toolResults?.length) msgs.push({ role: "user", content: req.userMessage });
    const body: Record<string, unknown> = {
      model: this.model(),
      max_tokens: this.maxTokens,
      stream: true,
      // The stable layer first and marked cacheable; the volatile one after it.
      system: [
        { type: "text", text: req.system.stable || " ", cache_control: { type: "ephemeral" } },
        ...(req.system.volatile ? [{ type: "text", text: req.system.volatile }] : []),
      ],
      messages: msgs,
    };
    if (req.tools?.length)
      body.tools = req.tools.map((t) => ({
        name: t.name,
        description: t.description.slice(0, 1024),
        input_schema: t.inputSchema,
      }));
    const { ctrl, end } = this.begin(key, req.signal);
    const blocks: Array<Block & { json?: string }> = [];
    let usageIn = 0;
    let usageCached = 0;
    let usageOut = 0;
    try {
      const apiKey = await this.o.apiKey?.();
      const out = await this.post(
        joinUrl(this.o.baseUrl, "v1/messages"),
        { "anthropic-version": ANTHROPIC_VERSION, ...(apiKey ? { "x-api-key": apiKey } : {}) },
        body,
        ctrl.signal,
      );
      if ("events" in out) {
        for (const e of out.events) yield e;
        return;
      }
      for await (const data of sseData(out.res.body as ReadableStream<Uint8Array>, ctrl.signal)) {
        let ev: {
          type?: string;
          index?: number;
          message?: {
            usage?: {
              input_tokens?: number;
              cache_read_input_tokens?: number;
              cache_creation_input_tokens?: number;
            };
          };
          content_block?: { type?: string; id?: string; name?: string; text?: string };
          delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
          usage?: { output_tokens?: number };
          error?: { message?: string };
        };
        try {
          ev = JSON.parse(data);
        } catch {
          continue;
        }
        if (ev.type === "error") {
          yield streamError(ev.error?.message);
          return yield { type: "done", stop: "error" };
        }
        if (ev.type === "message_start") {
          // Mac test B3: one shape for every engine — inputTokens is the whole prompt (new
          // input + cache writes + cache reads), cachedInputTokens the cache-read part of it.
          const mu = ev.message?.usage;
          usageCached = mu?.cache_read_input_tokens ?? 0;
          usageIn = (mu?.input_tokens ?? 0) + usageCached + (mu?.cache_creation_input_tokens ?? 0);
        } else if (ev.type === "content_block_start" && ev.content_block) {
          const cb = ev.content_block;
          const i = ev.index ?? blocks.length;
          if (cb.type === "tool_use")
            blocks[i] = {
              type: "tool_use",
              id: cb.id ?? `tu_${req.runId}_${i}`,
              name: cb.name ?? "",
              input: {},
              json: "",
            };
          else blocks[i] = { type: "text", text: cb.text ?? "" };
        } else if (ev.type === "content_block_delta" && ev.delta) {
          const b = blocks[ev.index ?? 0];
          if (ev.delta.type === "text_delta" && ev.delta.text) {
            if (b?.type === "text") b.text += ev.delta.text;
            yield { type: "text.delta", text: ev.delta.text };
          } else if (ev.delta.type === "input_json_delta" && b?.type === "tool_use")
            b.json = (b.json ?? "") + (ev.delta.partial_json ?? "");
        } else if (ev.type === "content_block_stop") {
          const b = blocks[ev.index ?? 0];
          if (b?.type === "text" && b.text) yield { type: "text.end" };
        } else if (ev.type === "message_delta") {
          if (ev.usage?.output_tokens !== undefined) usageOut = ev.usage.output_tokens;
        } else if (ev.type === "message_stop") break;
      }
      const content: Block[] = [];
      for (const b of blocks) {
        if (!b) continue;
        if (b.type === "tool_use")
          content.push({ type: "tool_use", id: b.id, name: b.name, input: parseArgs(b.json ?? "") });
        else if (b.type === "text" && b.text) content.push({ type: "text", text: b.text });
      }
      if (ctrl.signal.aborted) {
        const said = content.filter((b) => b.type === "text");
        if (said.length) msgs.push({ role: "assistant", content: said });
        this.save(key, msgs, VIEW);
        return yield { type: "done", stop: "interrupted" };
      }
      yield {
        type: "usage",
        inputTokens: usageIn,
        outputTokens: usageOut,
        ...(usageCached ? { cachedInputTokens: usageCached } : {}),
      };
      msgs.push({ role: "assistant", content: content.length ? content : [{ type: "text", text: "" }] });
      this.save(key, msgs, VIEW);
      const calls = content.filter((b) => b.type === "tool_use");
      for (const c of calls) yield { type: "tool.call", id: c.id, name: c.name, input: c.input };
      yield {
        type: "done",
        stop: calls.length ? "tool_use" : "end_turn",
      };
    } catch (err) {
      if (ctrl.signal.aborted) return yield { type: "done", stop: "interrupted" };
      yield networkError(err);
      yield { type: "done", stop: "error" };
    } finally {
      end();
    }
  }
}
