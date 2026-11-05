import { describe, expect, it } from "vitest";
import { openStore } from "../src/index.ts";

// Care moments: the care log (migration 32) keeps ids, words and numbers only.
describe("care log", () => {
  it("adds, lists by thread / memory / kind, reacts once, prunes, and drops odd words", () => {
    const s = openStore(":memory:");
    const t0 = new Date("2027-03-10T15:52:00Z");
    const shown = s.careLog.add(
      { botId: "b", threadId: "thr_1", kind: "shown", memoryId: "mem_1", category: "exam", score: 0.85 },
      t0,
    );
    s.careLog.add({ botId: "b", threadId: "thr_1", kind: "decision", reason: "chosen" }, t0);
    s.careLog.add(
      { botId: "b", threadId: "thr_2", kind: "mention", memoryId: "mem_1", category: "考試" },
      t0,
    );
    const since = new Date(t0.getTime() - 3600_000);
    expect(s.careLog.list({ botId: "b", since, threadId: "thr_1" })).toHaveLength(2);
    expect(s.careLog.list({ botId: "b", since, memoryId: "mem_1", kinds: ["mention"] })[0]?.category).toBe(
      "",
    );
    expect(s.careLog.react(shown, "positive", t0)).toBe(true);
    expect(s.careLog.react(shown, "negative", t0)).toBe(false);
    expect(s.careLog.get(shown)).toMatchObject({ reaction: "positive", score: 0.85 });
    expect(s.careLog.prune(new Date(t0.getTime() + 1))).toBe(3);
    s.close();
  });
});
