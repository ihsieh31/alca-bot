import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCodexArgs,
  CodexEngine,
  CodexStreamParser,
  type EngineEvent,
  type EngineLaunchConfig,
  FAKE_CODEX_SCRIPT,
  type HostToolCallRequest,
} from "../src/index.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function setup(o: { command?: string[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "alca-codex-test-"));
  const log = join(dir, "launches.ndjson");
  const sessions = new Map<string, string>();
  const cfg: EngineLaunchConfig = {
    engineId: "codex",
    cwd: dir,
    stablePrompt: "穩定層：你是 Alca。",
    env: {},
    approvalMode: "default",
    model: "gpt-5-codex",
  };
  const engine = new CodexEngine({
    command: o.command ?? [process.execPath, "--disable-warning=ExperimentalWarning", FAKE_CODEX_SCRIPT],
    launch: () => cfg,
    sessions: { get: (k) => sessions.get(k), set: (k, s) => void sessions.set(k, s) },
    baseEnv: { FAKE_CODEX_LOG: log },
    interruptGraceMs: 1000,
  });
  cleanups.push(
    () => engine.dispose(),
    () => rmSync(dir, { recursive: true, force: true }),
  );
  const launches = () =>
    readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { args: string[]; prompt: string });
  return { engine, sessions, launches };
}

async function turn(
  engine: CodexEngine,
  text: string,
  o: {
    signal?: AbortSignal;
    onToolCall?: (r: HostToolCallRequest) => Promise<{ ok: boolean; output: string }>;
    tools?: boolean;
  } = {},
) {
  const events: EngineEvent[] = [];
  for await (const e of engine.turn({
    threadId: "t1",
    runId: "r1",
    system: { stable: "穩定層：你是 Alca。", volatile: "現在：週二" },
    userMessage: text,
    signal: o.signal ?? new AbortController().signal,
    ...(o.tools
      ? {
          tools: [
            {
              name: "draft_save",
              description: "存一份草稿",
              inputSchema: { type: "object", properties: { text: { type: "string" } } },
            },
          ],
        }
      : {}),
    ...(o.onToolCall ? { onToolCall: o.onToolCall } : {}),
  }))
    events.push(e);
  return events;
}

const textOf = (ev: EngineEvent[]) => ev.flatMap((e) => (e.type === "text.delta" ? [e.text] : [])).join("");

describe("CodexEngine (fake CLI)", () => {
  it("builds a read-only, no-approval exec command, resuming by session id", () => {
    const cfg: EngineLaunchConfig = {
      engineId: "codex",
      cwd: "/w",
      stablePrompt: "",
      env: {},
      approvalMode: "default",
    };
    const a = buildCodexArgs(cfg, {
      resumeSessionId: "abc",
      hostTools: { command: "/node", args: ["tools.ts"], env: { ALCA_BRIDGE_FILE: "/tmp/b.json" } },
    });
    expect(a.slice(0, 7)).toEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "-C",
      "/w",
      "--sandbox",
      "read-only",
    ]);
    expect(a).toContain('approval_policy="never"');
    expect(a).toContain('mcp_servers.alcatools.env={ALCA_BRIDGE_FILE = "/tmp/b.json"}');
    expect(a.slice(-3)).toEqual(["resume", "abc", "-"]);
  });

  it("maps the JSONL stream: session, text, a shell item, usage, done; then resumes", async () => {
    const { engine, sessions, launches } = setup();
    const ev = await turn(engine, "幫我看一下 [shell:ls -la]");
    expect(ev[0]).toMatchObject({ type: "session" });
    expect(ev.find((e) => e.type === "tool.call")).toMatchObject({
      name: "shell",
      input: { command: "ls -la" },
    });
    expect(ev.find((e) => e.type === "tool.result")).toMatchObject({ ok: true, output: "ran ls -la" });
    expect(textOf(ev)).toBe("Codex 收到：幫我看一下 [shell:ls -la]");
    expect(ev.find((e) => e.type === "usage")).toMatchObject({
      inputTokens: 120,
      cachedInputTokens: 80,
      outputTokens: 12,
    });
    expect(ev.at(-1)).toEqual({ type: "done", stop: "end_turn" });
    const id = sessions.get("t1");
    expect(id).toBeTruthy();
    // The stable layer is given once, at the top of the conversation's first message.
    expect(launches()[0]?.prompt).toContain("<alca:instructions>");
    expect(launches()[0]?.args).toContain("gpt-5-codex");

    const ev2 = await turn(engine, "第二句");
    expect(textOf(ev2)).toContain(`（接續 ${String(id).slice(0, 8)}）`);
    expect(launches()[1]?.args.slice(-3)).toEqual(["resume", id, "-"]);
    expect(launches()[1]?.prompt).not.toContain("<alca:instructions>");
    expect(launches()[1]?.prompt).toContain("現在：週二");
  });

  it("host tools go over MCP to onToolCall (the gateway), never with the token on the command line", async () => {
    const { engine, launches } = setup();
    const calls: HostToolCallRequest[] = [];
    const ev = await turn(engine, '存起來 [mcp:draft_save {"text":"週會草稿"}]', {
      tools: true,
      onToolCall: async (r) => {
        calls.push(r);
        return { ok: true, output: "已存草稿" };
      },
    });
    expect(calls).toEqual([{ toolName: "draft_save", input: { text: "週會草稿" } }]);
    expect(ev.find((e) => e.type === "tool.call")).toMatchObject({ name: "draft_save" });
    expect(ev.find((e) => e.type === "tool.result")).toMatchObject({ ok: true, output: "已存草稿" });
    const args = launches()[0]?.args.join(" ") ?? "";
    expect(args).toContain("ALCA_BRIDGE_FILE");
    expect(args).not.toMatch(/[0-9a-f]{64}/); // the bridge token is in a 0600 file, not argv
  });

  it("without onToolCall a host tool call fails closed", async () => {
    const { engine } = setup();
    const ev = await turn(engine, '[mcp:draft_save {"text":"x"}]', { tools: true });
    expect(ev.find((e) => e.type === "tool.result")).toMatchObject({ ok: false });
  });

  it("interrupts a running turn", async () => {
    const { engine } = setup();
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 300);
    const t = Date.now();
    const ev = await turn(engine, "[slow] 慢慢來", { signal: ctrl.signal });
    expect(ev.at(-1)).toEqual({ type: "done", stop: "interrupted" });
    expect(Date.now() - t).toBeLessThan(4000);
  });

  it("a crash is a retryable error; a failed turn and a missing CLI are reported", async () => {
    const { engine } = setup();
    const crash = await turn(engine, "[crash]");
    expect(crash.find((e) => e.type === "error")).toMatchObject({ code: "engine.crashed", retryable: true });
    expect(crash.at(-1)).toEqual({ type: "done", stop: "error" });
    const failed = await turn(engine, "[fail]");
    expect(failed.find((e) => e.type === "error")).toMatchObject({ message: "模擬失敗" });
    const missing = setup({ command: ["/nonexistent/codex"] });
    const ev = await turn(missing.engine, "嗨");
    expect(ev.find((e) => e.type === "error")).toMatchObject({ code: "engine.not_found", retryable: false });
  });

  it("parser: text updates become deltas once; unknown lines are ignored", () => {
    const p = new CodexStreamParser();
    const a = p.push({ type: "item.updated", item: { id: "m", type: "agent_message", text: "你好" } });
    const b = p.push({ type: "item.completed", item: { id: "m", type: "agent_message", text: "你好世界" } });
    expect([...a, ...b]).toEqual([
      { type: "text.delta", text: "你好" },
      { type: "text.delta", text: "世界" },
      { type: "text.end" },
    ]);
    expect(p.push({ type: "something.new" })).toEqual([]);
  });
});
