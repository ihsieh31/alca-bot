import type { ScriptContext, ScriptStep } from "@alca/engines";
import { afterEach, describe, expect, it } from "vitest";
import {
  type DecideState,
  decideNext,
  MAX_STALLED_TURNS,
  ruleStall,
} from "../src/agents/harness-run/decide.ts";
import { RunTally } from "../src/agents/harness-run/tally.ts";
import { freshRetryBudget, type HostTool } from "../src/index.ts";
import { call, type Harness, lastLine, makeAgents, say, until } from "./agents-helpers.ts";

/**
 * Research audit A4: three turns in a row that try tools, get none to
 * succeed and change nothing end the task as partial, with the reason.
 * Fictional tasks only.
 */

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const routerFor = ({ req, pass }: ScriptContext): ScriptStep[] => {
  if (req.userMessage.includes("<alca:worker")) return say("收到回報");
  return pass === 0
    ? call("s", "worker_start", { title: "查", goal: lastLine(req.userMessage), harness: "general" })
    : say("派了");
};

const broken: HostTool = {
  spec: { name: "lookup", description: "lookup", inputSchema: { type: "object" } },
  actionClass: "read",
  run: async () => {
    throw new Error("來源暫時無法連線");
  },
};
const working: HostTool = {
  spec: { name: "peek", description: "peek", inputSchema: { type: "object" } },
  actionClass: "read",
  run: async () => "有資料",
};

const reportTo = (threadId: string) =>
  until(
    () =>
      h?.store.threads
        .messages(threadId)
        .find((m) => m.role === "system" && m.content.includes("<alca:worker")),
    20_000,
  );

describe("stall stop on the real path", () => {
  it("three turns of failing calls end the task partial with the reason", async () => {
    let turns = 0;
    const worker = ({ pass }: ScriptContext): ScriptStep[] => {
      if (pass === 0) {
        turns++;
        return call(`l${turns}`, "lookup", { q: "x" });
      }
      return say("查不到，再試一次");
    };
    h = makeAgents({ router: routerFor, worker, tools: [broken], level: "autonomous" });
    const t = h.core.createThread();
    await h.core.send(t.id, "查資料").done;
    const msg = (await reportTo(t.id)).content;
    expect(turns).toBe(MAX_STALLED_TURNS);
    expect(msg).toContain("partial");
    expect(msg).toContain("連續 3 輪嘗試工具都沒有成功");
  }, 30_000);

  it("a successful call in between resets the count; the reminders end it as before", async () => {
    let turns = 0;
    const worker = ({ pass }: ScriptContext): ScriptStep[] => {
      if (pass === 0) {
        turns++;
        return call(`c${turns}`, turns === 2 ? "peek" : "lookup", { q: "x" });
      }
      return say("還在查");
    };
    h = makeAgents({ router: routerFor, worker, tools: [broken, working], level: "autonomous" });
    const t = h.core.createThread();
    await h.core.send(t.id, "查資料").done;
    const msg = (await reportTo(t.id)).content;
    expect(turns).toBe(3);
    expect(msg).not.toContain("嘗試工具都沒有成功");
  }, 30_000);
});

describe("stall counting", () => {
  it("counts turns with failed calls only; text-only turns neither count nor reset", () => {
    const t = new RunTally("general");
    const turn = (calls: Array<[string, boolean]>) => {
      t.turnStarted();
      calls.forEach(([tool, ok], i) => {
        t.requested(`c${i}`, tool, {});
        t.completed(`c${i}`, ok, ok ? "ok" : "error");
      });
      t.turnEnded();
    };
    turn([["lookup", false]]);
    turn([]);
    expect(t.stalledTurns).toBe(1);
    turn([["lookup", false]]);
    expect(t.stalledTurns).toBe(2);
    turn([["peek", true]]);
    expect(t.stalledTurns).toBe(0);
  });

  it("ruleStall ends a stalled run without a report only", () => {
    const base: DecideState = {
      harness: "general",
      stopping: false,
      awaiting: false,
      finish: { reason: "completed" },
      ownsToolLoop: false,
      retry: freshRetryBudget(),
      overflowCompacted: false,
      budgetHit: false,
      budgetPass: false,
      handedOff: false,
      verifyStale: false,
      verifyRounds: 0,
      checksAvailable: false,
      inbox: 0,
      reminders: 0,
      stalledTurns: 3,
    };
    expect(decideNext(base)).toEqual({ kind: "end", why: "stalled" });
    expect(ruleStall({ ...base, stalledTurns: 2 })).toBeUndefined();
    expect(ruleStall({ ...base, report: "partial" })).toBeUndefined();
  });
});
