import { ScriptedEngine } from "@alca/engines";
import { describe, expect, it } from "vitest";
import { ROUTER_NATIVE_TOOL } from "../src/phases/infer.ts";
import { isType, makeCore, tool } from "./helpers.ts";

/** P13: a router turn never runs an engine-native tool that can change something. */
describe("router turn × native tools", () => {
  const owning = (steps: ConstructorParameters<typeof ScriptedEngine>[0], readOnly = false) =>
    new ScriptedEngine(steps, {
      capabilities: {
        ownsToolLoop: true,
        permissionPrompt: "mcp_tool",
        ...(readOnly ? { nativeToolsReadOnly: true } : {}),
      },
    });
  const routerRun = (core: ReturnType<typeof makeCore>["core"], engine: ScriptedEngine) => {
    const t = core.createThread("x");
    return core.launch({
      threadId: t.id,
      text: "hi",
      role: "router",
      engine,
      tools: [tool("worker_start", "read")],
      track: true,
    });
  };

  it("a native edit that ran without asking stops the turn with an error", async () => {
    const engine = owning([
      [
        { type: "tool.call", id: "n1", name: "Edit", input: { file_path: "/tmp/x", kind: "edit" } },
        { type: "tool.result", id: "n1", ok: true, output: "edited" },
        { type: "text.delta", text: "改好了" },
        { type: "done", stop: "end_turn" },
      ],
    ]);
    const { core, events } = makeCore(engine);
    const end = await routerRun(core, engine).done;
    expect(end.finish).toMatchObject({ reason: "failed", error: { code: ROUTER_NATIVE_TOOL } });
    expect(events.find(isType("error"))?.data.code).toBe(ROUTER_NATIVE_TOOL);
  });

  it("an ACP shell call (kind execute) without a permission request counts too; a read does not", async () => {
    const shell = owning([
      [
        { type: "tool.call", id: "s1", name: "curl -X POST https://x.test", input: { kind: "execute" } },
        { type: "tool.result", id: "s1", ok: true, output: "" },
        { type: "done", stop: "end_turn" },
      ],
    ]);
    expect((await routerRun(makeCore(shell).core, shell).done).finish?.reason).toBe("failed");
    const read = owning([
      [
        { type: "tool.call", id: "r1", name: "Read notes.md", input: { kind: "read" } },
        { type: "tool.result", id: "r1", ok: true, output: "notes" },
        { type: "done", stop: "end_turn" },
      ],
    ]);
    expect((await routerRun(makeCore(read).core, read).done).finish?.reason).toBe("completed");
  });

  it("a native call that asked (and was refused) is not a breach; a read-only sandbox is trusted", async () => {
    const asked = owning([
      [
        { type: "permission", call: { id: "p1", name: "Bash", input: { command: "rm -rf /" } } },
        { type: "done", stop: "end_turn" },
      ],
    ]);
    const { core } = makeCore(asked);
    expect((await routerRun(core, asked).done).finish?.reason).toBe("completed");
    expect(asked.permissionAnswers[0]).toMatchObject({ behavior: "deny" });
    const sandboxed = owning(
      [
        [
          { type: "tool.call", id: "c1", name: "shell", input: { command: "ls" } },
          { type: "tool.result", id: "c1", ok: true, output: "a b" },
          { type: "done", stop: "end_turn" },
        ],
      ],
      true,
    );
    expect((await routerRun(makeCore(sandboxed).core, sandboxed).done).finish?.reason).toBe("completed");
  });

  it("ToolSearch (Claude Code ≥ 2.1 loading its deferred MCP tools) is not the router acting", async () => {
    const engine = owning([
      [
        {
          type: "tool.call",
          id: "t1",
          name: "ToolSearch",
          input: { query: "select:mcp__alcatools__worker_start" },
        },
        { type: "tool.result", id: "t1", ok: true, output: "loaded" },
        { type: "text.delta", text: "好" },
        { type: "done", stop: "end_turn" },
      ],
    ]);
    expect((await routerRun(makeCore(engine).core, engine).done).finish?.reason).toBe("completed");
  });
});
