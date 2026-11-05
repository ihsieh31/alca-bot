// Mac device test 2026-11-05 N7: 回覆檢查's usage showed runs 1 but tokens 0.
// addonCompletion kept only the last usage reading (an engine that reports in
// several readings was undercounted), and a reading of 0 (a CLI turn the
// check's timeout cut off before any reply) was booked as 0 tokens although
// the prompt had been sent.
import { ScriptedEngine, type ScriptStep } from "@alca/engines";
import { describe, expect, it } from "vitest";
import { addonCompletion } from "../src/extract-engine.ts";

const run = (steps: ScriptStep[], prompt = "檢查這則回覆") => {
  const engine = new ScriptedEngine([steps]);
  return addonCompletion(() => engine)({
    botId: "b",
    prompt,
    signal: new AbortController().signal,
    purpose: "reply-check",
  });
};

describe("addonCompletion usage", () => {
  it("adds up every usage reading of the turn (per-message / delta engines)", async () => {
    const a = await run([
      { type: "usage", inputTokens: 900, outputTokens: 10 },
      { type: "text.delta", text: '{"ok":true}' },
      { type: "usage", inputTokens: 1_100, outputTokens: 25 },
      { type: "done", stop: "end_turn" },
    ]);
    expect(a).toEqual({ text: '{"ok":true}', inputTokens: 2_000, outputTokens: 35 });
  });

  it("one reading at the end (HTTP engines, Codex exec) is used as is", async () => {
    const a = await run([
      { type: "text.delta", text: "ok" },
      { type: "usage", inputTokens: 321, outputTokens: 4 },
      { type: "done", stop: "end_turn" },
    ]);
    expect(a.inputTokens).toBe(321);
    expect(a.outputTokens).toBe(4);
  });

  it("no reading, or a reading of 0, is estimated from the text — never booked as 0", async () => {
    const prompt = "x".repeat(400);
    const none = await run(
      [
        { type: "text.delta", text: "abcd" },
        { type: "done", stop: "end_turn" },
      ],
      prompt,
    );
    expect(none).toEqual({ text: "abcd", inputTokens: 200, outputTokens: 2 });
    const zero = await run(
      [
        { type: "usage", inputTokens: 0, outputTokens: 0 },
        { type: "done", stop: "interrupted" },
      ],
      prompt,
    );
    expect(zero.inputTokens).toBe(200);
    expect(zero.outputTokens).toBe(0);
  });
});
