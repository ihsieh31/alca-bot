import type { Engine } from "@alca/engines";
import type { ExtractCompletion } from "@alca/memory";

/**
 * The completion a model-based memory extractor runs on (P9): one turn on
 * the bot's own engine, in a fresh conversation of its own (never the
 * person's thread), with no tools and every permission denied. Only the
 * text comes back; a tool call ends the turn.
 */
export function engineCompletion(engineFor: (botId: string) => Engine | undefined): ExtractCompletion {
  let n = 0;
  return async ({ botId, prompt, signal }) => {
    const engine = engineFor(botId);
    if (!engine) throw new Error("no engine for this bot");
    const key = `memx:${botId}:${Date.now().toString(36)}${(n++).toString(36)}`;
    let text = "";
    try {
      for await (const e of engine.turn({
        threadId: key,
        runId: key,
        sessionKey: key,
        system: { stable: "", volatile: "" },
        userMessage: prompt,
        tools: [],
        signal,
        onPermission: async () => ({ behavior: "deny", message: "記憶整理不能用工具" }),
        onToolCall: async () => ({ ok: false, output: "記憶整理不能用工具" }),
      })) {
        if (e.type === "text.delta") text += e.text;
        if (e.type === "error" && !text) throw new Error(e.message);
        if (e.type === "tool.call" && !engine.capabilities.ownsToolLoop) break;
        if (e.type === "done") break;
        if (text.length > 20_000) break;
      }
    } finally {
      await engine.release?.(key).catch(() => undefined);
    }
    return text;
  };
}

/** What an add-on's completion spent (estimated from the text when the engine reports no usage). */
export interface AddonAnswer {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export type AddonCompletion = (o: {
  botId: string;
  prompt: string;
  signal: AbortSignal;
  purpose: string;
}) => Promise<AddonAnswer>;

const roughTokens = (s: string) => Math.ceil(s.length / 2);

/**
 * P14: one tool-less turn for an add-on (主動留意's candidates, 回覆檢查), on
 * the bot's own engine in a conversation of its own, every permission denied.
 */
export function addonCompletion(engineFor: (botId: string) => Engine | undefined): AddonCompletion {
  let n = 0;
  return async ({ botId, prompt, signal, purpose }) => {
    const engine = engineFor(botId);
    if (!engine) throw new Error("no engine for this bot");
    const key = `addon:${purpose}:${botId}:${Date.now().toString(36)}${(n++).toString(36)}`;
    let text = "";
    // N7 (Mac device test 2026-11-05): an engine may report usage in several
    // readings (Claude Code per message, Codex app-server as deltas); they add up.
    const usage = { inputTokens: 0, outputTokens: 0 };
    try {
      for await (const e of engine.turn({
        threadId: key,
        runId: key,
        sessionKey: key,
        system: { stable: "", volatile: "" },
        userMessage: prompt,
        tools: [],
        signal,
        onPermission: async () => ({ behavior: "deny", message: "擴充的檢查不能用工具" }),
        onToolCall: async () => ({ ok: false, output: "擴充的檢查不能用工具" }),
      })) {
        if (e.type === "text.delta") text += e.text;
        if (e.type === "usage") {
          usage.inputTokens += e.inputTokens;
          usage.outputTokens += e.outputTokens;
        }
        if (e.type === "error" && !text) throw new Error(e.message);
        if (e.type === "tool.call" && !engine.capabilities.ownsToolLoop) break;
        if (e.type === "done") break;
        if (text.length > 20_000) break;
      }
    } finally {
      await engine.release?.(key).catch(() => undefined);
    }
    // No reading (an engine without usage, or a turn cut off by the check's
    // timeout before the CLI reported any) is estimated, never booked as 0:
    // the prompt was sent, so the add-on's daily cap must see it.
    return {
      text,
      inputTokens: usage.inputTokens > 0 ? usage.inputTokens : roughTokens(prompt),
      outputTokens: usage.outputTokens > 0 ? usage.outputTokens : roughTokens(text),
    };
  };
}
