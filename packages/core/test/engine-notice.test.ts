import { CONTEXT_RESET, type EngineEvent, ScriptedEngine } from "@alca/engines";
import { checkSequence } from "@alca/protocol";
import { describe, expect, it } from "vitest";
import { isType, makeCore } from "./helpers.ts";

// Review 2026-11-05 #4: an engine's "notice" (the stored session could not be
// resumed) reaches the person in the bot's language and does not fail the turn.

const engine = () =>
  new ScriptedEngine((): EngineEvent[] => [
    { type: "notice", code: CONTEXT_RESET, message: "engine default" },
    { type: "text.delta", text: "好的" },
    { type: "done", stop: "end_turn" },
  ]);

describe("engine notices", () => {
  it("a context reset is shown as a retryable error in Chinese; the turn completes", async () => {
    const { core, events } = makeCore(engine());
    const t = core.createThread();
    expect(await core.send(t.id, "嗨").done).toBe("completed");
    const errs = events.filter(isType("error"));
    expect(errs).toHaveLength(1);
    expect(errs[0]?.data).toMatchObject({ code: CONTEXT_RESET, retryable: true });
    expect(errs[0]?.data.message).toMatch(/對話脈絡無法還原/);
    expect(checkSequence(events).ok).toBe(true);
  });

  it("in English for an English bot", async () => {
    const { core, store, events } = makeCore(engine());
    const bot = store.bots.ensureDefault();
    store.bots.update(bot.id, { language: "en" });
    const t = core.createThread(undefined, bot.id);
    expect(await core.send(t.id, "hi").done).toBe("completed");
    const msg = events.filter(isType("error"))[0]?.data.message ?? "";
    expect(msg).toMatch(/earlier context could not be restored/);
    expect(msg).not.toMatch(/[\p{Script=Han}]/u);
  });

  it("an unknown notice code passes the engine's own words", async () => {
    const { core, events } = makeCore(
      new ScriptedEngine((): EngineEvent[] => [
        { type: "notice", code: "engine.other", message: "引擎的話" },
        { type: "done", stop: "end_turn" },
      ]),
    );
    const t = core.createThread();
    await core.send(t.id, "嗨").done;
    expect(events.filter(isType("error"))[0]?.data.message).toBe("引擎的話");
  });
});
