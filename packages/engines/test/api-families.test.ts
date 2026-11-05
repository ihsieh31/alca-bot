import { afterEach, describe, expect, it } from "vitest";
import {
  AnthropicEngine,
  createApiEngine,
  type EngineEvent,
  type EngineTurnRequest,
  memoryHistory,
  OpenAIResponsesEngine,
  PROVIDERS,
  type ProviderDef,
} from "../src/index.ts";
import { type MockLlm, startMockLlm } from "../testing/mock-llm.ts";

let mock: MockLlm | undefined;
afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

const KEY = "sk-test-p11-0000000000";
const TOOLS = [
  {
    name: "send_mail",
    description: "寄信",
    inputSchema: { type: "object", properties: { to: { type: "string" } }, required: ["to"] },
  },
];
const req = (o: Partial<EngineTurnRequest> = {}): EngineTurnRequest => ({
  threadId: "thr_X",
  runId: "run_1",
  system: { stable: "你是 Alca。", volatile: "現在是早上。" },
  userMessage: "寄信給老闆",
  tools: TOOLS,
  signal: new AbortController().signal,
  ...o,
});
async function collect(it: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const out: EngineEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}
const textOf = (es: EngineEvent[]) => es.map((e) => (e.type === "text.delta" ? e.text : "")).join("");

/** Two passes: a tool call split across events, then the answer after its result. */
async function toolRoundTrip(engine: { turn(r: EngineTurnRequest): AsyncIterable<EngineEvent> }) {
  const first = await collect(engine.turn(req()));
  const call = first.find((e) => e.type === "tool.call") as Extract<EngineEvent, { type: "tool.call" }>;
  const second = await collect(
    engine.turn(req({ toolResults: [{ id: call.id, ok: true, output: "已寄出" }], userMessage: "" })),
  );
  return { first, call, second };
}

const reply = (n: { i: number }) => () => {
  n.i++;
  return n.i % 2 === 1
    ? { text: "我來寄。", toolCalls: [{ name: "send_mail", args: { to: "boss@example.com" } }] }
    : { text: "寄好了。" };
};

describe("OpenAI Responses engine", () => {
  it("streams text, assembles a function call, feeds function_call_output back, store:false, key in Bearer only", async () => {
    mock = await startMockLlm(reply({ i: 0 }), { key: KEY });
    const e = new OpenAIResponsesEngine({
      id: "openai",
      baseUrl: mock.openaiBase,
      model: "gpt-5-mini",
      apiKey: () => KEY,
      reasoningEffort: "low",
    });
    const { first, call, second } = await toolRoundTrip(e);
    expect(textOf(first)).toBe("我來寄。");
    expect(call).toMatchObject({ id: "call_resp_0", name: "send_mail", input: { to: "boss@example.com" } });
    expect(first.find((x) => x.type === "usage")).toMatchObject({ inputTokens: 11, cachedInputTokens: 4 });
    expect(first.at(-1)).toEqual({ type: "done", stop: "tool_use" });
    expect(textOf(second)).toBe("寄好了。");
    const [b1, b2] = mock.requests.map((r) => r.body);
    expect(b1).toMatchObject({ store: false, stream: true, reasoning: { effort: "low" } });
    expect(String(b1?.instructions)).toContain("你是 Alca。");
    expect((b1?.tools as Array<{ name: string; type: string }> | undefined)?.[0]).toMatchObject({
      type: "function",
      name: "send_mail",
    });
    const input = b2?.input as Array<Record<string, unknown>>;
    expect(input.at(-2)).toMatchObject({ type: "function_call", call_id: "call_resp_0" });
    expect(input.at(-1)).toEqual({ type: "function_call_output", call_id: "call_resp_0", output: "已寄出" });
    expect(mock.requests[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it("a refused key is engine.auth, and the key is not in the message", async () => {
    mock = await startMockLlm(() => ({ text: "x" }), { key: "sk-test-right" });
    const e = new OpenAIResponsesEngine({
      id: "openai",
      baseUrl: mock.openaiBase,
      model: "m",
      apiKey: () => KEY,
    });
    const out = await collect(e.turn(req()));
    expect(out[0]).toMatchObject({ type: "error", code: "engine.auth" });
    expect(JSON.stringify(out)).not.toContain(KEY);
  });
});

describe("Anthropic Messages engine", () => {
  it("streams text and tool_use (input_json_delta), answers with tool_result, key in x-api-key", async () => {
    mock = await startMockLlm(reply({ i: 0 }), { key: KEY });
    const history = memoryHistory();
    const e = new AnthropicEngine({
      id: "anthropic",
      baseUrl: mock.baseUrl,
      model: "claude-sonnet-4-5",
      apiKey: () => KEY,
      history,
    });
    const { first, call, second } = await toolRoundTrip(e);
    expect(textOf(first)).toBe("我來寄。");
    expect(first.filter((x) => x.type === "text.end")).toHaveLength(1);
    expect(call).toMatchObject({ id: "toolu_0", name: "send_mail", input: { to: "boss@example.com" } });
    expect(textOf(second)).toBe("寄好了。");
    const r1 = mock.requests[0];
    expect(r1?.headers["x-api-key"]).toBe(KEY);
    expect(r1?.headers["anthropic-version"]).toBe("2023-06-01");
    expect(r1?.headers.authorization).toBeUndefined();
    expect(r1?.body).toMatchObject({ stream: true, max_tokens: 8192 });
    expect((r1?.body.tools as Array<Record<string, unknown>> | undefined)?.[0]).toHaveProperty(
      "input_schema",
    );
    const msgs = mock.requests[1]?.body.messages as Array<{ role: string; content: unknown }>;
    expect(msgs.at(-1)).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_0", content: "已寄出" }],
    });
    expect(JSON.parse(history.get("thr_X") ?? "[]")).toHaveLength(4);
  });
});

/** Point a catalog entry at the mock (same path layout as the vendor). */
function base(def: ProviderDef, m: MockLlm): string {
  if (def.family === "anthropic") return m.baseUrl;
  if (def.family === "gemini") return m.geminiBase;
  return m.openaiBase;
}

describe("every API provider in the catalog vs the mock server", () => {
  const apis = PROVIDERS.filter((p) => p.kind === "api");
  it("covers the v7 list", () => {
    expect(apis.map((p) => p.id).sort()).toEqual(
      [
        "anthropic",
        "cerebras",
        "deepseek",
        "fireworks",
        "gemini",
        "groq",
        "lmstudio",
        "minimax",
        "mistral",
        "ollama",
        "openai",
        "openrouter",
        "together",
        "xai",
      ].sort(),
    );
  });

  for (const def of apis)
    it(`${def.id}: streaming + a tool call round trip; the key only in its auth header`, async () => {
      const n = { i: 0 };
      const key = def.keyRequired === false ? undefined : KEY;
      mock = await startMockLlm(reply(n), key ? { key } : {});
      const e = createApiEngine(def, {
        id: def.id,
        model: def.defaultModel ?? "local-model",
        baseUrl: base(def, mock),
        ...(key ? { apiKey: () => key } : {}),
      });
      const { first, call, second } = await toolRoundTrip(e);
      expect(textOf(first)).toBe("我來寄。");
      expect(call.name).toBe("send_mail");
      expect(call.input).toEqual({ to: "boss@example.com" });
      expect(textOf(second)).toBe("寄好了。");
      for (const r of mock.requests) expect(JSON.stringify(r.body)).not.toContain(KEY);
      if (!key) expect(mock.requests[0]?.headers.authorization).toBeUndefined();
      await e.dispose();
    });

  it("OpenAI can be switched to Chat Completions", async () => {
    mock = await startMockLlm(() => ({ text: "chat" }), { key: KEY });
    const def = PROVIDERS.find((p) => p.id === "openai") as ProviderDef;
    const e = createApiEngine(def, {
      id: "openai",
      model: "gpt-4o-mini",
      baseUrl: mock.openaiBase,
      family: "openai-chat",
      apiKey: () => KEY,
    });
    expect(textOf(await collect(e.turn(req({ tools: [] }))))).toBe("chat");
    expect(mock.requests[0]?.api).toBe("openai");
  });
});
