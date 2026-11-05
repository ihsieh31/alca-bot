import { conversationKey, type Engine, type EngineEvent, type EngineTurnRequest } from "../types.ts";
import {
  type HistoryStore,
  HTTP_CAPABILITIES,
  httpError,
  joinUrl,
  type KeyLookup,
  memoryHistory,
  networkError,
  sseData,
} from "./common.ts";
import { compactHistory, type HistoryView } from "./compact.ts";

/**
 * An engine for the Gemini API (`POST {base}/models/{model}:streamGenerateContent?alt=sse`,
 * key in the `x-goog-api-key` header, function declarations as tools).
 * Written from the public REST reference; host-loop like the other HTTP
 * engines. Gemini does not always give a call id, so we make one per call
 * and keep id → name to answer with the matching `functionResponse`.
 */

type Part =
  | { text: string }
  | { functionCall: { name: string; args: Record<string, unknown>; id?: string } }
  | { functionResponse: { name: string; response: { content: string }; id?: string } };

interface Content {
  role: "user" | "model";
  parts: Part[];
  /** Our own bookkeeping (stripped before sending): call ids of a model turn. */
  ids?: string[];
}

const isResponse = (m: Content) => m.parts.some((p) => "functionResponse" in p);

/** For the rolling summary (compact.ts): function responses are plumbing. */
const VIEW: HistoryView<Content> = {
  read: (m) =>
    isResponse(m)
      ? undefined
      : {
          role: m.role === "model" ? "assistant" : "user",
          text: m.parts
            .map((p) => ("text" in p ? p.text : ""))
            .filter(Boolean)
            .join("\n"),
        },
  isUserTurn: (m) => m.role === "user" && !isResponse(m),
  user: (text) => ({ role: "user", parts: [{ text }] }),
  assistant: (text) => ({ role: "model", parts: [{ text }] }),
};

export const GEMINI_DEFAULT_BASE = "https://generativelanguage.googleapis.com/v1beta";

export interface GeminiOptions {
  id: string;
  baseUrl?: string;
  model: string | (() => string);
  apiKey?: KeyLookup;
  history?: HistoryStore;
  maxMessages?: number;
  fetch?: typeof fetch;
}

/** Gemini accepts an OpenAPI subset: drop the JSON Schema keys it rejects. */
export function geminiSchema(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(geminiSchema);
  if (!s || typeof s !== "object") return s;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s as Record<string, unknown>)) {
    if (k === "additionalProperties" || k === "$schema" || k === "$id" || k === "default") continue;
    out[k] =
      k === "properties" && v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v as Record<string, unknown>).map(([pk, pv]) => [pk, geminiSchema(pv)]),
          )
        : geminiSchema(v);
  }
  return out;
}

export class GeminiEngine implements Engine {
  readonly id: string;
  readonly capabilities = HTTP_CAPABILITIES;
  private readonly o: GeminiOptions;
  private readonly history: HistoryStore;
  private readonly active = new Map<string, AbortController>();

  constructor(o: GeminiOptions) {
    this.o = o;
    this.id = o.id;
    this.history = o.history ?? memoryHistory();
  }

  private load(key: string): Content[] {
    try {
      const raw = this.history.get(key);
      const v = raw ? (JSON.parse(raw) as unknown) : [];
      return Array.isArray(v) ? (v as Content[]) : [];
    } catch {
      return [];
    }
  }

  private save(key: string, c: Content[]): void {
    const kept = compactHistory(c, this.o.maxMessages ?? 80, VIEW);
    this.history.set(key, JSON.stringify(kept));
  }

  /** Answer any calls of the last model turn that have no response yet. */
  private static answer(c: Content[], results: Map<string, string>): void {
    const last = c.at(-1);
    if (last?.role !== "model" || !last.ids?.length) return;
    const parts: Part[] = [];
    last.parts.forEach((p, i) => {
      if (!("functionCall" in p)) return;
      const id = last.ids?.[i] ?? "";
      parts.push({
        functionResponse: {
          name: p.functionCall.name,
          response: { content: results.get(id) ?? "（沒有執行：回合被中斷）" },
        },
      });
    });
    if (parts.length) c.push({ role: "user", parts });
  }

  async *turn(req: EngineTurnRequest): AsyncIterable<EngineEvent> {
    const key = conversationKey(req);
    const contents = this.load(key);
    const results = new Map(
      (req.toolResults ?? []).map((r) => [r.id, r.ok ? r.output : `錯誤：${r.output}`]),
    );
    GeminiEngine.answer(contents, results);
    if (!req.toolResults?.length) contents.push({ role: "user", parts: [{ text: req.userMessage }] });
    const model = typeof this.o.model === "function" ? this.o.model() : this.o.model;
    const body: Record<string, unknown> = {
      systemInstruction: {
        parts: [{ text: [req.system.stable, req.system.volatile].filter(Boolean).join("\n\n") }],
      },
      contents: contents.map(({ role, parts }) => ({ role, parts })),
    };
    if (req.tools?.length)
      body.tools = [
        {
          functionDeclarations: req.tools.map((t) => ({
            name: t.name,
            description: t.description.slice(0, 1024),
            parameters: geminiSchema(t.inputSchema),
          })),
        },
      ];
    const ctrl = new AbortController();
    this.active.set(key, ctrl);
    const onOuter = () => ctrl.abort();
    req.signal.addEventListener("abort", onOuter, { once: true });
    const parts: Part[] = [];
    const ids: string[] = [];
    let text = "";
    try {
      const apiKey = await this.o.apiKey?.();
      const url = `${joinUrl(this.o.baseUrl ?? GEMINI_DEFAULT_BASE, `models/${encodeURIComponent(model)}:streamGenerateContent`)}?alt=sse`;
      let res: Response;
      try {
        res = await (this.o.fetch ?? fetch)(url, {
          method: "POST",
          headers: { "content-type": "application/json", ...(apiKey ? { "x-goog-api-key": apiKey } : {}) },
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
      let usage:
        | { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number }
        | undefined;
      for await (const data of sseData(res.body, ctrl.signal)) {
        let chunk: {
          candidates?: Array<{ content?: { parts?: Array<Record<string, unknown>> } }>;
          usageMetadata?: typeof usage;
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
        for (const p of chunk.candidates?.[0]?.content?.parts ?? []) {
          if (typeof p.text === "string" && p.text) {
            text += p.text;
            yield { type: "text.delta", text: p.text };
          } else if (p.functionCall && typeof p.functionCall === "object") {
            const fc = p.functionCall as { name?: string; args?: Record<string, unknown>; id?: string };
            if (!fc.name) continue;
            if (text) {
              parts.push({ text });
              ids.push("");
              text = "";
              yield { type: "text.end" };
            }
            parts.push({ functionCall: { name: fc.name, args: fc.args ?? {} } });
            ids.push(fc.id ?? `gem_${req.runId}_${ids.length}`);
          }
        }
        if (chunk.usageMetadata) usage = chunk.usageMetadata;
      }
      if (text) {
        parts.push({ text });
        ids.push("");
      }
      if (ctrl.signal.aborted) {
        if (parts.length) contents.push({ role: "model", parts, ids });
        this.save(key, contents);
        return yield { type: "done", stop: "interrupted" };
      }
      if (text) yield { type: "text.end" };
      if (usage)
        yield {
          type: "usage",
          inputTokens: usage.promptTokenCount ?? 0,
          outputTokens: usage.candidatesTokenCount ?? 0,
          ...(usage.cachedContentTokenCount ? { cachedInputTokens: usage.cachedContentTokenCount } : {}),
        };
      contents.push({ role: "model", parts: parts.length ? parts : [{ text: "" }], ids });
      this.save(key, contents);
      const calls = parts.filter((p) => "functionCall" in p).length;
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i] as Part;
        if ("functionCall" in p)
          yield {
            type: "tool.call",
            id: ids[i] as string,
            name: p.functionCall.name,
            input: p.functionCall.args,
          };
      }
      yield { type: "done", stop: calls ? "tool_use" : "end_turn" };
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

  async dispose(): Promise<void> {
    for (const c of this.active.values()) c.abort();
    this.active.clear();
  }
}
