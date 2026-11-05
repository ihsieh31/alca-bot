import { describe, expect, it } from "vitest";
import { mentionOf, mentionQuery, nowLine, systemLine, type TeamBot } from "../app/team-view.ts";
import { reportOf } from "../app/timeline.ts";

const bot = (name: string, over: Partial<TeamBot> = {}): TeamBot => ({
  id: `bot_${name}`,
  name,
  isDefault: false,
  avatar: name.slice(0, 1),
  color: null,
  role: null,
  instructions: null,
  engineId: null,
  model: null,
  approvalLevel: null,
  browserProfile: "shared",
  memoryMode: "team",
  isLead: false,
  activity: { workers: 0, waiting: 0, peersOpen: 0, working: [] },
  threads: 0,
  ...over,
});

describe("phone × team view", () => {
  it("reads the @ being typed at the start only, with the caret at its end", () => {
    expect(mentionQuery("@", 1)).toBe("");
    expect(mentionQuery("＠研", 2)).toBe("研");
    expect(mentionQuery("  @寫", 4)).toBe("寫");
    expect(mentionQuery("@寫手 你好", 6)).toBeUndefined();
    expect(mentionQuery("請 @寫手", 5)).toBeUndefined();
    expect(mentionQuery("@寫手 你好", 3)).toBe("寫手");
  });

  it("matches the longest name at the start, as the core does", () => {
    const bots = [bot("研究"), bot("研究員")];
    expect(mentionOf("@研究員 比價", bots)?.name).toBe("研究員");
    expect(mentionOf("@研究 比價", bots)?.name).toBe("研究");
    expect(mentionOf("@研究員們", bots)).toBeUndefined();
    expect(mentionOf("請研究員比價", bots)).toBeUndefined();
  });

  it("says what a bot is doing, and that it waits for the person first", () => {
    expect(nowLine(bot("a")).state).toBe("idle");
    const w = nowLine(
      bot("b", {
        activity: {
          workers: 1,
          waiting: 1,
          peersOpen: 1,
          working: [
            { kind: "peer", id: "prq_1", title: "刪除購物清單", threadId: "thr_1", status: "running" },
          ],
        },
      }),
    );
    expect(w).toEqual({ text: "等你決定 · 隊友交辦：刪除購物清單", state: "waiting" });
  });

  it("turns system notes in a teammate's conversation into plain words", () => {
    expect(
      systemLine(
        '<alca:peer id="prq_1" kind="delegate" from="Alca" depth="1">\n比較三家店\n</alca:peer>\n隊友「Alca」交辦…',
      ),
    ).toEqual({ label: "收到交辦", text: "比較三家店" });
    expect(
      systemLine(
        '<alca:worker id="wkr_1" status="succeeded" title="比價">\n結果摘要（全文 2014 字，未放進這裡）：北岸最便宜\n全文：spl_1（需要細節時用 recall 取回）\n相鄰：對話 thr_1\n</alca:worker>\n工人「比價」完成了',
      ),
    ).toEqual({ label: "工人回報", text: "北岸最便宜" });
    expect(systemLine("<alca:memory>\nx\n</alca:memory>")).toBeNull();
  });

  it("a worker's stop reason reads in the interface language, never a hard-coded 「停下：」 (review #20)", async () => {
    const msg =
      '<alca:worker id="wkr_2" status="failed" title="訂位">\n停止原因：網站要求驗證碼\n</alca:worker>';
    expect(systemLine(msg)?.text).toBe("停下：網站要求驗證碼");
    const { setLocale } = await import("../../../packages/design/src/i18n/index.ts");
    setLocale("en");
    try {
      expect(systemLine(msg)?.text).toBe("Stopped: 網站要求驗證碼");
    } finally {
      setLocale("zh-Hant-TW");
    }
  });

  // Mac test 2026-11-04b C2: a worker whose last step failed is not "done" on the phone either.
  it("a worker report with ok=false reads as not done", () => {
    const failed = reportOf(
      "m1",
      '<alca:worker id="wkr_1" status="succeeded" ok="false" tool_errors="1" title="示範商店結帳">\n失敗的步驟：找不到 Chromium\n</alca:worker>\n…',
    );
    expect(failed).toMatchObject({ status: "failed", title: "「示範商店結帳」沒有完成" });
    const ok = reportOf(
      "m2",
      '<alca:worker id="wkr_2" status="succeeded" ok="true" title="比價">\n好了\n</alca:worker>',
    );
    expect(ok).toMatchObject({ status: "succeeded" });
  });
});
