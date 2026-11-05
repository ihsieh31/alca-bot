import { describe, expect, it } from "vitest";
import { MAX_FAIL_STREAK, OFFER_SOURCE } from "../src/index.ts";
import { DAY, HOUR, iso, proSetup, T0 } from "./proactive-helpers.ts";

// Gap analysis 2026-11 P2 / P3: evidence is not lost on a failed candidate
// call, and paid-for runner-ups wait in a short queue instead of being dropped.

const ev = (id: string, title: string, at: number) => ({ id, title, startsAt: iso(at) });

describe("主動留意: a failed candidate call keeps the evidence (P2)", () => {
  it("throw → model_failed, the same evidence is offered again on the next scan", async () => {
    const p = proSetup();
    p.cal.items = [ev("e1", "牙醫", T0 + 2 * DAY)];
    p.setAnswer(() => new Error("timeout"));
    const first = await p.h.agents.proactive.scan(p.bot, { force: true });
    expect(first.outcome).toBe("model_failed");
    expect(first.errors?.join()).toContain("timeout");
    p.setAnswer((ids) => [
      {
        fact: "11/6 牙醫",
        action: "提醒帶健保卡",
        category: "errand",
        due_at: iso(T0 + 2 * DAY),
        evidence_ids: ids.slice(0, 1),
      },
    ]);
    const again = await p.h.agents.proactive.scan(p.bot, { force: true });
    expect(p.calls).toHaveLength(2);
    expect(p.calls[1]).toContain("id=cal:e1");
    expect(again.outcome).toBe("offered");
  });

  it("an answer that is not the JSON asked for keeps the evidence; after the retry bound it is let go", async () => {
    const p = proSetup();
    p.cal.items = [ev("e1", "牙醫", T0 + 2 * DAY)];
    p.setAnswer(() => "抱歉，我不確定");
    for (let i = 0; i < MAX_FAIL_STREAK; i++)
      expect((await p.h.agents.proactive.scan(p.bot, { force: true })).outcome).toBe("model_failed");
    expect(p.calls).toHaveLength(MAX_FAIL_STREAK);
    // Let go after the bound: nothing new now, no more paid calls.
    expect((await p.h.agents.proactive.scan(p.bot, { force: true })).outcome).toBe("quiet");
    expect(p.calls).toHaveLength(MAX_FAIL_STREAK);
  });

  it("a failure doubles the scan interval (backoff)", async () => {
    const p = proSetup();
    p.cal.items = [ev("e1", "牙醫", T0 + 2 * DAY)];
    p.setAnswer(() => new Error("down"));
    expect((await p.h.agents.proactive.scan(p.bot, { force: true })).outcome).toBe("model_failed");
    p.advance(31 * 60_000);
    expect((await p.h.agents.proactive.scan(p.bot)).outcome).toBe("not_due");
    p.advance(30 * 60_000);
    expect((await p.h.agents.proactive.scan(p.bot)).outcome).toBe("model_failed");
  });

  it("an empty candidate list is a real answer: the cursor moves", async () => {
    const p = proSetup();
    p.cal.items = [ev("e1", "牙醫", T0 + 2 * DAY)];
    expect((await p.h.agents.proactive.scan(p.bot, { force: true })).outcome).toBe("no_candidate");
    expect((await p.h.agents.proactive.scan(p.bot, { force: true })).outcome).toBe("quiet");
  });
});

describe("主動留意: runner-ups wait in a short queue (P3)", () => {
  it("two passing candidates → one card now, the other from the queue, no second model call", async () => {
    const p = proSetup();
    p.cal.items = [ev("e1", "牙醫", T0 + DAY), ev("e2", "繳房租", T0 + DAY)];
    p.setAnswer((ids) => [
      {
        fact: "明天 10:00 看牙醫",
        action: "提醒帶健保卡",
        category: "errand",
        due_at: iso(T0 + DAY),
        evidence_ids: [ids[0] as string],
      },
      {
        fact: "明天要繳房租",
        action: "整理轉帳資料",
        category: "money_account",
        due_at: iso(T0 + DAY),
        evidence_ids: [ids[1] as string],
      },
    ]);
    const r = await p.h.agents.proactive.scan(p.bot, { force: true });
    expect(r.outcome).toBe("offered");
    expect(p.h.store.offers.list({ source: OFFER_SOURCE })).toHaveLength(1);
    const pumped = p.h.agents.proactive.pump(p.bot);
    expect(["offered", "queued"]).toContain(pumped?.outcome);
    const offers = p.h.store.offers.list({ source: OFFER_SOURCE });
    expect(offers).toHaveLength(2);
    expect(new Set(offers.flatMap((o) => o.evidence))).toEqual(new Set(["cal:e1", "cal:e2"]));
    expect(p.calls).toHaveLength(1);
    // Nothing left in the queue.
    expect(p.h.agents.proactive.pump(p.bot)).toBeUndefined();
  });

  it("a runner-up expires after a day", async () => {
    const p = proSetup();
    p.cal.items = [ev("e1", "a", T0 + 5 * DAY), ev("e2", "b", T0 + 5 * DAY)];
    p.setAnswer((ids) => [
      {
        fact: "週一交報告",
        action: "排寫作進度",
        category: "study",
        due_at: iso(T0 + HOUR * 20),
        evidence_ids: [ids[0] as string],
      },
      {
        fact: "週一繳費",
        action: "整理繳費資料",
        category: "money_account",
        due_at: iso(T0 + 5 * DAY),
        evidence_ids: [ids[1] as string],
      },
    ]);
    // Homework running would hold the runner-up; here the winner is a card at once, so hold it by time.
    await p.h.agents.proactive.scan(p.bot, { force: true });
    p.advance(25 * HOUR);
    expect(p.h.agents.proactive.pump(p.bot)).toBeUndefined();
    expect(p.h.store.offers.list({ source: OFFER_SOURCE })).toHaveLength(1);
  });
});

describe("主動留意: items are re-scored as they come due (P4)", () => {
  const far = (ids: string[]) => [
    {
      fact: "11/14 交期末報告",
      action: "排寫作進度",
      category: "study",
      due_at: iso(T0 + 10 * DAY),
      evidence_ids: [ids[0] as string],
    },
  ];

  it("an exam 10 days out: no card now; at 3 days out it becomes one without a model call", async () => {
    const p = proSetup({ answer: far });
    p.cal.items = [{ id: "e9", title: "期末報告截止", startsAt: iso(T0 + 10 * DAY) }];
    const r = await p.h.agents.proactive.scan(p.bot, { force: true });
    expect(r.outcome).toBe("no_candidate");
    expect(r.scores?.[0]?.score.total).toBeLessThan(0.55);
    // A day later nothing changed: still under the threshold, not looked at again yet.
    p.advance(DAY);
    expect(p.h.agents.proactive.pump(p.bot)).toBeUndefined();
    // The 3-day checkpoint: re-scored, now over the threshold → a card; still one model call.
    p.set(T0 + 7 * DAY + 60_000);
    const later = p.h.agents.proactive.pump(p.bot);
    expect(later?.outcome).toBe("offered");
    expect(later?.scores?.[0]?.score.total).toBeGreaterThanOrEqual(0.55);
    expect(p.calls).toHaveLength(1);
    expect(p.h.store.offers.list({ source: OFFER_SOURCE })[0]?.evidence).toEqual(["cal:e9"]);
  });

  it("the agents clock does the re-scoring (tick)", async () => {
    const p = proSetup({ answer: far });
    p.cal.items = [{ id: "e9", title: "期末報告截止", startsAt: iso(T0 + 10 * DAY) }];
    await p.h.agents.proactive.scan(p.bot, { force: true });
    expect(p.h.store.offers.list({ source: OFFER_SOURCE })).toHaveLength(0);
    p.set(T0 + 7 * DAY + 60_000);
    await p.h.agents.proactive.tick();
    expect(p.h.store.offers.list({ source: OFFER_SOURCE })).toHaveLength(1);
  });

  it("a moved calendar event (new `updated`) is new evidence; an unchanged one is not", async () => {
    const p = proSetup({ answer: () => [] });
    p.cal.items = [{ id: "e1", title: "讀書會", startsAt: iso(T0 + 9 * DAY), version: "v1" }];
    await p.h.agents.proactive.scan(p.bot, { force: true });
    expect(p.calls[0]).toContain("id=cal:e1@v1");
    expect((await p.h.agents.proactive.scan(p.bot, { force: true })).outcome).toBe("quiet");
    p.cal.items = [{ id: "e1", title: "讀書會（改到明天）", startsAt: iso(T0 + DAY), version: "v2" }];
    p.setAnswer((ids) => [
      {
        fact: "讀書會改到明天",
        action: "提醒準備講義",
        category: "study",
        due_at: iso(T0 + DAY),
        evidence_ids: [ids[0] as string],
      },
    ]);
    const moved = await p.h.agents.proactive.scan(p.bot, { force: true });
    expect(p.calls[1]).toContain("id=cal:e1@v2");
    expect(moved.outcome).toBe("offered");
  });

  it("a cancelled event is not evidence", async () => {
    const p = proSetup({ answer: () => [] });
    p.cal.items = [{ id: "e1", title: "x", startsAt: iso(T0 + DAY), status: "cancelled" }];
    expect((await p.h.agents.proactive.scan(p.bot, { force: true })).outcome).toBe("quiet");
  });
});
