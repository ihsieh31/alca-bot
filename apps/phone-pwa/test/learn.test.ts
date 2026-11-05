import { describe, expect, it } from "vitest";
import {
  confirmClasses,
  type MemoryItem,
  markedSteps,
  memoryChangeError,
  memoryMeta,
  memoryQuery,
  NO_APPROVE_MEMORY,
  type SkillVersionView,
  type SkillView,
  skillMeta,
} from "../app/learn-view.ts";

const mem = (o: Partial<MemoryItem>): MemoryItem => ({
  id: "mem_1",
  botId: "bot_1",
  scope: "shared",
  kind: "preference",
  body: "喜歡燕麥奶拿鐵",
  quote: null,
  origin: "user",
  confidence: 1,
  source: { kind: "chat", threadId: "thr_1", threadTitle: "早餐", workerTitle: null },
  edited: false,
  versions: 1,
  uses: 0,
  lastUsedAt: null,
  confirmedAt: null,
  createdAt: "2026-11-03T00:00:00Z",
  updatedAt: "2026-11-03T00:00:00Z",
  ...o,
});

const version = (o: Partial<SkillVersionView>): SkillVersionView => ({
  version: 1,
  name: "示範商店結帳",
  description: "",
  triggers: [],
  steps: [
    { text: "開啟結帳頁", actionClass: "network" },
    { text: "讀取頁面", actionClass: "read" },
    { text: "按下確認付款", actionClass: "payment" },
  ],
  actionClasses: ["network", "read", "payment"],
  alwaysConfirm: ["payment"],
  note: null,
  ...o,
});

describe("記憶 screen helpers", () => {
  it("turns a chip + search into memory.list arguments", () => {
    expect(memoryQuery("", "")).toEqual({});
    expect(memoryQuery("person", "  媽媽 ")).toEqual({ kind: "person", q: "媽媽" });
    expect(memoryQuery("inferred", "")).toEqual({ origin: "inferred" });
    expect(memoryQuery("user", "x".repeat(300)).q).toHaveLength(200);
  });

  it("says who said it and where it was learned", () => {
    // 素 Plain §5.2: plain sentence parts joined by 「，」, no middots, and 推測
    // reads 「尚未確認」 instead of a falsely precise percentage.
    expect(memoryMeta(mem({}))).toBe("你說的，從「早餐」");
    const inferred = memoryMeta(mem({ origin: "inferred", confidence: 0.55, edited: true }));
    expect(inferred).toBe("推測，尚未確認，已編輯，從「早餐」");
    expect(inferred).not.toMatch(/%|·/);
    expect(
      memoryMeta(mem({ source: { kind: "ui", threadId: null, threadTitle: null, workerTitle: null } })),
    ).toBe("你說的，你手動加的");
  });
});

describe("技能 proposal helpers", () => {
  it("marks only the always-confirm steps (pay / send / delete / publish) in red", () => {
    expect(markedSteps(version({}))).toEqual([2]);
    // A stale server that sent no alwaysConfirm list: the fixed set still marks the payment step.
    expect(markedSteps(version({ alwaysConfirm: [] }))).toEqual([2]);
    expect(confirmClasses(version({ alwaysConfirm: [] }))).toEqual(["payment"]);
    const safe = version({
      steps: [{ text: "寫週報", actionClass: "write" }],
      actionClasses: ["write"],
      alwaysConfirm: [],
    });
    expect(markedSteps(safe)).toEqual([]);
    expect(confirmClasses(safe)).toEqual([]);
    const all = version({
      steps: ["send", "delete", "publish", "execute"].map((c) => ({ text: c, actionClass: c })),
      alwaysConfirm: ["send", "delete", "publish"],
    });
    expect(markedSteps(all)).toEqual([0, 1, 2]);
  });

  it("describes a row: waiting, a revision, used, disabled", () => {
    const base: SkillView = {
      id: "skl_1",
      botId: "bot_1",
      botName: "Alca",
      status: "proposed",
      version: 0,
      current: null,
      pending: version({}),
      uses: 0,
      lastUsedAt: null,
      source: { threadId: "thr_1", threadTitle: "結帳" },
      updatedAt: "2026-11-03T00:00:00Z",
    };
    expect(skillMeta(base, "剛剛")).toBe("3 步，等你確認");
    expect(
      skillMeta({ ...base, version: 1, current: version({}), pending: version({ version: 2 }) }, "剛剛"),
    ).toBe("有更新等你確認（v1 → v2）");
    const saved = { ...base, status: "active" as const, version: 1, current: version({}), pending: null };
    expect(skillMeta(saved, "剛剛")).toBe("3 步，還沒用過");
    expect(skillMeta({ ...saved, uses: 2 }, "剛剛")).toBe("3 步，用過 2 次，剛剛");
    expect(skillMeta({ ...saved, status: "disabled" }, "剛剛")).toBe("3 步，還沒用過，已停用");
    for (const m of [skillMeta(base, "剛剛"), skillMeta({ ...saved, uses: 2 }, "剛剛")])
      expect(m).not.toContain("·");
  });
});

describe("記憶 edit / forget without the approve scope (review 2026-11-04b L7)", () => {
  it("a forbidden answer from the computer becomes a clear Chinese explanation", () => {
    const forbidden = Object.assign(new Error("這台裝置沒有「approve」權限"), { code: "forbidden" });
    expect(memoryChangeError(forbidden, "沒有忘記")).toBe(NO_APPROVE_MEMORY);
    expect(NO_APPROVE_MEMORY).toContain("沒有核准權限");
    expect(NO_APPROVE_MEMORY).toContain("設定 → 連線");
  });

  it("other failures keep their own message, or the fallback", () => {
    const timeout = Object.assign(new Error("memory.forget timed out"), { code: "timeout" });
    expect(memoryChangeError(timeout, "沒有忘記")).toBe("memory.forget timed out");
    expect(memoryChangeError("boom", "沒有存到")).toBe("沒有存到");
    expect(memoryChangeError(new Error(""), "沒有存到")).toBe("沒有存到");
  });
});
