import { type EngineEvent, type EngineTurnRequest, ScriptedEngine } from "@alca/engines";

/**
 * PERF-2026-11 (§3.3): the offline demo's engines. `ScriptedEngine` records
 * every request (full system prompt, user message, tool results) for tests;
 * a long `--engine demo` session grew by all of them without bound. The demo
 * keeps the newest DEMO_KEEP_REQUESTS (nothing in the app reads them).
 *
 * Not bounded here: ScriptedEngine's per-run pass counter (one number per
 * run, private to packages/engines; pruning it mid-run would replay a run's
 * first pass). Left to that package.
 */
export const DEMO_KEEP_REQUESTS = 32;

export class DemoEngine extends ScriptedEngine {
  override async *turn(req: EngineTurnRequest): AsyncIterable<EngineEvent> {
    // turn() records `req` first: trim to KEEP - 1 so it lands as the KEEP-th.
    for (const list of [this.requests, this.permissionAnswers] as unknown[][])
      if (list.length >= DEMO_KEEP_REQUESTS) list.splice(0, list.length - DEMO_KEEP_REQUESTS + 1);
    yield* super.turn(req);
  }
}
