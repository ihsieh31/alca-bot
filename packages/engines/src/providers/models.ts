import { ANTHROPIC_VERSION } from "../http/anthropic.ts";
import { joinUrl } from "../http/common.ts";
import type { ModelInfo, ModelsSource, ProviderDef } from "./catalog.ts";
import { type Runner, runCommand } from "./detect.ts";

/**
 * A provider's model list (P11): the vendor's live `GET /models` where it has
 * one (OpenAI-style, Anthropic and Gemini shapes), a CLI listing where the
 * agent has one (`opencode models`), else the built-in list. A failed live
 * call falls back to the built-in list with a note; a model id can always be
 * typed in by hand. The key goes only in the vendor's auth header.
 */

export interface ModelList {
  source: ModelsSource;
  models: ModelInfo[];
  /** Why the live list was not used (shown under the picker). */
  note?: string;
}

export interface ListOptions {
  baseUrl?: string;
  apiKey?: string;
  /** CLI command override (binary + args) for a CLI listing. */
  command?: readonly string[];
  fetch?: typeof fetch;
  run?: Runner;
  timeoutMs?: number;
}

const num = (v: unknown): number | undefined => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};

/** Per-token USD (OpenRouter's `pricing.prompt`) → per million, rounded to cents of a cent. */
const perMillion = (v: unknown) => {
  const n = num(v);
  return n === undefined ? undefined : Math.round(n * 1e6 * 10_000) / 10_000;
};

function openaiShape(body: unknown): ModelInfo[] {
  const list = Array.isArray(body) ? body : ((body as { data?: unknown })?.data ?? []);
  if (!Array.isArray(list)) return [];
  return list
    .filter((m): m is Record<string, unknown> => !!m && typeof (m as { id?: unknown }).id === "string")
    .map((m) => {
      const ctx = num(m.context_length) ?? num(m.context_window) ?? num(m.max_context_length);
      const pricing = (m.pricing ?? {}) as { prompt?: unknown; completion?: unknown };
      const inP = perMillion(pricing.prompt);
      const outP = perMillion(pricing.completion);
      const name = typeof m.name === "string" && m.name !== m.id ? m.name : undefined;
      return {
        id: m.id as string,
        ...(name ? { label: name } : {}),
        ...(ctx ? { contextTokens: ctx } : {}),
        ...(inP !== undefined ? { inputPrice: inP } : {}),
        ...(outP !== undefined ? { outputPrice: outP } : {}),
      };
    });
}

function anthropicShape(body: unknown): ModelInfo[] {
  const list = (body as { data?: unknown })?.data;
  if (!Array.isArray(list)) return [];
  return list
    .filter((m) => typeof m?.id === "string")
    .map((m) => ({
      id: m.id as string,
      ...(typeof m.display_name === "string" ? { label: m.display_name as string } : {}),
    }));
}

function geminiShape(body: unknown): ModelInfo[] {
  const list = (body as { models?: unknown })?.models;
  if (!Array.isArray(list)) return [];
  return list
    .filter(
      (m) =>
        typeof m?.name === "string" &&
        (!Array.isArray(m.supportedGenerationMethods) ||
          m.supportedGenerationMethods.includes("generateContent")),
    )
    .map((m) => {
      const ctx = num(m.inputTokenLimit);
      return {
        id: String(m.name).replace(/^models\//, ""),
        ...(typeof m.displayName === "string" ? { label: m.displayName as string } : {}),
        ...(ctx ? { contextTokens: ctx } : {}),
      };
    });
}

/** Fill in what the vendor list leaves out (context) from the built-in list. */
function enrich(live: ModelInfo[], builtin: readonly ModelInfo[]): ModelInfo[] {
  const known = new Map(builtin.map((m) => [m.id, m]));
  return live.map((m) => ({ ...known.get(m.id), ...m }));
}

async function live(def: ProviderDef, o: ListOptions): Promise<ModelInfo[]> {
  const base = o.baseUrl ?? def.baseUrl ?? "";
  const headers: Record<string, string> = { accept: "application/json" };
  let url = joinUrl(base, "models");
  if (def.family === "anthropic") {
    url = joinUrl(base, "v1/models?limit=100");
    headers["anthropic-version"] = ANTHROPIC_VERSION;
    if (o.apiKey) headers["x-api-key"] = o.apiKey;
  } else if (def.family === "gemini") {
    url = joinUrl(base, "models?pageSize=200");
    if (o.apiKey) headers["x-goog-api-key"] = o.apiKey;
  } else if (o.apiKey) headers.authorization = `Bearer ${o.apiKey}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), o.timeoutMs ?? 8000);
  try {
    const res = await (o.fetch ?? fetch)(url, { headers, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as unknown;
    const shaped =
      def.family === "anthropic"
        ? anthropicShape(body)
        : def.family === "gemini"
          ? geminiShape(body)
          : openaiShape(body);
    if (!shaped.length) throw new Error("清單是空的");
    return shaped.sort((a, b) => a.id.localeCompare(b.id));
  } finally {
    clearTimeout(t);
  }
}

async function cli(def: ProviderDef, o: ListOptions): Promise<ModelInfo[]> {
  const bin = o.command?.[0] ?? def.binary;
  if (!bin || !def.modelsCommand) return [];
  const r = await (o.run ?? runCommand)(bin, def.modelsCommand, o.timeoutMs ?? 8000);
  if (r.code !== 0) throw new Error(`${bin} ${def.modelsCommand.join(" ")} 結束碼 ${r.code}`);
  const ids = r.out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[\w.@:/-]{1,200}$/.test(l));
  if (!ids.length) throw new Error("沒有列出模型");
  return [...new Set(ids)].map((id) => ({ id }));
}

const reason = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 120);

export async function listModels(def: ProviderDef, o: ListOptions = {}): Promise<ModelList> {
  const builtin = [...def.models];
  const noKey = def.kind === "api" && def.keyRequired !== false && !o.apiKey && def.id !== "openrouter";
  if (def.kind === "api" && def.liveModels && !noKey) {
    try {
      return { source: "api", models: enrich(await live(def, o), builtin) };
    } catch (e) {
      return { source: "builtin", models: builtin, note: `抓不到即時清單（${reason(e)}），先用內建清單` };
    }
  }
  if (def.modelsCommand) {
    try {
      return { source: "cli", models: enrich(await cli(def, o), builtin) };
    } catch (e) {
      return { source: "builtin", models: builtin, note: `${reason(e)}，先用內建清單` };
    }
  }
  return {
    source: "builtin",
    models: builtin,
    ...(noKey && def.liveModels ? { note: "設好金鑰後會抓即時清單" } : {}),
  };
}
