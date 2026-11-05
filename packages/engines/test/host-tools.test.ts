import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ClaudeCodeEngine,
  type ClaudeCodeEngineOptions,
  type EngineEvent,
  FAKE_CLAUDE_SCRIPT,
  HOST_TOOL_PREFIX,
  type HostToolCallRequest,
  hostToolName,
  PermissionBridge,
  type PermissionRequest,
  type ToolSpec,
} from "../src/index.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const ECHO: ToolSpec = {
  name: "echo_tool",
  description: "echo",
  inputSchema: { type: "object", properties: { x: { type: "integer" } } },
};
const OTHER: ToolSpec = { name: "other_tool", description: "other", inputSchema: { type: "object" } };

function setup(over: Partial<ClaudeCodeEngineOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "alca-cc-tools-"));
  const log = join(dir, "launches.ndjson");
  const engine = new ClaudeCodeEngine({
    command: [process.execPath, "--disable-warning=ExperimentalWarning", FAKE_CLAUDE_SCRIPT],
    launch: () => ({
      engineId: "claude-code",
      cwd: dir,
      stablePrompt: "穩定層",
      env: {},
      approvalMode: "default",
    }),
    sessions: { get: () => undefined, set: () => undefined },
    baseEnv: { FAKE_CLAUDE_LOG: log },
    ...over,
  });
  cleanups.push(
    () => engine.dispose(),
    () => rmSync(dir, { recursive: true, force: true }),
  );
  const launches = () =>
    readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { args: string[] });
  return { engine, launches };
}

async function turn(
  engine: ClaudeCodeEngine,
  text: string,
  o: {
    tools?: ToolSpec[];
    onToolCall?: (r: HostToolCallRequest) => Promise<{ ok: boolean; output: string }>;
    onPermission?: (
      r: PermissionRequest,
    ) => Promise<{ behavior: "allow" } | { behavior: "deny"; message: string }>;
  } = {},
) {
  const events: EngineEvent[] = [];
  for await (const e of engine.turn({
    threadId: "thr",
    runId: "run",
    system: { stable: "穩定層", volatile: "" },
    userMessage: text,
    signal: new AbortController().signal,
    ...(o.tools ? { tools: o.tools } : {}),
    ...(o.onToolCall ? { onToolCall: o.onToolCall } : {}),
    ...(o.onPermission ? { onPermission: o.onPermission } : {}),
  }))
    events.push(e);
  return events;
}

describe("host tools over MCP (fake CLI)", () => {
  it("maps names both ways", () => {
    expect(hostToolName(`${HOST_TOOL_PREFIX}browser_click`)).toBe("browser_click");
    expect(hostToolName("mcp__other__browser_click")).toBeUndefined();
    expect(hostToolName("Bash")).toBeUndefined();
  });

  it("exposes the turn's tools as mcp__alcatools__*, routes calls to onToolCall, reports bare names", async () => {
    const { engine, launches } = setup();
    const calls: HostToolCallRequest[] = [];
    const perms: PermissionRequest[] = [];
    const events = await turn(engine, '[mcp:echo_tool {"x":1}]', {
      tools: [ECHO],
      onToolCall: async (c) => {
        calls.push(c);
        return { ok: true, output: `echo ${JSON.stringify(c.input)}` };
      },
      onPermission: async (p) => {
        perms.push(p);
        return { behavior: "allow" };
      },
    });
    expect(calls).toEqual([{ toolName: "echo_tool", input: { x: 1 } }]);
    // --allowedTools covers the host tools: the gate is in the host, not a CLI prompt.
    expect(perms).toEqual([]);
    const call = events.find((e) => e.type === "tool.call");
    expect(call).toMatchObject({ name: "echo_tool", input: { x: 1 } });
    expect(events.find((e) => e.type === "tool.result")).toMatchObject({ ok: true, output: 'echo {"x":1}' });
    const args = launches()[0]!.args;
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("mcp__alcatools");
    const cfg = JSON.parse(args[args.indexOf("--mcp-config") + 1]!) as {
      mcpServers: Record<string, { env: Record<string, string> }>;
    };
    expect(Object.keys(cfg.mcpServers).sort()).toEqual(["alca", "alcatools"]);
    // The tool list travels in a private file, not on the command line.
    const file = cfg.mcpServers.alcatools!.env.ALCA_TOOLS_FILE!;
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([ECHO]);
  });

  it("a permission prompt for a host tool (if the CLI asks anyway) carries the bare name and hostTool", async () => {
    const { engine } = setup({ baseEnv: { FAKE_CLAUDE_ASK_HOST_TOOLS: "1" } });
    const perms: PermissionRequest[] = [];
    const events = await turn(engine, '[mcp:echo_tool {"x":3}]', {
      tools: [ECHO],
      onToolCall: async () => ({ ok: true, output: "ran" }),
      onPermission: async (p) => {
        perms.push(p);
        return { behavior: "deny", message: "no" };
      },
    });
    expect(perms).toMatchObject([{ toolName: "echo_tool", hostTool: true, input: { x: 3 } }]);
    expect(events.find((e) => e.type === "tool.result")).toMatchObject({ ok: false, output: "no" });
  });

  it("fails closed: no onToolCall, or a tool that is not in this turn's list", async () => {
    const { engine } = setup();
    const a = await turn(engine, '[mcp:echo_tool {"x":2}]', { tools: [ECHO] });
    expect(a.find((e) => e.type === "tool.result")).toMatchObject({ ok: false });
    const b = await turn(engine, "[mcp:nope_tool {}]", {
      tools: [ECHO],
      onToolCall: async () => ({ ok: true, output: "should not run" }),
    });
    expect(b.find((e) => e.type === "tool.result")).toMatchObject({ ok: false });
  });

  it("restarts the process when the tool list changes, not otherwise", async () => {
    const { engine, launches } = setup();
    const ok = async () => ({ ok: true, output: "ok" });
    await turn(engine, "嗨", { tools: [ECHO], onToolCall: ok });
    await turn(engine, "嗨", { tools: [ECHO], onToolCall: ok });
    expect(launches()).toHaveLength(1);
    await turn(engine, "[mcp:other_tool {}]", { tools: [ECHO, OTHER], onToolCall: ok });
    expect(launches()).toHaveLength(2);
  });

  it("hostTools: false keeps the CLI to the permission server only", async () => {
    const { engine, launches } = setup({ hostTools: false });
    const events = await turn(engine, '[mcp:echo_tool {"x":1}]', {
      tools: [ECHO],
      onToolCall: async () => ({ ok: true, output: "should not run" }),
    });
    expect(events.find((e) => e.type === "tool.result")).toMatchObject({ ok: false });
    expect(launches()[0]!.args).not.toContain("--allowedTools");
  });
});

describe("bridge /tool", () => {
  it("needs the token and an active turn; handler errors become failed calls", async () => {
    const bridge = new PermissionBridge();
    cleanups.push(() => bridge.stop());
    const url = new URL("/tool", await bridge.start());
    const post = async (body: unknown, token = bridge.token) =>
      (await (
        await fetch(url, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      ).json()) as { ok: boolean; output: string };
    expect((await post({ threadId: "t", toolName: "x", input: {} }, "wrong")).ok).toBe(false);
    expect((await post({ threadId: "t", toolName: "x", input: {} })).ok).toBe(false);
    bridge.registerTools("t", async (c) => ({ ok: true, output: c.toolName }));
    expect(await post({ threadId: "t", toolName: "x", input: {} })).toEqual({ ok: true, output: "x" });
    bridge.registerTools("t", async () => {
      throw new Error("boom");
    });
    expect((await post({ threadId: "t", toolName: "x", input: {} })).ok).toBe(false);
  });
});
