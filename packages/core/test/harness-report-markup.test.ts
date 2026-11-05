import { describe, expect, it } from "vitest";
import { parseReport } from "../src/harness/contract.ts";
import { cleanReportArgs } from "../src/harness/markup.ts";

/**
 * Mac test B8: raw tool-call markup leaked into report_result's text is cut
 * off, and the parameters in it are salvaged into the structured fields.
 * Made-up reports only.
 */

describe("report_result with leaked tool-call markup", () => {
  it('the mac case: </summary> + <parameter name="changes"> — summary cut, changes salvaged', () => {
    const r = parseReport({
      status: "blocked",
      unblock: "請補上測試指令",
      summary:
        '已建立 README，但專案沒有測試指令，因此檢查無法通過。</summary>\n<parameter name="changes">["README.md（新建）", "docs/usage.md"]',
    });
    if (typeof r === "string") throw new Error(r);
    expect(r.summary).toBe("已建立 README，但專案沒有測試指令，因此檢查無法通過。");
    expect(r.summary).not.toMatch(/<\/?(summary|parameter)/);
    expect(r.changes).toEqual(["README.md（新建）", "docs/usage.md"]);
  });

  it("several leaked parameters, closed or not, invoke tags; a list that is not JSON becomes lines", () => {
    const a = cleanReportArgs({
      status: "done",
      summary:
        '修好了 parser。</parameter>\n<parameter name="changes">- src/parser.ts\n- test/parser.test.ts</parameter>\n<parameter name="proposal">之後可以加快取</parameter>\n</invoke>',
    });
    expect(a.summary).toBe("修好了 parser。");
    expect(a.changes).toEqual(["src/parser.ts", "test/parser.test.ts"]);
    expect(a.proposal).toBe("之後可以加快取");
  });

  it("never overwrites what the call carried, and leaves ordinary text (even with HTML) alone", () => {
    const a = cleanReportArgs({
      status: "done",
      summary: '加了 <div class="x"></div> 區塊。</summary><parameter name="changes">["leaked.ts"]',
      changes: ["real.ts"],
    });
    expect(a.summary).toBe('加了 <div class="x"></div> 區塊。');
    expect(a.changes).toEqual(["real.ts"]);
    const plain = { status: "done", summary: "用 <b>粗體</b> 寫了說明，沒有殘留。", changes: [] };
    expect(cleanReportArgs(plain)).toBe(plain);
    const r = parseReport(plain);
    expect(typeof r !== "string" && r.summary).toBe("用 <b>粗體</b> 寫了說明，沒有殘留。");
  });

  it("markup in the unblock text is cut too; a summary that is only markup is still refused", () => {
    const a = cleanReportArgs({
      status: "blocked",
      summary: "卡住了",
      unblock: '登入後台</unblock>\n<parameter name="claims">[]',
    });
    expect(a.unblock).toBe("登入後台");
    expect(a.claims).toEqual([]);
    expect(parseReport({ status: "done", summary: '<parameter name="changes">["a.ts"]' })).toBe(
      "需要 summary（具體的結果）",
    );
  });
});
