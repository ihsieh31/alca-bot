import { type ProactiveCase, T_NIGHT } from "./proactive-corpus.ts";

/**
 * The labeled 主動留意 corpus (gap analysis 2026-11 §4.6). Every name, place
 * and message is fictional. Times are hours from the case's start (Tue 10:00
 * in Taipei unless `start` says otherwise). `gold` = the matters that should
 * be a shown card by the end of the case; tags say what the case checks.
 */

const A_DAY = 24;
const person = "林雅婷 <yating@example.org>";

export const PROACTIVE_CASES: readonly ProactiveCase[] = [
  // ── should surface ────────────────────────────────────────────────────────
  {
    id: "surface.dentist-tomorrow",
    tags: ["surface", "calendar"],
    steps: [
      {
        atH: 0,
        cal: [{ id: "e1", title: "牙醫回診", matter: "dentist", startsInH: 24 }],
        model: [
          { ev: "e1", fact: "明天 10:00 牙醫回診", action: "提醒帶健保卡", category: "errand", dueInH: 24 },
        ],
      },
    ],
    gold: ["dentist"],
  },
  {
    id: "surface.bill-from-updates-tab",
    tags: ["surface", "mail", "money"],
    steps: [
      {
        atH: 0,
        mail: [
          {
            id: "m1",
            title: "11 月電費帳單，繳費期限 11/5",
            matter: "bill",
            from: "billing@power.example",
            labels: ["CATEGORY_UPDATES"],
          },
        ],
        model: [
          {
            ev: "m1",
            fact: "11 月電費 11/5 到期",
            action: "整理繳費資料",
            category: "money_account",
            dueInH: 38,
          },
        ],
      },
    ],
    gold: ["bill"],
  },
  {
    id: "surface.deadline-in-conversation",
    tags: ["surface", "deadlines"],
    steps: [
      {
        atH: 0,
        deadlines: [{ body: "週五要交實驗報告", matter: "lab-report", dueInH: 3 * A_DAY }],
        model: [
          {
            ev: "d:週五要交實驗報告",
            fact: "週五要交實驗報告",
            action: "排寫作進度",
            category: "study",
            dueInH: 3 * A_DAY,
          },
        ],
      },
    ],
    gold: ["lab-report"],
  },
  {
    id: "surface.person-asks-to-confirm",
    tags: ["surface", "mail"],
    steps: [
      {
        atH: 0,
        mail: [{ id: "m1", title: "週四社團會議時間確認", matter: "club-meeting", from: person }],
        model: [
          {
            ev: "m1",
            fact: "週四社團會議要確認時間",
            action: "擬回覆確認時間",
            category: "social",
            dueInH: 30,
          },
        ],
      },
    ],
    gold: ["club-meeting"],
  },
  {
    id: "surface.exam-with-profile",
    tags: ["surface", "calendar", "relevance"],
    profile: ["在準備多益考試"],
    steps: [
      {
        atH: 0,
        cal: [{ id: "e1", title: "多益考試", matter: "toeic", startsInH: 48 }],
        model: [
          { ev: "e1", fact: "週四多益考試", action: "整理考場與准考證資訊", category: "study", dueInH: 48 },
        ],
      },
    ],
    gold: ["toeic"],
  },
  {
    id: "surface.rent-tomorrow",
    tags: ["surface", "calendar", "money"],
    steps: [
      {
        atH: 0,
        cal: [{ id: "e1", title: "繳房租", matter: "rent", startsInH: 20 }],
        model: [
          { ev: "e1", fact: "明天要繳房租", action: "整理轉帳資料", category: "money_account", dueInH: 20 },
        ],
      },
    ],
    gold: ["rent"],
  },
  {
    id: "surface.airline-notice-relevant",
    tags: ["surface", "mail", "bulk", "relevance"],
    profile: ["11 月要去東京玩"],
    steps: [
      {
        atH: 0,
        mail: [
          {
            id: "m1",
            title: "東京航班線上報到已開放",
            matter: "flight",
            from: "no-reply@airline.example",
            labels: ["CATEGORY_UPDATES"],
          },
        ],
        model: [
          {
            ev: "m1",
            fact: "明天東京航班可以線上報到",
            action: "整理報到步驟",
            category: "errand",
            dueInH: 26,
          },
        ],
      },
    ],
    gold: ["flight"],
  },
  {
    id: "surface.two-matters-one-scan",
    tags: ["surface", "runner-up"],
    steps: [
      {
        atH: 0,
        cal: [
          { id: "e1", title: "牙醫", matter: "dentist", startsInH: 24 },
          { id: "e2", title: "繳學費", matter: "tuition", startsInH: 30 },
        ],
        model: [
          { ev: "e1", fact: "明天 10:00 牙醫", action: "提醒帶健保卡", category: "errand", dueInH: 24 },
          { ev: "e2", fact: "明天下午繳學費", action: "整理繳費單", category: "money_account", dueInH: 30 },
        ],
      },
      // The second card waits for the minimum gap (30 min in the corpus).
      { atH: 1, scan: false },
    ],
    gold: ["dentist", "tuition"],
  },
  {
    id: "surface.moved-event",
    tags: ["surface", "calendar", "changed"],
    steps: [
      {
        atH: 0,
        cal: [{ id: "e1", title: "讀書會", matter: "study-group", startsInH: 9 * A_DAY, version: "v1" }],
        model: [],
      },
      {
        atH: 2,
        cal: [
          { id: "e1", title: "讀書會（提前到明天）", matter: "study-group", startsInH: 26, version: "v2" },
        ],
        model: [
          { ev: "e1", fact: "讀書會提前到明天", action: "整理要討論的章節", category: "study", dueInH: 26 },
        ],
      },
    ],
    gold: ["study-group"],
  },
  {
    id: "surface.retry-after-model-failure",
    tags: ["surface", "model-failure"],
    steps: [
      {
        atH: 0,
        cal: [{ id: "e1", title: "健檢", matter: "checkup", startsInH: 28 }],
        model: new Error("timeout"),
      },
      {
        atH: 1,
        model: [{ ev: "e1", fact: "明天下午健檢", action: "提醒前一晚禁食", category: "errand", dueInH: 28 }],
      },
    ],
    gold: ["checkup"],
  },

  // ── near-due escalation ───────────────────────────────────────────────────
  {
    id: "near-due.exam-ten-days-out",
    tags: ["near-due", "calendar"],
    steps: [
      {
        atH: 0,
        cal: [{ id: "e1", title: "期末考", matter: "final", startsInH: 10 * A_DAY }],
        model: [
          { ev: "e1", fact: "11/13 期末考", action: "排複習進度", category: "study", dueInH: 10 * A_DAY },
        ],
      },
      { atH: 7 * A_DAY + 1, scan: false },
    ],
    gold: ["final"],
  },
  {
    id: "near-due.report-eight-days-out",
    tags: ["near-due", "calendar"],
    steps: [
      {
        atH: 0,
        cal: [{ id: "e1", title: "專題報告截止", matter: "project-report", startsInH: 8 * A_DAY }],
        model: [
          {
            ev: "e1",
            fact: "下週三專題報告截止",
            action: "列出還缺的段落",
            category: "project",
            dueInH: 8 * A_DAY,
          },
        ],
      },
      { atH: 3 * A_DAY, scan: false },
      { atH: 5 * A_DAY + 1, scan: false },
    ],
    gold: ["project-report"],
  },
  {
    id: "near-due.not-doable-stays-quiet",
    tags: ["near-due", "quiet"],
    steps: [
      {
        atH: 0,
        cal: [{ id: "e1", title: "同學婚禮", matter: "wedding", startsInH: 5 * A_DAY }],
        model: [
          { ev: "e1", fact: "週日同學婚禮", action: "出席婚禮", category: "social", dueInH: 5 * A_DAY },
        ],
      },
      { atH: 2 * A_DAY + 1, scan: false },
      { atH: 4 * A_DAY + 1, scan: false },
      { atH: 5 * A_DAY - 5, scan: false },
    ],
    gold: [],
  },

  // ── should stay quiet ─────────────────────────────────────────────────────
  { id: "quiet.nothing-new", tags: ["quiet"], steps: [{ atH: 0, model: [] }], gold: [] },
  {
    id: "quiet.model-says-nothing",
    tags: ["quiet", "mail"],
    steps: [
      { atH: 0, mail: [{ id: "m1", title: "謝謝你昨天的幫忙", matter: "thanks", from: person }], model: [] },
    ],
    gold: [],
  },
  {
    id: "quiet.undated-vague",
    tags: ["quiet"],
    steps: [
      {
        atH: 0,
        mail: [{ id: "m1", title: "有空聊聊", matter: "chat", from: person }],
        model: [{ ev: "m1", fact: "朋友說有空聊聊", action: "找時間", category: "social" }],
      },
    ],
    gold: [],
  },
  {
    id: "quiet.far-off-not-yet",
    tags: ["quiet", "calendar"],
    steps: [
      {
        atH: 0,
        cal: [{ id: "e1", title: "年度健檢", matter: "annual", startsInH: 13 * A_DAY }],
        model: [
          { ev: "e1", fact: "11/16 年度健檢", action: "提醒預約", category: "errand", dueInH: 13 * A_DAY },
        ],
      },
    ],
    gold: [],
  },
  {
    id: "quiet.malformed-answer",
    tags: ["quiet", "model-failure"],
    steps: [
      {
        atH: 0,
        cal: [{ id: "e1", title: "牙醫", matter: "dentist", startsInH: 24 }],
        model: "我覺得你應該去看牙醫。",
      },
    ],
    gold: [],
  },
  {
    id: "quiet.unknown-evidence",
    tags: ["quiet"],
    steps: [
      {
        atH: 0,
        cal: [{ id: "e1", title: "牙醫", matter: "dentist", startsInH: 24 }],
        model: [{ ev: "zzz", fact: "編造的期限", action: "整理", category: "study", dueInH: 24 }],
      },
    ],
    gold: [],
  },
  {
    id: "quiet.overdue",
    tags: ["quiet"],
    steps: [
      {
        atH: 0,
        mail: [{ id: "m1", title: "上週的會議記錄", matter: "minutes", from: person }],
        model: [{ ev: "m1", fact: "上週會議記錄", action: "整理重點", category: "project", dueInH: -30 }],
      },
    ],
    gold: [],
  },
  {
    id: "quiet.event-already-started",
    tags: ["quiet", "calendar"],
    steps: [
      {
        atH: 0,
        cal: [{ id: "e1", title: "早上的課", matter: "class", startsInH: -1 }],
        model: [{ ev: "e1", fact: "早上的課", action: "整理筆記", category: "study", dueInH: 1 }],
      },
    ],
    gold: [],
  },

  // ── promotional / bulk mail ───────────────────────────────────────────────
  {
    id: "promo.promotions-tab-never-seen",
    tags: ["promo", "mail"],
    steps: [
      {
        atH: 0,
        mail: [
          {
            id: "m1",
            title: "雙 11 全館 5 折明天結束",
            matter: "sale",
            from: "shop@store.example",
            labels: ["CATEGORY_PROMOTIONS"],
          },
        ],
        model: [{ ev: "m1", fact: "雙 11 折扣明天結束", action: "提醒下單", category: "errand", dueInH: 14 }],
      },
    ],
    gold: [],
  },
  {
    id: "promo.bulk-sale-in-updates",
    tags: ["promo", "mail", "bulk"],
    steps: [
      {
        atH: 0,
        mail: [
          {
            id: "m1",
            title: "會員限時特價倒數",
            matter: "sale",
            from: "noreply@shop.example",
            labels: ["CATEGORY_UPDATES"],
          },
        ],
        model: [
          { ev: "m1", fact: "會員限時特價明天截止", action: "提醒下單", category: "errand", dueInH: 14 },
        ],
      },
    ],
    gold: [],
  },
  {
    id: "promo.newsletter",
    tags: ["promo", "mail", "bulk"],
    steps: [
      {
        atH: 0,
        mail: [
          { id: "m1", title: "本週科技新聞", matter: "news", from: "Weekly <newsletter@media.example>" },
        ],
        model: [{ ev: "m1", fact: "本週科技電子報", action: "摘要電子報", category: "other", dueInH: 20 }],
      },
    ],
    gold: [],
  },
  {
    id: "promo.social-notification",
    tags: ["promo", "mail"],
    steps: [
      {
        atH: 0,
        mail: [
          {
            id: "m1",
            title: "有 3 個人回覆了你的貼文",
            matter: "social",
            from: "notify@social.example",
            labels: ["CATEGORY_SOCIAL"],
          },
        ],
        model: [{ ev: "m1", fact: "貼文有新回覆", action: "整理回覆", category: "social", dueInH: 5 }],
      },
    ],
    gold: [],
  },
  {
    id: "promo.common-words-not-relevant",
    tags: ["promo", "relevance", "bulk"],
    profile: ["明天要上課"],
    steps: [
      {
        atH: 0,
        mail: [{ id: "m1", title: "明天特價", matter: "sale", from: "marketing@shop.example" }],
        model: [{ ev: "m1", fact: "明天特價活動", action: "提醒你", category: "other", dueInH: 20 }],
      },
    ],
    gold: [],
  },

  // ── suppressed ────────────────────────────────────────────────────────────
  {
    id: "suppressed.topic",
    tags: ["suppressed"],
    steps: [
      {
        atH: 0,
        suppress: ["牙醫"],
        cal: [{ id: "e1", title: "牙醫", matter: "dentist", startsInH: 24 }],
        model: [{ ev: "e1", fact: "明天牙醫回診", action: "提醒帶健保卡", category: "errand", dueInH: 24 }],
      },
    ],
    gold: [],
  },
  {
    id: "suppressed.category-and-topic",
    tags: ["suppressed"],
    steps: [
      {
        atH: 0,
        suppress: ["讀書・排寫作進度"],
        deadlines: [{ body: "下週一交心得", matter: "essay", dueInH: 2 * A_DAY }],
        model: [
          {
            ev: "d:下週一交心得",
            fact: "下週一交心得",
            action: "排寫作進度",
            category: "study",
            dueInH: 2 * A_DAY,
          },
        ],
      },
    ],
    gold: [],
  },
  {
    id: "suppressed.after-queued",
    tags: ["suppressed", "quiet-hours", "revalidate"],
    start: T_NIGHT,
    steps: [
      {
        atH: 0,
        cal: [{ id: "e1", title: "牙醫", matter: "dentist", startsInH: 16 }],
        model: [
          { ev: "e1", fact: "明天 15:00 牙醫", action: "提醒帶健保卡", category: "errand", dueInH: 16 },
        ],
      },
      { atH: 2, scan: false, suppress: ["牙醫"] },
      { atH: 9.5, scan: false },
    ],
    gold: [],
  },

  // ── dedupe ────────────────────────────────────────────────────────────────
  {
    id: "dedupe.event-and-invite-same-scan",
    tags: ["dedupe"],
    steps: [
      {
        atH: 0,
        cal: [{ id: "e1", title: "產品週會", matter: "weekly", startsInH: 48 }],
        mail: [{ id: "m1", title: "邀請：產品週會 @ 週四 10:00", matter: "weekly", from: person }],
        model: [
          { ev: "e1", fact: "週四 10:00 產品週會", action: "整理上週進度", category: "project", dueInH: 48 },
          {
            ev: "m1",
            fact: "產品週會邀請（週四）",
            action: "擬接受邀請的回覆",
            category: "project",
            dueInH: 48,
          },
        ],
      },
    ],
    gold: ["weekly"],
  },
  {
    id: "dedupe.invite-a-scan-later",
    tags: ["dedupe"],
    steps: [
      {
        atH: 0,
        cal: [{ id: "e1", title: "產品週會", matter: "weekly", startsInH: 48 }],
        model: [
          { ev: "e1", fact: "週四 10:00 產品週會", action: "整理上週進度", category: "project", dueInH: 48 },
        ],
      },
      {
        atH: 1,
        mail: [{ id: "m1", title: "邀請：產品週會", matter: "weekly", from: person }],
        model: [
          {
            ev: "m1",
            fact: "產品週會邀請（週四）",
            action: "擬接受邀請的回覆",
            category: "project",
            dueInH: 48,
          },
        ],
      },
    ],
    gold: ["weekly"],
  },
  {
    id: "dedupe.same-evidence-twice",
    tags: ["dedupe"],
    steps: [
      {
        atH: 0,
        deadlines: [{ body: "週五交報告", matter: "report", dueInH: 3 * A_DAY }],
        model: [
          {
            ev: "d:週五交報告",
            fact: "週五交報告",
            action: "排寫作進度",
            category: "study",
            dueInH: 3 * A_DAY,
          },
        ],
      },
      {
        atH: 1,
        mail: [{ id: "m1", title: "報告格式說明", matter: "report", from: person }],
        model: [
          {
            ev: ["m1", "d:週五交報告"],
            fact: "週五報告格式說明",
            action: "整理格式重點",
            category: "study",
            dueInH: 3 * A_DAY,
          },
        ],
      },
    ],
    gold: ["report"],
  },
  {
    id: "dedupe.two-matters-same-day-both-shown",
    tags: ["dedupe", "surface"],
    steps: [
      {
        atH: 0,
        cal: [
          { id: "e1", title: "看牙醫", matter: "dentist", startsInH: 24 },
          { id: "e2", title: "繳房租", matter: "rent", startsInH: 25 },
        ],
        model: [
          { ev: "e1", fact: "明天 10:00 看牙醫", action: "提醒帶健保卡", category: "errand", dueInH: 24 },
          { ev: "e2", fact: "明天要繳房租", action: "整理轉帳資料", category: "money_account", dueInH: 25 },
        ],
      },
      // The second card waits for the minimum gap (30 min in the corpus).
      { atH: 1, scan: false },
    ],
    gold: ["dentist", "rent"],
  },

  // ── quiet hours and volume ────────────────────────────────────────────────
  {
    id: "quiet-hours.found-at-night-shown-in-morning",
    tags: ["quiet-hours"],
    start: T_NIGHT,
    steps: [
      {
        atH: 0,
        cal: [{ id: "e1", title: "牙醫", matter: "dentist", startsInH: 16 }],
        model: [
          { ev: "e1", fact: "明天 15:00 牙醫", action: "提醒帶健保卡", category: "errand", dueInH: 16 },
        ],
      },
      { atH: 3, scan: false },
      { atH: 9.2, scan: false },
    ],
    gold: ["dentist"],
  },
  {
    id: "quiet-hours.max-per-day",
    tags: ["quiet-hours", "volume"],
    settings: { maxPerDay: 1 },
    steps: [
      {
        atH: 0,
        cal: [
          { id: "e1", title: "牙醫", matter: "dentist", startsInH: 30 },
          { id: "e2", title: "繳房租", matter: "rent", startsInH: 40 },
        ],
        model: [
          { ev: "e1", fact: "明天下午看牙醫", action: "提醒帶健保卡", category: "errand", dueInH: 30 },
          { ev: "e2", fact: "後天要繳房租", action: "整理轉帳資料", category: "money_account", dueInH: 40 },
        ],
      },
      { atH: 4, scan: false },
      { atH: 23, scan: false },
    ],
    gold: ["dentist", "rent"],
  },

  // ── cancelled / changed before shown ──────────────────────────────────────
  {
    id: "cancelled.event-deleted-overnight",
    tags: ["cancelled", "revalidate"],
    start: T_NIGHT,
    steps: [
      {
        atH: 0,
        cal: [{ id: "e1", title: "家教課", matter: "tutoring", startsInH: 19 }],
        model: [{ ev: "e1", fact: "明天 18:00 家教課", action: "整理講義", category: "study", dueInH: 19 }],
      },
      { atH: 3, cal: [], model: [] },
      { atH: 9.5, scan: false },
    ],
    gold: [],
  },
  {
    id: "cancelled.status-cancelled",
    tags: ["cancelled", "calendar"],
    steps: [
      {
        atH: 0,
        cal: [{ id: "e1", title: "社團聚餐", matter: "dinner", startsInH: 30, status: "cancelled" }],
        model: [{ ev: "e1", fact: "明天社團聚餐", action: "提醒訂位", category: "social", dueInH: 30 }],
      },
    ],
    gold: [],
  },
  {
    id: "cancelled.cut-off-page-proves-nothing",
    tags: ["cancelled", "revalidate", "surface"],
    start: T_NIGHT,
    steps: [
      {
        atH: 0,
        cal: [{ id: "e1", title: "家教課", matter: "tutoring", startsInH: 19 }],
        model: [{ ev: "e1", fact: "明天 18:00 家教課", action: "整理講義", category: "study", dueInH: 19 }],
      },
      { atH: 3, cal: [], calPartial: true, model: [] },
      { atH: 9.5, scan: false },
    ],
    gold: ["tutoring"],
  },
  {
    id: "cancelled.moved-while-queued",
    tags: ["cancelled", "changed", "revalidate"],
    start: T_NIGHT,
    steps: [
      {
        atH: 0,
        cal: [{ id: "e1", title: "面談", matter: "interview", startsInH: 17, version: "v1" }],
        model: [
          { ev: "e1", fact: "明天 16:00 面談", action: "整理自我介紹", category: "project", dueInH: 17 },
        ],
      },
      {
        atH: 2,
        cal: [
          { id: "e1", title: "面談（改到下週）", matter: "interview", startsInH: 7 * A_DAY, version: "v2" },
        ],
        model: [],
      },
      { atH: 9.5, scan: false },
    ],
    gold: [],
  },
];

/** At least this many cases (the gap analysis asks for 30–40). */
export const MIN_CASES = 30;
