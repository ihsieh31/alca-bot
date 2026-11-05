import { describe, expect, it } from "vitest";
import {
  type CandidateItem,
  decideCare,
  momentBlock,
  type PolicyInput,
  type Situation,
  situationOf,
  whenLabel,
} from "../src/index.ts";

// Care moments, step 3 (decision) and step 4 (the block). All cases fictional.
const TZ = "Asia/Taipei";
const NIGHT = new Date("2027-03-10T15:52:00Z"); // Wed 23:52 Taipei
const NOON = new Date("2027-03-10T04:00:00Z"); // Wed 12:00

function item(
  over: Partial<Omit<CandidateItem, "time">> & { time?: string | undefined } = {},
): CandidateItem {
  const { time, ...rest } = over;
  const base: CandidateItem = {
    memoryId: "mem_1",
    category: "exam",
    title: "鋼琴檢定",
    date: "2027-03-12",
    timeZone: TZ,
    at: new Date("2027-03-12T06:30:00Z").toISOString(),
    mentionedInThread: false,
    mentionedRecently: false,
    suppressed: false,
    ...rest,
  };
  const t = "time" in over ? time : "14:30";
  return t ? { ...base, time: t } : base;
}

const sit = (
  text: string,
  now = NIGHT,
  history: Parameters<typeof situationOf>[0]["history"] = [],
): Situation => situationOf({ text, now, timeZone: TZ, history });

function input(
  s: Situation,
  items: CandidateItem[] = [item()],
  over: Partial<PolicyInput> = {},
): PolicyInput {
  return {
    situation: s,
    now: NIGHT,
    timeZone: TZ,
    items,
    shownInThread: { event: false, rest: false },
    ...over,
  };
}

describe("care moments: decision policy (restraint first)", () => {
  it("midnight goodbye with an exam in two days: the exam is chosen, rest allowed, reason logged", () => {
    const d = decideCare(input(sit("都交給你了，我要睡了，晚安")));
    expect(d).toMatchObject({ kind: "event", reason: "chosen", moment: true, rest: true });
    expect(d.item).toMatchObject({ title: "鋼琴檢定", daysAway: 2 });
    expect(d.score).toBeCloseTo(0.85);
    const [block] = momentBlock(d, sit("都交給你了，我要睡了，晚安"));
    expect(block).toContain("<alca:moment>");
    expect(block).toContain("鋼琴檢定，後天（3/12 週五） 14:30");
    expect(block).toContain("不合適就什麼都不加");
    expect(block).not.toContain("mem_1");
  });

  it("no moment, no block: mid-task, quick questions and plain daytime messages", () => {
    for (const text of ["幫我把按鈕改成藍色", "還要多久？", "這個 API 怎麼用", "UI 要有質感一點"]) {
      const s = sit(text);
      const d = decideCare(input(s));
      expect(d, text).toMatchObject({ kind: "none", reason: "not-a-moment", moment: false });
      expect(momentBlock(d, s)).toEqual([]);
    }
  });

  it("each hard gate keeps it quiet, with its own reason", () => {
    const s = sit("今天先到這裡，掰");
    expect(decideCare(input(s, [item({ mentionedInThread: true })])).reason).toBe("no-event");
    expect(decideCare(input(s, [item({ mentionedInThread: true })])).scored[0]?.verdict).toBe(
      "already-mentioned",
    );
    expect(decideCare(input(s, [item({ mentionedRecently: true })])).scored[0]?.verdict).toBe(
      "recently-mentioned",
    );
    expect(decideCare(input(s, [item({ suppressed: true })])).reason).toBe("suppressed");
    expect(decideCare(input(s, [item()], { shownInThread: { event: true, rest: false } })).reason).toBe(
      "thread-cooldown",
    );
    expect(decideCare(input(s, [item()], { suppressedAll: true }))).toMatchObject({
      kind: "closing",
      reason: "suppressed",
    });
    expect(decideCare(input(sit("我阿嬤住院了，先睡了")))).toMatchObject({
      kind: "closing",
      reason: "heavy",
    });
    expect(decideCare(input(sit("晚安，明天幾點開會？"))).reason).toBe("question-pending");
    expect(decideCare(input(s, [item()], { memoryOff: true })).reason).toBe("memory-off");
  });

  it("window and importance: too far, past, medical, deadlines below the threshold", () => {
    const s = sit("我要睡了，晚安");
    const far = item({
      date: "2027-03-14",
      time: undefined,
      at: new Date("2027-03-14T15:59:00Z").toISOString(),
    });
    expect(decideCare(input(s, [far])).scored[0]?.verdict).toBe("too-far");
    const past = item({
      date: "2027-03-10",
      time: "09:00",
      at: new Date("2027-03-10T01:00:00Z").toISOString(),
    });
    expect(decideCare(input(s, [past])).scored[0]?.verdict).toBe("past");
    expect(decideCare(input(s, [item({ category: "medical" })])).scored[0]?.verdict).toBe("heavy-item");
    expect(decideCare(input(s, [item({ category: "deadline" })])).scored[0]?.verdict).toBe("below-threshold");
    // Today, no time said, and it is already afternoon: it may be over.
    const today = item({
      date: "2027-03-10",
      time: undefined,
      at: new Date("2027-03-10T15:59:00Z").toISOString(),
    });
    expect(decideCare(input(sit("先這樣，掰", NOON), [today], { now: NOON })).scored[0]?.verdict).toBe(
      "past",
    );
  });

  it("only one item: the best score wins, the rest are runners-up", () => {
    const talk = item({
      memoryId: "mem_2",
      category: "interview",
      title: "實習面試",
      date: "2027-03-11",
      time: "10:00",
      at: new Date("2027-03-11T02:00:00Z").toISOString(),
    });
    const d = decideCare(input(sit("我要睡了，晚安"), [item(), talk]));
    expect(d.item?.memoryId).toBe("mem_2"); // 1 × 1 × 1 > 1 × 0.85 × 1
    expect(d.scored.find((x) => x.memoryId === "mem_1")?.verdict).toBe("runner-up");
  });

  it("feedback weights move the score (an often-ignored kind drops below the threshold)", () => {
    const s = sit("我要睡了，晚安");
    const d = decideCare(input(s, [item()], { weights: { exam: 0.5 } }));
    expect(d.item).toBeUndefined();
    expect(d.scored[0]?.verdict).toBe("below-threshold");
    expect(d.kind).toBe("rest"); // still night and going to sleep: a rest line may fit
  });

  it("end of an exchange: an event can fit, rest does not; a weaker item stays quiet", () => {
    const history = [{ role: "assistant", content: "要我幫你查路線嗎？", createdAt: "2027-03-10T03:59:00Z" }];
    const s = sit("不用", NOON, history);
    expect(s.endOfExchange).toBe(true);
    const tomorrow = item({
      date: "2027-03-11",
      time: "09:00",
      at: new Date("2027-03-11T01:00:00Z").toISOString(),
    });
    expect(decideCare(input(s, [tomorrow], { now: NOON }))).toMatchObject({ kind: "event", rest: false });
    const trip = item({
      category: "trip",
      date: "2027-03-12",
      time: undefined,
      at: new Date("2027-03-12T15:59:00Z").toISOString(),
    });
    expect(decideCare(input(s, [trip], { now: NOON })).reason).toBe("below-threshold");
  });

  it("goodbye without events: plain close at daytime, a rest line at night (once per thread)", () => {
    expect(decideCare(input(sit("先這樣，掰", NOON), [], { now: NOON }))).toMatchObject({
      kind: "closing",
      reason: "no-event",
    });
    expect(decideCare(input(sit("我要睡了"), []))).toMatchObject({ kind: "rest", reason: "chosen-rest" });
    expect(decideCare(input(sit("我要睡了"), [], { shownInThread: { event: false, rest: true } })).kind).toBe(
      "closing",
    );
    expect(decideCare(input(sit("我要睡了"), [], { restSuppressed: true })).kind).toBe("closing");
  });

  it("an English user gets the English block", () => {
    const s = sit("Thanks, going to bed. Good night!");
    const d = decideCare(
      input(s, [
        item({
          title: "driving test",
          date: "2027-03-11",
          time: "09:00",
          at: new Date("2027-03-11T01:00:00Z").toISOString(),
        }),
      ]),
    );
    const [block] = momentBlock(d, s);
    expect(block).toContain("One thing that may fit: driving test, tomorrow (Thu, Mar 11) at 09:00.");
    expect(block).toContain("never say how you know");
    if (d.item) expect(whenLabel(d.item, "zh")).toBe("明天（3/11 週四） 09:00");
  });
});
