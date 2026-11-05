// A fake `codex app-server` for tests (plan §3.3), written from the
// app-server protocol docs and v2 types in openai/codex (read 2026-11-04):
// JSON-RPC over stdio, one message per line, no "jsonrpc" member (this fake
// rejects a request that carries one). Handles initialize / initialized /
// thread/start / thread/resume / turn/start / turn/interrupt, and acts on
// directives in the turn text:
//   WRITE:name=content   a fileChange item for <cwd>/name; asks
//                        item/fileChange/requestApproval when the policy says
//                        so (untrusted: always; on-request / never: not inside
//                        the writable root); writes the file when accepted.
//                        In a read-only sandbox the patch is rejected unasked.
//   RUN:command          a commandExecution item; asks
//                        item/commandExecution/requestApproval under untrusted
//                        (except `ls` / `cat`), never under on-request / never.
//   HOSTTOOL:name {json} calls host tool `name` on the alcatools MCP server
//                        registered with root-level `-c mcp_servers.alcatools.*`.
//   SLOW                 streams deltas until turn/interrupt.
//   anything else        an agent message "echo: <last line>" in deltas.
// Every turn ends with thread/tokenUsage/updated (cumulative) and turn/completed.
// Env: FAKE_CODEX_AS_LOG (JSONL of every message received, plus {argv});
//      FAKE_CODEX_AS_BROKEN=1 exits at once (the probe fails);
//      FAKE_CODEX_AS_NO_INIT=1 answers initialize with an error;
//      FAKE_CODEX_AS_NO_UNTRUSTED=1 refuses approvalPolicy "untrusted" (Codex retired it, openai/codex#39630);
//      FAKE_CODEX_AS_NO_ON_REQUEST=1 refuses "on-request" too;
//      FAKE_CODEX_AS_SETUP_DELAY_MS delays a non-ephemeral thread/start (a turn mid-setup).
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";

type Json = Record<string, unknown>;
const argv = process.argv.slice(2);
const log = (m: unknown) => {
  if (process.env.FAKE_CODEX_AS_LOG) appendFileSync(process.env.FAKE_CODEX_AS_LOG, `${JSON.stringify(m)}\n`);
};
log({ argv, cwd: process.cwd() });
if (process.env.FAKE_CODEX_AS_BROKEN === "1") process.exit(2);
if (!argv.includes("app-server")) {
  process.stderr.write("fake codex: only `app-server` here\n");
  process.exit(2);
}

/** Root `-c key=value` overrides (mcp_servers.alcatools.*). */
const overrides = new Map<string, string>();
for (let i = 0; i < argv.length; i++)
  if (argv[i] === "-c") {
    const kv = argv[i + 1] ?? "";
    const at = kv.indexOf("=");
    overrides.set(kv.slice(0, at), kv.slice(at + 1));
    i++;
  }

const send = (m: Json) => process.stdout.write(`${JSON.stringify(m)}\n`);
const notify = (method: string, params: Json) => send({ method, params });
let nextId = 5000;
const waiting = new Map<number, (r: Json) => void>();
const ask = (method: string, params: Json) =>
  new Promise<Json>((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    send({ id, method, params });
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Thread {
  id: string;
  cwd: string;
  approvalPolicy: string;
  sandbox: string;
  instructions: string;
  usage: { input: number; cached: number; output: number };
}
const threads = new Map<string, Thread>();
let initialized = false;
let interrupted = new Set<string>();
let n = 0;

function tomlTable(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of raw.matchAll(/(\w+)\s*=\s*("(?:[^"\\]|\\.)*")/g))
    out[m[1] as string] = JSON.parse(m[2] as string) as string;
  return out;
}

async function callHostTool(name: string, args: Json): Promise<string> {
  const command = overrides.get("mcp_servers.alcatools.command");
  if (!command) return "no host tools server";
  const sargs = JSON.parse(overrides.get("mcp_servers.alcatools.args") ?? "[]") as string[];
  const env = { ...process.env, ...tomlTable(overrides.get("mcp_servers.alcatools.env") ?? "") };
  const child: ChildProcessWithoutNullStreams = spawn(JSON.parse(command) as string, sargs, {
    env,
    stdio: "pipe",
  });
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
    clientInfo: { name: "fake-codex" },
  });
  const r = (await rpc(3, "tools/call", { name, arguments: args })) as {
    result?: { content?: Array<{ text?: string }>; isError?: boolean };
  };
  child.kill();
  return `${r.result?.isError ? "error" : "ok"}|${r.result?.content?.[0]?.text ?? ""}`;
}

function agentMessage(t: Thread, turnId: string, text: string) {
  const itemId = `msg_${++n}`;
  notify("item/started", { threadId: t.id, turnId, item: { type: "agentMessage", id: itemId, text: "" } });
  const chars = [...text];
  for (let i = 0; i < chars.length; i += 4)
    notify("item/agentMessage/delta", {
      threadId: t.id,
      turnId,
      itemId,
      delta: chars.slice(i, i + 4).join(""),
    });
  notify("item/completed", { threadId: t.id, turnId, item: { type: "agentMessage", id: itemId, text } });
}

async function fileChange(t: Thread, turnId: string, name: string, content: string): Promise<string> {
  const path = isAbsolute(name) ? name : join(t.cwd, name);
  const itemId = `fc_${++n}`;
  const kind = existsSync(path) ? { type: "update", move_path: null } : { type: "add" };
  const item = {
    type: "fileChange",
    id: itemId,
    changes: [{ path, kind, diff: `+${content}` }],
    status: "inProgress",
  };
  notify("item/started", { threadId: t.id, turnId, item });
  let status = "completed";
  const inRoot = path.startsWith(t.cwd);
  if (t.sandbox === "read-only") status = "failed";
  else if (t.approvalPolicy === "untrusted" || !inRoot) {
    const r = await ask("item/fileChange/requestApproval", {
      threadId: t.id,
      turnId,
      itemId,
      startedAtMs: Date.now(),
      reason: null,
      grantRoot: inRoot ? null : path,
    });
    const decision = (r.result as { decision?: string } | undefined)?.decision;
    status = decision === "accept" || decision === "acceptForSession" ? "completed" : "declined";
  }
  if (status === "completed") writeFileSync(path, content);
  notify("item/completed", { threadId: t.id, turnId, item: { ...item, status } });
  return status;
}

async function command(t: Thread, turnId: string, cmd: string): Promise<string> {
  const itemId = `cmd_${++n}`;
  const item = {
    type: "commandExecution",
    id: itemId,
    command: cmd,
    cwd: t.cwd,
    processId: null,
    source: "agent",
    status: "inProgress",
    commandActions: [],
    aggregatedOutput: null,
    exitCode: null,
    durationMs: null,
  };
  notify("item/started", { threadId: t.id, turnId, item });
  const safe = /^(ls|cat)\b/.test(cmd);
  let status = "completed";
  if (t.approvalPolicy === "untrusted" && !safe) {
    const r = await ask("item/commandExecution/requestApproval", {
      threadId: t.id,
      turnId,
      itemId,
      startedAtMs: Date.now(),
      command: cmd,
      cwd: t.cwd,
    });
    const decision = (r.result as { decision?: string } | undefined)?.decision;
    status = decision === "accept" ? "completed" : "declined";
  }
  const writes = /[>]|\btouch\b/.test(cmd);
  if (status === "completed" && t.sandbox === "read-only" && writes) status = "failed";
  notify("item/completed", {
    threadId: t.id,
    turnId,
    item: {
      ...item,
      status,
      aggregatedOutput: status === "completed" ? `ran: ${cmd}` : "",
      exitCode: status === "completed" ? 0 : 1,
      durationMs: 3,
    },
  });
  return status;
}

async function runTurn(t: Thread, turnId: string, text: string) {
  notify("turn/started", {
    threadId: t.id,
    turn: { id: turnId, status: "inProgress", items: [], error: null },
  });
  const last = text.trim().split("\n").at(-1) ?? "";
  let status = "completed";
  const write = /WRITE:([^=\s]+)=(\S*)/.exec(text);
  const run = /RUN:(.+)$/m.exec(text);
  const host = /HOSTTOOL:(\w+)\s*(\{.*\})?/.exec(text);
  if (text.includes("SLOW")) {
    const itemId = `msg_${++n}`;
    for (let i = 0; i < 200; i++) {
      if (interrupted.has(turnId)) {
        status = "interrupted";
        break;
      }
      notify("item/agentMessage/delta", { threadId: t.id, turnId, itemId, delta: `·${i}` });
      await sleep(25);
    }
  } else if (write) {
    const s = await fileChange(t, turnId, write[1] as string, write[2] as string);
    agentMessage(t, turnId, s === "completed" ? "寫好了。" : `沒寫（${s}）。`);
  } else if (run) {
    const s = await command(t, turnId, (run[1] as string).trim());
    agentMessage(t, turnId, s === "completed" ? "跑完了。" : `沒跑（${s}）。`);
  } else if (host) {
    const itemId = `mcp_${++n}`;
    const args = JSON.parse(host[2] ?? "{}") as Json;
    const item = {
      type: "mcpToolCall",
      id: itemId,
      server: "alcatools",
      tool: host[1],
      status: "inProgress",
      arguments: args,
    };
    notify("item/started", { threadId: t.id, turnId, item });
    const out = await callHostTool(host[1] as string, args);
    notify("item/completed", {
      threadId: t.id,
      turnId,
      item: { ...item, status: "completed", result: { content: [{ type: "text", text: out }] }, error: null },
    });
    agentMessage(t, turnId, `host:${out}`);
  } else agentMessage(t, turnId, `echo: ${last}`);
  t.usage = { input: t.usage.input + 20, cached: t.usage.cached + 5, output: t.usage.output + 9 };
  const total = {
    totalTokens: t.usage.input + t.usage.output,
    inputTokens: t.usage.input,
    cachedInputTokens: t.usage.cached,
    cacheWriteInputTokens: 0,
    outputTokens: t.usage.output,
    reasoningOutputTokens: 0,
  };
  notify("thread/tokenUsage/updated", {
    threadId: t.id,
    turnId,
    tokenUsage: {
      total,
      last: { ...total, inputTokens: 20, cachedInputTokens: 5, outputTokens: 9 },
      modelContextWindow: 200000,
    },
  });
  notify("turn/completed", { threadId: t.id, turn: { id: turnId, status, items: [], error: null } });
  interrupted = new Set([...interrupted].filter((x) => x !== turnId));
}

function threadOf(p: Json, id: string): Thread {
  const t: Thread = {
    id,
    cwd: String(p.cwd ?? process.cwd()),
    approvalPolicy: String(p.approvalPolicy ?? "on-request"),
    sandbox: String(p.sandbox ?? "read-only"),
    instructions: String(p.developerInstructions ?? ""),
    usage: { input: 0, cached: 0, output: 0 },
  };
  threads.set(id, t);
  return t;
}

const threadResult = (t: Thread) => ({
  thread: { id: t.id, sessionId: t.id, ephemeral: false },
  model: "fake",
  modelProvider: "openai",
  cwd: t.cwd,
});

async function handle(m: Json): Promise<unknown> {
  const p = (m.params ?? {}) as Json;
  if (m.method === "initialize") {
    if (process.env.FAKE_CODEX_AS_NO_INIT === "1") throw { code: -32603, message: "broken" };
    if (initialized) throw { code: -32600, message: "Already initialized" };
    initialized = true;
    return { userAgent: "fake-codex/0.0.0", platformFamily: "unix", platformOs: process.platform };
  }
  if (!initialized) throw { code: -32600, message: "Not initialized" };
  // FAKE_CODEX_AS_SETUP_DELAY_MS: a turn's thread/start (not an ephemeral probe) answers this late.
  const delay = Number(process.env.FAKE_CODEX_AS_SETUP_DELAY_MS ?? 0);
  if (delay > 0 && m.method === "thread/start" && p.ephemeral !== true)
    await new Promise((r) => setTimeout(r, delay));
  const policy = typeof p.approvalPolicy === "string" ? p.approvalPolicy : undefined;
  if (policy === "untrusted" && process.env.FAKE_CODEX_AS_NO_UNTRUSTED === "1")
    throw {
      code: -32602,
      message:
        'Invalid params: unknown variant `untrusted`, expected one of `on-request`, `never`, `granular` (approval_policy = "untrusted" is no longer supported)',
    };
  if (policy === "on-request" && process.env.FAKE_CODEX_AS_NO_ON_REQUEST === "1")
    throw {
      code: -32602,
      message: "Invalid params: approval policy on-request is not allowed by requirements",
    };
  switch (m.method) {
    case "thread/start": {
      const t = threadOf(p, `thr_fake_${process.pid}_${++n}`);
      notify("thread/started", { thread: { id: t.id } });
      return threadResult(t);
    }
    case "thread/resume": {
      const id = String(p.threadId ?? "");
      if (!id.startsWith("thr_fake_"))
        throw { code: -32600, message: `no rollout found for thread id ${id}` };
      return threadResult(threadOf(p, id));
    }
    case "turn/start": {
      const t = threads.get(String(p.threadId));
      if (!t) throw { code: -32600, message: "thread not loaded" };
      if (typeof p.cwd === "string") t.cwd = p.cwd;
      if (typeof p.approvalPolicy === "string") t.approvalPolicy = p.approvalPolicy;
      const sp = p.sandboxPolicy as { type?: string } | undefined;
      if (sp?.type) t.sandbox = sp.type === "workspaceWrite" ? "workspace-write" : "read-only";
      const input = (p.input ?? []) as Array<{ text?: string }>;
      const turnId = `turn_${++n}`;
      setImmediate(() => void runTurn(t, turnId, input.map((i) => i.text ?? "").join("\n")));
      return { turn: { id: turnId, status: "inProgress", items: [], error: null } };
    }
    case "turn/interrupt":
      interrupted.add(String(p.turnId));
      return {};
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
  // The app-server wire omits the "jsonrpc" member; this fake is strict about it.
  if ("jsonrpc" in m) {
    if (m.id !== undefined)
      send({ id: m.id as number, error: { code: -32600, message: "unexpected jsonrpc member" } });
    return;
  }
  if (m.method === undefined && typeof m.id === "number") {
    waiting.get(m.id)?.(m);
    waiting.delete(m.id);
    return;
  }
  if (m.id === undefined) return; // notifications (initialized)
  void handle(m).then(
    (result) => send({ id: m.id as number, result: result ?? null }),
    (e: { code?: number; message?: string }) =>
      send({ id: m.id as number, error: { code: e.code ?? -32603, message: e.message ?? String(e) } }),
  );
});
