import { describe, expect, it } from "vitest";
import { OFFER_SOURCE, PROACTIVE_IGNORE_HOURS } from "../src/index.ts";
import { DAY, HOUR, iso, proSetup, T0 } from "./proactive-helpers.ts";

// Gap analysis 2026-11 P14: each scan's candidates are logged (score parts,
// drop reason, outcome) and precision is exposed through the add-on view.

describe("主動留意 telemetry and precision", () => {
  it("logs every candidate of a scan with its outcome; the card links back", async () => {
    const p = proSetup({
      answer: (ids) => [
        {
          fact: "明天 10:00 看牙醫",
          action: "提醒帶健保卡",
          category: "errand",
          due_at: iso(T0 + DAY),
          evidence_ids: [ids[0] as string],
        },
        {
          fact: "下下週讀書會",
          action: "整理講義",
          category: "study",
          due_at: iso(T0 + 12 * DAY),
          evidence_ids: [ids[1] as string],
        },
        {
          fact: "會員日優惠",
          action: "提醒下單",
          category: "errand",
          due_at: iso(T0 + DAY),
          evidence_ids: [ids[2] as string],
        },
      ],
    });
    p.cal.items = [
      { id: "e1", title: "牙醫", startsAt: iso(T0 + DAY) },
      { id: "e2", title: "讀書會", startsAt: iso(T0 + 12 * DAY) },
    ];
    p.mail.items = [{ id: "m1", title: "會員日", from: "noreply@shop.example" }];
    const r = await p.h.agents.proactive.scan(p.bot, { force: true });
    expect(r.outcome).toBe("offered");
    const rows = p.h.store.proactiveLog.list(p.bot, new Date(0));
    expect(rows.map((x) => [x.outcome, x.dropReason]).sort()).toEqual([
      ["dropped", "bulk"],
      ["offered", null],
      ["watch", null],
    ]);
    const offered = rows.find((x) => x.outcome === "offered");
    expect(offered?.offerId).toBe(r.offer?.id);
    expect(offered).toMatchObject({ via: "scan", category: "errand", sources: ["calendar"], evidenceN: 1 });
    expect(offered?.total).toBeGreaterThanOrEqual(0.55);
    expect(new Set(rows.map((x) => x.scanId)).size).toBe(1);
  });

  it("accept / dismiss / ignored rates over 30 days, in the add-on's settings view", async () => {
    const p = proSetup();
    const facts = ["看牙醫", "繳房租", "交作業", "還書"];
    let n = 0;
    p.setAnswer((ids) => [
      {
        fact: `明天${facts[n++]}`,
        action: "提醒你",
        category: "errand",
        due_at: iso(p.now() + DAY),
        evidence_ids: [ids[0] as string],
      },
    ]);
    const offer = async (i: number) => {
      p.cal.items = [{ id: `e${i}`, title: facts[i] as string, startsAt: iso(p.now() + DAY) }];
      const r = await p.h.agents.proactive.scan(p.bot, { force: true });
      return r.offer?.id as string;
    };
    const a = await offer(0);
    p.h.agents.proactive.answer(a, "yes");
    p.advance(HOUR);
    const b = await offer(1);
    p.h.agents.proactive.answer(b, "later");
    p.advance(HOUR);
    await offer(2);
    p.advance((PROACTIVE_IGNORE_HOURS + 1) * HOUR);
    await p.h.agents.proactive.tick(); // the unanswered card → ignored
    const m = p.h.agents.proactive.metrics(p.bot);
    expect(m).toMatchObject({
      windowDays: 30,
      accepted: 1,
      declined: 1,
      ignored: 1,
      acceptRate: 0.333,
      dismissRate: 0.333,
      ignoredRate: 0.333,
    });
    expect(m.candidates).toBeGreaterThanOrEqual(3);
    const view = p.h.agents.addons.view(p.bot, "proactive");
    expect(view.metrics).toMatchObject({ acceptRate: 0.333, ignoredRate: 0.333 });
    expect(p.h.agents.addons.view(p.bot, "reply-check").metrics).toBeUndefined();
  }, 20_000);

  it("a queued card dropped at revalidation is logged as revalidated_out with its reason", async () => {
    const night = Date.parse("2026-11-04T15:00:00.000Z"); // 23:00 in Taipei
    const p = proSetup({
      at: night,
      answer: (ids) => [
        {
          fact: "明天 15:00 看牙醫",
          action: "提醒帶健保卡",
          category: "errand",
          due_at: iso(night + 16 * HOUR),
          evidence_ids: [ids[0] as string],
        },
      ],
    });
    p.cal.items = [{ id: "e1", title: "牙醫", startsAt: iso(night + 16 * HOUR) }];
    const r = await p.h.agents.proactive.scan(p.bot, { force: true });
    expect(r.outcome).toBe("queued");
    p.set(night + 3 * HOUR);
    p.cal.items = [];
    await p.h.agents.proactive.scan(p.bot, { force: true });
    p.set(night + 10 * HOUR);
    p.h.agents.proactive.release(p.bot);
    expect(p.h.store.proactiveLog.byOffer(r.offer?.id as string)).toMatchObject({
      outcome: "revalidated_out",
      dropReason: "gone",
    });
    expect(p.h.agents.proactive.metrics(p.bot).outcomes.revalidated_out).toBe(1);
    expect(p.h.store.offers.list({ source: OFFER_SOURCE })[0]?.status).toBe("expired");
  });
});
