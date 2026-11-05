import { afterEach, describe, expect, it } from "vitest";
import {
  type EngineEvent,
  type EngineTurnRequest,
  GeminiEngine,
  geminiSchema,
  memoryHistory,
  OpenAICompatEngine,
} from "../src/index.ts";
import { type MockLlm, startMockLlm } from "../testing/mock-llm.ts";

let mock: MockLlm | undefined;
afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

const KEY = "sk-test-0000000000000000";
const TOOLS = [
  {
    name: "send_mail",
    description: "寄信",
    inputSchema: {
      type: "object",
      properties: { to: { type: "string" } },
      required: ["to"],
      additionalProperties: false,
    },
  },
];

function req(o: Partial<EngineTurnRequest> = {}): EngineTurnRequest {
  return {
    threadId: "thr_X",
    runId: "run_1",
    system: { stable: "你是 Alca。", volatile: "現在是早上。" },
    userMessage: "你好",
    tools: TOOLS,
    signal: new AbortController().signal,
    ...o,
  };
}

async function collect(it: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const out: EngineEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}
const text = (es: EngineEvent[]) => es.map((e) => (e.type === "text.delta" ? e.text : "")).join("");

describe("OpenAI-compatible engine", () => {
  it("streams text, assembles a tool call split across chunks, answers it on the next pass, keeps history", async () => {
    let n = 0;
    mock = await startMockLlm(
      () => {
        n++;
        if (n === 1)
          return { text: "我來寄。", toolCalls: [{ name: "send_mail", args: { to: "boss@example.com" } }] };
        if (n === 2) return { text: "寄好了。" };
        return { text: "第二題的回答" };
      },
      { key: KEY },
    );
    const history = memoryHistory();
    const e = new OpenAICompatEngine({
      id: "eng_test",
      baseUrl: mock.openaiBase,
      model: "test/model",
      apiKey: () => KEY,
      history,
    });
    const first = await collect(e.turn(req()));
    expect(text(first)).toBe("我來寄。");
    const call = first.find((x) => x.type === "tool.call");
    expect(call).toMatchObject({
      type: "tool.call",
      id: "call_mock_0",
      name: "send_mail",
      input: { to: "boss@example.com" },
    });
    expect(first.at(-1)).toEqual({ type: "done", stop: "tool_use" });
    expect(first.some((x) => x.type === "usage" && x.inputTokens === 11)).toBe(true);
    const b1 = mock.requests[0]!;
    expect(b1.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(b1.body).toMatchObject({ model: "test/model", stream: true });
    const msgs = b1.body.messages as Array<{ role: string; content: string }>;
    expect(msgs[0]).toEqual({ role: "system", content: "你是 Alca。\n\n現在是早上。" });
    expect((b1.body.tools as Array<{ function: { name: string } }>)[0]?.function.name).toBe("send_mail");

    const second = await collect(
      e.turn(req({ toolResults: [{ id: "call_mock_0", ok: true, output: "sent" }] })),
    );
    expect(text(second)).toBe("寄好了。");
    expect(second.at(-1)).toEqual({ type: "done", stop: "end_turn" });
    const m2 = mock.requests[1]!.body.messages as Array<Record<string, unknown>>;
    expect(m2.at(-2)).toMatchObject({
      role: "assistant",
      tool_calls: [{ id: "call_mock_0", function: { name: "send_mail" } }],
    });
    expect(m2.at(-1)).toEqual({ role: "tool", tool_call_id: "call_mock_0", content: "sent" });

    // A new message continues the same conversation.
    await collect(e.turn(req({ runId: "run_2", userMessage: "再問一題" })));
    const m3 = mock.requests[2]!.body.messages as Array<Record<string, unknown>>;
    expect(m3.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "assistant", "user"]);
    // The key is never stored with the conversation.
    expect(history.get("thr_X")).not.toContain(KEY);
  });

  it("a refused key is an engine.auth error (without the key); a local server needs no key", async () => {
    mock = await startMockLlm(() => ({ text: "hi" }), { key: KEY });
    const bad = new OpenAICompatEngine({
      id: "e",
      baseUrl: mock.openaiBase,
      model: "m",
      apiKey: () => "wrong-key",
    });
    const out = await collect(bad.turn(req()));
    const err = out.find((x) => x.type === "error");
    expect(err).toMatchObject({ code: "engine.auth", retryable: false });
    expect(JSON.stringify(err)).not.toContain("wrong-key");
    await mock.close();
    mock = await startMockLlm(() => ({ text: "本機模型" }));
    const local = new OpenAICompatEngine({ id: "e", baseUrl: mock.openaiBase, model: "llama3" });
    expect(text(await collect(local.turn(req())))).toBe("本機模型");
    expect(mock.requests[0]!.headers.authorization).toBeUndefined();
  });

  it("an interrupted tool call is closed before the next message (the API refuses dangling calls)", async () => {
    let n = 0;
    mock = await startMockLlm(() =>
      ++n === 1 ? { toolCalls: [{ name: "send_mail", args: { to: "a" } }] } : { text: "ok" },
    );
    const e = new OpenAICompatEngine({ id: "e", baseUrl: mock.openaiBase, model: "m" });
    await collect(e.turn(req()));
    await collect(e.turn(req({ runId: "run_2", userMessage: "算了" })));
    const m = mock.requests[1]!.body.messages as Array<Record<string, unknown>>;
    expect(m.map((x) => x.role)).toEqual(["system", "user", "assistant", "tool", "user"]);
    expect(m[3]).toMatchObject({ role: "tool", tool_call_id: "call_mock_0" });
  });
});

describe("Gemini engine", () => {
  it("streams text and function calls, sends the key in a header, answers with functionResponse by name", async () => {
    let n = 0;
    mock = await startMockLlm(
      () =>
        ++n === 1
          ? { text: "好", toolCalls: [{ name: "send_mail", args: { to: "x@y.z" } }] }
          : { text: "完成" },
      { key: KEY },
    );
    const e = new GeminiEngine({
      id: "eng_gem",
      baseUrl: mock.geminiBase,
      model: "gemini-2.5-flash",
      apiKey: () => KEY,
    });
    const first = await collect(e.turn(req()));
    expect(text(first)).toBe("好");
    const call = first.find((x): x is Extract<EngineEvent, { type: "tool.call" }> => x.type === "tool.call");
    expect(call).toMatchObject({ name: "send_mail", input: { to: "x@y.z" } });
    const r1 = mock.requests[0]!;
    expect(r1.path).toBe("/v1beta/models/gemini-2.5-flash:streamGenerateContent");
    expect(r1.headers["x-goog-api-key"]).toBe(KEY);
    const decl = (
      r1.body.tools as Array<{ functionDeclarations: Array<{ parameters: Record<string, unknown> }> }>
    )[0]!.functionDeclarations[0]!;
    expect(decl.parameters).not.toHaveProperty("additionalProperties");
    const second = await collect(e.turn(req({ toolResults: [{ id: call!.id, ok: true, output: "sent" }] })));
    expect(text(second)).toBe("完成");
    const contents = mock.requests[1]!.body.contents as Array<{
      role: string;
      parts: Array<Record<string, unknown>>;
    }>;
    expect(contents.at(-1)).toEqual({
      role: "user",
      parts: [{ functionResponse: { name: "send_mail", response: { content: "sent" } } }],
    });
    expect(contents.every((c) => !("ids" in c))).toBe(true);
  });

  it("geminiSchema drops keys the API rejects, recursively", () => {
    expect(
      geminiSchema({
        type: "object",
        additionalProperties: false,
        properties: { a: { type: "array", items: { type: "object", additionalProperties: false } } },
      }),
    ).toEqual({ type: "object", properties: { a: { type: "array", items: { type: "object" } } } });
  });
});
