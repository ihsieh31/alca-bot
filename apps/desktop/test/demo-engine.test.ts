import { describe, expect, it } from "vitest";
import { demoEngine } from "../src/demo.ts";
import { demoJudgeEngine, demoRouterEngine, demoWorkerEngine } from "../src/demo-agents.ts";
import { DEMO_KEEP_REQUESTS, DemoEngine } from "../src/demo-engine.ts";

const req = (i: number) =>
  ({
    threadId: "thread_demo",
    runId: `run_${i}`,
    system: { stable: "系統提示".repeat(500), volatile: "" },
    userMessage: "哈囉",
    signal: new AbortController().signal,
  }) as never;

describe("demo engines keep a bounded request log (PERF-2026-11 §3.3)", () => {
  it("every demo engine is a DemoEngine", () => {
    for (const e of [demoEngine(), demoRouterEngine(), demoWorkerEngine(), demoJudgeEngine()])
      expect(e).toBeInstanceOf(DemoEngine);
  });

  // The fast scripts (the chat demos stream with pauses, like a person typing).
  for (const [name, mk] of [
    ["demoWorkerEngine", () => demoWorkerEngine()],
    ["demoJudgeEngine", () => demoJudgeEngine()],
  ] as const)
    it(`${name} keeps the newest ${DEMO_KEEP_REQUESTS} requests`, async () => {
      const engine = mk();
      for (let i = 0; i < DEMO_KEEP_REQUESTS * 3; i++) {
        let n = 0;
        for await (const _ of engine.turn(req(i))) n++;
        expect(n).toBeGreaterThan(0);
        expect(engine.requests.length).toBeLessThanOrEqual(DEMO_KEEP_REQUESTS);
        expect(engine.requests.at(-1)?.runId).toBe(`run_${i}`);
      }
      expect(engine.requests).toHaveLength(DEMO_KEEP_REQUESTS);
      expect(engine.requests[0]?.runId).toBe(`run_${DEMO_KEEP_REQUESTS * 2}`);
    }, 30_000);
});
