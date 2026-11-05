// Opt-in (ALCA_SMOKE_CLAUDE=1): the default router + worker mode on the real
// Claude Code CLI. The router must dispatch a worker through Alca's MCP tools
// and the worker must finish. Mac test 2026-11-04: Claude Code 2.1.316 loaded
// its MCP tools with the built-in ToolSearch first, which Alca took as the
// router acting on its own and stopped the turn; the plain reply smoke in
// cli-engines.smoke.ts could not see that. Read-only: one note is read.
import { parseSettings } from "@alca/config";
import {
  AgentSystem,
  AlcaCore,
  claudeAgentEngines,
  DEFAULT_PROFILE,
  type HostTool,
  routerProfile,
  workerProfile,
} from "@alca/core";
import type { AlcaEvent } from "@alca/protocol";
import { openStore } from "@alca/store";
import { afterAll, describe, expect, it } from "vitest";
import { env, tempDir } from "./helpers.ts";

const CLAUDE = env("ALCA_SMOKE_CLAUDE");
/** The error code a router turn stops with when it runs a native tool itself (phases/infer.ts). */
const ROUTER_NATIVE_TOOL = "router.native_tool";

async function until<T>(f: () => T | undefined | false, ms: number): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe.skipIf(!CLAUDE)("smoke × Claude Code router → worker (your own login)", () => {
  const tmp = tempDir("alca-smoke-router-");
  const store = openStore(":memory:");
  const settings = parseSettings({ permissions: { level: "autonomous" } });
  const reads: unknown[] = [];
  const readNote: HostTool = {
    spec: {
      name: "read_note",
      description: "Read one of the person's notes by title.",
      inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
    },
    actionClass: "read",
    run: async (a) => {
      reads.push(a);
      return "筆記「購物清單」：牛奶、雞蛋、吐司";
    },
  };
  const model = env("ALCA_SMOKE_CLAUDE_MODEL");
  const command = CLAUDE && CLAUDE !== "1" ? CLAUDE.split(/\s+/) : ["claude"];
  const engines = claudeAgentEngines({
    command,
    cwd: tmp.dir,
    store,
    routerProfile: routerProfile(DEFAULT_PROFILE),
    workerProfile: workerProfile(DEFAULT_PROFILE),
    workerToolNames: ["read_note"],
    ...(model ? { model: () => ({ router: model, worker: model }) } : {}),
  });
  const core = new AlcaCore({ store, engine: engines.router, settings: () => settings, tools: [readNote] });
  const agents = new AgentSystem({
    core,
    routerEngine: engines.router,
    workerEngine: engines.worker,
    settings: () => settings,
    tickMs: 0,
  });
  const events: AlcaEvent[] = [];
  core.bus.subscribe("*", (e) => events.push(e));
  afterAll(async () => {
    await agents.close();
    await core.close();
    tmp.done();
  });

  it("the router dispatches a worker, the worker reads the note, nobody is stopped", async () => {
    const t = core.createThread();
    const finish = await core.send(
      t.id,
      "請派一位工人用 read_note 讀取標題為「購物清單」的筆記，等它回報後告訴我內容。",
    ).done;
    const breach = events.find((e) => e.type === "error" && e.data.code === ROUTER_NATIVE_TOOL);
    expect(breach, "the router was stopped for a native tool (ToolSearch?)").toBeUndefined();
    expect(finish).toBe("completed");
    const w = await until(() => store.workers.byThread(t.id)[0], 60_000);
    await until(
      () => ["succeeded", "failed"].includes(store.workers.get(w.id)?.status ?? "") || undefined,
      180_000,
    );
    expect(store.workers.get(w.id)?.status).toBe("succeeded");
    expect(reads.length).toBeGreaterThan(0);
  }, 240_000);
});
