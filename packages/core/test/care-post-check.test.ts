import { describe, expect, it } from "vitest";
import {
  type CareDecision,
  careMetrics,
  careSuppression,
  categoryWeights,
  mentions,
  postCheckCare,
  reactionOf,
  splitSentences,
} from "../src/index.ts";

// Care moments, step 5 (post-check) and step 6 (feedback). All cases fictional.
const exam = {
  memoryId: "mem_1",
  category: "exam" as const,
  title: "鋼琴檢定",
  date: "2027-03-12",
  time: "14:30",
  timeZone: "Asia/Taipei",
  at: "2027-03-12T06:30:00.000Z",
  daysAway: 2,
};
const event: CareDecision = {
  kind: "event",
  reason: "chosen",
  moment: true,
  rest: true,
  item: exam,
  scored: [],
};
const closing: CareDecision = { kind: "closing", reason: "no-event", moment: true, rest: false, scored: [] };
const none: CareDecision = { kind: "none", reason: "not-a-moment", moment: false, rest: false, scored: [] };

describe("care moments: post-check", () => {
  it("keeps a good goodbye as it is", () => {
    const reply = "好，剩下的我會跑完測試再合併。晚安，後天的鋼琴檢定加油。";
    const r = postCheckCare({
      reply,
      decision: event,
      timelineTitles: ["鋼琴檢定", "札幌旅行"],
      leaving: true,
    });
    expect(r).toMatchObject({ changed: false, violations: [], shown: { item: true, rest: false } });
    expect(r.text).toBe(reply);
  });

  it("drops a question or an offer after a goodbye", () => {
    const r = postCheckCare({
      reply: "好，都交給我。晚安，後天的鋼琴檢定加油。要我明天早上提醒你嗎？",
      decision: event,
      timelineTitles: ["鋼琴檢定"],
      leaving: true,
    });
    expect(r.violations).toContain("offer-after-goodbye");
    expect(r.text).toBe("好，都交給我。晚安，後天的鋼琴檢定加油。");
    const q = postCheckCare({
      reply: "OK, it's all handled. Anything else before you go?",
      decision: closing,
      timelineTitles: [],
      leaving: true,
    });
    expect(q.violations).toContain("question-after-goodbye");
    expect(q.text).toBe("OK, it's all handled.");
  });

  it("drops a line about an item the policy did not choose, and a second care line", () => {
    const r = postCheckCare({
      reply: "收到。後天的鋼琴檢定加油。下週的札幌旅行也玩得開心。快去睡吧。",
      decision: event,
      timelineTitles: ["鋼琴檢定", "札幌旅行"],
      leaving: true,
    });
    expect(r.violations).toEqual(expect.arrayContaining(["unchosen-item", "extra-care-line"]));
    expect(r.text).toBe("收到。後天的鋼琴檢定加油。");
    // Nothing was chosen: a wish for an item is unprompted, it goes.
    const q = postCheckCare({
      reply: "好，不設提醒。明天鋼琴檢定加油！",
      decision: { ...closing, kind: "none" },
      timelineTitles: ["鋼琴檢定"],
      leaving: false,
    });
    expect(q.text).toBe("好，不設提醒。");
  });

  it("drops a care line that names where the memory came from", () => {
    const r = postCheckCare({
      reply: "好，晚安。我記得你說過後天要考鋼琴檢定，加油！",
      decision: event,
      timelineTitles: ["鋼琴檢定"],
      leaving: true,
    });
    expect(r.violations).toContain("cites-source");
    expect(r.text).toBe("好，晚安。");
  });

  it("a plain 「早點休息」 in a daytime goodbye stays; after a suppression it goes", () => {
    expect(
      postCheckCare({ reply: "好，先這樣。早點休息！", decision: closing, timelineTitles: [], leaving: true })
        .changed,
    ).toBe(false);
    const sup: CareDecision = { ...closing, reason: "suppressed" };
    expect(
      postCheckCare({ reply: "好，先這樣。早點休息！", decision: sup, timelineTitles: [], leaving: true })
        .text,
    ).toBe("好，先這樣。");
  });

  it("does nothing on turns that are not moments (a mention there answers the person)", () => {
    const reply = "這週最重要的是週五的鋼琴檢定，要我排練習時間嗎？";
    expect(postCheckCare({ reply, decision: none, timelineTitles: ["鋼琴檢定"], leaving: false }).text).toBe(
      reply,
    );
  });

  it("never empties a reply", () => {
    const r = postCheckCare({
      reply: "要我提醒你嗎？",
      decision: closing,
      timelineTitles: [],
      leaving: true,
    });
    expect(r.text).toBe("要我提醒你嗎？");
    expect(r.changed).toBe(false);
  });

  it("a report of what was done is not an offer (「你要我改的…都改好了」 stays)", () => {
    const reply = "晚安！你要我改的三個地方都改好了。";
    const r = postCheckCare({ reply, decision: closing, timelineTitles: [], leaving: true });
    expect(r).toMatchObject({ changed: false, text: reply });
    // 「不需要我…」 reports, too; 「需要我…嗎」 offers.
    expect(
      postCheckCare({
        reply: "測試都過了，不需要我再動。晚安。",
        decision: closing,
        timelineTitles: [],
        leaving: true,
      }).changed,
    ).toBe(false);
    expect(
      postCheckCare({
        reply: "都好了。需要我明天再看一次嗎？",
        decision: closing,
        timelineTitles: [],
        leaving: true,
      }).text,
    ).toBe("都好了。");
  });

  it("blank lines do not hide a trailing offer; the goodbye tail is the last two real sentences", () => {
    const r = postCheckCare({
      reply: "改好了，也部署了。\n\n要我明天提醒你嗎？\n\n晚安！",
      decision: closing,
      timelineTitles: [],
      leaving: true,
    });
    expect(r.violations).toContain("offer-after-goodbye");
    expect(r.text).toBe("改好了，也部署了。\n\n\n\n晚安！");
    // An earlier question (not in the tail) is part of the work report and stays.
    const keep = "你問「為什麼會壞？」，是快取沒清。已經修好。晚安。";
    expect(postCheckCare({ reply: keep, decision: closing, timelineTitles: [], leaving: true }).text).toBe(
      keep,
    );
  });

  it("Chinese punctuation: 「！？」 runs and closing quotes stay with their sentence", () => {
    expect(splitSentences("真的嗎？！好啊。")).toEqual(["真的嗎？！", "好啊。"]);
    expect(splitSentences("他說「好嗎？」我說好。")).toEqual(["他說「好嗎？」", "我說好。"]);
    // A trailing quoted question goes whole, never leaving a lone 」.
    const r = postCheckCare({
      reply: "好，已經寄出。晚安。「要我明天再追蹤嗎？」",
      decision: closing,
      timelineTitles: [],
      leaving: true,
    });
    expect(r.text).toBe("好，已經寄出。晚安。");
  });

  it("a fenced code block is one piece and is never cut", () => {
    const code = "```ts\nconst ok = a ? b : c?\n// 鋼琴檢定加油\n```";
    expect(splitSentences(`看這段：\n${code}\n晚安`)).toEqual(["看這段：\n", code, "\n", "晚安"]);
    const reply = `改好了：\n${code}`;
    const r = postCheckCare({ reply, decision: closing, timelineTitles: ["鋼琴檢定"], leaving: true });
    expect(r.text).toBe(reply);
    expect(postCheckCare({ reply, decision: none, timelineTitles: ["鋼琴檢定"], leaving: false }).text).toBe(
      reply,
    );
  });

  it("a plain report about an item discussed earlier stays; a wish or reminder about it goes", () => {
    const r = postCheckCare({
      reply: "札幌旅行的訂房確認信寄出了。晚安，後天的鋼琴檢定加油。",
      decision: event,
      timelineTitles: ["鋼琴檢定", "札幌旅行"],
      leaving: true,
      discussed: ["札幌旅行"],
    });
    expect(r.text).toBe("札幌旅行的訂房確認信寄出了。晚安，後天的鋼琴檢定加油。");
    for (const extra of ["札幌旅行玩得開心！", "別忘了札幌旅行要帶護照。"]) {
      const x = postCheckCare({
        reply: `收到。晚安，後天的鋼琴檢定加油。${extra}`,
        decision: event,
        timelineTitles: ["鋼琴檢定", "札幌旅行"],
        leaving: true,
        discussed: ["札幌旅行"],
      });
      expect(x.text).toBe("收到。晚安，後天的鋼琴檢定加油。");
    }
    // Not discussed: even a plain line about it is an unprompted reminder on a goodbye.
    expect(
      postCheckCare({
        reply: "收到，晚安。下週還有札幌旅行。",
        decision: closing,
        timelineTitles: ["札幌旅行"],
        leaving: true,
      }).text,
    ).toBe("收到，晚安。");
  });

  it("mention and sentence helpers", () => {
    expect(mentions("後天的鋼琴檢定加油", "鋼琴檢定")).toBe(true);
    expect(mentions("鋼琴考試加油", "鋼琴檢定")).toBe(false);
    expect(mentions("good luck with the driving test!", "driving test")).toBe(true);
    expect(splitSentences("A. B! 好。嗎？").join("")).toBe("A. B! 好。嗎？");
  });
});

describe("care moments: feedback loop", () => {
  it("reads the reaction to a shown line", () => {
    expect(reactionOf("謝謝，晚安")).toBe("positive");
    expect(reactionOf("you too, thanks")).toBe("positive");
    expect(reactionOf("別再提這種")).toBe("negative");
    expect(reactionOf("stop reminding me")).toBe("negative");
    expect(reactionOf("對了 PR 的 CI 跑完了嗎")).toBe("ignored");
    expect(careSuppression("不用關心我")).toBe(true);
    expect(careSuppression("別再叫我去睡")).toBe(true);
    expect(careSuppression("晚安")).toBe(false);
  });

  it("weights move by reaction, within [0.5, 1.2]; unanswered after 12 h counts as ignored", () => {
    const now = new Date("2027-03-12T00:00:00Z");
    const row = (
      category: string,
      reaction: "positive" | "negative" | "ignored" | null,
      hoursAgo: number,
    ) => ({
      id: `care_${Math.random()}`,
      botId: "b",
      threadId: "t",
      runId: null,
      kind: "shown" as const,
      memoryId: null,
      category,
      reason: "",
      score: null,
      reaction,
      createdAt: new Date(now.getTime() - hoursAgo * 3600_000).toISOString(),
      reactedAt: null,
    });
    const w = categoryWeights(
      [
        row("exam", "positive", 30),
        row("exam", "positive", 20),
        row("trip", "negative", 5),
        row("trip", null, 13),
        row("rest", null, 1),
      ],
      now,
    );
    expect(w).toEqual({ exam: 1.2, trip: 0.6 });
    const m = careMetrics(
      [
        ...[
          row("exam", "positive", 30),
          row("trip", "negative", 5),
          row("trip", null, 13),
          row("rest", null, 1),
        ],
        { ...row("", null, 2), kind: "decision" as const, reason: "no-event" },
        { ...row("exam", null, 2), kind: "decision" as const, reason: "chosen" },
      ],
      now,
    );
    expect(m).toMatchObject({
      moments: 2,
      shown: 4,
      positive: 1,
      negative: 1,
      ignored: 1,
      pending: 1,
      precision: 0.333,
    });
    expect(m.quietReasons).toEqual({ "no-event": 1 });
  });
});
