import { ScriptedEngine, streamText } from "@alca/engines";
import { checkSequence } from "@alca/protocol";
import { describe, expect, it } from "vitest";
import { buildStablePrompt, DEFAULT_PROFILE } from "../src/index.ts";
import { isType, makeCore, tool, types, waitFor } from "./helpers.ts";

describe("turn pipeline", () => {
  it("runs the phases in order and emits a valid, persisted event stream", async () => {
    const engine = new ScriptedEngine([streamText("你好，我是 Alca。", 3)]);
    const { core, store, events } = makeCore(engine);
    const t = core.createThread();
    const { runId, done } = core.send(t.id, "嗨");
    expect(await done).toBe("completed");
    expect(types(events)).toEqual([
      "run.started",
      "message.completed",
      "message.delta",
      "message.delta",
      "message.delta",
      "message.delta",
      "message.completed",
      "run.finished",
    ]);
    expect(checkSequence(events)).toMatchObject({ ok: true, openRuns: [] });
    expect(core.runEvents(runId)).toEqual(events);
    expect(core.messages(t.id).map((m) => [m.role, m.content])).toEqual([
      ["user", "嗨"],
      ["assistant", "你好，我是 Alca。"],
    ]);
    expect(core.traces.get(runId)?.map((s) => `${s.phase}:${s.verdict}`)).toEqual([
      "prepare:continue",
      "recall:continue",
      "infer:jump:reflect",
      "reflect:continue",
      "persist:halt",
    ]);
    expect(store.runs.get(runId)).toMatchObject({ status: "finished", finishReason: "completed" });
    expect(core.listThreads()[0]?.title).toBe("嗨");
  });

  it("keeps the stable prompt byte-identical across turns; memory goes in the user message", async () => {
    let clock = new Date("2026-11-03T08:00:00+08:00");
    const engine = new ScriptedEngine(() => streamText("ok"));
    const { core, store } = makeCore(engine, { now: () => clock, tools: [tool("read_note", "read")] });
    store.memory.add({
      botId: store.bots.ensureDefault().id,
      scope: "shared",
      kind: "preference",
      body: "使用者喜歡烏龍茶",
      origin: "user",
      confidence: 1,
      source: { kind: "ui" },
    });
    const t = core.createThread();
    await core.send(t.id, "推薦飲料").done;
    clock = new Date("2026-11-03T21:45:00+08:00");
    await core.send(t.id, "烏龍茶", { initiator: { kind: "schedule", id: "s" } }).done;
    const [a, b] = engine.requests;
    expect(a!.system.stable).toBe(b!.system.stable);
    expect(Buffer.from(a!.system.stable).equals(Buffer.from(b!.system.stable))).toBe(true);
    expect(a!.system.stable).toBe(buildStablePrompt(DEFAULT_PROFILE, ["read_note"]));
    expect(a!.system.volatile).not.toBe(b!.system.volatile);
    expect(b!.system.volatile).toContain("21:45");
    for (const r of [a!, b!]) {
      expect(r.system.stable).not.toMatch(/2026|烏龍茶|21:45|08:00/);
      expect(r.system.volatile).not.toContain("烏龍茶");
    }
    expect(b!.userMessage).toContain("<alca:recalled>");
    expect(b!.userMessage).toContain("使用者喜歡烏龍茶");
    expect(b!.userMessage.endsWith("烏龍茶")).toBe(true);
  });

  it("host-loop tools: read runs without asking and results feed the next pass", async () => {
    const read = tool("read_note", "read", (a) => `內容:${String(a.path)}`);
    const engine = new ScriptedEngine(({ pass, req }) =>
      pass === 0
        ? [
            { type: "tool.call", id: "e1", name: "read_note", input: { path: "/n/a.md" } },
            { type: "done", stop: "tool_use" },
          ]
        : streamText(`看到了 ${req.toolResults?.[0]?.output}`),
    );
    const { core, events } = makeCore(engine, { tools: [read] });
    const t = core.createThread();
    expect(await core.send(t.id, "讀筆記").done).toBe("completed");
    expect(read.calls).toEqual([{ path: "/n/a.md" }]);
    expect(engine.requests[1]?.toolResults).toEqual([{ id: "e1", ok: true, output: "內容:/n/a.md" }]);
    expect(events.find(isType("tool.completed"))?.data).toMatchObject({ ok: true, result: "內容:/n/a.md" });
    expect(core.messages(t.id).at(-1)?.content).toBe("看到了 內容:/n/a.md");
    expect(checkSequence(events).ok).toBe(true);
  });

  it("batches by path claims: two reads share a batch, a write to the same path does not", async () => {
    const { batchCalls } = await import("../src/index.ts");
    const mk = (callId: string, reads: string[], writes: string[]) =>
      ({
        callId,
        engineCallId: callId,
        tool: "t",
        args: {},
        actionClass: "read",
        claims: { reads, writes },
        status: "planned",
      }) as const;
    expect(
      batchCalls([mk("a", ["/x"], []), mk("b", ["/x"], []), mk("c", [], ["/x/y"]), mk("d", ["/z"], [])]),
    ).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("an engine error fails the run but still closes it", async () => {
    const engine = new ScriptedEngine([
      [
        { type: "error", code: "quota", message: "額度用完", retryable: false },
        { type: "done", stop: "error" },
      ],
    ]);
    const { core, events } = makeCore(engine);
    const t = core.createThread();
    const { runId, done } = core.send(t.id, "x");
    expect(await done).toBe("failed");
    expect(events.at(-1)).toMatchObject({ type: "run.finished", data: { reason: "failed" } });
    expect(core.jobs.byStatus("failed")).toHaveLength(1);
    expect(core.store.runs.get(runId)?.status).toBe("finished");
  });

  it("refuses a second turn while one runs, and interrupts cleanly", async () => {
    const engine = new ScriptedEngine(() => [
      { type: "text.delta", text: "開始…" },
      { type: "wait", ms: 10_000 },
    ]);
    const { core, events } = makeCore(engine);
    const t = core.createThread();
    const { done } = core.send(t.id, "慢慢來");
    await waitFor(events, isType("message.delta"));
    expect(() => core.send(t.id, "插隊")).toThrow(/already has a running turn/);
    expect(await core.interrupt(t.id)).toBe(true);
    expect(await done).toBe("interrupted");
    expect(events.at(-1)).toMatchObject({ type: "run.finished", data: { reason: "interrupted" } });
    expect(checkSequence(events).ok).toBe(true);
    expect(core.jobs.byStatus("cancelled")).toHaveLength(1);
  });

  it("always persists after a throwing phase, and refuses backward jumps", async () => {
    const { DEFAULT_PIPELINE } = await import("../src/index.ts");
    const engine = new ScriptedEngine(() => streamText("x"));
    const throwing = makeCore(engine, {
      pipeline: {
        ...DEFAULT_PIPELINE,
        recall: async () => {
          throw new Error("index broken");
        },
      },
    });
    const t = throwing.core.createThread();
    expect(await throwing.core.send(t.id, "a").done).toBe("failed");
    expect(types(throwing.events).slice(-2)).toEqual(["error", "run.finished"]);
    expect(checkSequence(throwing.events).ok).toBe(true);

    const backward = makeCore(engine, {
      pipeline: { ...DEFAULT_PIPELINE, reflect: async (state) => ({ kind: "jump", to: "prepare", state }) },
    });
    const t2 = backward.core.createThread();
    const { runId, done } = backward.core.send(t2.id, "b");
    await expect(done).rejects.toThrow(/backward jump/);
    expect(backward.store.runs.get(runId)?.status).toBe("finished");
  });
});
