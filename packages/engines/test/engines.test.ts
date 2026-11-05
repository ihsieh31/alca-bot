import { describe, expect, it } from "vitest";
import {
  buildClaudeArgs,
  CLAUDE_BACKGROUND_TOOLS,
  ClaudeStreamParser,
  composeClaudeUserText,
  type EngineEvent,
  type EngineLaunchConfig,
  launchConfigHash,
  PERMISSION_TOOL,
  ScriptedEngine,
  streamText,
} from "../src/index.ts";

const base: EngineLaunchConfig = {
  engineId: "claude-code",
  cwd: "/tmp/w",
  stablePrompt: "你是 Alca。",
  env: { B: "2", A: "1" },
  approvalMode: "default",
};

async function collect(it: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const out: EngineEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const req = (over: Partial<Parameters<ScriptedEngine["turn"]>[0]> = {}) => ({
  threadId: "t",
  runId: "r",
  system: { stable: "S", volatile: "V" },
  userMessage: "hi",
  signal: new AbortController().signal,
  ...over,
});

describe("launchConfigHash", () => {
  it("is stable under env key order and changes when restart-relevant fields change", () => {
    expect(launchConfigHash(base)).toBe(launchConfigHash({ ...base, env: { A: "1", B: "2" } }));
    expect(launchConfigHash(base)).not.toBe(launchConfigHash({ ...base, model: "x" }));
    expect(launchConfigHash(base)).not.toBe(launchConfigHash({ ...base, stablePrompt: "changed" }));
    expect(launchConfigHash(base)).not.toBe(launchConfigHash({ ...base, extraArgs: ["--bare"] }));
  });
});

describe("claude args", () => {
  it("launches stream-json in and out, permission tool, resume", () => {
    const a = buildClaudeArgs(
      { ...base, model: "sonnet" },
      { resumeSessionId: "s-1", permissionServer: { command: "node", args: ["p.ts"], env: { X: "1" } } },
    );
    expect(a.slice(0, 7)).toEqual([
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
    ]);
    expect(a).toContain(PERMISSION_TOOL);
    expect(a[a.indexOf("--resume") + 1]).toBe("s-1");
    expect(a[a.indexOf("--append-system-prompt") + 1]).toBe("你是 Alca。");
    expect(JSON.parse(a[a.indexOf("--mcp-config") + 1] as string).mcpServers.alca.command).toBe("node");
  });

  it("removes the scheduling / sub-agent tools on every launch, folded into one --disallowedTools (mac test 2026-11-04b A8)", () => {
    const plain = buildClaudeArgs(base, {});
    expect(plain.filter((x) => x === "--disallowedTools")).toHaveLength(1);
    const off = (a: string[]) => a[a.indexOf("--disallowedTools") + 1]!.split(",");
    for (const n of CLAUDE_BACKGROUND_TOOLS) expect(off(plain)).toContain(n);
    const router = buildClaudeArgs(
      { ...base, extraArgs: ["--tools", "AskUserQuestion", "--disallowedTools", "Bash,Read"] },
      {},
    );
    expect(router.filter((x) => x === "--disallowedTools")).toHaveLength(1);
    expect(off(router)).toEqual(expect.arrayContaining(["Bash", "Read", "CronCreate", "Agent"]));
    expect(router[router.indexOf("--tools") + 1]).toBe("AskUserQuestion");
  });

  it("puts volatile context in the user message, never on the command line", () => {
    expect(
      composeClaudeUserText({ system: { stable: "S", volatile: "現在 10:00" }, userMessage: "嗨" }),
    ).toBe("現在 10:00\n\n嗨");
  });
});

describe("ClaudeStreamParser", () => {
  it("maps init, partial deltas, tool use, tool result and result", () => {
    const p = new ClaudeStreamParser();
    const lines: unknown[] = [
      { type: "system", subtype: "init", session_id: "s1", model: "m" },
      { type: "stream_event", event: { type: "message_start" }, parent_tool_use_id: null },
      {
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "你" } },
      },
      {
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "好" } },
      },
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "你好" },
            { type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } },
          ],
        },
      },
      {
        type: "assistant",
        parent_tool_use_id: "tu0",
        message: { content: [{ type: "text", text: "sub-agent noise" }] },
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu1",
              content: [{ type: "text", text: "a b" }],
              is_error: false,
            },
          ],
        },
      },
      { type: "assistant", message: { content: [{ type: "text", text: "完成" }] } },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "s1",
        usage: { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 10 },
      },
      { type: "something_new" },
    ];
    const events = lines.flatMap((l) => p.feed(l));
    expect(events).toEqual([
      { type: "session", sessionId: "s1", model: "m" },
      { type: "text.delta", text: "你" },
      { type: "text.delta", text: "好" },
      { type: "text.end" },
      { type: "tool.call", id: "tu1", name: "Bash", input: { command: "ls" } },
      { type: "tool.result", id: "tu1", ok: true, output: "a b" },
      { type: "text.delta", text: "完成" },
      { type: "text.end" },
      { type: "usage", inputTokens: 15, outputTokens: 3, cachedInputTokens: 10 },
      { type: "done", stop: "end_turn" },
    ]);
  });

  it("reports failed results and interrupts", () => {
    const p = new ClaudeStreamParser();
    expect(p.feed({ type: "result", subtype: "success", is_error: true, result: "Invalid API key" })).toEqual(
      [
        { type: "error", code: "claude.success", message: "Invalid API key", retryable: false },
        { type: "done", stop: "error" },
      ],
    );
    p.interrupted = true;
    expect(p.feed({ type: "result", subtype: "error_during_execution" }).at(-1)).toEqual({
      type: "done",
      stop: "interrupted",
    });
  });
});

describe("ScriptedEngine", () => {
  it("plays turns in order, records requests and adds done", async () => {
    const e = new ScriptedEngine([
      streamText("你好呀", 2),
      [
        { type: "tool.call", id: "c", name: "echo", input: {} },
        { type: "done", stop: "tool_use" },
      ],
    ]);
    const t1 = await collect(e.turn(req()));
    expect(t1.map((x) => x.type)).toEqual(["text.delta", "text.delta", "text.end", "done"]);
    const t2 = await collect(e.turn(req({ userMessage: "again" })));
    expect(t2.at(-1)).toEqual({ type: "done", stop: "tool_use" });
    expect(e.requests.map((r) => r.userMessage)).toEqual(["hi", "again"]);
    expect((await collect(e.turn(req()))).map((x) => x.type)).toEqual(["error", "done"]);
  });

  it("simulates permission prompts and interrupts", async () => {
    const e = new ScriptedEngine(() => [
      { type: "permission", call: { id: "p1", name: "Bash", input: { command: "rm x" } } },
      { type: "wait", ms: 5000 },
      { type: "text.delta", text: "never" },
    ]);
    const ac = new AbortController();
    const events: EngineEvent[] = [];
    for await (const ev of e.turn(
      req({ signal: ac.signal, onPermission: async () => ({ behavior: "deny", message: "不行" }) }),
    )) {
      events.push(ev);
      if (ev.type === "tool.result") void e.interrupt("t");
    }
    expect(events).toEqual([
      { type: "tool.call", id: "p1", name: "Bash", input: { command: "rm x" } },
      { type: "tool.result", id: "p1", ok: false, output: "不行" },
      { type: "done", stop: "interrupted" },
    ]);
  });
});
