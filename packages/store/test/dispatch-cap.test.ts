import { describe, expect, it } from "vitest";
import { CAP_EXPIRE_MS, MAX_CONTINUES, openStore } from "../src/index.ts";

/** Design §0.2.5 (S10): the ledger side of 續做. */

const open = () => {
  const s = openStore(":memory:");
  const d = s.dispatches.open(
    { botId: "bot_a", threadId: "thr_a", harness: "coding", level: "autonomous" },
    1,
  );
  return { s, id: d.id };
};

/** One execution of `worker` that runs out of budget (with or without progress). */
function runOut(
  s: ReturnType<typeof open>["s"],
  id: string,
  worker: string,
  n: number,
  progress: boolean,
  t: number,
) {
  expect(s.dispatches.begin(id, worker, `${worker}:r`, t)).toBe(true);
  return s.dispatches.caps.exhaust(
    id,
    `${worker}:r`,
    "partial",
    { workerId: worker },
    { n, handoff: `/h/${id}-${n}.md`, progress },
    t,
  );
}

describe("dispatch caps (design §0.2.5)", () => {
  it("a budget run-out waits in needs_review, unfinished; only the fenced writer", () => {
    const { s, id } = open();
    s.dispatches.begin(id, "wkr_1", "wkr_1:r", 2);
    expect(
      s.dispatches.caps.exhaust(id, "old:r", "partial", {}, { n: 1, handoff: null, progress: true }, 3),
    ).toBe(false);
    expect(
      s.dispatches.caps.exhaust(id, "wkr_1:r", "partial", {}, { n: 1, handoff: "/h", progress: true }, 3),
    ).toBe(true);
    expect(s.dispatches.get(id)).toMatchObject({
      status: "needs_review",
      outcome: "partial",
      finishedAt: null,
    });
    expect(s.dispatches.caps.state(id)).toMatchObject({ continues: 0, waiting: true });
    expect(s.dispatches.caps.refusal(id)).toBeUndefined();
    expect(
      s.dispatches
        .events(id)
        .map((e) => e.kind)
        .slice(-2),
    ).toEqual(["reported", "cap.exhausted"]);
  });

  it("resume is a compare-and-set: one of two wins, and the continuation runs on the same dispatch", () => {
    const { s, id } = open();
    runOut(s, id, "wkr_1", 1, true, 2);
    expect(s.dispatches.caps.resume(id, "wkr_2", "user", 3)).toBe(1);
    expect(s.dispatches.caps.resume(id, "wkr_3", "router", 3)).toBeUndefined();
    expect(s.dispatches.get(id)).toMatchObject({ status: "queued", activeWorkerId: "wkr_2" });
    expect(s.dispatches.begin(id, "wkr_3", "wkr_3:r", 4)).toBe(false);
    expect(s.dispatches.begin(id, "wkr_2", "wkr_2:r", 4)).toBe(true);
  });

  it("the UPDATE is the compare-and-set itself: past a stale pre-check, only this waiting row moves", () => {
    const { s, id } = open();
    runOut(s, id, "wkr_1", 1, true, 2);
    const other = s.dispatches.open({ botId: "bot_a", threadId: "thr_a", level: "autonomous" }, 2);
    s.dispatches.begin(other.id, "wkr_9", "wkr_9:r", 2);
    s.dispatches.park(other.id, "interrupted_after_outward", 2);
    expect(s.dispatches.caps.resume(id, "wkr_2", "user", 3)).toBe(1);
    // A caller that read "waiting" before the first resume landed: the refusal no longer
    // stops it, so the UPDATE's WHERE (still waiting in needs_review) must.
    const caps = s.dispatches.caps;
    const real = caps.refusal.bind(caps);
    caps.refusal = () => undefined;
    try {
      expect(caps.resume(id, "wkr_3", "router", 4)).toBeUndefined();
      expect(s.dispatches.get(id)).toMatchObject({ status: "queued", activeWorkerId: "wkr_2" });
      expect(s.dispatches.events(id).filter((e) => e.kind === "continued")).toHaveLength(1);
      expect(s.dispatches.get(other.id)).toMatchObject({ status: "needs_review", finishedAt: null });
    } finally {
      caps.refusal = real;
    }
  });

  it("at most six continuations; the seventh is refused", () => {
    const { s, id } = open();
    let worker = "wkr_0";
    runOut(s, id, worker, 1, true, 10);
    for (let k = 1; k <= MAX_CONTINUES; k++) {
      const next = `wkr_${k}`;
      expect(s.dispatches.caps.resume(id, next, "user", 10 + k)).toBe(k);
      worker = next;
      runOut(s, id, worker, k + 1, true, 10 + k);
    }
    expect(s.dispatches.caps.refusal(id)).toBe(`已經續做 ${MAX_CONTINUES} 次了，不能再續做`);
    expect(s.dispatches.caps.resume(id, "wkr_x", "user", 99)).toBeUndefined();
    expect(s.dispatches.get(id)?.status).toBe("needs_review");
  });

  it("two continuations in a row without progress are refused (the first run does not count)", () => {
    const { s, id } = open();
    runOut(s, id, "wkr_0", 1, false, 10);
    expect(s.dispatches.caps.resume(id, "wkr_1", "user", 11)).toBe(1);
    runOut(s, id, "wkr_1", 2, false, 12);
    expect(s.dispatches.caps.refusal(id)).toBeUndefined();
    expect(s.dispatches.caps.resume(id, "wkr_2", "user", 13)).toBe(2);
    runOut(s, id, "wkr_2", 3, false, 14);
    expect(s.dispatches.caps.refusal(id)).toMatch(/最近兩次續做都沒有進展/);
    expect(s.dispatches.caps.resume(id, "wkr_3", "user", 15)).toBeUndefined();
  });

  it("72 hours without a continuation settles as budget; other needs_review rows are left alone", () => {
    const { s, id } = open();
    runOut(s, id, "wkr_1", 1, true, 100);
    const other = s.dispatches.open({ botId: "bot_a", threadId: "thr_a", level: "autonomous" }, 100);
    s.dispatches.begin(other.id, "wkr_9", "wkr_9:r", 100);
    s.dispatches.park(other.id, "interrupted_after_outward", 100);
    expect(s.dispatches.caps.expire(100 + CAP_EXPIRE_MS - 1)).toEqual([]);
    expect(s.dispatches.caps.expire(100 + CAP_EXPIRE_MS)).toEqual([id]);
    expect(s.dispatches.get(id)).toMatchObject({ status: "settled", outcome: "budget" });
    expect(s.dispatches.get(other.id)).toMatchObject({ status: "needs_review", finishedAt: null });
    expect(s.dispatches.caps.refusal(id)).toBe("這件工作已經結束或已經在續做了");
    expect(s.dispatches.events(id).at(-1)?.kind).toBe("cap.expired");
  });

  it("a claimed wait closes when its continuation runs out of budget", () => {
    const { s, id } = open();
    s.dispatches.begin(id, "wkr_1", "wkr_1:r", 2);
    const wt = s.dispatches.askInput(
      id,
      "wkr_1:r",
      {},
      { workerId: "wkr_1", questions: [], expiresAt: null },
      3,
    );
    expect(s.dispatches.claim(wt?.id as string, "wkr_2", 4, { answers: ["a"], by: "user" })).toBe(true);
    runOut(s, id, "wkr_2", 1, true, 5);
    expect(s.dispatches.wait(wt?.id as string)?.state).toBe("closed");
  });
});
