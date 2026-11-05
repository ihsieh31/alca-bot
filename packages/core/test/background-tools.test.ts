// Mac test 2026-11-04b A8: the router called Claude Code's built-in CronCreate,
// which never asks the permission tool, and the schedule stayed inside the
// long-lived router process. Now no role has the scheduling / sub-agent tools
// (--tools allowlist on the router, --disallowedTools everywhere), the core
// denies them asked or not, and a process that ran one anyway is ended.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSettings } from "@alca/config";
import { FAKE_CLAUDE_SCRIPT, ScriptedEngine } from "@alca/engines";
import type { AlcaEvent } from "@alca/protocol";
import { openStore } from "@alca/store";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentSystem,
  AlcaCore,
  claudeAgentEngines,
  DEFAULT_PROFILE,
  ROUTER_BUILTIN_TOOLS,
  routerProfile,
  workerProfile,
} from "../src/index.ts";
import { ENGINE_NATIVE_TOOL, ROUTER_NATIVE_TOOL } from "../src/phases/infer.ts";
import { until } from "./agents-helpers.ts";
import { isType, makeCore, tool } from "./helpers.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function fakeCli(extraEnv: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "alca-bg-tools-"));
  const log = join(dir, "launches.ndjson");
  const store = openStore(":memory:");
  const settings = parseSettings({ permissions: { level: "autonomous" } });
  const notes = tool("read_note", "read", () => "ok");
  const engines = claudeAgentEngines({
    command: [process.execPath, "--disable-warning=ExperimentalWarning", FAKE_CLAUDE_SCRIPT],
    cwd: dir,
    store,
    routerProfile: routerProfile(DEFAULT_PROFILE),
    workerProfile: workerProfile(DEFAULT_PROFILE),
    workerToolNames: ["read_note"],
    baseEnv: { FAKE_CLAUDE_LOG: log, ...extraEnv },
  });
  const core = new AlcaCore({ store, engine: engines.router, settings: () => settings, tools: [notes] });
  const agents = new AgentSystem({
    core,
    routerEngine: engines.router,
    workerEngine: engines.worker,
    settings: () => settings,
    tickMs: 0,
  });
  const events: AlcaEvent[] = [];
  core.bus.subscribe("*", (e) => events.push(e));
  cleanups.push(
    async () => {
      await agents.close();
      await core.close();
    },
    () => rmSync(dir, { recursive: true, force: true }),
  );
  const lines = () =>
    readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { pid: number; args?: string[]; cron?: string });
  return { core, store, engines, events, lines };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const CRON = '[builtin:CronCreate {"cron":"30 9 * * *","recurring":true,"prompt":"每天 09:30 派工人"}]';

describe("A8: Claude Code's scheduling and sub-agent tools", () => {
  it("the router keeps only the question card; every launch removes CronCreate / Agent; the router cannot schedule", async () => {
    const { core, store, lines } = fakeCli();
    const t = core.createThread();
    await core.send(t.id, CRON).done;
    const said = store.threads.messages(t.id).filter((m) => m.role === "assistant");
    expect(said.at(-1)?.content).toBe("這個工作階段沒有 CronCreate 工具。");
    const launches = lines().filter((l) => l.args);
    const router = launches.find((l) => l.args!.includes("--tools"))!;
    expect(router.args![router.args!.indexOf("--tools") + 1]).toBe(ROUTER_BUILTIN_TOOLS.join(","));
    for (const l of launches) {
      const a = l.args!;
      expect(a.filter((x) => x === "--disallowedTools")).toHaveLength(1);
      const off = a[a.indexOf("--disallowedTools") + 1]!.split(",");
      for (const n of ["CronCreate", "CronDelete", "ScheduleWakeup", "Agent", "Task", "RemoteTrigger"])
        expect(off).toContain(n);
    }
    expect(lines().some((l) => l.cron)).toBe(false);
  }, 30_000);

  it("a CLI that runs CronCreate anyway: the run stops, says so, and the process holding the schedule is ended", async () => {
    const { core, store, engines, events, lines } = fakeCli({ FAKE_CLAUDE_IGNORE_TOOL_FLAGS: "1" });
    const t = core.createThread();
    await core.send(t.id, CRON).done;
    const err = await until(() =>
      events.find((e): e is Extract<AlcaEvent, { type: "error" }> => e.type === "error"),
    );
    expect(err.data.code).toBe(ROUTER_NATIVE_TOOL);
    expect(err.data.message).toMatch(/排程或子代理.*例行工作/);
    const job = lines().find((l) => l.cron);
    expect(job?.cron).toBe("30 9 * * *");
    // At b034304 the router process (and its session-only job) lived on.
    await until(() => !alive(job!.pid), 10_000);
    const routerKey = store.workers.routerSession(core.defaultBotId);
    expect(engines.router.hasProcess(routerKey)).toBe(false);
  }, 30_000);
});

class Releasing extends ScriptedEngine {
  readonly released: string[] = [];
  async release(key: string): Promise<void> {
    this.released.push(key);
  }
}

const owning = (steps: ConstructorParameters<typeof ScriptedEngine>[0]) =>
  new Releasing(steps, { capabilities: { ownsToolLoop: true, permissionPrompt: "mcp_tool" } });

describe("A8: the core denies them in every role, asked or not, at every level", () => {
  it("a worker's unasked Agent / CronCreate under 自主 stops the run and releases the process", async () => {
    for (const name of ["CronCreate", "Agent"]) {
      const engine = owning([
        [
          { type: "tool.call", id: "n1", name, input: { cron: "* * * * *", prompt: "x" } },
          { type: "tool.result", id: "n1", ok: true, output: "Scheduled" },
          { type: "done", stop: "end_turn" },
        ],
      ]);
      const { core, events } = makeCore(engine, { level: "autonomous" });
      const t = core.createThread("x");
      const end = await core.launch({
        threadId: t.id,
        text: "做",
        role: "worker",
        engine,
        tools: [],
        track: true,
      }).done;
      // At b034304 an unasked CronCreate under 自主 was "execute" the level allows: no breach.
      expect(end.finish?.error?.code, name).toBe(ENGINE_NATIVE_TOOL);
      expect(events.find(isType("error"))?.data.message).toMatch(/例行工作/);
      expect(engine.released).toHaveLength(1);
    }
  });

  it("an engine that asks before CronCreate is told no, with where scheduling lives", async () => {
    const engine = owning([
      [
        { type: "permission", call: { id: "p1", name: "CronCreate", input: { cron: "30 9 * * *" } } },
        { type: "done", stop: "end_turn" },
      ],
    ]);
    const { core, events } = makeCore(engine, { level: "autonomous" });
    await core.send(core.createThread("x").id, "排程").done;
    expect(engine.permissionAnswers[0]).toMatchObject({ behavior: "deny" });
    expect(String((engine.permissionAnswers[0] as { message?: string }).message)).toMatch(/例行工作/);
    expect(events.some((e) => e.type === "approval.requested")).toBe(false);
  });
});
