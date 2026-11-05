import type { Engine, EngineEvent, EngineTurnRequest } from "../types.ts";
import {
  type HistoryStore,
  HTTP_CAPABILITIES,
  httpError,
  type KeyLookup,
  memoryHistory,
  networkError,
} from "./common.ts";
import { compactHistory, type HistoryView } from "./compact.ts";

/**
 * Shared skeleton of the P11 HTTP engines (Anthropic Messages, OpenAI
 * Responses): history per conversation key, one abort controller per running
 * turn, and the POST that maps network and HTTP failures onto engine events.
 * The key is read at call time and only goes in the header the vendor wants.
 */

export interface HttpEngineOptions {
  id: string;
  baseUrl: string;
  model: string | (() => string);
  apiKey?: KeyLookup;
  history?: HistoryStore;
  maxMessages?: number;
  /** "low" | "medium" | "high" where the model supports reasoning effort. */
  reasoningEffort?: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}

export type PostOutcome = { res: Response } | { events: EngineEvent[] };

export abstract class HttpEngineBase<M> implements Engine {
  readonly id: string;
  readonly capabilities = HTTP_CAPABILITIES;
  protected readonly o: HttpEngineOptions;
  private readonly history: HistoryStore;
  private readonly active = new Map<string, AbortController>();

  constructor(o: HttpEngineOptions) {
    this.o = o;
    this.id = o.id;
    this.history = o.history ?? memoryHistory();
  }

  abstract turn(req: EngineTurnRequest): AsyncIterable<EngineEvent>;

  protected model(): string {
    return typeof this.o.model === "function" ? this.o.model() : this.o.model;
  }

  protected load(key: string): M[] {
    try {
      const raw = this.history.get(key);
      const v = raw ? (JSON.parse(raw) as unknown) : [];
      return Array.isArray(v) ? (v as M[]) : [];
    } catch {
      return [];
    }
  }

  /** Store the history, bounded; older turns fold into the rolling summary (compact.ts). */
  protected save(key: string, msgs: M[], view: HistoryView<M>): void {
    this.history.set(key, JSON.stringify(compactHistory(msgs, this.o.maxMessages ?? 80, view)));
  }

  /** A controller for this turn, aborted by the caller's signal or `interrupt(key)`. */
  protected begin(key: string, outer: AbortSignal): { ctrl: AbortController; end: () => void } {
    const ctrl = new AbortController();
    this.active.set(key, ctrl);
    const onOuter = () => ctrl.abort();
    outer.addEventListener("abort", onOuter, { once: true });
    if (outer.aborted) ctrl.abort();
    return {
      ctrl,
      end: () => {
        outer.removeEventListener("abort", onOuter);
        if (this.active.get(key) === ctrl) this.active.delete(key);
      },
    };
  }

  /** POST JSON; a failure comes back as the events to yield (error + done). */
  protected async post(
    url: string,
    headers: Record<string, string>,
    body: unknown,
    signal: AbortSignal,
  ): Promise<PostOutcome> {
    let res: Response;
    try {
      res = await (this.o.fetch ?? fetch)(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          ...headers,
          ...this.o.headers,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (signal.aborted) return { events: [{ type: "done", stop: "interrupted" }] };
      return { events: [networkError(err), { type: "done", stop: "error" }] };
    }
    if (!res.ok || !res.body)
      return {
        events: [httpError(res.status, await res.text().catch(() => "")), { type: "done", stop: "error" }],
      };
    return { res };
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

/** A tool-result text the way the HTTP engines feed it back. */
export const resultText = (r: { ok: boolean; output: string }) => (r.ok ? r.output : `錯誤：${r.output}`);

export const streamError = (message: unknown): EngineEvent => ({
  type: "error",
  code: "engine.stream",
  message: String(message ?? "stream error").slice(0, 300),
  retryable: false,
});
