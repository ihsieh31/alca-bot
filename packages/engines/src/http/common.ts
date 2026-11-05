import type { EngineCapabilities, EngineEvent } from "../types.ts";

/**
 * Shared parts of the HTTP model engines (P7): an SSE line reader, the
 * per-conversation history, the key lookup, and error mapping. These engines
 * are host-loop engines: they return tool calls and the core runs them
 * through the gateway, exactly like the scripted engine.
 */

export const HTTP_CAPABILITIES: EngineCapabilities = Object.freeze({
  kind: "api",
  persistentProcess: false,
  streaming: true,
  resume: true,
  interrupt: true,
  ownsToolLoop: false,
  nativePermissionModes: [],
  permissionPrompt: "host_loop",
  systemPromptAtLaunch: false,
  supportsPromptCache: false,
  supportsImages: false,
});

/** Where a conversation's history lives between turns (and restarts): a string per key. */
export interface HistoryStore {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
}

/** Plain in-memory history (tests; the desktop passes one backed by the store). */
export function memoryHistory(): HistoryStore {
  const m = new Map<string, string>();
  return { get: (k) => m.get(k), set: (k, v) => void m.set(k, v) };
}

/** Read the API key at call time (from the local vault); undefined = no key (a local server). */
export type KeyLookup = () => Promise<string | undefined> | string | undefined;

/** Split a fetch body into SSE `data:` payloads (one per event; multi-line data joined). */
export async function* sseData(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let data: string[] = [];
  const onAbort = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      for (;;) {
        const nl = buf.indexOf("\n");
        if (nl < 0) break;
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (line === "") {
          if (data.length) yield data.join("\n");
          data = [];
        } else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
    }
    if (data.length) yield data.join("\n");
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

/** Map an HTTP failure to an engine error event. The key is never in the message. */
export function httpError(status: number, text: string): EngineEvent {
  const short = text.replace(/\s+/g, " ").slice(0, 300);
  if (status === 401 || status === 403)
    return {
      type: "error",
      code: "engine.auth",
      message: `模型服務拒絕了金鑰（${status}）`,
      retryable: false,
    };
  if (status === 429)
    return {
      type: "error",
      code: "engine.quota",
      message: `模型服務的額度或速率到了（429）：${short}`,
      retryable: true,
    };
  if (status === 404)
    return {
      type: "error",
      code: "engine.not_found",
      message: `找不到模型或網址（404）：${short}`,
      retryable: false,
    };
  return {
    type: "error",
    code: "engine.http",
    message: `模型服務回應 ${status}：${short}`,
    retryable: status >= 500,
  };
}

export function networkError(err: unknown): EngineEvent {
  return {
    type: "error",
    code: "engine.network",
    message: `連不上模型服務：${String((err as Error)?.message ?? err).slice(0, 200)}`,
    retryable: true,
  };
}

/** Join a base URL and a path without doubling slashes. */
export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/** Parse a tool's JSON arguments; anything that is not an object becomes {} with the raw text kept. */
export function parseArgs(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : { value: v };
  } catch {
    return { _raw: raw.slice(0, 4000) };
  }
}
