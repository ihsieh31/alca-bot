import { describe, expect, it } from "vitest";
import { AppSource, type Candidate, isBulkMail, OFFER_SOURCE, scoreCandidate } from "../src/index.ts";
import { DAY, iso, proSetup, T0 } from "./proactive-helpers.ts";

// Gap analysis 2026-11 P5 / P6 / P7: promotional and social mail stays out,
// bulk mail needs to be about the person, and common words are not relevance.

const base = {
  now: new Date(T0),
  doable: 1,
  stats: { accepted: 0, total: 0 },
  suppress: [],
  evidenceUsed: false,
};
const cand = (fact: string, o: Partial<Candidate> = {}): Candidate => ({
  fact,
  action: "提醒你",
  category: "errand",
  evidenceIds: ["mail:x"],
  dueAt: iso(T0 + 0.5 * DAY),
  ...o,
});

describe("主動留意: mail noise (P6 / P7)", () => {
  it("promotions / social / forums mail is dropped; updates and no-reply senders are marked bulk", async () => {
    const src = new AppSource("mail", async () => ({
      complete: true,
      items: [
        {
          id: "p",
          title: "雙11 全館 5 折",
          from: "shop@store.example",
          labels: ["CATEGORY_PROMOTIONS", "UNREAD"],
        },
        { id: "s", title: "有人留言", from: "x@social.example", labels: ["CATEGORY_SOCIAL"] },
        { id: "u", title: "11 月電費帳單", from: "billing@power.example", labels: ["CATEGORY_UPDATES"] },
        { id: "n", title: "電子報", from: "Weekly <newsletter@media.example>" },
        { id: "h", title: "週五開會改時間", from: "王小明 <ming@example.org>", labels: ["INBOX"] },
      ],
    }));
    const r = await src.read({ botId: "b", cursor: {}, now: new Date(T0) });
    expect(r.ok && r.items.map((i) => [i.id, i.bulk ?? false])).toEqual([
      ["mail:u", true],
      ["mail:n", true],
      ["mail:h", false],
    ]);
    expect(isBulkMail({ from: "no-reply@bank.example" })).toBe(true);
    expect(isBulkMail({ from: "ming@example.org" })).toBe(false);
  });

  it("a 'sale ends tomorrow' bulk mail scores 0 even when the model proposes it", () => {
    const s = scoreCandidate({
      ...base,
      profile: [],
      candidate: cand("明天限時特價最後一天", { bulk: true }),
    });
    expect(s).toMatchObject({ total: 0, reason: "bulk" });
  });

  it("bulk mail unrelated to the person is dropped; a bill (money) still passes; related bulk mail passes", () => {
    expect(
      scoreCandidate({ ...base, profile: [], candidate: cand("包裹明天送達", { bulk: true }) }).reason,
    ).toBe("bulk");
    const bill = scoreCandidate({
      ...base,
      profile: [],
      candidate: cand("11 月電費明天截止", { bulk: true, category: "money_account", action: "整理繳費資料" }),
    });
    expect(bill.reason).toBeUndefined();
    expect(bill.total).toBeGreaterThanOrEqual(0.55);
    const related = scoreCandidate({
      ...base,
      profile: [{ subject: "x", body: "在等 iPad 保護殼的包裹" }],
      candidate: cand("iPad 保護殼包裹明天送達", { bulk: true }),
    });
    expect(related.reason).toBeUndefined();
  });

  it("the full path: a bulk promo through the mail source makes no card", async () => {
    const p = proSetup({
      answer: (ids) => [
        {
          fact: "會員日優惠明天結束",
          action: "提醒你下單",
          category: "errand",
          due_at: iso(T0 + DAY / 2),
          evidence_ids: [ids[0] as string],
        },
      ],
    });
    p.mail.items = [
      { id: "m1", title: "會員日優惠倒數", from: "noreply@shop.example", labels: ["CATEGORY_UPDATES"] },
    ];
    const r = await p.h.agents.proactive.scan(p.bot, { force: true });
    expect(r.outcome).toBe("no_candidate");
    expect(r.scores?.[0]?.score.reason).toBe("bulk");
    expect(p.calls[0]).toContain("大量寄送");
    expect(p.h.store.offers.list({ source: OFFER_SOURCE })).toHaveLength(0);
  });
});

describe("主動留意: relevance needs real words in common (P5)", () => {
  it("明天要上課 vs 明天特價 → relevance 0; three key words in common → 1; one or two → 0.5", () => {
    const profile = (body: string) => [{ subject: "s", body }];
    expect(
      scoreCandidate({ ...base, profile: profile("明天要上課"), candidate: cand("明天特價") }).relevance,
    ).toBe(0);
    expect(
      scoreCandidate({ ...base, profile: profile("報告時間"), candidate: cand("明天報告時間") }).relevance,
    ).toBe(0.5);
    expect(
      scoreCandidate({ ...base, profile: profile("在準備多益考試"), candidate: cand("多益考試報名截止") })
        .relevance,
    ).toBe(1);
  });
});
