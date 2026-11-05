import { describe, expect, it } from "vitest";
import {
  candidateFromRemember,
  daysUntil,
  lifeBody,
  lifeInstant,
  lifeSubject,
  parseClock,
  parseLifeCancel,
  parseLifeEvent,
  parseLifeMemory,
  ruleExtract,
} from "../src/index.ts";

// Care moments, capture: every case is fictional. Wed 2027-03-10 21:00 in Taipei.
const NOW = new Date("2027-03-10T13:00:00Z");
const TZ = "Asia/Taipei";

describe("care moments: life timeline capture", () => {
  it("resolves relative days at capture time, in the person's zone, with the time when said", () => {
    const e = parseLifeEvent("我後天下午兩點半要考鋼琴檢定", NOW, TZ);
    expect(e).toMatchObject({
      title: "鋼琴檢定",
      category: "exam",
      date: "2027-03-12",
      time: "14:30",
      timeZone: TZ,
    });
    expect(e?.at).toBe(new Date("2027-03-12T06:30:00Z").toISOString());
    expect(parseLifeEvent("明天考試", NOW, TZ)).toMatchObject({ title: "考試", date: "2027-03-11" });
    expect(parseLifeEvent("下週一有面試", NOW, TZ)).toMatchObject({
      category: "interview",
      date: "2027-03-15",
    });
    expect(parseLifeEvent("3/20 要去札幌旅行", NOW, TZ)).toMatchObject({
      category: "trip",
      title: "札幌旅行",
      date: "2027-03-20",
    });
    expect(parseLifeEvent("I have my driving test tomorrow at 9am", NOW, TZ)).toMatchObject({
      category: "exam",
      title: "driving test",
      date: "2027-03-11",
      time: "09:00",
    });
    expect(parseLifeEvent("I fly to Lisbon on Friday", NOW, TZ)).toMatchObject({
      category: "trip",
      date: "2027-03-12",
    });
    // Another zone: 23:00 in New York is already the next day in Taipei; "tomorrow" is New York's.
    const ny = parseLifeEvent(
      "my interview is tomorrow at 10am",
      new Date("2027-03-11T04:00:00Z"),
      "America/New_York",
    );
    expect(ny).toMatchObject({ date: "2027-03-11", time: "10:00", timeZone: "America/New_York" });
  });

  it("is not an event: questions, wishes, things already done, deadlines (主動留意's)", () => {
    for (const s of [
      "明天要考試嗎",
      "希望明天不要考試",
      "今天考完試了",
      "明天要交報告",
      "如果下週有面試就好了",
    ])
      expect(parseLifeEvent(s, NOW, TZ), s).toBeUndefined();
  });

  it("reads clocks in Chinese numerals and English", () => {
    expect(parseClock("下午一點半")).toEqual({ hh: 13, mm: 30 });
    expect(parseClock("早上十點十五分")).toEqual({ hh: 10, mm: 15 });
    expect(parseClock("19:05")).toEqual({ hh: 19, mm: 5 });
    expect(parseClock("at 7pm")).toEqual({ hh: 19, mm: 0 });
    expect(parseClock("沒有時間")).toBeUndefined();
  });

  it("writes and reads back the timeline memory (subject + body with absolute date and zone)", () => {
    const e = parseLifeEvent("後天早上九點駕照路考", NOW, TZ);
    expect(e).toBeDefined();
    if (!e) return;
    expect(lifeSubject(e)).toBe("life:exam:駕照路考");
    expect(lifeBody(e)).toBe("駕照路考 (2027-03-12 09:00, Asia/Taipei)");
    expect(parseLifeMemory(lifeSubject(e), lifeBody(e))).toEqual({
      category: "exam",
      title: "駕照路考",
      date: "2027-03-12",
      time: "09:00",
      timeZone: TZ,
    });
    expect(parseLifeMemory("pref:咖啡", "喜歡咖啡")).toBeUndefined();
  });

  it("ruleExtract: a life event is a dated fact, separate from preferences; a move is a correction", () => {
    const [c] = ruleExtract("我要睡了，後天下午兩點半要考鋼琴檢定", { now: NOW, timeZone: TZ });
    expect(c).toMatchObject({
      kind: "fact",
      subject: "life:exam:鋼琴檢定",
      body: "鋼琴檢定 (2027-03-12 14:30, Asia/Taipei)",
    });
    expect(c?.dueAt).toBe(new Date("2027-03-12T06:30:00Z").toISOString());
    const [moved] = ruleExtract("鋼琴檢定延期到 3/25", { now: NOW, timeZone: TZ });
    expect(moved).toMatchObject({ subject: "life:exam:鋼琴檢定", correction: true });
    expect(moved?.body).toContain("2027-03-25");
    // A deadline still goes the old way (a `due:` project memory).
    expect(ruleExtract("明天要交報告", { now: NOW, timeZone: TZ })[0]?.subject).toMatch(/^due:/);
  });

  it("記住… keeps the timeline subject and the absolute date", () => {
    const c = candidateFromRemember(
      { text: "下週二有鋼琴發表會", quote: "記住下週二有鋼琴發表會" },
      { now: NOW, timeZone: TZ },
    );
    expect(c).toMatchObject({ kind: "fact", subject: "life:performance:鋼琴發表會", confidence: 1 });
    expect(c.body).toContain("2027-03-16");
  });

  it("cancellations and day distance", () => {
    expect(parseLifeCancel("鋼琴檢定取消了")).toEqual({ category: "exam", title: "鋼琴檢定" });
    expect(parseLifeCancel("the trip got called off")?.category).toBe("trip");
    expect(parseLifeCancel("鋼琴檢定延期到 3/25")).toBeUndefined();
    expect(daysUntil("2027-03-12", NOW, TZ)).toBe(2);
    expect(daysUntil("2027-03-10", NOW, TZ)).toBe(0);
  });

  it("lifeInstant: the instant an edited body names (time or 23:59, in its zone); nothing for free text", () => {
    const sub = "life:exam:鋼琴檢定";
    expect(lifeInstant(sub, "鋼琴檢定 (2027-03-12 14:30, Asia/Taipei)")).toBe("2027-03-12T06:30:00.000Z");
    expect(lifeInstant(sub, "鋼琴檢定 (2027-03-12, Asia/Taipei)")).toBe("2027-03-12T15:59:00.000Z");
    expect(lifeInstant(sub, "鋼琴檢定，日期再確認")).toBeUndefined();
    expect(lifeInstant(sub, "鋼琴檢定 (2027-13-40 99:99, Asia/Taipei)")).toBeUndefined();
    expect(lifeInstant(sub, "鋼琴檢定 (2027-03-12 14:30, Not/AZone)")).toBeUndefined();
  });
});
