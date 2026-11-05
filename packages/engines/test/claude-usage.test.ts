// Mac device test 2026-11-05 N4: a proactive worker on Claude Code ran to 74k
// tokens against a 20k budget because the CLI's usage was booked only from the
// turn's final `result`. The parser now books each model message's usage as it
// arrives, and reconciles the turn total so nothing is counted twice.
import { describe, expect, it } from "vitest";
import { ClaudeStreamParser, type EngineEvent } from "../src/index.ts";

const usageOf = (events: EngineEvent[]) => events.flatMap((e) => (e.type === "usage" ? [e] : []));

const sum = (events: EngineEvent[]) =>
  usageOf(events).reduce(
    (a, e) => ({
      input: a.input + e.inputTokens,
      output: a.output + e.outputTokens,
      cached: a.cached + (e.cachedInputTokens ?? 0),
    }),
    { input: 0, output: 0, cached: 0 },
  );

const assistant = (id: string, usage: Record<string, number>, content: unknown[]) => ({
  type: "assistant",
  parent_tool_use_id: null,
  message: { id, role: "assistant", usage, content },
});

const toolUse = (n: number) => ({
  type: "tool_use",
  id: `toolu_${n}`,
  name: "Read",
  input: { file_path: "a" },
});

describe("ClaudeStreamParser per-message usage", () => {
  it("books each assistant message's usage before its tool call, not only at the end", () => {
    const p = new ClaudeStreamParser();
    p.beginTurn();
    const first = p.feed(
      assistant("msg_1", { input_tokens: 5, cache_read_input_tokens: 9000, output_tokens: 40 }, [toolUse(1)]),
    );
    expect(first[0]).toEqual({ type: "usage", inputTokens: 9005, outputTokens: 40, cachedInputTokens: 9000 });
    expect(first[1]).toMatchObject({ type: "tool.call", id: "toolu_1" });
    const second = p.feed(
      assistant("msg_2", { input_tokens: 7, cache_creation_input_tokens: 300, output_tokens: 20 }, [
        toolUse(2),
      ]),
    );
    expect(usageOf(second)).toEqual([{ type: "usage", inputTokens: 307, outputTokens: 20 }]);
  });

  it("a message streamed in several lines is counted once (its repeated or growing usage)", () => {
    const p = new ClaudeStreamParser();
    p.beginTurn();
    const u = { input_tokens: 10, cache_read_input_tokens: 100, output_tokens: 3 };
    const a = p.feed(assistant("msg_1", u, [{ type: "text", text: "hi" }]));
    const b = p.feed(assistant("msg_1", u, [toolUse(1)]));
    const c = p.feed(assistant("msg_1", { ...u, output_tokens: 30 }, [toolUse(2)]));
    expect(sum([...a, ...b, ...c])).toEqual({ input: 110, output: 30, cached: 100 });
    expect(usageOf(b)).toEqual([]);
  });

  it("stream events book input at message_start and output at message_delta", () => {
    const p = new ClaudeStreamParser();
    p.beginTurn();
    const start = p.feed({
      type: "stream_event",
      parent_tool_use_id: null,
      event: {
        type: "message_start",
        message: { id: "msg_s", usage: { input_tokens: 4, cache_read_input_tokens: 2000, output_tokens: 1 } },
      },
    });
    expect(sum(start)).toEqual({ input: 2004, output: 1, cached: 2000 });
    const delta = p.feed({
      type: "stream_event",
      parent_tool_use_id: null,
      event: { type: "message_delta", usage: { output_tokens: 55 } },
    });
    expect(sum(delta)).toEqual({ input: 0, output: 54, cached: 0 });
    // The assistant line for the same message adds nothing new.
    const line = p.feed(
      assistant("msg_s", { input_tokens: 4, cache_read_input_tokens: 2000, output_tokens: 55 }, [toolUse(1)]),
    );
    expect(usageOf(line)).toEqual([]);
  });

  it("the result total only adds what the messages did not (no double count)", () => {
    const p = new ClaudeStreamParser();
    p.beginTurn();
    const msgs = [
      ...p.feed(assistant("m1", { input_tokens: 100, output_tokens: 10 }, [toolUse(1)])),
      ...p.feed(assistant("m2", { input_tokens: 200, output_tokens: 20 }, [{ type: "text", text: "ok" }])),
    ];
    const end = p.feed({
      type: "result",
      subtype: "success",
      // A sub-agent's 50 input tokens were not on the main thread's messages.
      usage: { input_tokens: 350, output_tokens: 30 },
    });
    expect(sum(end)).toEqual({ input: 50, output: 0, cached: 0 });
    expect(sum([...msgs, ...end])).toEqual({ input: 350, output: 30, cached: 0 });
    expect(end.at(-1)).toEqual({ type: "done", stop: "end_turn" });
  });

  it("without per-message usage the result still books the whole turn (older CLIs)", () => {
    const p = new ClaudeStreamParser();
    p.beginTurn();
    p.feed({ type: "assistant", parent_tool_use_id: null, message: { content: [toolUse(1)] } });
    const end = p.feed({
      type: "result",
      subtype: "success",
      usage: { input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 30 },
    });
    expect(usageOf(end)).toEqual([
      { type: "usage", inputTokens: 42, outputTokens: 7, cachedInputTokens: 30 },
    ]);
  });

  it("a new turn starts its own ledger", () => {
    const p = new ClaudeStreamParser();
    p.beginTurn();
    p.feed(assistant("m1", { input_tokens: 100, output_tokens: 10 }, [toolUse(1)]));
    p.feed({ type: "result", subtype: "success", usage: { input_tokens: 100, output_tokens: 10 } });
    p.beginTurn();
    const end = p.feed({ type: "result", subtype: "success", usage: { input_tokens: 40, output_tokens: 4 } });
    expect(sum(end)).toEqual({ input: 40, output: 4, cached: 0 });
  });
});
