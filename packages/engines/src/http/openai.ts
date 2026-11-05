import { conversationKey, type Engine, type EngineEvent, type EngineTurnRequest } from "../types.ts";
import {
  type HistoryStore,
  HTTP_CAPABILITIES,
  httpError,
  joinUrl,
  type KeyLookup,
  memoryHistory,
  networkError,
  parseArgs,
  sseData,
} from "./common.ts";
import { compactHistory, type HistoryView } from "./compact.ts";

/**
 * An engine for any OpenAI-compatible chat-completions server: OpenRouter,
 * a local Ollama or LM Studio, or any service speaking the same wire format
 * (`POST {base}/chat/completions`, `stream: true`, function tools). The key
 * comes from the local vault at call time and goes only in the
 * Authorization header; a local server may need none. Written from the
 * public wire format; host-loop: tool calls go back to the core's gateway.
 */

type Msg =
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
    }
  | { role: "tool"; tool_call_id: string; content: string };

/** For the rolling summary (compact.ts): tool results and bare tool calls are plumbing. */
const VIEW: HistoryView<Msg> = {
  read: (m) =>
    m.role === "tool"
      ? undefined
      : m.role === "user"
        ? { role: "user", text: m.content }
        : { role: "assistant", text: m.content ?? "" },
  isUserTurn: (m) => m.role === "user",
  user: (text) => ({ role: "user", content: text }),
  assistant: (text) => ({ role: "assistant", content: text }),
};

export interface OpenAICompatOptions {
  /** Engine id (e.g. the provider id `eng_…`); shown on runs. */
  id: string;
  baseUrl: string;
  model: string | (() => string);
  apiKey?: KeyLookup;
  history?: HistoryStore;
  /** Extra headers (e.g. OpenRouter's HTTP-Referer / X-Title). */
  headers?: Record<string, string>;
  /** Most messages kept per conversation (default 80). */
  maxMessages?: number;
  temperature?: number;
  /** `reasoning_effort` for models that take it (e.g. "low" | "medium" | "high"). */
  reasoningEffort?: string;
  fetch?: typeof fetch;
}

interface Pending {
  id: string;
  name: string;
  args: string;
}

export class OpenAICompatEngine implements Engine {
  readonly id: string;
  readonly capabilities = HTTP_CAPABILITIES;
  private readonly o: OpenAICompatOptions;
  private readonly history: HistoryStore;
  private readonly active = new Map<string, AbortController>();

  constructor(o: OpenAICompatOptions) {
    this.o = o;
    this.id = o.id;
    this.history = o.history ?? memoryHistory();
  }

  private load(key: string): Msg[] {
    try {
      const raw = this.history.get(key);
      const v = raw ? (JSON.parse(raw) as unknown) : [];
      return Array.isArray(v) ? (v as Msg[]) : [];
    } catch {
      return [];
    }
  }

  private save(key: string, msgs: Msg[]): void {
    const kept = compactHistory(msgs, this.o.maxMessages ?? 80, VIEW);
    this.history.set(key, JSON.stringify(kept));
  }

  /** Close any tool calls left without results (an interrupted turn), so the next request is valid. */
  private static closeDangling(msgs: Msg[], results: Map<string, string>): void {
    const last = [...msgs].reverse().find((m) => m.role === "assistant");
    if (last?.role !== "assistant" || !last.tool_calls?.length) return;
    const answered = new Set(
      msgs.filter((m) => m.role === "tool").map((m) => (m as { tool_call_id: string }).tool_call_id),
    );
    for (const c of last.tool_calls)
      if (!answered.has(c.id))
        msgs.push({
          role: "tool",
          tool_call_id: c.id,
          content: results.get(c.id) ?? "（沒有執行：回合被中斷）",
        });
  }

  async *turn(req: EngineTurnRequest): AsyncIterable<EngineEvent> {
    const key = conversationKey(req);
    const msgs = this.load(key);
    const results = new Map(
      (req.toolResults ?? []).map((r) => [r.id, r.ok ? r.output : `錯誤：${r.output}`]),
    );
    if (req.toolResults?.length) OpenAICompatEngine.closeDangling(msgs, results);
    else {
      OpenAICompatEngine.closeDangling(msgs, new Map());
      msgs.push({ role: "user", content: req.userMessage });
    }
    const system = [req.system.stable, req.system.volatile].filter(Boolean).join("\n\n");
    const model = typeof this.o.model === "function" ? this.o.model() : this.o.model;
    const body: Record<string, unknown> = {
      model,
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "system", content: system }, ...msgs],
      ...(this.o.temperature !== undefined ? { temperature: this.o.temperature } : {}),
      ...(this.o.reasoningEffort ? { reasoning_effort: this.o.reasoningEffort } : {}),
    };
    if (req.tools?.length)
      body.tools = req.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description.slice(0, 1024), parameters: t.inputSchema },
      }));

    const ctrl = new AbortController();
    this.active.set(key, ctrl);
    const onOuter = () => ctrl.abort();
    req.signal.addEventListener("abort", onOuter, { once: true });
    let text = "";
    const pending = new Map<number, Pending>();
    try {
      const apiKey = await this.o.apiKey?.();
      let res: Response;
      try {
        res = await (this.o.fetch ?? fetch)(joinUrl(this.o.baseUrl, "chat/completions"), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "text/event-stream",
            ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
            ...this.o.headers,
          },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
      } catch (err) {
        if (ctrl.signal.aborted) return yield { type: "done", stop: "interrupted" };
        yield networkError(err);
        return yield { type: "done", stop: "error" };
      }
      if (!res.ok || !res.body) {
        yield httpError(res.status, await res.text().catch(() => ""));
        return yield { type: "done", stop: "error" };
      }
      for await (const data of sseData(res.body, ctrl.signal)) {
        if (data === "[DONE]") break;
        let chunk: {
          choices?: Array<{
            delta?: {
              content?: string | null;
              tool_calls?: Array<{
                index?: number;
                id?: string;
                function?: { name?: string; arguments?: string };
              }>;
            };
            finish_reason?: string | null;
          }>;
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            prompt_tokens_details?: { cached_tokens?: number };
          };
          error?: { message?: string };
        };
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }
        if (chunk.error) {
          yield {
            type: "error",
            code: "engine.stream",
            message: String(chunk.error.message ?? "stream error").slice(0, 300),
            retryable: false,
          };
          return yield { type: "done", stop: "error" };
        }
        const ch = chunk.choices?.[0];
        const d = ch?.delta;
        if (d?.content) {
          text += d.content;
          yield { type: "text.delta", text: d.content };
        }
        for (const tc of d?.tool_calls ?? []) {
          const i = tc.index ?? 0;
          const p = pending.get(i) ?? { id: "", name: "", args: "" };
          if (tc.id) p.id = tc.id;
          if (tc.function?.name) p.name += tc.function.name;
          if (tc.function?.arguments) p.args += tc.function.arguments;
          pending.set(i, p);
        }
        if (chunk.usage)
          yield {
            type: "usage",
            inputTokens: chunk.usage.prompt_tokens ?? 0,
            outputTokens: chunk.usage.completion_tokens ?? 0,
            ...(chunk.usage.prompt_tokens_details?.cached_tokens
              ? { cachedInputTokens: chunk.usage.prompt_tokens_details.cached_tokens }
              : {}),
          };
      }
      if (ctrl.signal.aborted) {
        if (text) msgs.push({ role: "assistant", content: text });
        this.save(key, msgs);
        return yield { type: "done", stop: "interrupted" };
      }
      if (text) yield { type: "text.end" };
      const calls = [...pending.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([i, p]) => ({ ...p, id: p.id || `call_${req.runId}_${i}` }))
        .filter((p) => p.name);
      msgs.push({
        role: "assistant",
        content: text || null,
        ...(calls.length
          ? {
              tool_calls: calls.map((c) => ({
                id: c.id,
                type: "function" as const,
                function: { name: c.name, arguments: c.args || "{}" },
              })),
            }
          : {}),
      });
      this.save(key, msgs);
      for (const c of calls) yield { type: "tool.call", id: c.id, name: c.name, input: parseArgs(c.args) };
      yield { type: "done", stop: calls.length ? "tool_use" : "end_turn" };
    } catch (err) {
      if (ctrl.signal.aborted) return yield { type: "done", stop: "interrupted" };
      yield networkError(err);
      yield { type: "done", stop: "error" };
    } finally {
      req.signal.removeEventListener("abort", onOuter);
      if (this.active.get(key) === ctrl) this.active.delete(key);
    }
  }

  async interrupt(key: string): Promise<void> {
    this.active.get(key)?.abort();
  }

  async release(_key: string): Promise<void> {
    // Nothing held between turns but the stored history.
  }

  async dispose(): Promise<void> {
    for (const c of this.active.values()) c.abort();
    this.active.clear();
  }
}
