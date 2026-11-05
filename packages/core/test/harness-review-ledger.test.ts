import type { Engine, ScriptContext, ScriptStep } from "@alca/engines";
import { WorkerState } from "@alca/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { reviewerEngine } from "../src/agents/harness-run/review.ts";
import { shownStatus } from "../src/agents/harness-run/view.ts";
import { call, type Harness, lastLine, makeAgents, say, until } from "./agents-helpers.ts";

/**
 * Mac test 2026-11 B4: every review (or skip) is in the dispatch ledger and
 * on the worker's panel, and an engine whose own tools can write reviews on
 * its read-only variant. Fictional tasks only.
 */

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const routerFor = ({ req, pass }: ScriptContext): ScriptStep[] => {
  if (req.userMessage.includes("<alca:worker")) return say("收到回報");
  return pass === 0
    ? call("s", "worker_start", { title: "整理清單", goal: lastLine(req.userMessage), harness: "general" })
    : say("派了");
};

function workerFor(verdicts: string[]) {
  let reviews = 0;
  let reports = 0;
  return ({ req, pass }: ScriptContext): ScriptStep[] => {
    if (req.userMessage.includes("<alca:review-goal>")) return say(verdicts[reviews++] ?? '{"met":true}');
    if (pass === 0) return call(`r${++reports}`, "report_result", { status: "done", summary: "整理好了" });
    return say("完成");
  };
}

async function run(verdicts: string[]) {
  h = makeAgents({ router: routerFor, worker: workerFor(verdicts), level: "autonomous" });
  const bot = h.store.bots.ensureDefault().id;
  h.store.bots.update(bot, { harness: JSON.stringify({ reviewer: true }) });
  const t = h.core.createThread();
  await h.core.send(t.id, "整理清單").done;
  await until(
    () =>
      h?.store.threads.messages(t.id).find((m) => m.role === "system" && m.content.includes("<alca:worker")),
    20_000,
  );
  const states = h.agents.workerStates(t.id);
  const last = states.at(-1);
  const dispatchId = last?.harness?.dispatchId as string;
  const kinds = h.store.dispatches.eventsOf(dispatchId, ["review.result", "review.skipped"]);
  return { last, kinds };
}

describe("review in the ledger and on the panel (B4)", () => {
  it("met: a review.result event, and the panel says 通過", async () => {
    const { last, kinds } = await run(['{"met":true,"gaps":[]}']);
    expect(kinds.map((e) => e.kind)).toEqual(["review.result"]);
    expect(kinds[0]?.detail).toMatchObject({ round: 1, met: true, gaps: [] });
    expect(last?.harness?.review).toEqual({ state: "met", round: 1 });
    expect(WorkerState.safeParse(last).success).toBe(true);
  }, 30_000);

  it("not met twice then met: each verdict is recorded; the last one shows", async () => {
    const no = '{"met":false,"gaps":["少了第三項"]}';
    const { last, kinds } = await run([no, '{"met":true}']);
    expect(kinds.map((e) => (e.detail as { met: boolean }).met)).toEqual([false, true]);
    expect(kinds[0]?.detail).toMatchObject({ gaps: ["少了第三項"] });
    expect(last?.harness?.review?.state).toBe("met");
  }, 30_000);

  it("gaps to the end: the panel shows 未達成 with the gaps", async () => {
    const no = '{"met":false,"gaps":["沒有排序"]}';
    const { last } = await run([no, no, no, no]);
    expect(last?.harness?.review).toMatchObject({ state: "gaps", gaps: ["沒有排序"] });
    expect(last?.status).toBe("needs_review");
  }, 30_000);

  it("an unreadable verdict is a review.skipped with its reason", async () => {
    const { last, kinds } = await run(["我覺得還行"]);
    expect(kinds.map((e) => e.kind)).toEqual(["review.skipped"]);
    expect(kinds[0]?.detail).toMatchObject({ reason: "no_verdict" });
    expect(last?.harness?.review).toEqual({ state: "skipped", round: 1, reason: "no_verdict" });
  }, 30_000);
});

const fake = (caps: Partial<Engine["capabilities"]>, variant?: () => Engine | undefined): Engine =>
  ({
    id: "x",
    capabilities: { ownsToolLoop: false, ...caps },
    ...(variant ? { readOnlyVariant: variant } : {}),
  }) as unknown as Engine;

describe("reviewerEngine (B4)", () => {
  it("an engine without its own tool loop, or with read-only native tools, reviews as it is", () => {
    const api = fake({ ownsToolLoop: false });
    expect(reviewerEngine(api)).toBe(api);
    const sandboxed = fake({ ownsToolLoop: true, nativeToolsReadOnly: true });
    expect(reviewerEngine(sandboxed)).toBe(sandboxed);
  });

  it("an engine whose native tools can write reviews on its read-only variant, or not at all", () => {
    const ro = fake({ ownsToolLoop: true, nativeToolsReadOnly: true });
    expect(reviewerEngine(fake({ ownsToolLoop: true }, () => ro))).toBe(ro);
    expect(reviewerEngine(fake({ ownsToolLoop: true }))).toBeUndefined();
    // a "variant" that can still write is never used
    expect(reviewerEngine(fake({ ownsToolLoop: true }, () => fake({ ownsToolLoop: true })))).toBeUndefined();
    expect(
      reviewerEngine(
        fake({ ownsToolLoop: true }, () => {
          throw new Error("x");
        }),
      ),
    ).toBeUndefined();
  });
});

describe("shownStatus (B6)", () => {
  it("a finished execution shows what its task is waiting on or why it fell short", () => {
    expect(shownStatus("succeeded", "waiting_input")).toBe("waiting");
    expect(shownStatus("succeeded", "waiting_event")).toBe("waiting");
    for (const p of ["blocked", "unverified", "partial", "needs_review"] as const)
      expect(shownStatus("succeeded", p)).toBe("needs_review");
    expect(shownStatus("succeeded", "failed")).toBe("failed");
    expect(shownStatus("succeeded", "expired")).toBe("stopped");
    expect(shownStatus("succeeded", "done")).toBe("succeeded");
    expect(shownStatus("succeeded", "continued")).toBe("succeeded");
    expect(shownStatus("succeeded", undefined)).toBe("succeeded");
    expect(shownStatus("running", "verifying")).toBe("running");
    expect(shownStatus("failed", "done")).toBe("failed");
  });
});
