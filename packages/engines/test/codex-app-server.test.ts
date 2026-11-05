import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AppServerApprovalPolicy,
  type AppServerSandbox,
  CodexAppServerEngine,
  CodexEngine,
  checkHarnessFit,
  type Engine,
  type EngineEvent,
  type EngineTurnRequest,
  FAKE_CODEX_APP_SERVER_SCRIPT,
  FAKE_CODEX_SCRIPT,
  type PermissionRequest,
} from "../src/index.ts";

// Plan §3.3: the Codex app-server driver against `fake-codex-app-server`
// (NOT a real Codex CLI: the protocol was taken from the openai/codex docs and
// v2 types; DEVICE-TEST must still confirm it on a machine with Codex).

const engines: Engine[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(engines.splice(0).map((e) => e.dispose()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "alca-cas-"));
  dirs.push(d);
  return d;
};

const req = (text: string, o: Partial<EngineTurnRequest> = {}): EngineTurnRequest => ({
  threadId: "thr_A",
  runId: "run_1",
  sessionKey: "wkr_A",
  system: { stable: "你是 Alca 的工人。", volatile: "" },
  userMessage: text,
  signal: new AbortController().signal,
  ...o,
});

async function collect(it: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const out: EngineEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

function make(o: {
  sandbox: AppServerSandbox;
  policy?: AppServerApprovalPolicy;
  env?: Record<string, string>;
  fallback?: boolean;
  dir?: string;
}) {
  const dir = o.dir ?? tmp();
  const store = new Map<string, string>();
  const sessions = { get: (k: string) => store.get(k), set: (k: string, v: string) => void store.set(k, v) };
  const command = [process.execPath, "--disable-warning=ExperimentalWarning", FAKE_CODEX_APP_SERVER_SCRIPT];
  const launch = () => ({
    engineId: "codex",
    cwd: dir,
    stablePrompt: "穩定層",
    env: {},
    approvalMode: o.sandbox,
  });
  const e = new CodexAppServerEngine({
    command,
    launch,
    sessions,
    sandbox: o.sandbox,
    home: false,
    ...(o.policy ? { approvalPolicy: o.policy } : {}),
    ...(o.env ? { baseEnv: o.env } : {}),
    ...(o.fallback
      ? {
          fallback: new CodexEngine({
            command: [process.execPath, "--disable-warning=ExperimentalWarning", FAKE_CODEX_SCRIPT],
            launch,
            sessions,
            home: false,
          }),
        }
      : {}),
    setupTimeoutMs: 5000,
  });
  engines.push(e);
  return { e, dir, store };
}

describe("Codex app-server: coding (workspace-write + untrusted)", () => {
  it("a file change asks the host first; allowed → written, observed as apply_patch with its path", async () => {
    const { e, dir } = make({ sandbox: "workspace-write" });
    expect(checkHarnessFit(e, "coding")).toEqual({ ok: true });
    const asked: PermissionRequest[] = [];
    const out = await collect(
      e.turn(
        req("WRITE:a.txt=hello", {
          onPermission: async (p) => {
            asked.push(p);
            return { behavior: "allow" };
          },
        }),
      ),
    );
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      toolName: "apply_patch",
      input: { kind: "edit", paths: [join(dir, "a.txt")] },
    });
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("hello");
    const call = out.find((x) => x.type === "tool.call");
    expect(call).toMatchObject({ name: "apply_patch" });
    expect(out.find((x) => x.type === "tool.result")).toMatchObject({ ok: true });
    expect(out.at(-1)).toMatchObject({ type: "done", stop: "end_turn" });
  });

  it("denied → declined, nothing written; a command asks as `shell` with kind execute", async () => {
    const { e, dir } = make({ sandbox: "workspace-write" });
    const out = await collect(
      e.turn(req("WRITE:b.txt=x", { onPermission: async () => ({ behavior: "deny", message: "no" }) })),
    );
    expect(existsSync(join(dir, "b.txt"))).toBe(false);
    expect(out.find((x) => x.type === "tool.result")).toMatchObject({ ok: false });
    const asked: PermissionRequest[] = [];
    await collect(
      e.turn(
        req("RUN:npm test", {
          onPermission: async (p) => {
            asked.push(p);
            return { behavior: "allow" };
          },
        }),
      ),
    );
    expect(asked[0]).toMatchObject({ toolName: "shell", input: { command: "npm test", kind: "execute" } });
  });

  it("keeps one process and one thread across turns; usage is booked as deltas", async () => {
    const { e, store } = make({ sandbox: "workspace-write" });
    const a = await collect(e.turn(req("一")));
    const b = await collect(e.turn(req("二")));
    expect(e.launches.get("wkr_A")).toBe(1);
    const sa = a.find((x) => x.type === "session");
    const sb = b.find((x) => x.type === "session");
    expect(sa).toEqual(sb);
    expect(store.get("wkr_A")).toMatch(/^thr_fake_/);
    expect(b.find((x) => x.type === "usage")).toMatchObject({ inputTokens: 20, outputTokens: 9 });
    expect(
      b
        .filter((x) => x.type === "text.delta")
        .map((x) => (x as { text: string }).text)
        .join(""),
    ).toBe("echo: 二");
  });

  it("released, then resumed with thread/resume on a new process", async () => {
    const log = join(tmp(), "log.jsonl");
    const { e, store } = make({ sandbox: "workspace-write", env: { FAKE_CODEX_AS_LOG: log } });
    await collect(e.turn(req("一")));
    const thread = store.get("wkr_A");
    await e.release("wkr_A");
    await collect(e.turn(req("二")));
    expect(e.launches.get("wkr_A")).toBe(2);
    const msgs = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(msgs.find((m) => m.method === "thread/resume")?.params).toMatchObject({ threadId: thread });
    expect(msgs.some((m) => "jsonrpc" in m)).toBe(false);
    const start = msgs.find((m) => m.method === "thread/start")?.params;
    expect(start).toMatchObject({
      approvalPolicy: "untrusted",
      sandbox: "workspace-write",
      developerInstructions: "穩定層",
    });
  });

  it("interrupts a running turn with turn/interrupt; the thread survives", async () => {
    const { e } = make({ sandbox: "workspace-write" });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const out = await collect(e.turn(req("SLOW", { signal: ac.signal })));
    expect(out.at(-1)).toMatchObject({ type: "done", stop: "interrupted" });
    expect(e.hasProcess("wkr_A")).toBe(true);
    const next = await collect(e.turn(req("再一次")));
    expect(next.at(-1)).toMatchObject({ type: "done", stop: "end_turn" });
  });

  it("on-request does not ask for in-root writes, so the matrix makes it unfit for coding", async () => {
    const { e, dir } = make({ sandbox: "workspace-write", policy: "on-request" });
    expect(checkHarnessFit(e, "coding")).toMatchObject({ ok: false });
    const asked: string[] = [];
    await collect(
      e.turn(
        req("WRITE:c.txt=y", {
          onPermission: async (p) => {
            asked.push(p.toolName);
            return { behavior: "allow" };
          },
        }),
      ),
    );
    expect(asked).toEqual([]);
    expect(readFileSync(join(dir, "c.txt"), "utf8")).toBe("y");
  });
});

describe("Codex app-server: general (read-only)", () => {
  it("cannot write: the patch fails in the sandbox, nothing is asked or written", async () => {
    const { e, dir } = make({ sandbox: "read-only" });
    expect(checkHarnessFit(e, "general")).toEqual({ ok: true });
    expect(checkHarnessFit(e, "coding")).toMatchObject({ ok: false }); // native commands never ask
    const asked: string[] = [];
    const out = await collect(
      e.turn(
        req("WRITE:d.txt=z", {
          onPermission: async (p) => {
            asked.push(p.toolName);
            return { behavior: "allow" };
          },
        }),
      ),
    );
    expect(asked).toEqual([]);
    expect(existsSync(join(dir, "d.txt"))).toBe(false);
    expect(out.find((x) => x.type === "tool.result")).toMatchObject({ ok: false });
  });
});

describe("Codex app-server: capability probe", () => {
  it("no app-server: the general engine falls back to read-only `codex exec`", async () => {
    const { e } = make({ sandbox: "read-only", env: { FAKE_CODEX_AS_BROKEN: "1" }, fallback: true });
    expect(await e.probe()).toBe(false);
    expect(e.capabilities.harness).toMatchObject({ asksBeforeExec: "never", writes: "host_tools" });
    const out = await collect(e.turn(req("你好")));
    expect(out.some((x) => x.type === "text.delta")).toBe(true);
    expect(out.at(-1)).toMatchObject({ type: "done", stop: "end_turn" });
  });

  it("no app-server: the coding engine refuses the turn and becomes unfit for coding", async () => {
    const { e } = make({ sandbox: "workspace-write", env: { FAKE_CODEX_AS_NO_INIT: "1" } });
    expect(checkHarnessFit(e, "coding")).toEqual({ ok: true }); // optimistic before the probe
    const out = await collect(e.turn(req("WRITE:e.txt=1")));
    expect(out.find((x) => x.type === "error")).toMatchObject({ code: "engine.app_server_unavailable" });
    expect(out.at(-1)).toMatchObject({ type: "done", stop: "error" });
    expect(e.available).toBe(false);
    expect(checkHarnessFit(e, "coding")).toMatchObject({ ok: false });
  });
});
