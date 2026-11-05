import type { MockReply } from "./mock-llm.ts";

/**
 * The P11 parts of the mock model server: OpenAI Responses and Anthropic
 * Messages streams (text in small pieces, tool-call arguments split across
 * events), and `GET /models` lists in the OpenAI (with OpenRouter's context
 * and per-token pricing), Anthropic and Gemini shapes.
 */

type Send = (d: unknown) => void;

const pieces = (s: string, n: number) => {
  const out: string[] = [];
  const cs = [...s];
  for (let i = 0; i < cs.length; i += n) out.push(cs.slice(i, i + n).join(""));
  return out;
};

export function streamResponses(out: MockReply, send: Send): void {
  send({ type: "response.created", response: { id: "resp_mock" } });
  let idx = 0;
  if (out.text) {
    send({
      type: "response.output_item.added",
      output_index: idx,
      item: { type: "message", role: "assistant" },
    });
    for (const p of pieces(out.text, 3))
      send({ type: "response.output_text.delta", output_index: idx, delta: p });
    idx++;
  }
  for (const [i, c] of (out.toolCalls ?? []).entries()) {
    const call_id = `call_resp_${i}`;
    send({
      type: "response.output_item.added",
      output_index: idx,
      item: { type: "function_call", id: `fc_${i}`, call_id, name: c.name, arguments: "" },
    });
    const args = JSON.stringify(c.args);
    for (const p of pieces(args, 5))
      send({
        type: "response.function_call_arguments.delta",
        output_index: idx,
        item_id: `fc_${i}`,
        delta: p,
      });
    send({
      type: "response.output_item.done",
      output_index: idx,
      item: { type: "function_call", id: `fc_${i}`, call_id, name: c.name, arguments: args },
    });
    idx++;
  }
  send({
    type: "response.completed",
    response: {
      id: "resp_mock",
      usage: {
        input_tokens: out.usage?.input ?? 11,
        output_tokens: out.usage?.output ?? 7,
        input_tokens_details: { cached_tokens: 4 },
      },
    },
  });
}

export function streamAnthropic(out: MockReply, send: Send): void {
  send({
    type: "message_start",
    message: { id: "msg_mock", usage: { input_tokens: out.usage?.input ?? 11 } },
  });
  let idx = 0;
  if (out.text) {
    send({ type: "content_block_start", index: idx, content_block: { type: "text", text: "" } });
    for (const p of pieces(out.text, 3))
      send({ type: "content_block_delta", index: idx, delta: { type: "text_delta", text: p } });
    send({ type: "content_block_stop", index: idx });
    idx++;
  }
  for (const [i, c] of (out.toolCalls ?? []).entries()) {
    send({
      type: "content_block_start",
      index: idx,
      content_block: { type: "tool_use", id: `toolu_${i}`, name: c.name, input: {} },
    });
    for (const p of pieces(JSON.stringify(c.args), 5))
      send({ type: "content_block_delta", index: idx, delta: { type: "input_json_delta", partial_json: p } });
    send({ type: "content_block_stop", index: idx });
    idx++;
  }
  send({
    type: "message_delta",
    delta: { stop_reason: out.toolCalls?.length ? "tool_use" : "end_turn" },
    usage: { output_tokens: out.usage?.output ?? 7 },
  });
  send({ type: "message_stop" });
}

export function modelList(shape: "openai" | "anthropic" | "gemini"): unknown {
  if (shape === "anthropic")
    return { data: [{ id: "claude-mock-1", display_name: "Claude Mock" }, { id: "claude-sonnet-4-5" }] };
  if (shape === "gemini")
    return {
      models: [
        {
          name: "models/gemini-mock",
          displayName: "Gemini Mock",
          inputTokenLimit: 32768,
          supportedGenerationMethods: ["generateContent"],
        },
        { name: "models/embedding-mock", supportedGenerationMethods: ["embedContent"] },
      ],
    };
  return {
    data: [
      {
        id: "mock/fast",
        name: "Mock Fast",
        context_length: 131072,
        pricing: { prompt: "0.0000005", completion: "0.0000015" },
      },
      { id: "openai/gpt-6-luna" },
    ],
  };
}
