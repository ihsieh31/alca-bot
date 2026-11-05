import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { STALE_WORD, staleApprovals, workerEnded } from "../ui/approval-stale.ts";
import { REVIEWER_NOTE, TOKEN_CAP_PLACEHOLDER } from "../ui/bot-advanced-model.ts";
import { harnessSections } from "../ui/worker-view.ts";
import { uiText } from "./ui-text.ts";

/** Mac test 2026-11 B10 (desktop layout) and B4 (reviewer note). Fictional data only. */

// G2: a .ts file is read with its words filled in from the string table.
const css = (f: string) =>
  f.endsWith(".ts") ? uiText(`apps/desktop/ui/${f}`) : readFileSync(`apps/desktop/ui/${f}`, "utf8");
const rule = (src: string, sel: string): string => {
  const i = src.indexOf(`${sel} {`);
  expect(i, `${sel} has a rule`).toBeGreaterThanOrEqual(0);
  return src.slice(i, src.indexOf("}", i));
};

describe("bot editor layout (B10)", () => {
  it("the editor is a flex column, so the 設定／擴充 tabs never sit over the body", () => {
    const ed = rule(css("bot-edit.css"), ".tm-editor");
    expect(ed).toContain("display: flex;");
    expect(ed).toContain("flex-direction: column;");
    expect(ed).not.toContain("grid-template-rows");
  });

  it("the body takes the room that is left and scrolls inside it", () => {
    const body = rule(css("bot-edit.css"), ".be-body");
    expect(body).toContain("flex: 1;");
    expect(body).toContain("min-height: 0;");
    expect(body).toContain("overflow-y: auto;");
  });

  it("進階 is one word on one line, never stacked", () => {
    const word = rule(css("bot-edit.css"), ".be-adv-word");
    expect(word).toContain("white-space: nowrap;");
    expect(word).toContain("flex: none;");
    expect(css("bot-edit.ts")).toContain('h("span", { class: "be-adv-word" }, "進階")');
  });

  it("the token cap's placeholder is short enough for its field", () => {
    expect(TOKEN_CAP_PLACEHOLDER).toBe("預設");
    const src = css("bot-advanced.ts");
    expect(src).toContain("TOKEN_CAP_PLACEHOLDER");
    expect(src).not.toMatch(/placeholder: "tokens（預設跟系統）"/);
  });
});

describe("reviewer note (B4)", () => {
  it("says the reviewer only reads and never edits files", () => {
    expect(REVIEWER_NOTE).toContain("唯讀");
    expect(REVIEWER_NOTE).toContain("不改檔");
    const src = css("bot-advanced.ts");
    expect(src).toContain("REVIEWER_NOTE");
    expect(src).not.toContain("不帶工具的審查者");
  });
});

describe("worker panel order (B10)", () => {
  const base = { kind: "general" as const, phase: "waiting_input" as const };

  it("open questions and the 完全授權 list come before everything else", () => {
    const s = harnessSections(
      {
        ...base,
        doneWhen: "選好時段",
        questions: [{ id: "q1", prompt: "哪一天？" }] as never,
        autoAllowed: [{ at: "2026-01-01T00:00:00Z", tool: "shell", summary: "ls" }],
      },
      true,
    );
    expect(s.slice(0, 2)).toEqual(["questions", "allowed"]);
    expect(s).toEqual(["questions", "allowed", "doneWhen", "checks", "budget", "review"]);
  });

  it("questions show only while the worker waits on them; snapshots only for coding work", () => {
    const q = [{ id: "q1", prompt: "哪一天？" }] as never;
    expect(harnessSections({ ...base, phase: "running", questions: q }, false)).toEqual(["budget", "review"]);
    expect(harnessSections({ kind: "coding", phase: "done", dispatchId: "d1" }, false)).toEqual([
      "budget",
      "review",
      "snapshots",
    ]);
    expect(harnessSections({ kind: "general", phase: "done", dispatchId: "d1" }, false)).not.toContain(
      "snapshots",
    );
  });

  it("the summary is not capped at 52vh and scrolls on its own (素 Plain: no scroll-shadow gradient)", () => {
    const sum = rule(css("worker-harness.css"), ".wp-summary");
    expect(sum).not.toContain("52vh");
    expect(sum).toContain("overflow-y: auto;");
    expect(sum).toContain("overscroll-behavior: contain;");
  });
});

describe("approval cards of an ended worker (B10)", () => {
  it("a worker is over once it is past every live phase or status", () => {
    expect(workerEnded({ status: "running" })).toBe(false);
    expect(workerEnded({ status: "waiting" })).toBe(false);
    expect(workerEnded({ status: "failed" })).toBe(true);
    expect(workerEnded({ status: "stopped" })).toBe(true);
    expect(workerEnded({ status: "running", harness: { phase: "waiting_input" } })).toBe(false);
    expect(workerEnded({ status: "running", harness: { phase: "verifying" } })).toBe(false);
    expect(workerEnded({ status: "needs_review", harness: { phase: "blocked" } })).toBe(true);
    expect(workerEnded({ status: "succeeded", harness: { phase: "done" } })).toBe(true);
  });

  it("only the open cards that worker asked for go stale, in order", () => {
    const owners = new Map<string, string | undefined>([
      ["a1", "w-1"],
      ["a2", "w-2"],
      ["a3", "w-1"],
      ["a4", undefined],
    ]);
    const owner = (id: string) => owners.get(id);
    expect(staleApprovals(["a1", "a2", "a3", "a4"], owner, "w-1")).toEqual(["a1", "a3"]);
    expect(staleApprovals(["a2"], owner, "w-1")).toEqual([]);
    expect(staleApprovals(["a4"], owner, "")).toEqual([]);
    expect(STALE_WORD).toBe("已失效");
  });

  it("the timeline keeps the worker on each card and drops the buttons of a stale one", () => {
    const tl = css("timeline.ts");
    expect(tl).toContain("workerId: wid");
    // 素 Plain: the card folds into a receipt row; a stale one says 已失效 (approval-card.ts).
    expect(tl).toContain("card.resolve(decision, STALE_WORD, at)");
    expect(css("approval-card.ts")).toMatch(/stale: \["alert", "muted"/);
    expect(tl).toMatch(/workerUpdated\(w[^)]*\): void \{\s*if \(!workerEnded\(w\)\) return;/);
    const app = css("app.ts");
    expect(app).toContain('e.type === "worker.updated"');
    expect(app).toContain("timeline.workerUpdated(");
  });
});
