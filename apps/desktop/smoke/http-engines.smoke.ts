import { GeminiEngine, memoryHistory, OpenAICompatEngine } from "@alca/engines";
import { describe, expect, it } from "vitest";
import { env, firstError, oneTurn, TIME_TOOL } from "./helpers.ts";

const OPENROUTER = env("ALCA_SMOKE_OPENROUTER_KEY");
const GEMINI = env("ALCA_SMOKE_GEMINI_KEY");

describe.skipIf(!OPENROUTER)("smoke × OpenRouter (real account)", () => {
  const engine = new OpenAICompatEngine({
    id: "smoke-openrouter",
    baseUrl: env("ALCA_SMOKE_OPENROUTER_BASE") ?? "https://openrouter.ai/api/v1",
    model: env("ALCA_SMOKE_OPENROUTER_MODEL") ?? "openai/gpt-6-luna",
    apiKey: async () => OPENROUTER,
    history: memoryHistory(),
    headers: { "X-Title": "Alca smoke test" },
  });

  it("answers a plain turn and keeps the conversation", async () => {
    const a = await oneTurn(engine, "Reply with exactly the word: pong", { key: "or" });
    expect(firstError(a.events)).toBeUndefined();
    expect(a.text.toLowerCase()).toContain("pong");
    const b = await oneTurn(engine, "What single word did you just reply with? Answer with that word only.", {
      key: "or",
    });
    expect(b.text.toLowerCase()).toContain("pong");
  }, 120_000);

  it("asks for a host tool in the host-loop shape", async () => {
    const r = await oneTurn(engine, "Use the get_time tool for Taipei. Do not answer in text.", {
      key: "or-tool",
      tools: [TIME_TOOL],
    });
    expect(r.events.find((e) => e.type === "tool.call")).toMatchObject({ name: "get_time" });
  }, 120_000);
});

describe.skipIf(!GEMINI)("smoke × Gemini API (real account)", () => {
  const engine = new GeminiEngine({
    id: "smoke-gemini",
    model: env("ALCA_SMOKE_GEMINI_MODEL") ?? "gemini-3.8-flash",
    apiKey: async () => GEMINI,
    history: memoryHistory(),
  });

  it("answers a plain turn", async () => {
    const a = await oneTurn(engine, "Reply with exactly the word: pong", { key: "gm" });
    expect(firstError(a.events)).toBeUndefined();
    expect(a.text.toLowerCase()).toContain("pong");
  }, 120_000);

  it("asks for a host tool", async () => {
    const r = await oneTurn(engine, "Use the get_time tool for Taipei. Do not answer in text.", {
      key: "gm-tool",
      tools: [TIME_TOOL],
    });
    expect(r.events.find((e) => e.type === "tool.call")).toMatchObject({ name: "get_time" });
  }, 120_000);
});
