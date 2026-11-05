// A fake Agent Client Protocol agent for tests (P11), written from the
// public ACP spec: JSON-RPC 2.0, one JSON object per line on stdio. It
// answers initialize / session/new / session/load / session/set_mode /
// session/set_model / session/prompt / session/cancel, and its prompts act
// on keywords in the prompt text:
//   PERMISSION  a tool call that asks session/request_permission first
//   HOSTTOOL    calls the host tool `note_add` through the MCP server it was given
//   SLOW        streams until session/cancel arrives (stopReason "cancelled")
//   WRITEFILE:name=text  a native `edit` tool call on <cwd>/name: asks
//               session/request_permission first unless the session is in
//               `auto_edit` / `yolo` mode (then it writes unasked, as a real
//               agent in an auto mode does); writes the file when allowed
//   RUNCMD:cmd  a native `execute` tool call, asking first (same modes)
//   anything else: echoes "echo:" and the last line, in chunks
// FAKE_ACP_AUTH=1 makes session/new fail with auth_required (-32000).
// FAKE_ACP_SET_MODE_FAIL=1 makes session/set_mode fail (strict-mode tests).
// Every message it receives is appended to $FAKE_ACP_LOG (JSONL), if set.
// FAKE_ACP_PROBE_WRITE=a,b tries to write each file at start and logs {probe, ok, sandbox} (next round §5.5).
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";

type Json = Record<string, unknown>;
const log = (m: unknown) => {
  if (process.env.FAKE_ACP_LOG) appendFileSync(process.env.FAKE_ACP_LOG, `${JSON.stringify(m)}\n`);
};
for (const f of (process.env.FAKE_ACP_PROBE_WRITE ?? "").split(",").filter(Boolean)) {
  let ok = true;
  try {
    writeFileSync(f, "probe");
  } catch {
    ok = false;
  }
  log({ probe: f, ok, sandbox: process.env.ALCA_SANDBOX ?? null });
}
const send = (m: Json) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
let nextId = 1000;
const waiting = new Map<number, (r: Json) => void>();
const ask = (method: string, params: Json) =>
  new Promise<Json>((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    send({ id, method, params });
  });
const update = (sessionId: string, u: Json) =>
  send({ method: "session/update", params: { sessionId, update: u } });
const chunk = (sessionId: string, text: string) =>
  update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });

const sessions = new Map<string, { mcp: Json[]; cwd: string; mode: string }>();
let cancelled = new Set<string>();
let n = 0;

async function callHostTool(sessionId: string, name: string, args: Json): Promise<string> {
  const server = sessions.get(sessionId)?.mcp[0] as
    | { command: string; args: string[]; env: Array<{ name: string; value: string }> }
    | undefined;
  if (!server) return "no mcp server";
  const env = { ...process.env, ...Object.fromEntries(server.env.map((e) => [e.name, e.value])) };
  const child: ChildProcessWithoutNullStreams = spawn(server.command, server.args, { env, stdio: "pipe" });
  const rl = createInterface({ input: child.stdout });
  const replies = new Map<number, (m: Json) => void>();
  rl.on("line", (l) => {
    try {
      const m = JSON.parse(l) as Json;
      replies.get(m.id as number)?.(m);
    } catch {}
  });
  const rpc = (id: number, method: string, params: Json) =>
    new Promise<Json>((resolve) => {
      replies.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  await rpc(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "fake-acp" },
  });
  const list = (await rpc(2, "tools/list", {})) as { result?: { tools?: Array<{ name: string }> } };
  const names = (list.result?.tools ?? []).map((t) => t.name);
  const r = (await rpc(3, "tools/call", { name, arguments: args })) as {
    result?: { content?: Array<{ text?: string }>; isError?: boolean };
  };
  child.kill();
  return `${names.join(",")}|${r.result?.isError ? "error" : "ok"}|${r.result?.content?.[0]?.text ?? ""}`;
}

/** A native tool call that asks first unless the session is in an auto mode; `act` runs when allowed. */
async function native(
  sessionId: string,
  kind: string,
  title: string,
  rawInput: Json,
  locations: Json[],
  act: () => string,
): Promise<boolean> {
  const s = sessions.get(sessionId);
  const auto = s?.mode === "auto_edit" || s?.mode === "yolo";
  const toolCallId = `tc_${++n}`;
  const toolCall = { toolCallId, title, kind, status: "pending", rawInput, locations };
  update(sessionId, { sessionUpdate: "tool_call", ...toolCall });
  let ok = true;
  if (!auto) {
    const r = await ask("session/request_permission", {
      sessionId,
      toolCall,
      options: [
        { optionId: "yes", name: "Allow", kind: "allow_once" },
        { optionId: "no", name: "Reject", kind: "reject_once" },
      ],
    });
    const outcome = (r.result as { outcome?: { outcome?: string; optionId?: string } } | undefined)?.outcome;
    ok = outcome?.outcome === "selected" && outcome.optionId === "yes";
  }
  if (ok) update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "in_progress" });
  const out = ok ? act() : "denied";
  update(sessionId, {
    sessionUpdate: "tool_call_update",
    toolCallId,
    status: ok ? "completed" : "failed",
    content: [{ type: "content", content: { type: "text", text: out } }],
  });
  return ok;
}

async function prompt(p: Json): Promise<Json> {
  const sessionId = String(p.sessionId);
  const blocks = (p.prompt ?? []) as Array<{ type: string; text?: string }>;
  const text = blocks.map((b) => b.text ?? "").join("\n");
  const wf = /WRITEFILE:([^=\s]+)=(\S*)/.exec(text);
  if (wf) {
    const cwd = sessions.get(sessionId)?.cwd || process.cwd();
    const name = wf[1] as string;
    const path = isAbsolute(name) ? name : join(cwd, name);
    const ok = await native(sessionId, "edit", `Write ${name}`, { path, content: wf[2] }, [{ path }], () => {
      writeFileSync(path, wf[2] as string);
      return `wrote ${path}`;
    });
    chunk(sessionId, ok ? "寫好了。" : "沒寫。");
    return { stopReason: "end_turn" };
  }
  const rc = /RUNCMD:(.+)$/m.exec(text);
  if (rc) {
    const cmd = (rc[1] as string).trim();
    const ok = await native(sessionId, "execute", cmd, { command: cmd }, [], () => `ran: ${cmd}`);
    chunk(sessionId, ok ? "跑完了。" : "沒跑。");
    return { stopReason: "end_turn" };
  }
  if (text.includes("SLOW")) {
    for (let i = 0; i < 100; i++) {
      if (cancelled.has(sessionId)) {
        cancelled = new Set([...cancelled].filter((s) => s !== sessionId));
        return { stopReason: "cancelled" };
      }
      chunk(sessionId, `·${i}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    return { stopReason: "end_turn" };
  }
  if (text.includes("PERMISSION")) {
    chunk(sessionId, "我要寫檔。");
    const toolCall = {
      toolCallId: "tc_1",
      title: "Write notes.txt",
      kind: "edit",
      status: "pending",
      rawInput: { path: "notes.txt" },
      // ACP locations: the files the call touches (the host snapshots them before an edit, P13).
      locations: [{ path: "/work/notes.txt", line: 3 }, { path: "" }, { line: 1 }, { path: "/work/b.md" }],
    };
    update(sessionId, { sessionUpdate: "tool_call", ...toolCall });
    const r = await ask("session/request_permission", {
      sessionId,
      toolCall,
      options: [
        { optionId: "yes", name: "Allow", kind: "allow_once" },
        { optionId: "always", name: "Always", kind: "allow_always" },
        { optionId: "no", name: "Reject", kind: "reject_once" },
      ],
    });
    const outcome = (r.result as { outcome?: { outcome?: string; optionId?: string } } | undefined)?.outcome;
    const ok = outcome?.outcome === "selected" && outcome.optionId === "yes";
    update(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: "tc_1",
      status: ok ? "completed" : "failed",
      content: [{ type: "content", content: { type: "text", text: ok ? "wrote notes.txt" : "denied" } }],
    });
    chunk(sessionId, ok ? "寫好了。" : `沒寫（${outcome?.outcome ?? "?"}）。`);
    return { stopReason: "end_turn" };
  }
  if (text.includes("HOSTTOOL")) {
    update(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: "tc_h",
      title: "alcatools/note_add",
      kind: "other",
      status: "in_progress",
    });
    const out = await callHostTool(sessionId, "note_add", { text: "hi" });
    update(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: "tc_h",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: out } }],
    });
    chunk(sessionId, `host:${out}`);
    return { stopReason: "end_turn" };
  }
  const last = text.trim().split("\n").at(-1) ?? "";
  for (const piece of ["echo:", " ", last.slice(0, 20), last.slice(20, 60)])
    if (piece) chunk(sessionId, piece);
  return { stopReason: "end_turn" };
}

async function handle(m: Json): Promise<unknown> {
  const p = (m.params ?? {}) as Json;
  switch (m.method) {
    case "initialize":
      return {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, promptCapabilities: { image: false } },
        authMethods: [{ id: "login", name: "Log in" }],
      };
    case "session/new": {
      if (process.env.FAKE_ACP_AUTH === "1") throw { code: -32000, message: "Authentication required" };
      const sessionId = `sess_${process.pid}_${++n}`;
      sessions.set(sessionId, {
        mcp: (p.mcpServers ?? []) as Json[],
        cwd: String(p.cwd ?? ""),
        mode: "default",
      });
      return {
        sessionId,
        modes: {
          currentModeId: "default",
          availableModes: [{ id: "default" }, { id: "auto_edit" }, { id: "yolo" }],
        },
        models: {
          currentModelId: "m-small",
          availableModels: [{ modelId: "m-small" }, { modelId: "m-large" }],
        },
      };
    }
    case "session/load":
      sessions.set(String(p.sessionId), {
        mcp: (p.mcpServers ?? []) as Json[],
        cwd: String(p.cwd ?? ""),
        mode: "default",
      });
      return {};
    case "session/set_mode": {
      if (process.env.FAKE_ACP_SET_MODE_FAIL === "1") throw { code: -32603, message: "cannot switch mode" };
      const s = sessions.get(String(p.sessionId));
      if (s) s.mode = String(p.modeId);
      return {};
    }
    case "session/set_model":
      return {};
    case "session/prompt":
      return await prompt(p);
    default:
      throw { code: -32601, message: `method not found: ${String(m.method)}` };
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  let m: Json;
  try {
    m = JSON.parse(line) as Json;
  } catch {
    return;
  }
  log(m);
  if (m.method === undefined && typeof m.id === "number") {
    waiting.get(m.id)?.(m);
    waiting.delete(m.id);
    return;
  }
  if (m.method === "session/cancel") {
    cancelled.add(String((m.params as Json)?.sessionId));
    return;
  }
  if (m.id === undefined) return;
  void handle(m).then(
    (result) => send({ id: m.id as number, result: result ?? null }),
    (e: { code?: number; message?: string }) =>
      send({ id: m.id as number, error: { code: e.code ?? -32603, message: e.message ?? String(e) } }),
  );
});
