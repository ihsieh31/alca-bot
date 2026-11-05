// A fake `claude` CLI for tests and the offline demo. It speaks the same
// stream-json shapes as `claude -p --input-format stream-json
// --output-format stream-json --verbose --include-partial-messages`
// (as described in the public CLI docs), and drives the permission tool over
// a real MCP stdio connection taken from --mcp-config.
//
// Directives inside the user text:
//   [bash:CMD]        tool_use Bash {command: CMD}, asks permission first
//   [ask:Q|A|B]       AskUserQuestion via the permission tool
//   [fail-read:N]     N identical failing Read calls (loop-guard tests)
//   [slow]            stream slowly so the turn can be interrupted
//   [crash]           exit mid-turn
//   [write:PATH|TEXT] tool_use Write {file_path, content} (PATH relative to the
//                     cwd), asks permission first unless --permission-mode is
//                     acceptEdits / bypassPermissions; writes the file when allowed
//   [read:PATH]       tool_use Read {file_path: PATH} (no prompt, like the
//                     CLI's default mode for reads)
//   [mcp:TOOL {json}] call host tool TOOL on the `alcatools` MCP server
//                     (several in one message run in order; asks permission
//                     first unless --allowedTools covers mcp__alcatools). The
//                     JSON may nest objects and contain "]" inside strings.
//                     In the JSON, "$ref(text)" becomes the @N of the first
//                     line of the previous result that contains text.
//   [builtin:NAME {json}] a built-in tool that runs WITHOUT the permission
//                     tool, like Claude Code 2.1's CronCreate / Agent /
//                     ScheduleWakeup (mac test 2026-11-04b A8). CronCreate
//                     "schedules" a job inside this process: it is listed in
//                     FAKE_CLAUDE_LOG as {pid, cron} and lives until exit.
// --disallowedTools removes built-in tools (Bash, Read, …) and --tools keeps
// only the named ones ("" = none): a directive for a removed tool is answered
// in text, with no tool_use, as the CLI would have no such tool.
// Settings and MCP servers the person has, as Claude Code reads them (review
// 2026-11-04b S1): `permissions.allow` rules from $HOME/.claude/settings.json
// (source "user"), <cwd>/.claude/settings.json ("project") and
// <cwd>/.claude/settings.local.json ("local") pre-allow Bash commands — such a
// command runs WITHOUT calling the permission tool — unless
// `--setting-sources` leaves that source out ("" = none). `mcpServers` in
// $HOME/.claude.json and <cwd>/.mcp.json are loaded unless --strict-mcp-config.
// FAKE_CLAUDE_IGNORE_TOOL_FLAGS=1 keeps every built-in tool whatever
// --tools / --disallowedTools say (a CLI that ignores them, for the host's own
// detection). FAKE_CLAUDE_PREALLOW=1 pre-allows every Bash command whatever the flags
// (a CLI that runs a tool without asking, for the host's own detection).
// Env: FAKE_CLAUDE_LOG — append one JSON line per launch ({pid, args, cwd, toolSearch});
//      FAKE_CLAUDE_ASK_HOST_TOOLS — ask permission even for --allowedTools;
//      FAKE_CLAUDE_TOOL_SEARCH — like Claude Code ≥ 2.1, call the built-in
//        ToolSearch (no prompt) before the first [mcp:…] call: "1" unless
//        ENABLE_TOOL_SEARCH=false, "always" regardless;
//      FAKE_CLAUDE_EXIT_DELAY_MS — linger this long after stdin closes (review 2026-11-05 #13);
//      FAKE_CLAUDE_EXIT_LOG — append {pid, exitAt} when it exits after stdin closed;
//      FAKE_CLAUDE_RESUME_MISSING — "1" / "silent": a --resume launch fails (review 2026-11-05 #4);
//      FAKE_CLAUDE_REPORT_REPLY — answer a worker report (<alca:worker …>) with
//        this text, like a router that words it its own way (C2).
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";

type Json = Record<string, unknown>;
const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const readJson = (path: string): Json => {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Json) : {};
  } catch {
    return {};
  }
};
const sourcesFlag = flag("--setting-sources");
const sources = new Set(
  sourcesFlag === undefined ? ["user", "project", "local"] : sourcesFlag.split(",").filter(Boolean),
);
const home = process.env.HOME ?? "/nonexistent";
const settingFiles: Array<[string, string]> = [
  ["user", join(home, ".claude", "settings.json")],
  ["project", join(process.cwd(), ".claude", "settings.json")],
  ["local", join(process.cwd(), ".claude", "settings.local.json")],
];
const allowRules = settingFiles
  .filter(([src]) => sources.has(src))
  .flatMap(([, f]) => ((readJson(f).permissions as Json | undefined)?.allow ?? []) as string[]);
const userMcp: string[] = argv.includes("--strict-mcp-config")
  ? []
  : [join(home, ".claude.json"), join(process.cwd(), ".mcp.json")].flatMap((f) =>
      Object.keys((readJson(f).mcpServers as Json | undefined) ?? {}),
    );
/** Is this Bash command pre-allowed by a loaded settings file (`Bash`, `Bash(*)`, `Bash(git push:*)`)? */
const bashPreAllowed = (command: string): boolean =>
  process.env.FAKE_CLAUDE_PREALLOW === "1" ||
  allowRules.some((r) => {
    if (r === "Bash" || r === "Bash(*)") return true;
    const m = /^Bash\((.*?)(:\*)?\)$/.exec(r);
    return !!m && (m[2] ? command.startsWith(m[1] as string) : command === m[1]);
  });

if (process.env.FAKE_CLAUDE_LOG) {
  appendFileSync(
    process.env.FAKE_CLAUDE_LOG,
    `${JSON.stringify({ pid: process.pid, at: Date.now(), args: argv, cwd: process.cwd(), toolSearch: process.env.ENABLE_TOOL_SEARCH ?? null, allowRules, userMcp, env: Object.keys(process.env).sort() })}\n`,
  );
}

// FAKE_CLAUDE_RESUME_MISSING=1: a `--resume` launch says the session is gone and exits
// (Claude Code cleaned its jsonl, or the session lives under another cwd); "silent" exits
// with no output at all.
if (flag("--resume") && process.env.FAKE_CLAUDE_RESUME_MISSING) {
  if (process.env.FAKE_CLAUDE_RESUME_MISSING !== "silent")
    process.stderr.write(`No conversation found with session ID: ${flag("--resume")}\n`);
  process.exit(1);
}
const sessionId = flag("--resume") ?? randomUUID();
const model = flag("--model") ?? "fake-sonnet";
const out = (m: Json) => process.stdout.write(`${JSON.stringify(m)}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let interrupted = false;

// ── MCP clients (permission tool + host tools) ──────────────────
interface McpClient {
  child: ChildProcess;
  call: (method: string, params: Json) => Promise<Json>;
  tools: string[];
}
const servers = new Map<string, McpClient>();

async function connectServer(name: string, server: { command: string; args: string[]; env?: Json }) {
  const child = spawn(server.command, server.args, {
    env: { ...process.env, ...(server.env as Record<string, string>) },
    stdio: ["pipe", "pipe", "inherit"],
  });
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
    clientInfo: { name: "fake-claude" },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const list = await call("tools/list", {});
  const tools = ((list.tools ?? []) as Array<{ name: string }>).map((t) => t.name);
  servers.set(name, { child, call, tools });
}

async function connectMcp(): Promise<void> {
  const cfgText = flag("--mcp-config");
  if (!cfgText) return;
  const cfg = JSON.parse(cfgText) as {
    mcpServers: Record<string, { command: string; args: string[]; env?: Json }>;
  };
  for (const [name, server] of Object.entries(cfg.mcpServers)) await connectServer(name, server);
  const perm = flag("--permission-prompt-tool");
  if (perm) {
    const [, srv, tool] = perm.split("__");
    if (!srv || !tool || !servers.get(srv)?.tools.includes(tool))
      throw new Error("permission server has no approve tool");
  }
}

const allowedTools = (flag("--allowedTools") ?? "").split(/[,\s]+/).filter(Boolean);
const disallowed = new Set((flag("--disallowedTools") ?? "").split(/[,\s]+/).filter(Boolean));
const toolsFlag = flag("--tools");
const builtinAllow = toolsFlag === undefined ? undefined : new Set(toolsFlag.split(/[,\s]+/).filter(Boolean));
/** Does this process have the built-in tool (not removed by --disallowedTools, kept by --tools)? */
const hasBuiltin = (name: string) =>
  process.env.FAKE_CLAUDE_IGNORE_TOOL_FLAGS === "1" ||
  (!disallowed.has(name) && (builtinAllow === undefined || builtinAllow.has(name)));

/** `[mcp:name {json}]` directives, with a string-aware balanced-brace scan for the JSON. */
function mcpDirectives(text: string): Array<{ tool: string; raw: string }> {
  const out: Array<{ tool: string; raw: string }> = [];
  const re = /\[mcp:([a-z_]+)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    let i = m.index + m[0].length;
    while (text[i] === " ") i++;
    let raw = "{}";
    if (text[i] === "{") {
      let depth = 0;
      let inStr = false;
      const start = i;
      for (; i < text.length; i++) {
        const c = text[i];
        if (inStr) {
          if (c === "\\") i++;
          else if (c === '"') inStr = false;
        } else if (c === '"') inStr = true;
        else if (c === "{") depth++;
        else if (c === "}" && --depth === 0) break;
      }
      raw = text.slice(start, i + 1);
      i++;
    }
    if (text[i] !== "]") continue;
    re.lastIndex = i + 1;
    out.push({ tool: m[1] as string, raw });
  }
  return out;
}
const preAllowed = (name: string) =>
  !process.env.FAKE_CLAUDE_ASK_HOST_TOOLS &&
  allowedTools.some((a) => a === name || (a.startsWith("mcp__") && name.startsWith(`${a}__`)));

async function askPermission(toolName: string, input: Json, toolUseId: string): Promise<Json> {
  const [, srv, tool] = (flag("--permission-prompt-tool") ?? "").split("__");
  const mcp = srv ? servers.get(srv) : undefined;
  if (!mcp || !tool) return { behavior: "deny", message: "no permission tool configured" };
  const r = await mcp.call("tools/call", {
    name: tool,
    arguments: { tool_name: toolName, input, tool_use_id: toolUseId },
  });
  const content = (r.content ?? []) as Array<{ text: string }>;
  return JSON.parse(content[0]?.text ?? '{"behavior":"deny","message":"empty"}') as Json;
}

// ── stream helpers ───────────────────────────────────────────────
const base = () => ({ session_id: sessionId, parent_tool_use_id: null });

async function streamText(text: string, delayMs = 0): Promise<void> {
  out({ type: "stream_event", event: { type: "message_start" }, ...base() });
  const chars = [...text];
  for (let i = 0; i < chars.length; i += 3) {
    if (interrupted) return;
    out({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: chars.slice(i, i + 3).join("") },
      },
      ...base(),
    });
    if (delayMs) await sleep(delayMs);
  }
  out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] }, ...base() });
}

async function toolCall(
  name: string,
  input: Json,
  needsPermission: boolean,
  run: () => string | Error | Promise<string | Error>,
) {
  const id = `toolu_${randomUUID().slice(0, 12)}`;
  out({ type: "stream_event", event: { type: "message_start" }, ...base() });
  out({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
    ...base(),
  });
  let result: { text: string; isError: boolean };
  if (needsPermission) {
    const answer = await askPermission(name, input, id);
    if (answer.behavior !== "allow") {
      result = { text: String(answer.message ?? "denied"), isError: true };
    } else {
      const r = await run();
      result = r instanceof Error ? { text: r.message, isError: true } : { text: r, isError: false };
    }
  } else {
    const r = await run();
    result = r instanceof Error ? { text: r.message, isError: true } : { text: r, isError: false };
  }
  out({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content: result.text, is_error: result.isError }],
    },
    ...base(),
  });
  return result;
}

function finish(subtype: "success" | "error_during_execution", text: string): void {
  out({
    type: "result",
    subtype,
    is_error: subtype !== "success",
    result: text,
    duration_ms: 5,
    num_turns: 1,
    total_cost_usd: 0,
    usage: {
      input_tokens: 12,
      output_tokens: 7,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 0,
    },
    ...base(),
  });
}

async function onUserText(full: string): Promise<void> {
  out({
    type: "system",
    subtype: "init",
    session_id: sessionId,
    model,
    tools: [
      ...["Bash", "Read", "Write", "Edit"].filter(hasBuiltin),
      ...[...servers].flatMap(([n, c]) => c.tools.map((t) => `mcp__${n}__${t}`)),
    ],
    cwd: process.cwd(),
  });
  const text =
    full
      .split("\n")
      .filter((l) => l.trim())
      .at(-1) ?? "";
  if (text.includes("[crash]")) process.exit(3);

  const bash = /\[bash:([^\]]+)\]/.exec(text);
  if (bash && !hasBuiltin("Bash")) {
    await streamText("這個工作階段沒有 Bash 工具。");
    finish("success", "ok");
    return;
  }
  const write = /\[write:([^|\]]+)\|([^\]]*)\]/.exec(text);
  if (write) {
    if (!hasBuiltin("Write")) await streamText("這個工作階段沒有 Write 工具。");
    else {
      const raw = write[1] as string;
      const path = isAbsolute(raw) ? raw : join(process.cwd(), raw);
      const mode = flag("--permission-mode") ?? "default";
      const asks = mode !== "acceptEdits" && mode !== "bypassPermissions";
      const r = await toolCall("Write", { file_path: path, content: write[2] }, asks, () => {
        writeFileSync(path, write[2] as string);
        return `File created successfully at: ${path}`;
      });
      await streamText(r.isError ? `沒有寫：${r.text}` : "寫好了。");
    }
    finish("success", "ok");
    return;
  }
  const read = /\[read:([^\]]+)\]/.exec(text);
  if (read) {
    if (!hasBuiltin("Read")) await streamText("這個工作階段沒有 Read 工具。");
    else {
      const r = await toolCall("Read", { file_path: read[1] }, false, () => `內容：${read[1]}`);
      await streamText(`讀到了：${r.text}`);
    }
    finish("success", "ok");
    return;
  }
  if (bash) {
    const cmd = bash[1] as string;
    const r = await toolCall("Bash", { command: cmd }, !bashPreAllowed(cmd), () => `ran: ${cmd}`);
    await streamText(r.isError ? `沒有執行：${r.text}` : `完成：${r.text}`);
    finish("success", "ok");
    return;
  }
  const builtin = /\[builtin:([A-Za-z]+)\s*(\{[^\]]*\})?\]/.exec(text);
  if (builtin) {
    const name = builtin[1] as string;
    if (!hasBuiltin(name)) await streamText(`這個工作階段沒有 ${name} 工具。`);
    else {
      const input = JSON.parse(builtin[2] ?? "{}") as Json;
      const r = await toolCall(name, input, false, () => {
        if (name === "CronCreate") {
          if (process.env.FAKE_CLAUDE_LOG)
            appendFileSync(
              process.env.FAKE_CLAUDE_LOG,
              `${JSON.stringify({ pid: process.pid, cron: input.cron ?? null })}\n`,
            );
          return `Scheduled recurring job (${String(input.cron)}). Session-only.`;
        }
        return `${name} done`;
      });
      await streamText(`完成：${r.text}`);
    }
    finish("success", "ok");
    return;
  }
  const ask = /\[ask:([^\]]+)\]/.exec(text);
  if (ask && !hasBuiltin("AskUserQuestion")) {
    await streamText("這個工作階段沒有 AskUserQuestion 工具。");
    finish("success", "ok");
    return;
  }
  if (ask) {
    const [q, ...opts] = (ask[1] as string).split("|");
    const input = {
      questions: [
        { question: q, header: "問題", options: opts.map((label) => ({ label })), multiSelect: false },
      ],
    };
    const r = await toolCall("AskUserQuestion", input, true, () => "answered");
    await streamText(`你選了：${r.text}`);
    finish("success", "ok");
    return;
  }
  const mcpCalls = mcpDirectives(text);
  if (mcpCalls.length) {
    const host = servers.get("alcatools");
    const search = process.env.FAKE_CLAUDE_TOOL_SEARCH;
    if (search === "always" || (search === "1" && process.env.ENABLE_TOOL_SEARCH !== "false")) {
      const names = mcpCalls.map((m) => `mcp__alcatools__${m.tool}`).join(",");
      await toolCall("ToolSearch", { query: `select:${names}` }, false, () => `loaded ${names}`);
    }
    let last = { text: "", isError: false };
    for (const m of mcpCalls) {
      if (interrupted) break;
      const tool = m.tool;
      const raw = m.raw.replace(/\$ref\(([^)]*)\)/g, (_all, needle: string) => {
        const line = last.text.split("\n").find((l) => l.includes(needle)) ?? "";
        return /@\d+/.exec(line)?.[0] ?? "@0";
      });
      const name = `mcp__alcatools__${tool}`;
      last = await toolCall(name, JSON.parse(raw) as Json, !preAllowed(name), async () => {
        if (!host?.tools.includes(tool)) return new Error(`No such tool available: ${name}`);
        const r = await host.call("tools/call", { name: tool, arguments: JSON.parse(raw) });
        const content = (r.content ?? []) as Array<{ text: string }>;
        const t = content.map((c) => c.text).join("");
        return r.isError ? new Error(t) : t;
      });
    }
    await streamText(
      last.isError ? `沒有執行：${last.text.slice(0, 300)}` : `完成：${last.text.slice(0, 300)}`,
    );
    finish("success", "ok");
    return;
  }
  const loop = /\[fail-read:(\d+)\]/.exec(text);
  if (loop) {
    for (let i = 0; i < Number(loop[1]) && !interrupted; i++) {
      await toolCall("Read", { file_path: "/nope.txt" }, false, () => new Error("File does not exist."));
      await sleep(15); // a real tool call takes a moment
    }
    if (interrupted) return finish("error_during_execution", "interrupted");
    await streamText("放棄了。");
    finish("success", "ok");
    return;
  }
  if (text.includes("[slow]")) {
    await streamText("這是一段很慢的回答，".repeat(20), 25);
    if (interrupted) return finish("error_during_execution", "interrupted");
    finish("success", "ok");
    return;
  }
  const reportReply = process.env.FAKE_CLAUDE_REPORT_REPLY;
  if (reportReply && full.includes("<alca:worker ")) {
    await streamText(reportReply);
    finish("success", "ok");
    return;
  }
  await streamText(`收到：${text}`);
  finish("success", "ok");
}

// ── main loop: one stdin line per message ────────────────────────
let chain: Promise<void> = Promise.resolve();
const ready = connectMcp();
createInterface({ input: process.stdin })
  .on("line", (line) => {
    if (!line.trim()) return;
    const msg = JSON.parse(line) as Json;
    if (msg.type === "control_request") {
      const req = msg.request as { subtype?: string };
      if (req.subtype === "interrupt") interrupted = true;
      out({ type: "control_response", response: { subtype: "success", request_id: msg.request_id } });
      return;
    }
    if (msg.type === "user") {
      const content = (msg.message as { content: Array<{ type: string; text?: string }> }).content;
      const text = content.map((b) => b.text ?? "").join("");
      interrupted = false;
      chain = chain.then(() => ready).then(() => onUserText(text));
    }
  })
  .on("close", () => {
    void chain
      // FAKE_CLAUDE_EXIT_DELAY_MS: still flushing its session file for a while after stdin closed.
      .then(() => new Promise((r) => setTimeout(r, Number(process.env.FAKE_CLAUDE_EXIT_DELAY_MS ?? 0))))
      .then(() => {
        if (process.env.FAKE_CLAUDE_EXIT_LOG)
          appendFileSync(
            process.env.FAKE_CLAUDE_EXIT_LOG,
            `${JSON.stringify({ pid: process.pid, exitAt: Date.now() })}\n`,
          );
        for (const c of servers.values()) c.child.kill();
        process.exit(0);
      });
  });
process.on("SIGINT", () => {
  interrupted = true;
});
