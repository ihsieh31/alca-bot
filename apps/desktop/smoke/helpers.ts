// Opt-in smoke tests against real accounts and real CLIs (P9). Nothing here
// runs in `pnpm test` or CI: `pnpm smoke` runs them, and each block is
// skipped unless its env var is set. Every call is read-only or a plain
// chat turn; nothing is sent, posted, bought or deleted.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Engine, EngineEvent, ToolSpec } from "@alca/engines";

export const env = (k: string): string | undefined => process.env[k]?.trim() || undefined;

export function tempDir(prefix: string): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

export async function oneTurn(
  engine: Engine,
  text: string,
  o: { key?: string; tools?: ToolSpec[]; timeoutMs?: number } = {},
): Promise<{ events: EngineEvent[]; text: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), o.timeoutMs ?? 120_000);
  const events: EngineEvent[] = [];
  try {
    for await (const e of engine.turn({
      threadId: o.key ?? "smoke",
      runId: `smoke_${Date.now()}`,
      sessionKey: o.key ?? "smoke",
      system: { stable: "You are a terse test assistant. Follow the instruction exactly.", volatile: "" },
      userMessage: text,
      signal: ctrl.signal,
      ...(o.tools ? { tools: o.tools } : {}),
      onPermission: async () => ({ behavior: "deny", message: "smoke test: no tools" }),
      onToolCall: async () => ({ ok: false, output: "smoke test: not run" }),
    })) {
      events.push(e);
      if (e.type === "done") break;
    }
  } finally {
    clearTimeout(t);
  }
  const textOut = events.flatMap((e) => (e.type === "text.delta" ? [e.text] : [])).join("");
  return { events, text: textOut };
}

export const firstError = (ev: EngineEvent[]) => ev.find((e) => e.type === "error");

export const TIME_TOOL: ToolSpec = {
  name: "get_time",
  description: "Returns the current time in a city.",
  inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
};
