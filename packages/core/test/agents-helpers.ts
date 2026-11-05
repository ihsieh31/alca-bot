import { type PermissionLevelT, parseSettings, type SettingsInput } from "@alca/config";
import { type Script, ScriptedEngine, type ScriptStep, streamText } from "@alca/engines";
import type { AgentsEvent, AlcaEvent } from "@alca/protocol";
import { openStore, type Store } from "@alca/store";
import { AgentSystem, AlcaCore, type HostTool, type RoutineCheck, type SemanticJudge } from "../src/index.ts";

export const say = (t: string): ScriptStep[] => streamText(t, 8);
export const call = (id: string, name: string, input: Record<string, unknown>): ScriptStep[] => [
  { type: "tool.call", id, name, input },
  { type: "done", stop: "tool_use" },
];

/** Last line of the user message (where the router's text / the worker's goal is). */
export const lastLine = (s: string) => s.trim().split("\n").at(-1) ?? "";

export interface Harness {
  core: AlcaCore;
  agents: AgentSystem;
  store: Store;
  events: AlcaEvent[];
  agentEvents: AgentsEvent[];
  close(): Promise<void>;
}

export function makeAgents(o: {
  router: Script;
  worker: Script;
  tools?: HostTool[];
  level?: PermissionLevelT;
  workers?: NonNullable<SettingsInput["engineering"]>["workers"];
  routines?: NonNullable<SettingsInput["engineering"]>["routines"];
  earlyWork?: NonNullable<SettingsInput["engineering"]>["earlyWork"];
  checks?: RoutineCheck[];
  rules?: unknown[];
  judge?: SemanticJudge;
  store?: Store;
  routerCapabilities?: ConstructorParameters<typeof ScriptedEngine>[1];
  /** Read on every call, so a test can flip a setting (e.g. the learning switch). */
  advanced?: () => NonNullable<SettingsInput["advanced"]>;
  level$?: () => PermissionLevelT;
  /** Extra agent-system options (P14: clock, add-on completion, sources). */
  system?: Partial<ConstructorParameters<typeof AgentSystem>[0]>;
}): Harness {
  const store = o.store ?? openStore(":memory:");
  const make = () =>
    parseSettings({
      permissions: { level: o.level$?.() ?? o.level ?? "confirm_each_step" },
      engineering: {
        workers: { watchdogSec: 3600, ...o.workers },
        routines: { startDelaySec: 0, ...o.routines },
        ...(o.earlyWork ? { earlyWork: o.earlyWork } : {}),
      },
      ...(o.advanced ? { advanced: o.advanced() } : {}),
    });
  const fixed = make();
  const live = !!(o.advanced || o.level$);
  const settings = live ? make() : fixed;
  const routerEngine = new ScriptedEngine(o.router, { id: "router", ...o.routerCapabilities });
  const workerEngine = new ScriptedEngine(o.worker, { id: "worker" });
  const core = new AlcaCore({
    store,
    engine: routerEngine,
    settings: () => (live ? make() : settings),
    tools: o.tools ?? [],
    ...(o.rules ? { rules: () => o.rules as unknown[] } : {}),
  });
  const agents = new AgentSystem({
    core,
    routerEngine,
    workerEngine,
    settings: () => (live ? make() : settings),
    tickMs: 0,
    ...(o.judge ? { judge: o.judge } : {}),
    ...(o.checks ? { checks: o.checks } : {}),
    ...o.system,
  });
  const events: AlcaEvent[] = [];
  const agentEvents: AgentsEvent[] = [];
  core.bus.subscribe("*", (e) => events.push(e));
  agents.subscribe((e) => agentEvents.push(e));
  return {
    core,
    agents,
    store,
    events,
    agentEvents,
    close: async () => {
      await agents.close();
      await core.close();
    },
  };
}

export async function until<T>(fn: () => T | undefined | false, ms = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
