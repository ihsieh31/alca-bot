// Mac test 2026-11-04b C2: what counts as the router claiming a failed worker's task is done.
import { describe, expect, it } from "vitest";
import { failedWorkerNote, workerOk } from "../src/index.ts";

const report = (ok: boolean, extra = "") =>
  `<alca:worker id="wkr_1" status="succeeded" ok="${ok}" title="示範商店結帳">\n${extra}沒有執行：瀏覽器開不起來\n</alca:worker>`;

describe("failedWorkerNote", () => {
  it.each([
    ["「示範商店結帳」完成了。瀏覽器開不起來", true],
    ["已經完成結帳", true],
    ["搞定！", true],
    ["沒有完成：瀏覽器開不起來。", false],
    ["無法完成結帳，因為瀏覽器開不起來。", false],
    ["還沒完成，要再試一次嗎？", false],
    ["工人說不要說「完成了」——其實失敗了。", false],
    ["結帳失敗：找不到瀏覽器。", false],
  ])("%s → note %s", (reply, expected) => {
    expect(!!failedWorkerNote(report(false, "失敗的步驟：找不到 Chromium\n"), [reply])).toBe(expected);
  });

  it("names the failed step", () => {
    expect(failedWorkerNote(report(false, "失敗的步驟：找不到 Chromium\n"), ["完成了"])).toContain(
      "找不到 Chromium",
    );
  });

  it("never notes an ok worker or a turn that is not a worker report", () => {
    expect(failedWorkerNote(report(true), ["完成了"])).toBeUndefined();
    expect(failedWorkerNote("幫我結帳", ["完成了"])).toBeUndefined();
  });

  it("workerOk: the turn finished and the last step did not fail", () => {
    expect(workerOk({ status: "succeeded", toolErrors: { count: 0, last: null } })).toBe(true);
    expect(workerOk({ status: "succeeded", toolErrors: { count: 2, last: null } })).toBe(true);
    expect(workerOk({ status: "succeeded", toolErrors: { count: 1, last: "boom" } })).toBe(false);
    expect(workerOk({ status: "failed", toolErrors: { count: 0, last: null } })).toBe(false);
  });
});
