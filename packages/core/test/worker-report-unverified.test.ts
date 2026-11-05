// Mac device test 2026-11-05 O5b: a coding worker ended unverified (no check to
// run), its report went to the router as status="succeeded" ok="false"
// report="unverified" with a generic "not done" line, and the router told the
// user 「兩件事都做了」. The report now says the verdict in plain words in both
// languages, and the honesty note catches 都做了／做好了 and English claims.
import type { WorkerRecord } from "@alca/store";
import { describe, expect, it } from "vitest";
import { failedWorkerNote, formatWorkerReport } from "../src/index.ts";

const worker = (over: Partial<WorkerRecord> = {}): WorkerRecord =>
  ({
    id: "wkr_1",
    botId: "bot",
    threadId: "thr_1",
    title: "改 a.txt 與 b.txt",
    status: "succeeded",
    stopReason: null,
    result: { mode: "inline", summary: "改好了", chars: 3 },
    toolErrors: { count: 0, last: null },
    parentRunId: null,
    ...over,
  }) as unknown as WorkerRecord;

describe("formatWorkerReport: a report that is not done says so", () => {
  it("unverified: the verdict line names 未驗證 / unverified and the closing line forbids 做好了", () => {
    const body = formatWorkerReport(worker(), {
      lines: ["收工驗證：沒有通過或沒有跑（status 已標成 unverified）"],
      ok: false,
      report: "unverified",
    });
    const [head, verdict] = body.split("\n");
    expect(head).toContain('ok="false"');
    expect(head).toContain('report="unverified"');
    expect(verdict).toMatch(/^結果：未驗證（unverified）/);
    expect(verdict).toContain("不是完成（not done）");
    expect(body).toContain("未驗證：請告訴使用者做了什麼、但沒有驗證過");
    expect(body).not.toContain("完成了，請向使用者簡短回報");
  });

  it.each([
    ["partial", "只做了一部分（partial）"],
    ["blocked", "卡住了（blocked）"],
    ["needs_input", "在等使用者回答（needs_input）"],
  ])("%s gets its own word", (report, word) => {
    const body = formatWorkerReport(worker(), { lines: [], ok: false, report });
    expect(body.split("\n")[1]).toBe(`結果：${word}。不是完成（not done）。`);
  });

  it("a failed step and a stopped worker get a verdict line too; a done worker none", () => {
    const failedStep = formatWorkerReport(
      worker({ toolErrors: { count: 1, last: "browser_open：沒有瀏覽器" } }),
    );
    expect(failedStep.split("\n")[1]).toBe("結果：最後一個步驟失敗（failed step）。不是完成（not done）。");
    const stopped = formatWorkerReport(worker({ status: "stopped", stopReason: "budget" }));
    expect(stopped.split("\n")[1]).toBe("結果：已停止（stopped）。不是完成（not done）。");
    const done = formatWorkerReport(worker(), { lines: [], ok: true, report: "done" });
    expect(done).not.toContain("結果：");
    expect(done).toContain("完成了，請向使用者簡短回報");
  });
});

describe("failedWorkerNote: the router saying an unverified task is done", () => {
  const input = formatWorkerReport(worker(), { lines: [], ok: false, report: "unverified" });

  it.each([
    ["兩件事都做了。", true],
    ["a.txt 和 b.txt 都改好了，做好了。", true],
    ["Both tasks are done.", true],
    ["I've completed both changes.", true],
    ["改了 a.txt 和 b.txt，但沒有驗證過（沒有檢查可跑）。", false],
    ["The files were changed but not verified; the work is not done until a check passes.", false],
    ["It has not completed verification.", false],
  ])("%s → note %s", (reply, expected) => {
    expect(!!failedWorkerNote(input, [reply])).toBe(expected);
  });

  it("the note gives the verdict as the reason", () => {
    expect(failedWorkerNote(input, ["都做了"])).toContain("未驗證（unverified）");
  });

  // Review #15: honest English reports that merely use "finished" / "completed".
  it.each([
    ["The worker finished, but the build failed.", false],
    ["3 of 5 steps completed; the last two need a retry.", false],
    ["The task finished with an error in the tests.", false],
    ["I've finished it, but the check failed.", false],
    ["It's done.", true],
    ["All done — both files are updated.", true],
    ["The changes have been done. Both files are updated.", true],
    ["We successfully completed the migration.", true],
  ])("English: %s → note %s", (reply, expected) => {
    expect(!!failedWorkerNote(input, [reply])).toBe(expected);
  });

  it("the note follows the reply's language", () => {
    const en = failedWorkerNote(input, ["It's done."]) ?? "";
    expect(en).toMatch(/^Alca note: the worker "/u);
    expect(en).toContain('The "done" above is not correct.');
    expect(en).not.toContain("上面說的");
    const zh = failedWorkerNote(input, ["都做了"]) ?? "";
    expect(zh).toMatch(/^Alca 註記：/u);
  });
});
