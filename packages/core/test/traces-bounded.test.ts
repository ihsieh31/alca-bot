import { ScriptedEngine, streamText } from "@alca/engines";
import { describe, expect, it } from "vitest";
import { TRACE_KEEP } from "../src/agent.ts";
import { makeCore } from "./helpers.ts";

describe("AlcaCore.traces (PERF-2026-11 patch 02)", () => {
  it("keeps the phase traces of the newest TRACE_KEEP runs only", async () => {
    const engine = new ScriptedEngine(() => streamText("ok"));
    const { core } = makeCore(engine);
    const t = core.createThread();
    const ids: string[] = [];
    for (let i = 0; i < TRACE_KEEP + 6; i++) {
      const { runId, done } = core.send(t.id, `第 ${i} 則`);
      ids.push(runId);
      expect(await done).toBe("completed");
      engine.requests.length = 0;
    }
    expect(core.traces.size).toBe(TRACE_KEEP);
    for (const id of ids.slice(0, 6)) expect(core.traces.has(id)).toBe(false);
    expect([...core.traces.keys()]).toEqual(ids.slice(6));
    expect(core.traces.get(ids.at(-1)!)?.at(-1)?.phase).toBe("persist");
  }, 60_000);
});
