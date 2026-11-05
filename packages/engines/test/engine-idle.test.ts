import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ClaudeCodeEngine,
  CodexAppServerEngine,
  DEFAULT_IDLE_MS,
  defaultIdleMs,
  type EngineEvent,
  type EngineTurnRequest,
  FAKE_CLAUDE_SCRIPT,
  FAKE_CODEX_APP_SERVER_SCRIPT,
  IdleReaper,
} from "../src/index.ts";

// Proactivity item 10: a persistent CLI engine releases a conversation's
// process after it sat idle (not mid-turn) past the limit, and the next turn
// resumes the kept session (Claude Code `--resume`, Codex `thread/resume`).

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "alca-idle-"));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
};

/** A hand-wound clock: the sweep is called directly, the timer never fires in a test. */
function clock() {
  let t = 1_000_000;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

/** Start a turn and wait until it streams text (the process is up and mid-turn); then collect the rest. */
async function midTurn(it: AsyncIterable<EngineEvent>): Promise<() => Promise<EngineEvent[]>> {
  const iter = it[Symbol.asyncIterator]();
  const out: EngineEvent[] = [];
  for (;;) {
    const r = await iter.next();
    if (r.done) throw new Error("the turn ended before it streamed");
    out.push(r.value);
    if (r.value.type === "text.delta") break;
  }
  return async () => {
    for (let r = await iter.next(); !r.done; r = await iter.next()) out.push(r.value);
    return out;
  };
}

async function collect(it: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const out: EngineEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const req = (text: string, o: Partial<EngineTurnRequest> = {}): EngineTurnRequest => ({
  threadId: "thr",
  runId: "run",
  sessionKey: "wkr",
  system: { stable: "穩定層", volatile: "" },
  userMessage: text,
  signal: new AbortController().signal,
  ...o,
});

const lines = (file: string) =>
  readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

describe("IdleReaper", () => {
  it("releases only conversations idle past the limit and not mid-turn", async () => {
    const c = clock();
    const released: string[] = [];
    const r = new IdleReaper(
      async (k) => {
        released.push(k);
      },
      { idleMs: 1000, sweepEveryMs: 3_600_000, now: c.now },
    );
    cleanups.push(() => r.stop());
    r.touch("a");
    r.begin("b");
    c.advance(500);
    r.touch("c");
    c.advance(600);
    expect(await r.sweep()).toEqual(["a"]);
    expect(r.lastUsedAt("a")).toBeUndefined();
    r.end("b"); // the idle clock starts when the turn ends
    c.advance(999);
    expect(await r.sweep()).toEqual(["c"]);
    c.advance(1);
    expect(await r.sweep()).toEqual(["b"]);
    expect(released).toEqual(["a", "c", "b"]);
    expect(r.released).toBe(3);
    expect(r.armed).toBe(false); // nothing left to watch: the timer is cleared
  });

  it("arms an unref'd timer on first use; stop clears it; 0 turns the sweep off", async () => {
    const r = new IdleReaper(async () => {}, { idleMs: 60_000 });
    expect(r.armed).toBe(false);
    r.touch("a");
    expect(r.armed).toBe(true);
    const timer = (r as unknown as { timer: NodeJS.Timeout }).timer;
    expect(timer.hasRef()).toBe(false);
    r.stop();
    expect(r.armed).toBe(false);
    const off = new IdleReaper(async () => {}, { idleMs: 0, now: () => 9e15 });
    off.touch("a");
    expect(off.armed).toBe(false);
    expect(await off.sweep()).toEqual([]);
  });

  it("ALCA_ENGINE_IDLE_MINUTES sets the default (10 min when unset or invalid)", () => {
    expect(DEFAULT_IDLE_MS).toBe(600_000);
    expect(defaultIdleMs({})).toBe(600_000);
    expect(defaultIdleMs({ ALCA_ENGINE_IDLE_MINUTES: "3" })).toBe(180_000);
    expect(defaultIdleMs({ ALCA_ENGINE_IDLE_MINUTES: "0" })).toBe(0);
    expect(defaultIdleMs({ ALCA_ENGINE_IDLE_MINUTES: "abc" })).toBe(600_000);
    expect(defaultIdleMs({ ALCA_ENGINE_IDLE_MINUTES: "-2" })).toBe(600_000);
  });
});

function claude() {
  const dir = tmp();
  const log = join(dir, "launches.ndjson");
  const sessions = new Map<string, string>();
  const c = clock();
  const engine = new ClaudeCodeEngine({
    command: [process.execPath, "--disable-warning=ExperimentalWarning", FAKE_CLAUDE_SCRIPT],
    launch: () => ({
      engineId: "claude-code",
      cwd: dir,
      stablePrompt: "穩定層",
      env: {},
      approvalMode: "default",
    }),
    sessions: { get: (t) => sessions.get(t), set: (t, s) => void sessions.set(t, s) },
    baseEnv: { FAKE_CLAUDE_LOG: log },
    interruptGraceMs: 2000,
    idle: { idleMs: 10 * 60_000, sweepEveryMs: 3_600_000, now: c.now },
  });
  cleanups.push(() => engine.dispose());
  return { engine, sessions, c, launches: () => lines(log) as Array<{ args: string[] }> };
}

describe("ClaudeCodeEngine: idle shutdown (fake CLI)", () => {
  it("an idle conversation's process is released and the next turn resumes its session", async () => {
    const { engine, sessions, c, launches } = claude();
    await collect(engine.turn(req("一")));
    expect(engine.hasProcess("wkr")).toBe(true);
    const sid = sessions.get("wkr");
    expect(sid).toBeTruthy();
    c.advance(9 * 60_000);
    expect(await engine.idle.sweep()).toEqual([]);
    expect(engine.hasProcess("wkr")).toBe(true);
    c.advance(60_000);
    expect(await engine.idle.sweep()).toEqual(["wkr"]);
    expect(engine.hasProcess("wkr")).toBe(false);
    const out = await collect(engine.turn(req("二")));
    expect(out.at(-1)).toMatchObject({ type: "done", stop: "end_turn" });
    const all = launches();
    expect(all).toHaveLength(2);
    const second = all[1]?.args ?? [];
    expect(second[second.indexOf("--resume") + 1]).toBe(sid);
  });

  it("a conversation mid-turn is never released, however long ago it started", async () => {
    const { engine, c } = claude();
    await collect(engine.turn(req("暖身")));
    const ac = new AbortController();
    const rest = await midTurn(engine.turn(req("[slow] 很長的回合", { signal: ac.signal })));
    c.advance(60 * 60_000);
    expect(await engine.idle.sweep()).toEqual([]);
    expect(engine.hasProcess("wkr")).toBe(true);
    ac.abort();
    await rest();
    expect(engine.idle.isBusy("wkr")).toBe(false);
    c.advance(10 * 60_000);
    expect(await engine.idle.sweep()).toEqual(["wkr"]);
  });

  it("dispose clears the sweep timer", async () => {
    const { engine } = claude();
    await collect(engine.turn(req("一")));
    expect(engine.idle.armed).toBe(true);
    await engine.dispose();
    expect(engine.idle.armed).toBe(false);
  });
});

function codex() {
  const dir = tmp();
  const log = join(dir, "log.jsonl");
  const store = new Map<string, string>();
  const c = clock();
  const e = new CodexAppServerEngine({
    command: [process.execPath, "--disable-warning=ExperimentalWarning", FAKE_CODEX_APP_SERVER_SCRIPT],
    launch: () => ({
      engineId: "codex",
      cwd: dir,
      stablePrompt: "穩定層",
      env: {},
      approvalMode: "workspace-write",
    }),
    sessions: { get: (k) => store.get(k), set: (k, v) => void store.set(k, v) },
    sandbox: "workspace-write",
    home: false,
    baseEnv: { FAKE_CODEX_AS_LOG: log },
    setupTimeoutMs: 5000,
    idle: { idleMs: 10 * 60_000, sweepEveryMs: 3_600_000, now: c.now },
  });
  cleanups.push(() => e.dispose());
  return { e, store, c, log: () => lines(log) as Array<{ method?: string; params?: unknown }> };
}

describe("CodexAppServerEngine: idle shutdown (fake app-server)", () => {
  it("an idle conversation's app-server is released and the next turn uses thread/resume", async () => {
    const { e, store, c, log } = codex();
    await collect(e.turn(req("一")));
    const thread = store.get("wkr");
    expect(thread).toMatch(/^thr_fake_/);
    c.advance(10 * 60_000);
    expect(await e.idle.sweep()).toEqual(["wkr"]);
    expect(e.hasProcess("wkr")).toBe(false);
    const out = await collect(e.turn(req("二")));
    expect(out.at(-1)).toMatchObject({ type: "done", stop: "end_turn" });
    expect(e.launches.get("wkr")).toBe(2);
    expect(log().find((m) => m.method === "thread/resume")?.params).toMatchObject({ threadId: thread });
  });

  it("a turn in progress keeps its app-server", async () => {
    const { e, c } = codex();
    const ac = new AbortController();
    const rest = await midTurn(e.turn(req("SLOW", { signal: ac.signal })));
    c.advance(60 * 60_000);
    expect(await e.idle.sweep()).toEqual([]);
    expect(e.hasProcess("wkr")).toBe(true);
    ac.abort();
    const out = await rest();
    expect(out.at(-1)).toMatchObject({ type: "done", stop: "interrupted" });
    await e.dispose();
    expect(e.idle.armed).toBe(false);
  });
});
