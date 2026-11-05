import type { ScriptContext } from "@alca/engines";
import { streamText } from "@alca/engines";
import type { AlcaEvent } from "@alca/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CARD_TYPES } from "../src/agents/system.ts";
import { call, type Harness, lastLine, makeAgents, say, until } from "./agents-helpers.ts";
import { tool } from "./helpers.ts";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
  vi.restoreAllMocks();
});

const LONG = "這是一段很長的串流文字，會被切成很多個 message.delta。".repeat(60);

function routerScript({ req, pass }: ScriptContext) {
  if (pass === 0 && !req.userMessage.includes("<alca:worker"))
    return [
      {
        type: "tool.call" as const,
        id: "r1",
        name: "worker_start",
        input: { title: "長文後刪除", goal: "long" },
      },
      { type: "done" as const, stop: "tool_use" as const },
    ];
  return say("好");
}

function workerScript({ req, pass }: ScriptContext) {
  if (pass > 0 && req.toolResults?.[0]?.id === "w-del") return say("刪好了。");
  if (lastLine(req.userMessage) === "long")
    return [...streamText(LONG, 4).filter((s) => s.type !== "text.end"), ...call("w-del", "delete_note", {})];
  return say("ok");
}

describe("pendingCards (PERF-2026-11 §6)", () => {
  it("covers every approval / question event type", () => {
    expect([...CARD_TYPES].sort()).toEqual([
      "approval.requested",
      "approval.resolved",
      "question.answered",
      "question.asked",
    ]);
  });

  it("replays a live worker's cards, read with a SQL type filter instead of every streamed event", async () => {
    h = makeAgents({ router: routerScript, worker: workerScript, tools: [tool("delete_note", "delete")] });
    const { core, agents, store, events } = h;
    const t = core.createThread("卡片");
    await core.send(t.id, "做吧").done;
    const card = await until(() =>
      events.find(
        (e): e is Extract<AlcaEvent, { type: "approval.requested" }> => e.type === "approval.requested",
      ),
    );
    const worker = store.workers.byThread(t.id)[0]!;
    const all = agents.workerEvents(worker.id);
    expect(all.filter((e) => e.type === "message.delta").length).toBeGreaterThan(100);

    const spy = vi.spyOn(store.runs, "events");
    const cards = agents.pendingCards(t.id);
    // Same answer as filtering everything by hand…
    expect(cards).toEqual(all.filter((e) => CARD_TYPES.includes(e.type)));
    expect(cards.map((e) => e.type)).toEqual(["approval.requested"]);
    expect((cards[0] as typeof card).data.approvalId).toBe(card.data.approvalId);
    // …but every read asked SQL for the card types only.
    expect(spy).toHaveBeenCalled();
    for (const c of spy.mock.calls) expect(c[2]?.types).toEqual(CARD_TYPES);

    core.answerApproval(card.data.approvalId, "approved");
    await until(() => store.workers.get(worker.id)?.status === "succeeded");
    expect(agents.pendingCards(t.id)).toEqual([]);
  }, 30_000);
});
