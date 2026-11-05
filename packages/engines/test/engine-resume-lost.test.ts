import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ClaudeCodeEngine,
  CONTEXT_RESET,
  CodexAppServerEngine,
  type EngineEvent,
  type EngineTurnRequest,
  FAKE_CLAUDE_SCRIPT,
  FAKE_CODEX_APP_SERVER_SCRIPT,
} from "../src/index.ts";

// Review 2026-11-05 #4: with idle reaping every conversation resumes after ten
// quiet minutes, so a session that will not resume must not fail every later
// turn (Claude) nor be swapped for a fresh one without a word (Codex): the
// stored id is forgotten, the turn runs in a fresh session, and a notice says so.

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "alca-resume-"));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
};

async function collect(it: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const out: EngineEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const req = (text: string): EngineTurnRequest => ({
  threadId: "thr",
  runId: "run",
  sessionKey: "wkr",
  system: { stable: "穩定層", volatile: "" },
  userMessage: text,
  signal: new AbortController().signal,
});

const lines = (file: string) =>
  readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

function sessionsBox(initial?: string) {
  const map = new Map<string, string>(initial ? [["wkr", initial]] : []);
  const cleared: string[] = [];
  return {
    map,
    cleared,
    mem: {
      get: (k: string) => map.get(k),
      set: (k: string, v: string) => void map.set(k, v),
      clear: (k: string) => {
        cleared.push(k);
        map.delete(k);
      },
    },
  };
}

function claude(mode: "1" | "silent" | "", stored: string) {
  const dir = tmp();
  const log = join(dir, "launches.ndjson");
  const s = sessionsBox(stored);
  const engine = new ClaudeCodeEngine({
    command: [process.execPath, "--disable-warning=ExperimentalWarning", FAKE_CLAUDE_SCRIPT],
    launch: () => ({
      engineId: "claude-code",
      cwd: dir,
      stablePrompt: "穩定層",
      env: {},
      approvalMode: "default",
    }),
    sessions: s.mem,
    baseEnv: { FAKE_CLAUDE_LOG: log, ...(mode ? { FAKE_CLAUDE_RESUME_MISSING: mode } : {}) },
    interruptGraceMs: 2000,
  });
  cleanups.push(() => engine.dispose());
  return { engine, s, launches: () => lines(log) as Array<{ args: string[] }> };
}

describe("ClaudeCodeEngine: a --resume that fails (fake CLI)", () => {
  for (const mode of ["1", "silent"] as const)
    it(`"${mode}": clears the stored session, says so, and answers the turn in a fresh session`, async () => {
      const { engine, s, launches } = claude(mode, "sess-gone-1");
      const out = await collect(engine.turn(req("一")));
      expect(out.find((e) => e.type === "notice")).toMatchObject({ type: "notice", code: CONTEXT_RESET });
      expect(out.some((e) => e.type === "error")).toBe(false);
      expect(out.at(-1)).toMatchObject({ type: "done", stop: "end_turn" });
      expect(out.some((e) => e.type === "text.delta")).toBe(true);
      expect(s.cleared).toEqual(["wkr"]);
      const fresh = s.map.get("wkr");
      expect(fresh).toBeTruthy();
      expect(fresh).not.toBe("sess-gone-1");
      const [first, second] = launches();
      expect(first?.args).toContain("--resume");
      expect(second?.args).not.toContain("--resume");
      // The next turn runs on the fresh process: no notice again.
      const again = await collect(engine.turn(req("二")));
      expect(again.some((e) => e.type === "notice")).toBe(false);
      expect(again.at(-1)).toMatchObject({ type: "done", stop: "end_turn" });
    });

  it("a resume that works says nothing and keeps the session", async () => {
    const { engine, s, launches } = claude("", "sess-kept-1");
    const out = await collect(engine.turn(req("一")));
    expect(out.some((e) => e.type === "notice")).toBe(false);
    expect(s.cleared).toEqual([]);
    expect(s.map.get("wkr")).toBe("sess-kept-1");
    expect(launches()).toHaveLength(1);
  });

  it("without sessions.clear the failed id is still not resumed again", async () => {
    const dir = tmp();
    const log = join(dir, "l.ndjson");
    const map = new Map([["wkr", "sess-gone-2"]]);
    const engine = new ClaudeCodeEngine({
      command: [process.execPath, "--disable-warning=ExperimentalWarning", FAKE_CLAUDE_SCRIPT],
      launch: () => ({
        engineId: "claude-code",
        cwd: dir,
        stablePrompt: "",
        env: {},
        approvalMode: "default",
      }),
      sessions: { get: (k) => map.get(k), set: (k, v) => void map.set(k, v) },
      baseEnv: { FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_RESUME_MISSING: "1" },
    });
    cleanups.push(() => engine.dispose());
    const out = await collect(engine.turn(req("一")));
    expect(out.at(-1)).toMatchObject({ type: "done", stop: "end_turn" });
    expect(map.get("wkr")).not.toBe("sess-gone-2");
  });
});

function codex(stored: string) {
  const dir = tmp();
  const log = join(dir, "log.jsonl");
  const s = sessionsBox(stored);
  const e = new CodexAppServerEngine({
    command: [process.execPath, "--disable-warning=ExperimentalWarning", FAKE_CODEX_APP_SERVER_SCRIPT],
    launch: () => ({
      engineId: "codex",
      cwd: dir,
      stablePrompt: "穩定層",
      env: {},
      approvalMode: "workspace-write",
    }),
    sessions: s.mem,
    sandbox: "workspace-write",
    home: false,
    baseEnv: { FAKE_CODEX_AS_LOG: log },
    setupTimeoutMs: 5000,
  });
  cleanups.push(() => e.dispose());
  return { e, s, log: () => lines(log) as Array<{ method?: string; params?: { threadId?: string } }> };
}

describe("CodexAppServerEngine: a thread/resume that fails (fake app-server)", () => {
  it("clears the stored thread, says so, and runs the turn on a fresh thread", async () => {
    const { e, s, log } = codex("thr_gone_1");
    const out = await collect(e.turn(req("一")));
    expect(out.find((x) => x.type === "notice")).toMatchObject({ type: "notice", code: CONTEXT_RESET });
    expect(out.at(-1)).toMatchObject({ type: "done", stop: "end_turn" });
    expect(s.cleared).toEqual(["wkr"]);
    expect(s.map.get("wkr")).toMatch(/^thr_fake_/);
    const methods = log().map((m) => m.method);
    expect(methods).toContain("thread/resume");
    expect(methods).toContain("thread/start");
  });

  it("a thread that resumes says nothing", async () => {
    const first = codex("");
    await collect(first.e.turn(req("一")));
    const thread = first.s.map.get("wkr") as string;
    await first.e.release("wkr");
    const out = await collect(first.e.turn(req("二")));
    expect(out.some((x) => x.type === "notice")).toBe(false);
    expect(first.s.map.get("wkr")).toBe(thread);
    expect(first.s.cleared).toEqual([]);
  });
});

describe("ClaudeCodeEngine: a released process is gone before the session is resumed (review #13)", () => {
  it("a turn that starts while the idle release is still stopping waits for the old CLI to exit", async () => {
    const dir = tmp();
    const log = join(dir, "launches.ndjson");
    const exits = join(dir, "exits.ndjson");
    const s = sessionsBox();
    const engine = new ClaudeCodeEngine({
      command: [process.execPath, "--disable-warning=ExperimentalWarning", FAKE_CLAUDE_SCRIPT],
      launch: () => ({
        engineId: "claude-code",
        cwd: dir,
        stablePrompt: "",
        env: {},
        approvalMode: "default",
      }),
      sessions: s.mem,
      baseEnv: { FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_EXIT_LOG: exits, FAKE_CLAUDE_EXIT_DELAY_MS: "600" },
    });
    cleanups.push(() => engine.dispose());
    await collect(engine.turn(req("一")));
    const releasing = engine.release("wkr"); // the idle sweep, not awaited by the next turn
    const out = await collect(engine.turn(req("二")));
    await releasing;
    expect(out.at(-1)).toMatchObject({ type: "done", stop: "end_turn" });
    const [first, second] = lines(log) as Array<{ pid: number; at: number; args: string[] }>;
    expect(second?.args).toContain("--resume");
    const exit = (lines(exits) as Array<{ pid: number; exitAt: number }>).find((x) => x.pid === first?.pid);
    expect(exit).toBeDefined();
    expect(second?.at).toBeGreaterThanOrEqual(exit?.exitAt as number);
  }, 20_000);
});
