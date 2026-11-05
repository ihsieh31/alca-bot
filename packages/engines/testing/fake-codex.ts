// A fake `codex` CLI for tests: `codex exec --json … [resume <id>] -` with the
// prompt on stdin, printing the JSONL event shapes of the public Codex CLI
// docs. `-c mcp_servers.alcatools.*` starts the host tools server for real
// and speaks MCP to it over stdio.
//
// Directives in the prompt:
//   [shell:CMD]        a command_execution item (read-only sandbox: it "runs" here)
//   [mcp:TOOL {json}]  call host tool TOOL on the alcatools MCP server
//   [slow]             wait 5 s before answering (interrupt tests; SIGINT ends it)
//   [crash]            exit 2 mid-turn
//   [fail]             turn.failed
// Env: FAKE_CODEX_LOG — append {pid, args, prompt, codexHome, configMcp, env} per launch;
//      configMcp lists the `[mcp_servers.<name>]` tables of $CODEX_HOME/config.toml
//      (default ~/.codex), the servers a real Codex would call without asking.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

type Json = Record<string, unknown>;
const argv = process.argv.slice(2);
const out = (m: Json) => process.stdout.write(`${JSON.stringify(m)}\n`);

/** `-c key=value` overrides (values as our args builder writes them: JSON-ish TOML). */
function overrides(): Map<string, string> {
  const m = new Map<string, string>();
  for (let i = 0; i < argv.length; i++)
    if (argv[i] === "-c" && argv[i + 1]) {
      const kv = argv[i + 1] as string;
      const eq = kv.indexOf("=");
      m.set(kv.slice(0, eq), kv.slice(eq + 1));
    }
  return m;
}

function tomlTable(v: string): Record<string, string> {
  const o: Record<string, string> = {};
  for (const m of v.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*=\s*("(?:[^"\\]|\\.)*")/g))
    o[m[1] as string] = JSON.parse(m[2] as string) as string;
  return o;
}

async function hostTools(): Promise<((tool: string, args: Json) => Promise<Json>) | undefined> {
  const c = overrides();
  const command = c.get("mcp_servers.alcatools.command");
  if (!command) return undefined;
  const child = spawn(
    JSON.parse(command) as string,
    JSON.parse(c.get("mcp_servers.alcatools.args") ?? "[]"),
    {
      env: { ...process.env, ...tomlTable(c.get("mcp_servers.alcatools.env") ?? "") },
      stdio: ["pipe", "pipe", "inherit"],
    },
  );
  let next = 1;
  const pending = new Map<number, (r: Json) => void>();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const msg = JSON.parse(line) as { id?: number; result?: Json; error?: Json };
    if (typeof msg.id === "number") pending.get(msg.id)?.(msg.result ?? { error: msg.error });
  });
  const call = (method: string, params: Json) =>
    new Promise<Json>((resolve) => {
      const id = next++;
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  await call("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "fake-codex" },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  process.on("exit", () => child.kill());
  return (tool, args) => call("tools/call", { name: tool, arguments: args });
}

async function main() {
  const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
  const configFile = join(codexHome, "config.toml");
  const configMcp = existsSync(configFile)
    ? [...readFileSync(configFile, "utf8").matchAll(/^\[mcp_servers\.([\w-]+)\]/gm)].map((m) => m[1])
    : [];
  let prompt = "";
  for await (const chunk of process.stdin) prompt += String(chunk);
  if (process.env.FAKE_CODEX_LOG)
    appendFileSync(
      process.env.FAKE_CODEX_LOG,
      `${JSON.stringify({ pid: process.pid, args: argv, prompt, codexHome, configMcp, env: Object.keys(process.env).sort() })}\n`,
    );
  const r = argv.indexOf("resume");
  const resumed = r >= 0 ? argv[r + 1] : undefined;
  const thread = resumed ?? randomUUID();
  out({ type: "thread.started", thread_id: thread });
  out({ type: "turn.started" });
  let n = 0;
  const last = prompt.trim().split("\n").at(-1) ?? "";
  if (prompt.includes("[crash]")) {
    process.stderr.write("boom\n");
    process.exit(2);
  }
  if (prompt.includes("[fail]")) {
    out({ type: "turn.failed", error: { message: "模擬失敗" } });
    return;
  }
  if (prompt.includes("[slow]")) {
    process.on("SIGINT", () => process.exit(130));
    await new Promise((res) => setTimeout(res, 5000));
  }
  for (const m of prompt.matchAll(/\[shell:([^\]]+)\]/g)) {
    const id = `item_${n++}`;
    out({
      type: "item.started",
      item: { id, type: "command_execution", command: m[1], status: "in_progress" },
    });
    out({
      type: "item.completed",
      item: {
        id,
        type: "command_execution",
        command: m[1],
        aggregated_output: `ran ${m[1]}`,
        exit_code: 0,
        status: "completed",
      },
    });
  }
  const calls = [...prompt.matchAll(/\[mcp:([a-z_]+) (\{[^\]]*\})\]/g)];
  if (calls.length) {
    const call = await hostTools();
    for (const m of calls) {
      const id = `item_${n++}`;
      const args = JSON.parse(m[2] as string) as Json;
      out({
        type: "item.started",
        item: {
          id,
          type: "mcp_tool_call",
          server: "alcatools",
          tool: m[1],
          arguments: args,
          status: "in_progress",
        },
      });
      const res = call ? await call(m[1] as string, args) : { error: { message: "no server" } };
      const failed = !!res.error || res.isError === true;
      out({
        type: "item.completed",
        item: {
          id,
          type: "mcp_tool_call",
          server: "alcatools",
          tool: m[1],
          arguments: args,
          status: failed ? "failed" : "completed",
          result: res,
        },
      });
    }
  }
  const text = `Codex 收到：${last}${resumed ? `（接續 ${resumed.slice(0, 8)}）` : ""}`;
  const id = `item_${n++}`;
  out({ type: "item.updated", item: { id, type: "agent_message", text: text.slice(0, 6) } });
  out({ type: "item.completed", item: { id, type: "agent_message", text } });
  out({ type: "turn.completed", usage: { input_tokens: 120, cached_input_tokens: 80, output_tokens: 12 } });
  process.exit(0);
}

void main();
