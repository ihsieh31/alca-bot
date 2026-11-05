import { describe, expect, it } from "vitest";
import {
  closingOf,
  endsExchange,
  type HistoryMessage,
  isNight,
  languageOf,
  situationOf,
} from "../src/index.ts";

// Care moments, step 2: the situation model. All cases fictional.
const TZ = "Asia/Taipei";
const at = (iso: string) => new Date(iso);
const msg = (role: string, content: string, createdAt: string): HistoryMessage => ({
  role,
  content,
  createdAt,
});

describe("care moments: situation", () => {
  it("closing intent in Chinese and English, only where it is really a goodbye", () => {
    for (const s of [
      "我要睡了，晚安",
      "晚安",
      "先睡了",
      "好累，去睡覺了",
      "Good night!",
      "ok going to bed",
      "gn",
    ])
      expect(closingOf(s), s).toBe("sleep");
    for (const s of ["那先這樣吧", "今天先到這裡", "掰掰", "ok bye", "talk to you tomorrow", "我要休息了"])
      expect(closingOf(s), s).toBe("bye");
    for (const s of [
      "先這樣做，然後跑測試",
      "我昨天睡了很久",
      "不想睡",
      "bye 這個字怎麼拼",
      "把 sleep 函式改掉",
    ])
      expect(closingOf(s), s).toBeNull();
  });

  it("late night in the person's zone", () => {
    const s = situationOf({ text: "晚安", now: at("2027-03-10T15:50:00Z"), timeZone: TZ, history: [] });
    expect([s.hour, s.minute, s.night]).toEqual([23, 50, true]);
    const day = situationOf({ text: "晚安", now: at("2027-03-10T06:00:00Z"), timeZone: TZ, history: [] });
    expect(day.night).toBe(false);
    expect(isNight(4)).toBe(true);
    expect(isNight(5)).toBe(false);
    expect(isNight(22)).toBe(true);
  });

  it("the end of an exchange: a decline or an acknowledgement, not a yes to an offer", () => {
    const offer = [msg("assistant", "要我幫你排一下路線嗎？", "2027-03-10T00:00:00Z")];
    const report = [msg("assistant", "改好了，已經部署。", "2027-03-10T00:00:00Z")];
    expect(endsExchange("不用", offer)).toBe(true);
    expect(endsExchange("晚上再試", offer)).toBe(true);
    expect(endsExchange("好", offer)).toBe(false);
    // A plain acknowledgement is not an end (owner's rule: no care line on daytime acks).
    expect(endsExchange("好", report)).toBe(false);
    expect(endsExchange("Okok", report)).toBe(false);
    expect(endsExchange("好，這樣就好", report)).toBe(true);
    expect(endsExchange("thanks, that's all", report)).toBe(true);
    expect(endsExchange("晚上再試", report)).toBe(false);
    expect(endsExchange("還要多久？", report)).toBe(false);
    expect(endsExchange("幫我再改一下按鈕", report)).toBe(false);
    expect(endsExchange("不用", [])).toBe(false);
  });

  it("mid-task, question, lingering after good night, session length, heavy tone, language", () => {
    const now = at("2027-03-10T15:55:00Z");
    const history = [
      msg("user", "幫我修好這個 bug", "2027-03-10T13:00:00Z"),
      msg("assistant", "修好了", "2027-03-10T13:30:00Z"),
      msg("user", "再看一下手機版", "2027-03-10T14:10:00Z"),
      msg("assistant", "看過了", "2027-03-10T14:50:00Z"),
      msg("user", "我要睡了，晚安", "2027-03-10T15:30:00Z"),
      msg("assistant", "晚安", "2027-03-10T15:31:00Z"),
    ];
    const s = situationOf({ text: "你怎麼做到的？", now, timeZone: TZ, history });
    expect(s).toMatchObject({ closing: null, lingering: true, question: true });
    expect(s.sessionMinutes).toBe(175);
    expect(
      situationOf({ text: "幫我加一個按鈕", now: at("2027-03-10T03:00:00Z"), timeZone: TZ, history: [] })
        .midTask,
    ).toBe(true);
    expect(situationOf({ text: "我阿公昨天過世了，先這樣", now, timeZone: TZ, history: [] }).heavy).toBe(
      true,
    );
    expect(situationOf({ text: "晚安，明天的會幾點？", now, timeZone: TZ, history: [] })).toMatchObject({
      closing: "sleep",
      question: true,
    });
    expect(languageOf("Good night!")).toBe("en");
    expect(languageOf("晚安")).toBe("zh");
    expect(languageOf("👍", "en")).toBe("en");
  });
});
