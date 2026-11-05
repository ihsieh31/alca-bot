import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ClaudeCodeEngine,
  type EngineEvent,
  type EngineLaunchConfig,
  FAKE_CLAUDE_SCRIPT,
  type PermissionRequest,
} from "../src/index.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function setup(cfgOver: Partial<EngineLaunchConfig> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "alca-cc-"));
  const log = join(dir, "launches.ndjson");
  const sessions = new Map<string, string>();
  let cfg: EngineLaunchConfig = {
    engineId: "claude-code",
    cwd: dir,
    stablePrompt: "穩定層",
    env: {},
    approvalMode: "default",
    ...cfgOver,
  };
  const engine = new ClaudeCodeEngine({
    command: [process.execPath, "--disable-warning=ExperimentalWarning", FAKE_CLAUDE_SCRIPT],
    launch: () => cfg,
    sessions: { get: (t) => sessions.get(t), set: (t, s) => void sessions.set(t, s) },
    baseEnv: { FAKE_CLAUDE_LOG: log },
    interruptGraceMs: 2000,
  });
  cleanups.push(
    () => engine.dispose(),
    () => rmSync(dir, { recursive: true, force: true }),
  );
  const launches = () =>
    readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { pid: number; args: string[]; cwd: string });
  return { engine, sessions, launches, setCfg: (c: Partial<EngineLaunchConfig>) => (cfg = { ...cfg, ...c }) };
}

async function turn(
  engine: ClaudeCodeEngine,
  text: string,
  opts: {
    onPermission?: (
      r: PermissionRequest,
    ) => Promise<{ behavior: "allow" } | { behavior: "deny"; message: string }>;
    signal?: AbortSignal;
    volatile?: string;
    cwd?: string;
  } = {},
) {
  const events: EngineEvent[] = [];
  for await (const e of engine.turn({
    threadId: "thr",
    runId: "run",
    system: { stable: "穩定層", volatile: opts.volatile ?? "時間：現在" },
    userMessage: text,
    signal: opts.signal ?? new AbortController().signal,
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(opts.onPermission ? { onPermission: opts.onPermission } : {}),
  })) {
    events.push(e);
  }
  return events;
}

const text = (events: EngineEvent[]) =>
  events.flatMap((e) => (e.type === "text.delta" ? [e.text] : [])).join("");

describe("ClaudeCodeEngine (fake CLI)", () => {
  it("keeps one process across turns and streams text", async () => {
    const { engine, launches, sessions } = setup();
    const a = await turn(engine, "第一句");
    expect(text(a)).toBe("收到：第一句");
    expect(a.at(-1)).toEqual({ type: "done", stop: "end_turn" });
    expect(a.find((e) => e.type === "usage")).toMatchObject({ cachedInputTokens: 30 });
    const b = await turn(engine, "第二句", { volatile: "時間：之後" });
    expect(text(b)).toBe("收到：第二句");
    expect(launches()).toHaveLength(1);
    expect(sessions.get("thr")).toMatch(/^[0-9a-f-]{36}$/);
    const args = launches()[0]!.args;
    expect(args).toContain("--input-format");
    expect(args[args.indexOf("--append-system-prompt") + 1]).toBe("穩定層");
    expect(args.join(" ")).not.toContain("時間");
  });

  it("P13: starts in the turn's working folder; another folder restarts and resumes", async () => {
    const { engine, launches, sessions } = setup();
    const a = mkdtempSync(join(tmpdir(), "alca-cc-work-"));
    const b = mkdtempSync(join(tmpdir(), "alca-cc-work-"));
    cleanups.push(
      () => rmSync(a, { recursive: true, force: true }),
      () => rmSync(b, { recursive: true, force: true }),
    );
    await turn(engine, "一", { cwd: a });
    await turn(engine, "二", { cwd: a });
    const sid = sessions.get("thr");
    await turn(engine, "三", { cwd: b });
    const l = launches();
    expect(l.map((x) => realpathSync(x.cwd))).toEqual([realpathSync(a), realpathSync(b)]);
    expect(l[1]?.args.join(" ")).toContain(`--resume ${sid}`);
  });

  it("restarts only when the launch hash changes, resuming the stored session", async () => {
    const { engine, launches, sessions, setCfg } = setup();
    await turn(engine, "一");
    const sid = sessions.get("thr");
    setCfg({ env: {} }); // same hash
    await turn(engine, "二");
    expect(launches()).toHaveLength(1);
    setCfg({ model: "opus" });
    await turn(engine, "三");
    const all = launches();
    expect(all).toHaveLength(2);
    const second = all[1]!.args;
    expect(second[second.indexOf("--resume") + 1]).toBe(sid);
    expect(second[second.indexOf("--model") + 1]).toBe("opus");
    expect(sessions.get("thr")).toBe(sid);
  });

  it("routes permission prompts through the MCP tool to the host and back", async () => {
    const { engine } = setup();
    const seen: PermissionRequest[] = [];
    const allowed = await turn(engine, "[bash:ls -la]", {
      onPermission: async (r) => {
        seen.push(r);
        return { behavior: "allow" };
      },
    });
    expect(seen[0]).toMatchObject({ toolName: "Bash", input: { command: "ls -la" } });
    expect(seen[0]?.toolUseId).toMatch(/^toolu_/);
    expect(allowed.find((e) => e.type === "tool.result")).toMatchObject({ ok: true, output: "ran: ls -la" });
    const denied = await turn(engine, "[bash:rm -rf /]", {
      onPermission: async () => ({ behavior: "deny", message: "使用者拒絕" }),
    });
    expect(denied.find((e) => e.type === "tool.result")).toMatchObject({ ok: false, output: "使用者拒絕" });
    // No handler → fail closed.
    const none = await turn(engine, "[bash:echo]");
    expect(none.find((e) => e.type === "tool.result")).toMatchObject({ ok: false });
  });

  it("interrupts a running turn without losing the process", async () => {
    const { engine, launches } = setup();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 150);
    const ev = await turn(engine, "[slow]", { signal: ac.signal });
    expect(ev.at(-1)).toEqual({ type: "done", stop: "interrupted" });
    expect(engine.hasProcess("thr")).toBe(true);
    expect(text(await turn(engine, "還在嗎"))).toBe("收到：還在嗎");
    expect(launches()).toHaveLength(1);
  });

  it("reports a crash as a retryable error and respawns with --resume next turn", async () => {
    const { engine, launches } = setup();
    await turn(engine, "hello");
    const crashed = await turn(engine, "[crash]");
    expect(crashed.find((e) => e.type === "error")).toMatchObject({ code: "engine.exited", retryable: true });
    expect(text(await turn(engine, "again"))).toBe("收到：again");
    const all = launches();
    expect(all).toHaveLength(2);
    expect(all[1]!.args).toContain("--resume");
  });
});
