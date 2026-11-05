// Fake-engine fixtures for scenarios: a core + agent system wired to scripted
// router / worker engines and recording host tools. Nothing here touches the
// network, a real model or the person's data; the store is in memory.
import { randomBytes } from "node:crypto";
import { type PermissionLevelT, parseSettings, type SettingsInput } from "@alca/config";
import {
  AgentSystem,
  AlcaCore,
  type HostTool,
  ROUTER_RULES_EN,
  type RoutineCheck,
  WORKER_RULES_EN,
} from "@alca/core";
import { type Script, ScriptedEngine, type ScriptStep, streamText } from "@alca/engines";
import type { AgentsEvent, AlcaEvent } from "@alca/protocol";
import { openStore, Sealer, type Store } from "@alca/store";

/**
 * Next round R7.9 (Phase F2): `ALCA_EVAL_SEALED=1` runs every scenario with
 * column encryption on (one data key per process, so a scenario that
 * reopens a file store reads it back). Behaviour must not change; CI runs
 * the evals once each way.
 */
export const EVAL_SEALED = process.env.ALCA_EVAL_SEALED === "1";
const EVAL_SEALER = EVAL_SEALED
  ? new Sealer({ current: 1, keys: { "1": randomBytes(32).toString("base64") } })
  : undefined;
let sealedStores = 0;

/**
 * Next round R9.6 (G2): `ALCA_EVAL_LANG=en` runs the scenarios with every bot
 * set to English (`bots.language = 'en'`), so the router and the workers get
 * the English rules. Behaviour must match the Chinese run; CI runs the
 * router, approval and memory groups this way.
 */
export const EVAL_LANG: "zh" | "en" = process.env.ALCA_EVAL_LANG === "en" ? "en" : "zh";
let englishTurns = 0;
if (EVAL_LANG === "en") {
  // Count the engine turns whose stable prompt carries the English router or worker rules.
  const marks = [ROUTER_RULES_EN[0], WORKER_RULES_EN[0]] as string[];
  const proto = ScriptedEngine.prototype as unknown as {
    stepsFor(req: { system: { stable: string } }): unknown;
  };
  const stepsFor = proto.stepsFor;
  proto.stepsFor = function (this: unknown, req) {
    if (marks.some((m) => req.system.stable.includes(m))) englishTurns += 1;
    return stepsFor.call(this, req);
  };
}
/** How many engine turns saw the English rules (the English run checks it is not 0). */
export const englishTurnCount = () => englishTurns;

/** Every store a scenario opens: in memory by default, sealed when `ALCA_EVAL_SEALED=1`, English bots when `ALCA_EVAL_LANG=en`. */
export function evalStore(path = ":memory:"): Store {
  const store = openStore(path, undefined, EVAL_SEALER ? { sealer: EVAL_SEALER } : {});
  if (store.sealer) sealedStores += 1;
  if (EVAL_LANG === "en")
    store.db.exec(`UPDATE bots SET language = 'en';
CREATE TEMP TRIGGER IF NOT EXISTS eval_bots_en AFTER INSERT ON bots BEGIN UPDATE bots SET language = 'en' WHERE id = NEW.id; END;`);
  return store;
}

/** How many stores were opened with the data key (the sealed run checks it is not 0). */
export const sealedStoreCount = () => sealedStores;

export const say = (t: string): ScriptStep[] => streamText(t, 16);
export const call = (id: string, name: string, input: Record<string, unknown>): ScriptStep[] => [
  { type: "tool.call", id, name, input },
  { type: "done", stop: "tool_use" },
];
/** Last line of a user message (the router's text / a worker's goal). */
export const lastLine = (s: string) => s.trim().split("\n").at(-1) ?? "";

export type RecordingTool = HostTool & { calls: Record<string, unknown>[] };

export function tool(
  name: string,
  actionClass: HostTool["actionClass"],
  run?: (args: Record<string, unknown>) => string,
): RecordingTool {
  const calls: Record<string, unknown>[] = [];
  return {
    calls,
    spec: { name, description: name, inputSchema: { type: "object" } },
    actionClass,
    run: async (args) => {
      calls.push(args);
      return run ? run(args) : `${name} ok`;
    },
  };
}

export const NOW = () => new Date("2026-11-03T08:00:00+08:00");

/** A core with no router (direct mode): one engine runs the turn and calls tools. */
export function directCore(
  engine: ScriptedEngine,
  o: { tools?: HostTool[]; level?: PermissionLevelT; rules?: unknown[] } = {},
) {
  const store = evalStore();
  const settings = parseSettings({ permissions: { level: o.level ?? "confirm_each_step" } });
  const core = new AlcaCore({
    store,
    engine,
    settings: () => settings,
    now: NOW,
    tools: o.tools ?? [],
    ...(o.rules ? { rules: () => o.rules as unknown[] } : {}),
  });
  const events: AlcaEvent[] = [];
  core.bus.subscribe("*", (e) => events.push(e));
  return { core, store, events, close: () => core.close() };
}

export interface Agents {
  core: AlcaCore;
  agents: AgentSystem;
  store: Store;
  router: ScriptedEngine;
  worker: ScriptedEngine;
  events: AlcaEvent[];
  agentEvents: AgentsEvent[];
  close(): Promise<void>;
}

/** Router + workers (the default desktop mode) over scripted engines. */
export function agentSystem(o: {
  router: Script;
  worker: Script;
  tools?: HostTool[];
  level?: PermissionLevelT;
  checks?: RoutineCheck[];
  rules?: unknown[];
  advanced?: NonNullable<SettingsInput["advanced"]>;
  workers?: NonNullable<SettingsInput["engineering"]>["workers"];
  /** P14: extra agent-system options (a clock, the add-on completion). */
  system?: Partial<ConstructorParameters<typeof AgentSystem>[0]>;
  /** A store to reuse (restart scenarios reopen a file-backed one). */
  store?: Store;
}): Agents {
  const store = o.store ?? evalStore();
  const settings = parseSettings({
    permissions: { level: o.level ?? "confirm_each_step" },
    engineering: {
      workers: { watchdogSec: 3600, ...o.workers },
      routines: { startDelaySec: 0 },
    },
    ...(o.advanced ? { advanced: o.advanced } : {}),
  });
  const router = new ScriptedEngine(o.router, { id: "router" });
  const worker = new ScriptedEngine(o.worker, { id: "worker" });
  const core = new AlcaCore({
    store,
    engine: router,
    settings: () => settings,
    now: NOW,
    tools: o.tools ?? [],
    ...(o.rules ? { rules: () => o.rules as unknown[] } : {}),
  });
  const agents = new AgentSystem({
    core,
    routerEngine: router,
    workerEngine: worker,
    settings: () => settings,
    tickMs: 0,
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
    router,
    worker,
    events,
    agentEvents,
    close: async () => {
      await agents.close();
      await core.close();
    },
  };
}

export async function until<T>(fn: () => T | undefined | false | null, ms = 8000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Like `until`, but resolves to undefined instead of throwing (for "this must NOT happen" checks). */
export async function within<T>(fn: () => T | undefined | false | null, ms: number): Promise<T | undefined> {
  try {
    return await until(fn, ms);
  } catch {
    return undefined;
  }
}

export type ApprovalRequested = Extract<AlcaEvent, { type: "approval.requested" }>;
export const approvals = (events: AlcaEvent[]): ApprovalRequested[] =>
  events.filter((e): e is ApprovalRequested => e.type === "approval.requested");

/** Run `fn` with a fixture and always close it. */
export async function using<T extends { close(): Promise<void> | void }>(
  f: T,
  fn: (f: T) => Promise<void>,
): Promise<void> {
  try {
    await fn(f);
  } finally {
    await f.close();
  }
}
