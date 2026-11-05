import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AcpEngine,
  type AcpEngineOptions,
  ClaudeCodeEngine,
  type Engine,
  type EngineEvent,
  type EngineTurnRequest,
  FAKE_ACP_SCRIPT,
  FAKE_CLAUDE_SCRIPT,
  GENERAL_DENIED_ACP_KINDS,
} from "../src/index.ts";

// P15 E / plan §3.2 / §3.4: an external engine per harness — a general worker
// has its native shell and file writes off (read back before anything runs);
// a coding worker keeps them, asking the host every time.

const engines: Engine[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(engines.splice(0).map((e) => e.dispose()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "alca-harness-"));
  dirs.push(d);
  return d;
};

const req = (text: string, o: Partial<EngineTurnRequest> = {}): EngineTurnRequest => ({
  threadId: "thr_A",
  runId: "run_1",
  sessionKey: "wkr_A",
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

function acp(o: Partial<AcpEngineOptions> & { env?: Record<string, string> }, approvalMode = "autonomous") {
  const dir = tmp();
  const store = new Map<string, string>();
  const e = new AcpEngine({
    id: "fake-acp",
    command: [process.execPath, "--disable-warning=ExperimentalWarning", FAKE_ACP_SCRIPT],
    launch: () => ({ engineId: "fake-acp", cwd: dir, stablePrompt: "", env: {}, approvalMode }),
    sessions: { get: (k) => store.get(k), set: (k, v) => void store.set(k, v) },
    modes: { confirm_each_step: ["default"], autonomous: ["auto_edit"] },
    ...(o.env ? { baseEnv: o.env } : {}),
    ...o,
  });
  engines.push(e);
  return { e, dir };
}

describe("general harness on an ACP agent", () => {
  it("refuses native edit / execute kinds without asking the host", async () => {
    const { e } = acp({ denyKinds: GENERAL_DENIED_ACP_KINDS, strictMode: true }, "confirm_each_step");
    const asked: string[] = [];
    const out = await collect(
      e.turn(
        req("PERMISSION", {
          onPermission: async (p) => {
            asked.push(p.toolName);
            return { behavior: "allow" };
          },
        }),
      ),
    );
    expect(asked).toEqual([]);
    expect(out.find((x) => x.type === "tool.result")).toMatchObject({ ok: false });
  });

  it("strict mode: a mode switch that fails refuses the work", async () => {
    const { e } = acp({ strictMode: true, env: { FAKE_ACP_SET_MODE_FAIL: "1" } });
    const out = await collect(e.turn(req("你好")));
    expect(out.find((x) => x.type === "error")?.type).toBe("error");
    expect(out.at(-1)).toMatchObject({ type: "done", stop: "error" });
  });
});

describe("coding harness on an ACP agent (asking mode)", () => {
  it("stays in the asking mode at the autonomous level: a native edit asks first, then writes", async () => {
    const { e, dir } = acp({ askingMode: true });
    const asked: Array<{ toolName: string; input: Record<string, unknown> }> = [];
    await collect(
      e.turn(
        req("WRITEFILE:n.txt=hi", {
          onPermission: async (p) => {
            asked.push(p);
            return { behavior: "allow" };
          },
        }),
      ),
    );
    expect(asked).toHaveLength(1);
    expect(asked[0]?.input).toMatchObject({ kind: "edit", paths: [join(dir, "n.txt")] });
    expect(readFileSync(join(dir, "n.txt"), "utf8")).toBe("hi");
  });

  it("without the asking mode the same agent writes unasked (auto_edit) — which the coding engine refuses", async () => {
    const plain = acp({});
    const asked: string[] = [];
    await collect(
      plain.e.turn(
        req("WRITEFILE:m.txt=1", {
          onPermission: async (p) => {
            asked.push(p.toolName);
            return { behavior: "allow" };
          },
        }),
      ),
    );
    expect(asked).toEqual([]);
    expect(existsSync(join(plain.dir, "m.txt"))).toBe(true);
    // An agent whose "asking" mode in fact edits unasked (a wrong mode map, a misbehaving agent):
    // the coding engine stops at the first native edit that never asked.
    const forced = acp({ askingMode: true, modes: { confirm_each_step: ["auto_edit"], autonomous: [] } });
    const out = await collect(
      forced.e.turn(req("WRITEFILE:o.txt=2", { onPermission: async () => ({ behavior: "allow" }) })),
    );
    expect(out.find((x) => x.type === "error")).toMatchObject({ code: "engine.unasked_native" });
    expect(out.at(-1)).toMatchObject({ type: "done" });
  });
});

function claude(o: { env?: Record<string, string>; disallow?: string[] }) {
  const dir = tmp();
  const sessions = new Map<string, string>();
  const e = new ClaudeCodeEngine({
    command: [process.execPath, "--disable-warning=ExperimentalWarning", FAKE_CLAUDE_SCRIPT],
    launch: () => ({
      engineId: "claude-code",
      cwd: dir,
      stablePrompt: "穩定層",
      env: {},
      approvalMode: "default",
      ...(o.disallow ? { extraArgs: ["--disallowedTools", o.disallow.join(",")] } : {}),
    }),
    sessions: { get: (k) => sessions.get(k), set: (k, s) => void sessions.set(k, s) },
    ...(o.env ? { baseEnv: o.env } : {}),
    interruptGraceMs: 2000,
    verifyInit: (init) =>
      init.tools?.some((t) => t === "Bash" || t === "Write") ? "一般工人不能有原生的 Bash／Write" : undefined,
  });
  engines.push(e);
  return e;
}

describe("general harness on Claude Code", () => {
  it("runs when the CLI confirms Bash and Write are gone", async () => {
    const out = await collect(claude({ disallow: ["Bash", "Write", "Edit"] }).turn(req("你好")));
    expect(out.some((x) => x.type === "error")).toBe(false);
    expect(out.at(-1)).toMatchObject({ type: "done" });
  });

  it("refuses the turn when the CLI still offers them (it ignored the flag)", async () => {
    const out = await collect(
      claude({ disallow: ["Bash", "Write"], env: { FAKE_CLAUDE_IGNORE_TOOL_FLAGS: "1" } }).turn(req("你好")),
    );
    expect(out.find((x) => x.type === "error")).toMatchObject({ code: "engine.mode_mismatch" });
    expect(out.at(-1)).toMatchObject({ type: "done", stop: "error" });
    expect(out.some((x) => x.type === "text.delta")).toBe(false);
  });
});
