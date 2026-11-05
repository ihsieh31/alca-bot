import { conversationKey, type EngineEvent, type EngineTurnRequest } from "../types.ts";
import { HttpEngineBase, type HttpEngineOptions, resultText, streamError } from "./base.ts";
import { joinUrl, networkError, parseArgs, sseData } from "./common.ts";
import type { HistoryView } from "./compact.ts";

/**
 * OpenAI Responses API engine (P11): `POST {base}/responses` with
 * `stream: true` and `store: false` (the conversation is kept here, as the
 * input item list, not on the vendor's side). Function tools are
 * `{type: "function", name, description, parameters}`; the model's
 * `function_call` items go back to the core's gateway and come in again as
 * `function_call_output` items. Streaming events read: response.output_text.delta,
 * response.output_item.added / .done, response.function_call_arguments.delta,
 * response.completed (usage), response.failed / error. Written from the public
 * API reference.
 */

type Item =
  | { role: "user" | "assistant"; content: string }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

export const OPENAI_DEFAULT_BASE = "https://api.openai.com/v1";

export type OpenAIResponsesOptions = Omit<HttpEngineOptions, "baseUrl"> & { baseUrl?: string };

const isOutput = (m: Item) => "type" in m && m.type === "function_call_output";

/** For the rolling summary (compact.ts): function calls and outputs are plumbing. */
const VIEW: HistoryView<Item> = {
  read: (m) => ("role" in m ? { role: m.role, text: m.content } : undefined),
  isUserTurn: (m) => "role" in m && m.role === "user",
  user: (text) => ({ role: "user", content: text }),
  assistant: (text) => ({ role: "assistant", content: text }),
};

export class OpenAIResponsesEngine extends HttpEngineBase<Item> {
  constructor(o: OpenAIResponsesOptions) {
    super({ ...o, baseUrl: o.baseUrl ?? OPENAI_DEFAULT_BASE });
  }

  /** Give every trailing function_call without an output one (its result, or "interrupted"). */
  private static answer(items: Item[], results: Map<string, { ok: boolean; output: string }>): void {
    const answered = new Set(items.filter(isOutput).map((m) => (m as { call_id: string }).call_id));
    for (let i = items.length - 1; i >= 0; i--) {
      const m = items[i] as Item;
      if (!("type" in m)) break;
      if (m.type === "function_call" && !answered.has(m.call_id)) {
        const r = results.get(m.call_id);
        items.push({
          type: "function_call_output",
          call_id: m.call_id,
          output: r ? resultText(r) : "（沒有執行：回合被中斷）",
        });
      }
    }
  }

  async *turn(req: EngineTurnRequest): AsyncIterable<EngineEvent> {
    const key = conversationKey(req);
    const items = this.load(key);
    OpenAIResponsesEngine.answer(items, new Map((req.toolResults ?? []).map((r) => [r.id, r])));
    if (!req.toolResults?.length) items.push({ role: "user", content: req.userMessage });
    const body: Record<string, unknown> = {
      model: this.model(),
      stream: true,
      store: false,
      instructions: [req.system.stable, req.system.volatile].filter(Boolean).join("\n\n"),
      input: items,
      ...(this.o.reasoningEffort ? { reasoning: { effort: this.o.reasoningEffort } } : {}),
    };
    if (req.tools?.length)
      body.tools = req.tools.map((t) => ({
        type: "function",
        name: t.name,
        description: t.description.slice(0, 1024),
        parameters: t.inputSchema,
        strict: false,
      }));
    const { ctrl, end } = this.begin(key, req.signal);
    let text = "";
    const calls = new Map<number, { call_id: string; name: string; args: string }>();
    let usage:
      | { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } }
      | undefined;
    try {
      const apiKey = await this.o.apiKey?.();
      const out = await this.post(
        joinUrl(this.o.baseUrl, "responses"),
        apiKey ? { authorization: `Bearer ${apiKey}` } : {},
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
          delta?: string;
          output_index?: number;
          item?: { type?: string; call_id?: string; name?: string; arguments?: string };
          response?: { usage?: typeof usage; error?: { message?: string } };
          message?: string;
        };
        try {
          ev = JSON.parse(data);
        } catch {
          continue;
        }
        const t = ev.type ?? "";
        if (t === "response.output_text.delta" && ev.delta) {
          text += ev.delta;
          yield { type: "text.delta", text: ev.delta };
        } else if (t === "response.output_item.added" && ev.item?.type === "function_call") {
          if (text) yield { type: "text.end" };
          calls.set(ev.output_index ?? calls.size, {
            call_id: ev.item.call_id ?? "",
            name: ev.item.name ?? "",
            args: ev.item.arguments ?? "",
          });
        } else if (t === "response.function_call_arguments.delta") {
          const c = calls.get(ev.output_index ?? 0);
          if (c) c.args += ev.delta ?? "";
        } else if (t === "response.output_item.done" && ev.item?.type === "function_call") {
          const c = calls.get(ev.output_index ?? 0);
          if (c && ev.item.arguments !== undefined) c.args = ev.item.arguments;
          if (c && ev.item.call_id) c.call_id = ev.item.call_id;
        } else if (t === "response.completed") {
          usage = ev.response?.usage;
          break;
        } else if (t === "response.failed" || t === "error") {
          yield streamError(ev.response?.error?.message ?? ev.message);
          return yield { type: "done", stop: "error" };
        }
      }
      if (ctrl.signal.aborted) {
        if (text) items.push({ role: "assistant", content: text });
        this.save(key, items, VIEW);
        return yield { type: "done", stop: "interrupted" };
      }
      if (text && !calls.size) yield { type: "text.end" };
      if (usage)
        yield {
          type: "usage",
          inputTokens: usage.input_tokens ?? 0,
          outputTokens: usage.output_tokens ?? 0,
          ...(usage.input_tokens_details?.cached_tokens
            ? { cachedInputTokens: usage.input_tokens_details.cached_tokens }
            : {}),
        };
      if (text) items.push({ role: "assistant", content: text });
      const list = [...calls.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([i, c]) => ({ ...c, call_id: c.call_id || `call_${req.runId}_${i}` }))
        .filter((c) => c.name);
      for (const c of list)
        items.push({ type: "function_call", call_id: c.call_id, name: c.name, arguments: c.args || "{}" });
      this.save(key, items, VIEW);
      for (const c of list)
        yield { type: "tool.call", id: c.call_id, name: c.name, input: parseArgs(c.args) };
      yield { type: "done", stop: list.length ? "tool_use" : "end_turn" };
    } catch (err) {
      if (ctrl.signal.aborted) return yield { type: "done", stop: "interrupted" };
      yield networkError(err);
      yield { type: "done", stop: "error" };
    } finally {
      end();
    }
  }
}
