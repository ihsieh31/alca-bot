import { OpenAICompatEngine } from "@alca/engines";
import { type MockLlm, startMockLlm } from "@alca/engines/testing";
import { afterEach, describe, expect, it } from "vitest";
import { isType, makeCore, tool, waitFor } from "./helpers.ts";

let mock: MockLlm | undefined;
afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

describe("core × OpenAI-compatible engine (mock server)", () => {
  it("streams the answer; a send tool call from the model stops at the card and runs once after 允許", async () => {
    let n = 0;
    mock = await startMockLlm((r) => {
      n++;
      const msgs = r.body.messages as Array<{ role: string; content: string }>;
      if (n === 1)
        return {
          text: "好，我寄給老闆。",
          toolCalls: [{ name: "send_mail", args: { to: "boss@example.com" } }],
        };
      return { text: `寄出結果：${msgs.at(-1)?.content}` };
    });
    const engine = new OpenAICompatEngine({ id: "eng_mock", baseUrl: mock.openaiBase, model: "m" });
    const send = tool("send_mail", "send", (a) => `已寄給 ${String(a.to)}`);
    const { core, events } = makeCore(engine, { tools: [send], level: "autonomous" });
    const t = core.createThread();
    const { done } = core.send(t.id, "寄信給老闆說我晚到");
    const card = await waitFor(events, isType("approval.requested"));
    expect(card.data.actionClass).toBe("send");
    expect(send.calls).toHaveLength(0);
    core.answerApproval(card.data.approvalId, "approved");
    expect(await done).toBe("completed");
    expect(send.calls).toEqual([{ to: "boss@example.com" }]);
    const texts = core
      .messages(t.id)
      .filter((m) => m.role === "assistant")
      .map((m) => m.content);
    expect(texts).toEqual(["好，我寄給老闆。", "寄出結果：已寄給 boss@example.com"]);
    expect(events.filter((e) => e.type === "message.delta").length).toBeGreaterThan(3);
    const fin = events.filter(isType("run.finished")).at(-1);
    expect(fin?.data.usage?.inputTokens).toBeGreaterThan(0);
  });
});
