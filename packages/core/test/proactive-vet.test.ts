import { describe, expect, it } from "vitest";
import { evidenceState, OFFER_SOURCE, PRESENCE_MAX, sameMatter, withPresence } from "../src/index.ts";
import { DAY, HOUR, iso, proSetup } from "./proactive-helpers.ts";

// Gap analysis 2026-11 P8 / P9 / P10: a queued card is revalidated before it
// is shown, and one matter seen through two sources becomes one card.

const NIGHT = Date.parse("2026-11-04T15:00:00.000Z"); // Wed 23:00 in Taipei
const MORNING = Date.parse("2026-11-05T01:00:00.000Z"); // Thu 09:00 in Taipei

const dentist = (ids: string[]) => [
  {
    fact: "明天 15:00 看牙醫",
    action: "提醒帶健保卡",
    category: "errand",
    due_at: iso(NIGHT + 16 * HOUR),
    evidence_ids: [ids[0] as string],
  },
];

describe("主動留意: a queued card is checked again before it is shown (P9)", () => {
  it("event cancelled overnight → the queued card expires instead of being shown", async () => {
    const p = proSetup({ at: NIGHT, settings: { quietHours: "22:00-08:00" }, answer: dentist });
    p.cal.items = [{ id: "e1", title: "牙醫", startsAt: iso(NIGHT + 16 * HOUR), version: "v1" }];
    const r = await p.h.agents.proactive.scan(p.bot, { force: true });
    expect(r.outcome).toBe("queued");
    // 02:00: the event is gone from a complete read.
    p.set(NIGHT + 3 * HOUR);
    p.cal.items = [];
    await p.h.agents.proactive.scan(p.bot, { force: true });
    p.set(MORNING);
    expect(p.h.agents.proactive.release(p.bot)).toBeUndefined();
    expect(p.h.store.offers.get(r.offer?.id as string)?.status).toBe("expired");
  });

  it("a page that may be cut off proves nothing: the card is still shown", async () => {
    const p = proSetup({ at: NIGHT, answer: dentist });
    p.cal.items = [{ id: "e1", title: "牙醫", startsAt: iso(NIGHT + 16 * HOUR) }];
    const r = await p.h.agents.proactive.scan(p.bot, { force: true });
    p.set(NIGHT + 3 * HOUR);
    p.cal.items = [];
    p.cal.complete = false;
    await p.h.agents.proactive.scan(p.bot, { force: true });
    p.set(MORNING);
    expect(p.h.agents.proactive.release(p.bot)?.id).toBe(r.offer?.id);
  });

  it("a suppress rule written while it waited → not shown", async () => {
    const p = proSetup({ at: NIGHT, answer: dentist });
    p.cal.items = [{ id: "e1", title: "牙醫", startsAt: iso(NIGHT + 16 * HOUR) }];
    const r = await p.h.agents.proactive.scan(p.bot, { force: true });
    expect(r.outcome).toBe("queued");
    p.h.agents.learning?.suppress(p.bot, "牙醫", "牙醫的事不用提醒我");
    p.set(MORNING);
    expect(p.h.agents.proactive.release(p.bot)).toBeUndefined();
    expect(p.h.store.offers.get(r.offer?.id as string)?.status).toBe("expired");
  });

  it("a moved event: the queued card about the old time expires", async () => {
    const p = proSetup({ at: NIGHT, answer: dentist });
    p.cal.items = [{ id: "e1", title: "牙醫", startsAt: iso(NIGHT + 16 * HOUR), version: "v1" }];
    const r = await p.h.agents.proactive.scan(p.bot, { force: true });
    p.set(NIGHT + HOUR);
    p.cal.items = [{ id: "e1", title: "牙醫", startsAt: iso(NIGHT + 4 * DAY), version: "v2" }];
    p.setAnswer(() => []);
    await p.h.agents.proactive.scan(p.bot, { force: true });
    p.set(MORNING);
    expect(p.h.agents.proactive.release(p.bot)).toBeUndefined();
    expect(p.h.store.offers.get(r.offer?.id as string)?.status).toBe("expired");
  });
});

describe("主動留意: one matter through two sources is one card (P8)", () => {
  const ev = { id: "e1", title: "產品週會", startsAt: iso(NIGHT + 35 * HOUR) };
  const ml = { id: "m1", title: "邀請：產品週會 @ 週五 10:00", from: "pm@example.org" };

  it("the event and its invitation mail in one scan → one card, the other a duplicate", async () => {
    const p = proSetup({
      answer: (ids) => [
        {
          fact: "週五 10:00 產品週會",
          action: "整理上週進度",
          category: "project",
          due_at: iso(NIGHT + 35 * HOUR),
          evidence_ids: [ids.find((i) => i.startsWith("cal:")) as string],
        },
        {
          fact: "產品週會邀請（週五）",
          action: "擬接受邀請的回覆",
          category: "project",
          due_at: iso(NIGHT + 35 * HOUR),
          evidence_ids: [ids.find((i) => i.startsWith("mail:")) as string],
        },
      ],
    });
    p.cal.items = [ev];
    p.mail.items = [ml];
    const r = await p.h.agents.proactive.scan(p.bot, { force: true });
    expect(r.outcome).toBe("offered");
    expect(r.scores?.[1]?.score.reason).toBe("duplicate");
    expect(p.h.agents.proactive.pump(p.bot)).toBeUndefined();
    expect(p.h.store.offers.list({ source: OFFER_SOURCE })).toHaveLength(1);
  });

  it("the mail arriving a scan later is a duplicate of the card already made", async () => {
    const p = proSetup({
      answer: (ids) => [
        {
          fact: "週五 10:00 產品週會",
          action: "整理上週進度",
          category: "project",
          due_at: iso(NIGHT + 35 * HOUR),
          evidence_ids: [ids[0] as string],
        },
      ],
    });
    p.cal.items = [ev];
    expect((await p.h.agents.proactive.scan(p.bot, { force: true })).outcome).toBe("offered");
    p.mail.items = [ml];
    p.setAnswer((ids) => [
      {
        fact: "產品週會邀請（週五）",
        action: "擬接受邀請的回覆",
        category: "project",
        due_at: iso(NIGHT + 35 * HOUR),
        evidence_ids: [ids.find((i) => i.startsWith("mail:")) as string],
      },
    ]);
    const again = await p.h.agents.proactive.scan(p.bot, { force: true });
    expect(again.outcome).toBe("no_candidate");
    expect(again.scores?.[0]?.score.reason).toBe("duplicate");
  });

  it("sameMatter: shared key words and a close date; common words alone do not count", () => {
    expect(
      sameMatter(
        { text: "週五 10:00 產品週會", dueAt: iso(NIGHT) },
        { text: "產品週會邀請", dueAt: iso(NIGHT + HOUR) },
      ),
    ).toBe(true);
    expect(
      sameMatter(
        { text: "明天 10:00 看牙醫", dueAt: iso(NIGHT) },
        { text: "明天要繳房租", dueAt: iso(NIGHT) },
      ),
    ).toBe(false);
    expect(
      sameMatter({ text: "產品週會", dueAt: iso(NIGHT) }, { text: "產品週會", dueAt: iso(NIGHT + 3 * DAY) }),
    ).toBe(false);
    expect(sameMatter({ text: "明天特價提醒" }, { text: "明天要上課提醒" })).toBe(false);
  });

  it("evidenceState: mail is never judged by presence; a calendar event past the window is not 'gone'", () => {
    const at = iso(NIGHT);
    const presence = { calendar: { ids: ["cal:a@v1"], at }, mail: { ids: [], at } };
    expect(evidenceState(presence, "mail:x")).toBeUndefined();
    expect(evidenceState(presence, "cal:a@v1")).toBeUndefined();
    expect(evidenceState(presence, "cal:a@v0")).toBe("changed");
    expect(evidenceState(presence, "cal:b", iso(NIGHT + DAY))).toBe("gone");
    expect(evidenceState(presence, "cal:b", iso(NIGHT + 20 * DAY))).toBeUndefined();
    expect(evidenceState({}, "cal:b")).toBeUndefined();
  });

  it("review #7: a card queued before ids carried a version is still there when the event is (not 'gone')", () => {
    const at = iso(NIGHT);
    const presence = { calendar: { ids: ["cal:a@v0123456789ab"], at } };
    expect(evidenceState(presence, "cal:a", iso(NIGHT + DAY))).toBeUndefined();
    // Versioned by Google's `updated` (before review #8): cannot tell a change either.
    expect(evidenceState(presence, "cal:a@2026-11-01T00:00:00.000Z", iso(NIGHT + DAY))).toBeUndefined();
    expect(evidenceState(presence, "cal:a@vffffffffffff", iso(NIGHT + DAY))).toBe("changed");
    expect(evidenceState(presence, "cal:gone", iso(NIGHT + DAY))).toBe("gone");
  });

  it("review #7: end to end, an unversioned queued card is shown once the event reads with a version", async () => {
    const p = proSetup({ at: NIGHT, answer: dentist });
    p.cal.items = [{ id: "e1", title: "牙醫", startsAt: iso(NIGHT + 16 * HOUR) }];
    const r = await p.h.agents.proactive.scan(p.bot, { force: true });
    expect(r.outcome).toBe("queued");
    expect(r.offer?.evidence[0]).not.toContain("@");
    p.set(NIGHT + HOUR);
    p.cal.items = [{ id: "e1", title: "牙醫", startsAt: iso(NIGHT + 16 * HOUR), version: "v0123456789ab" }];
    p.setAnswer(() => []);
    await p.h.agents.proactive.scan(p.bot, { force: true });
    p.set(MORNING);
    expect(p.h.agents.proactive.release(p.bot)?.id).toBe(r.offer?.id);
  });

  it("review #9: a read with more ids than presence keeps is not complete (nothing past the cut is 'gone')", () => {
    const ids = Array.from({ length: PRESENCE_MAX + 100 }, (_, i) => `cal:e${i}`);
    const now = new Date(NIGHT);
    const p = withPresence(
      {},
      "calendar",
      { ok: true, items: [], cursor: {}, present: { ids, complete: true } },
      now,
    );
    expect(p.calendar).toBeUndefined();
    expect(evidenceState(p, `cal:e${PRESENCE_MAX + 50}`, iso(NIGHT + DAY))).toBeUndefined();
    const small = withPresence(
      {},
      "calendar",
      { ok: true, items: [], cursor: {}, present: { ids: ids.slice(0, 3), complete: true } },
      now,
    );
    expect(small.calendar?.ids).toEqual(ids.slice(0, 3));
  });
});
