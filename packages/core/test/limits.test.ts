import { parseSettings } from "@alca/config";
import {
  type Engine,
  type EngineEvent,
  type EngineTurnRequest,
  SCRIPTED_CAPABILITIES,
  ScriptedEngine,
} from "@alca/engines";
import type { AlcaEvent } from "@alca/protocol";
import { openStore } from "@alca/store";
import { describe, expect, it } from "vitest";
import { AlcaCore, RunSlots, TurnClock } from "../src/index.ts";
import { isType, tool, waitFor } from "./helpers.ts";

/** An engine whose first `stuck` turns never end and ignore every interrupt; later turns answer. */
class StuckEngine implements Engine {
  readonly id = "stuck";
  readonly capabilities = SCRIPTED_CAPABILITIES;
  turns = 0;
  released: string[] = [];
  private readonly stuck: number;
  constructor(stuck = 1) {
    this.stuck = stuck;
  }
  async *turn(_req: EngineTurnRequest): AsyncIterable<EngineEvent> {
    this.turns++;
    if (this.turns <= this.stuck) await new Promise(() => undefined);
    yield { type: "text.delta", text: "好了" };
    yield { type: "text.end" };
    yield { type: "done", stop: "end_turn" };
  }
  async interrupt(): Promise<void> {
    // ignores it
  }
  async release(key: string): Promise<void> {
    this.released.push(key);
  }
  async dispose(): Promise<void> {}
}

function coreWith(engine: Engine, engineering: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const store = openStore(":memory:");
  const settings = parseSettings({ permissions: { level: "confirm_each_step" }, engineering });
  const core = new AlcaCore({ store, engine, settings: () => settings, forceCloseGraceMs: 50, ...extra });
  const events: AlcaEvent[] = [];
  core.bus.subscribe("*", (e) => events.push(e));
  return { core, store, events };
}

describe("turn timeout (engineering.turnTimeoutSec)", () => {
  it("closes a turn whose engine never answers and ignores its interrupt; the thread is usable again", async () => {
    const engine = new StuckEngine(1);
    const { core, store, events } = coreWith(engine, { turnTimeoutSec: 1 });
    const t = core.createThread("x");
    const first = core.send(t.id, "hi");
    expect(await first.done).toBe("failed");
    const err = events.find(isType("error"));
    expect(err?.data.code).toBe("turn.timeout");
    expect(err?.data.message).toContain("1 秒");
    expect(store.runs.get(first.runId)?.finishReason).toBe("failed");
    expect(core.isBusy(t.id)).toBe(false);
    expect(engine.released).toEqual([t.id]);
    const second = core.send(t.id, "again");
    expect(await second.done).toBe("completed");
    expect(core.messages(t.id).at(-1)?.content).toBe("好了");
  });

  it("an engine that does stop on the abort ends the run as failed with turn.timeout", async () => {
    const engine = new ScriptedEngine([
      [
        { type: "wait", ms: 5000 },
        { type: "done", stop: "end_turn" },
      ],
    ]);
    const { core, events } = coreWith(engine, { turnTimeoutSec: 1 });
    const t = core.createThread("x");
    const r = core.send(t.id, "hi");
    expect(await r.done).toBe("failed");
    const fin = events.filter(isType("run.finished"));
    expect(fin).toHaveLength(1);
    expect(fin[0]?.data.reason).toBe("failed");
  });

  it("time spent waiting for the person's approval is not counted", async () => {
    const write = tool("note_write", "write");
    const engine = new ScriptedEngine([
      [
        { type: "tool.call", id: "c1", name: "note_write", input: { text: "a" } },
        { type: "done", stop: "tool_use" },
      ],
      [{ type: "text.delta", text: "寫好了" }, { type: "text.end" }, { type: "done", stop: "end_turn" }],
    ]);
    const { core, events } = coreWith(engine, { turnTimeoutSec: 1 }, { tools: [write] });
    const t = core.createThread("x");
    const r = core.send(t.id, "write it");
    const card = await waitFor(events, isType("approval.requested"));
    await new Promise((res) => setTimeout(res, 1500));
    core.answerApproval(card.data.approvalId, "approved");
    expect(await r.done).toBe("completed");
    expect(write.calls).toHaveLength(1);
    expect(events.some((e) => e.type === "error")).toBe(false);
  });
});

describe("global run cap (engineering.maxConcurrentRuns)", () => {
  it("a second thread waits for a slot while the first runs", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let started = 0;
    const engine: Engine = {
      id: "gated",
      capabilities: SCRIPTED_CAPABILITIES,
      async *turn() {
        started++;
        if (started === 1) await gate;
        yield { type: "done", stop: "end_turn" };
      },
      interrupt: async () => undefined,
      dispose: async () => undefined,
    };
    const { core } = coreWith(engine, { maxConcurrentRuns: 1 });
    const a = core.createThread("a");
    const b = core.createThread("b");
    const ra = core.send(a.id, "one");
    await new Promise((r) => setTimeout(r, 30));
    const rb = core.send(b.id, "two");
    await new Promise((r) => setTimeout(r, 60));
    expect(started).toBe(1);
    expect(core.slots.waiting).toBe(1);
    release?.();
    expect(await ra.done).toBe("completed");
    expect(await rb.done).toBe("completed");
    expect(started).toBe(2);
    expect(core.slots.inUse).toBe(0);
  });

  it("a run waiting for an approval gives its slot back", async () => {
    const write = tool("note_write", "write");
    const engine = new ScriptedEngine(({ req, pass }) =>
      req.userMessage === "needs ok" && pass === 0
        ? [
            { type: "tool.call", id: "c1", name: "note_write", input: {} },
            { type: "done", stop: "tool_use" },
          ]
        : [{ type: "done", stop: "end_turn" }],
    );
    const { core, events } = coreWith(engine, { maxConcurrentRuns: 1 }, { tools: [write] });
    const a = core.createThread("a");
    const b = core.createThread("b");
    const ra = core.send(a.id, "needs ok");
    const card = await waitFor(events, isType("approval.requested"));
    const rb = core.send(b.id, "quick");
    expect(await rb.done).toBe("completed");
    core.answerApproval(card.data.approvalId, "approved");
    expect(await ra.done).toBe("completed");
  });

  it("an interrupt while queued ends the run without ever reaching the engine", async () => {
    const engine = new StuckEngine(5);
    const { core } = coreWith(engine, { maxConcurrentRuns: 1, turnTimeoutSec: 60 });
    const a = core.createThread("a");
    const b = core.createThread("b");
    core.send(a.id, "one").done.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 20));
    const rb = core.send(b.id, "two");
    await new Promise((r) => setTimeout(r, 20));
    expect(await core.interrupt(b.id)).toBe(true);
    expect(await rb.done).toBe("interrupted");
    expect(engine.turns).toBe(1);
  });
});

describe("RunSlots / TurnClock", () => {
  it("slots are FIFO, read their size live and reject an aborted waiter", async () => {
    let max = 1;
    const s = new RunSlots(() => max);
    const r1 = await s.acquire();
    const order: string[] = [];
    const ac = new AbortController();
    const p2 = s.acquire(ac.signal).then(() => order.push("aborted-one"));
    const p3 = s.acquire().then((r) => {
      order.push("three");
      return r;
    });
    ac.abort();
    await expect(p2).rejects.toThrow("aborted");
    max = 2;
    r1();
    (await p3)();
    expect(order).toEqual(["three"]);
    expect(s.inUse).toBe(0);
  });

  it("the clock only counts while running and nests pauses", async () => {
    let fired = 0;
    const c = new TurnClock(80, () => fired++);
    c.start();
    c.pause();
    c.pause();
    await new Promise((r) => setTimeout(r, 120));
    c.resume();
    expect(fired).toBe(0);
    c.resume();
    await new Promise((r) => setTimeout(r, 120));
    expect(fired).toBe(1);
    expect(c.hasExpired).toBe(true);
    c.stop();
  });
});

describe("RunSlots lanes", () => {
  it("workers leave one slot for conversations, and a queued turn goes before queued workers", async () => {
    const s = new RunSlots(() => 2);
    const w1 = await s.acquire(undefined, "worker");
    const order: string[] = [];
    const w2 = s.acquire(undefined, "worker").then((r) => {
      order.push("w2");
      return r;
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(order).toEqual([]); // the second slot is kept for a conversation
    const t1 = await s.acquire(undefined, "turn");
    const t2 = s.acquire(undefined, "turn").then((r) => {
      order.push("t2");
      return r;
    });
    w1();
    (await t2)();
    t1();
    (await w2)();
    expect(order).toEqual(["t2", "w2"]);
    expect(s.inUse).toBe(0);
  });
});
