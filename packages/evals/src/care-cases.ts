import type { CareCase } from "./care-corpus.ts";

/**
 * The labeled care-moments corpus. Every person, event and date is
 * fictional (the week of Wed 2027-03-10, Taipei time); the shapes come from
 * the aggregated analysis in docs/design/CARE-MOMENTS.md §4 — a goodbye
 * after a long late session, declining an offer, putting an offer off, a
 * quick question near midnight, acknowledgements, a second goodbye, a line
 * already said in another thread.
 *
 * `positive` cases must end with exactly the expected line; `negative` cases
 * (the false-positive set) must end with no line about any timeline item.
 */

const EXAM = { at: "2027-03-08T10:00", user: "3/12 下午兩點半要考鋼琴檢定" };
const EXAM_TOMORROW = { at: "2027-03-08T10:00", user: "3/11 早上九點有駕照路考" };
const LONG_SESSION = [
  { at: "2027-03-10T21:00", user: "幫我把匯出 PDF 的 bug 修好" },
  { at: "2027-03-10T21:40", user: "手機版的間距也順便調一下" },
  { at: "2027-03-10T22:20", user: "UI 要再乾淨一點，不要一看就是模板" },
];

export const CARE_CASES: readonly CareCase[] = [
  // ── positives: the right moment ─────────────────────────────────────────
  {
    id: "pos.midnight-goodbye-exam-in-two-days",
    tags: ["positive", "closing", "night"],
    events: [EXAM],
    prior: LONG_SESSION,
    final: { at: "2027-03-10T23:52", user: "剩下的你都處理完，確定沒問題就合併，我要睡了，晚安" },
    expect: { line: "item", title: "鋼琴檢定" },
  },
  {
    id: "pos.declined-offer-exam-tomorrow",
    tags: ["positive", "end-of-exchange", "day"],
    events: [EXAM_TOMORROW],
    prior: [
      {
        at: "2027-03-10T13:00",
        user: "幫我看一下演唱會搶票的消息",
        reply: "還沒開賣。要我每天幫你盯著嗎？",
      },
    ],
    final: { at: "2027-03-10T13:01", user: "不用" },
    expect: { line: "item", title: "駕照路考" },
  },
  {
    id: "pos.put-off-offer-trip-tomorrow",
    tags: ["positive", "end-of-exchange", "day"],
    events: [{ at: "2027-03-08T10:00", user: "3/11 要去札幌旅行" }],
    prior: [{ at: "2027-03-10T08:50", user: "新的同步方式好了嗎", reply: "好了。可以兩台平板試一下嗎？" }],
    final: { at: "2027-03-10T08:52", user: "晚上再試" },
    expect: { line: "item", title: "札幌旅行" },
  },
  {
    id: "pos.english-goodnight-interview-tomorrow",
    tags: ["positive", "closing", "night", "english"],
    lang: "en",
    events: [{ at: "2027-03-08T10:00", user: "my internship interview is on Mar 11 at 10am" }],
    prior: [{ at: "2027-03-10T22:30", user: "please clean up the settings page layout" }],
    final: { at: "2027-03-10T23:30", user: "Thanks, that's everything. Going to bed, good night!" },
    expect: { line: "item", title: "internship interview" },
  },
  {
    id: "pos.daytime-goodbye-birthday-tomorrow",
    tags: ["positive", "closing", "day"],
    events: [{ at: "2027-03-08T10:00", user: "我媽 3/11 生日" }],
    prior: [{ at: "2027-03-10T17:00", user: "幫我整理這週的待辦" }],
    final: { at: "2027-03-10T17:30", user: "先這樣，掰" },
    expect: { line: "item", title: "媽生日" },
  },
  {
    id: "pos.goodnight-no-events-rest",
    tags: ["positive", "closing", "night", "no-event"],
    prior: [{ at: "2027-03-10T23:00", user: "幫我把明天的會議整理成清單" }],
    final: { at: "2027-03-10T23:40", user: "我要睡了，晚安" },
    expect: { line: "rest" },
  },
  {
    id: "pos.still-here-after-goodnight-rest-once",
    tags: ["positive", "lingering", "night"],
    events: [EXAM],
    prior: [{ at: "2027-03-10T23:30", user: "都交給你了，我要睡了，晚安" }],
    final: { at: "2027-03-10T23:34", user: "對了，你剛剛那個怎麼做到的？" },
    expect: { line: "rest" },
  },
  {
    id: "pos.daytime-goodbye-no-events",
    tags: ["closing-only", "closing", "day", "no-event"],
    prior: [{ at: "2027-03-10T15:00", user: "幫我把報告的錯字改掉" }],
    final: { at: "2027-03-10T15:20", user: "好，今天先到這裡" },
    expect: { line: "closing" },
  },

  // ── negatives: ordinary turns, no care line ─────────────────────────────
  {
    id: "neg.daytime-mid-task",
    tags: ["negative", "mid-task", "day"],
    events: [EXAM_TOMORROW],
    final: { at: "2027-03-10T14:00", user: "幫我把登入按鈕改成藍色" },
    expect: { line: "none" },
  },
  {
    id: "neg.late-quick-question",
    tags: ["negative", "question", "night"],
    events: [EXAM],
    prior: LONG_SESSION,
    final: { at: "2027-03-10T23:49", user: "完全整合好大概還要多久？" },
    expect: { line: "none" },
  },
  {
    id: "neg.late-instruction",
    tags: ["negative", "mid-task", "night"],
    events: [EXAM],
    prior: LONG_SESSION,
    final: { at: "2027-03-10T23:20", user: "幫我把 PR 開好，跑完所有測試" },
    expect: { line: "none" },
  },
  {
    id: "neg.daytime-ack",
    tags: ["negative", "ack", "day"],
    events: [EXAM_TOMORROW],
    prior: [{ at: "2027-03-10T14:00", user: "部署好了嗎", reply: "部署好了，網址不變。" }],
    final: { at: "2027-03-10T14:01", user: "好" },
    expect: { line: "none" },
  },
  {
    id: "neg.daytime-ack-okok",
    tags: ["negative", "ack", "day"],
    events: [EXAM_TOMORROW],
    prior: [{ at: "2027-03-10T09:00", user: "今天有什麼要注意的", reply: "下午記得把表單交出去。" }],
    final: { at: "2027-03-10T09:01", user: "Okok" },
    expect: { line: "none" },
  },
  {
    id: "neg.daytime-thanks-mid-stream",
    tags: ["negative", "ack", "day"],
    events: [EXAM_TOMORROW],
    prior: [{ at: "2027-03-10T11:00", user: "明天天氣如何", reply: "明天晴，最高 24 度。" }],
    final: { at: "2027-03-10T11:01", user: "謝謝" },
    expect: { line: "none" },
  },
  {
    id: "neg.goodbye-after-mentioning-it-in-thread",
    tags: ["negative", "closing", "night", "dedupe"],
    events: [EXAM],
    prior: [{ at: "2027-03-10T23:00", user: "後天的鋼琴檢定好緊張", reply: "會順利的，你準備很久了。" }],
    final: { at: "2027-03-10T23:50", user: "我要睡了，晚安" },
    expect: { line: "none" },
  },
  {
    id: "neg.goodbye-line-already-said-elsewhere",
    tags: ["negative", "closing", "night", "dedupe"],
    events: [EXAM],
    prior: [
      { at: "2027-03-10T19:00", user: "幫我訂一下明天的會議室", other: true },
      { at: "2027-03-10T19:30", user: "先這樣，掰", other: true },
    ],
    final: { at: "2027-03-10T23:50", user: "晚安" },
    expect: { line: "none" },
  },
  {
    id: "neg.second-goodbye-same-thread",
    tags: ["negative", "closing", "night", "dedupe"],
    events: [EXAM],
    prior: [{ at: "2027-03-10T23:30", user: "都弄好了，晚安" }],
    final: { at: "2027-03-10T23:45", user: "真的要睡了，晚安" },
    expect: { line: "none" },
  },
  {
    id: "neg.heavy-day",
    tags: ["negative", "closing", "night", "heavy"],
    events: [EXAM],
    final: { at: "2027-03-10T23:40", user: "家裡有人住院了，我先去睡了" },
    expect: { line: "none" },
  },
  {
    id: "neg.suppressed",
    tags: ["negative", "closing", "night", "suppressed"],
    events: [EXAM],
    prior: [{ at: "2027-03-09T12:00", user: "以後別再提醒我考試", other: true }],
    final: { at: "2027-03-10T23:50", user: "我要睡了，晚安" },
    expect: { line: "none" },
  },
  {
    id: "neg.too-far",
    tags: ["negative", "closing", "night", "window"],
    events: [{ at: "2027-03-08T10:00", user: "3/14 要考鋼琴檢定" }],
    final: { at: "2027-03-10T23:50", user: "晚安" },
    expect: { line: "none" },
  },
  {
    id: "neg.medical",
    tags: ["negative", "closing", "night", "heavy"],
    events: [{ at: "2027-03-08T10:00", user: "3/11 早上要去醫院回診" }],
    final: { at: "2027-03-10T23:30", user: "我要睡了，晚安" },
    expect: { line: "none" },
  },
  {
    id: "neg.goodbye-with-question",
    tags: ["negative", "closing", "night", "question"],
    events: [EXAM_TOMORROW],
    final: { at: "2027-03-10T22:30", user: "晚安，明天的會幾點開始？" },
    expect: { line: "none" },
  },
  {
    id: "neg.today-no-time-afternoon",
    tags: ["negative", "closing", "day", "window"],
    events: [{ at: "2027-03-09T10:00", user: "3/10 要考鋼琴檢定" }],
    final: { at: "2027-03-10T18:00", user: "先這樣，掰" },
    expect: { line: "none" },
  },
  {
    id: "neg.english-mid-task-night",
    tags: ["negative", "mid-task", "night", "english"],
    lang: "en",
    events: [{ at: "2027-03-08T10:00", user: "my internship interview is on Mar 11 at 10am" }],
    final: { at: "2027-03-10T23:10", user: "can you fix the failing build before you stop?" },
    expect: { line: "none" },
  },
];
