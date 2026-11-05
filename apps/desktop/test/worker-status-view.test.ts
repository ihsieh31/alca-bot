import { describe, expect, it } from "vitest";
import { reviewView as phoneReview, working } from "../../phone-pwa/app/worker-view.ts";
import { reportLine, reportWord } from "../ui/report-text.ts";
import { isWorking, reviewView, statusTone, statusWord } from "../ui/worker-view.ts";

/** Mac test 2026-11 B4 / B6: what the panels and chat cards say (pure, no DOM). Fictional data only. */

const hs = (phase: string) => ({ phase }) as { phase: "waiting_input" };

describe("worker status on the panels (B6)", () => {
  it("never says 完成 while the task waits; the stop button only while it works", () => {
    const waiting = { status: "waiting", harness: hs("waiting_input") };
    expect(statusWord(waiting)).toBe("等你回答");
    expect(statusTone(waiting)).toBe("waiting");
    expect(isWorking(waiting)).toBe(false);
    expect(working(waiting)).toBe(false);
    const blocked = { status: "needs_review", harness: hs("blocked") };
    expect(statusWord(blocked)).toBe("卡住了");
    expect(statusTone(blocked)).toBe("needs_review");
    const verifying = { status: "running", harness: hs("verifying") };
    expect(isWorking(verifying)).toBe(true);
    expect(working(verifying)).toBe(true);
    expect(statusWord({ status: "succeeded", harness: hs("done") })).toBe("完成");
    // a plain worker still goes by its status
    expect(statusWord({ status: "waiting" })).toBe("需要你");
    expect(isWorking({ status: "waiting" })).toBe(true);
    expect(isWorking({ status: "succeeded" })).toBe(false);
  });
});

describe("the reviewer line (B4)", () => {
  it("通過, 未達成 with gaps, 跳過 with why; nothing when no review ran", () => {
    for (const view of [reviewView, phoneReview]) {
      expect(view({ review: { state: "met", round: 1 } })).toMatchObject({ title: "審查：通過", tone: "ok" });
      expect(view({ review: { state: "gaps", round: 2, gaps: ["少了排序"] } })).toEqual({
        title: "審查：未達成",
        tone: "warn",
        gaps: ["少了排序"],
      });
      expect(view({ review: { state: "skipped", round: 1, reason: "engine_not_read_only" } })?.title).toBe(
        "審查：跳過（這個引擎無法以唯讀方式審查）",
      );
      expect(view({ review: { state: "skipped", round: 1, reason: "new_reason" } })?.title).toBe(
        "審查：跳過（原因不明）",
      );
      // an older core sends only gaps
      expect(view({ gaps: ["x"] })?.title).toBe("審查：未達成");
      expect(view({})).toBeUndefined();
    }
  });
});

describe("worker report cards in plain words (B6)", () => {
  it("a question is 有問題要問你, not 沒有完成", () => {
    expect(reportWord("succeeded", "false", "needs_input")).toEqual({
      word: "有問題要問你",
      tone: "waiting",
    });
    expect(reportWord("succeeded", "false", "blocked").word).toBe("卡住了");
    expect(reportWord("succeeded", "true", "done")).toEqual({ word: "完成了", tone: "succeeded" });
    expect(reportWord("succeeded", "false", undefined)).toEqual({ word: "沒有完成", tone: "failed" });
    expect(reportWord("stopped", "false", undefined).word).toBe("停下了");
  });

  it("no status=… or NEEDS_INPUT labels, and none of the router's own instructions", () => {
    expect(reportLine("工人原話（status=needs_input）：要先確定時段")).toBe("要先確定時段");
    expect(reportLine("工人原話（沒有呼叫 report_result，以下是它最後的文字）：做好了")).toBe("做好了");
    expect(reportLine("NEEDS_INPUT 1：哪一天？；選項（第一個是推薦）：週日／週六")).toBe(
      "問題 1：哪一天？（選項：週日／週六）",
    );
    expect(reportLine("NEEDS_INPUT 2（只有本人能答）：登入碼？")).toBe("問題 2：登入碼？");
    expect(reportLine("這些題目要問使用者本人；他回覆後，用 worker_answer 轉交")).toBeUndefined();
    expect(reportLine("這是工人的說法，請用上面 harness 的實際動作核對")).toBeUndefined();
    // O5b: the router's verdict line is not shown on the card (its status word says it)
    expect(
      reportLine("結果：未驗證（unverified）：做了，但檢查沒有通過。不是完成（not done）。"),
    ).toBeUndefined();
    expect(reportLine("自稱的改動：a.ts")).toBe("改動：a.ts");
    for (const l of ["工人原話（status=blocked）：卡住", "NEEDS_INPUT 1：x"])
      expect(reportLine(l)).not.toMatch(/status=|NEEDS_INPUT/);
  });
});
