import { type PermissionLevelT, parseSettings } from "@alca/config";
import type { Engine } from "@alca/engines";
import type { AlcaEvent } from "@alca/protocol";
import { openStore } from "@alca/store";
import { AlcaCore, type AlcaCoreOptions, type HostTool } from "../src/index.ts";

export function tool(
  name: string,
  actionClass: HostTool["actionClass"],
  run?: (args: Record<string, unknown>) => string,
): HostTool & { calls: Record<string, unknown>[] } {
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

export function makeCore(engine: Engine, opts: Partial<AlcaCoreOptions> & { level?: PermissionLevelT } = {}) {
  const store = opts.store ?? openStore(":memory:");
  const settings = parseSettings({ permissions: { level: opts.level ?? "confirm_each_step" } });
  const core = new AlcaCore({
    store,
    engine,
    settings: () => settings,
    now: () => new Date("2026-11-03T08:00:00+08:00"),
    ...opts,
  });
  const events: AlcaEvent[] = [];
  core.bus.subscribe("*", (e) => events.push(e));
  return { core, store, events };
}

/** Wait until an event matching `pred` has been published. */
export async function waitFor<T extends AlcaEvent>(
  events: AlcaEvent[],
  pred: (e: AlcaEvent) => e is T,
  ms = 3000,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const hit = events.find(pred);
    if (hit) return hit;
    if (Date.now() - start > ms) throw new Error("timed out waiting for event");
    await new Promise((r) => setTimeout(r, 5));
  }
}

export const isType =
  <K extends AlcaEvent["type"]>(type: K) =>
  (e: AlcaEvent): e is Extract<AlcaEvent, { type: K }> =>
    e.type === type;

export const types = (events: AlcaEvent[]) => events.map((e) => e.type);
