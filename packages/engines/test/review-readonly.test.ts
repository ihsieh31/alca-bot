import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildClaudeArgs,
  CLAUDE_WRITE_TOOLS,
  ClaudeCodeEngine,
  type Engine,
  type EngineEvent,
  type EngineLaunchConfig,
  FAKE_CLAUDE_SCRIPT,
  noNativeToolsProblem,
  readOnlyLaunch,
} from "../src/index.ts";

// Mac test 2026-11 B4: the independent reviewer on Claude Code runs on a
// variant started with no tools at all, and refuses a turn whose CLI still
// offers one. Fictional prompts only.

const engines: Engine[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(engines.splice(0).map((e) => e.dispose()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const coding: EngineLaunchConfig = {
  engineId: "claude-code",
  cwd: "/work",
  stablePrompt: "程式工人的穩定層",
  env: {},
  approvalMode: "default",
  model: "haiku",
  extraArgs: ["--max-turns", "240", "--tools", "Bash,Edit", "--disallowedTools", "Task"],
};

async function collect(it: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const out: EngineEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

function claude(env?: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "alca-review-ro-"));
  dirs.push(dir);
  const sessions = new Map<string, string>();
  const e = new ClaudeCodeEngine({
    command: [process.execPath, "--disable-warning=ExperimentalWarning", FAKE_CLAUDE_SCRIPT],
    launch: () => ({ ...coding, cwd: dir }),
    sessions: { get: (k) => sessions.get(k), set: (k, s) => void sessions.set(k, s) },
    ...(env ? { baseEnv: env } : {}),
    interruptGraceMs: 2000,
  });
  engines.push(e);
  return e;
}

const req = (text: string) => ({
  threadId: "thr_R",
  runId: "run_r",
  sessionKey: "wkr_R~review1~x",
  system: { stable: "", volatile: "" },
  userMessage: text,
  signal: new AbortController().signal,
});

describe("read-only reviewer launch (B4)", () => {
  it("drops the role's --tools / --max-turns and the stable prompt; no tools, one turn, writes denied", () => {
    const ro = readOnlyLaunch(coding);
    expect(ro.stablePrompt).toBe("");
    expect(ro.model).toBe("haiku");
    const args = buildClaudeArgs(ro, {});
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args.filter((a) => a === "--tools")).toHaveLength(1);
    expect(args[args.indexOf("--max-turns") + 1]).toBe("1");
    expect(args.filter((a) => a === "--max-turns")).toHaveLength(1);
    const denied = (args[args.indexOf("--disallowedTools") + 1] ?? "").split(",");
    for (const t of [...CLAUDE_WRITE_TOOLS, "Task"]) expect(denied).toContain(t);
    expect(args).not.toContain("--append-system-prompt");
  });

  it("an init that still lists a built-in tool is refused; MCP tools alone are fine", () => {
    expect(noNativeToolsProblem({ tools: ["mcp__alca__approve"] })).toBeUndefined();
    expect(noNativeToolsProblem({ tools: [] })).toBeUndefined();
    expect(noNativeToolsProblem({ tools: ["Read", "mcp__alca__approve"] })).toMatch(/Read/);
  });

  it("the variant says its native tools are read-only; the worker engine does not", () => {
    const e = claude();
    expect(e.capabilities.nativeToolsReadOnly).toBeUndefined();
    const v = e.readOnlyVariant();
    expect(v.capabilities.nativeToolsReadOnly).toBe(true);
    expect(v.capabilities.ownsToolLoop).toBe(true);
    expect(e.readOnlyVariant()).toBe(v);
    expect(v.readOnlyVariant()).toBe(v);
  });

  it("a review turn runs on the variant with no built-in tools", async () => {
    const out = await collect(claude().readOnlyVariant().turn(req("請審查")));
    expect(out.some((x) => x.type === "error")).toBe(false);
    expect(out.at(-1)).toMatchObject({ type: "done" });
  });

  it("a CLI that ignores the flags is refused before anything runs", async () => {
    const out = await collect(
      claude({ FAKE_CLAUDE_IGNORE_TOOL_FLAGS: "1" }).readOnlyVariant().turn(req("請審查")),
    );
    expect(out.find((x) => x.type === "error")).toMatchObject({ code: "engine.mode_mismatch" });
    expect(out.some((x) => x.type === "text.delta")).toBe(false);
  });
});
