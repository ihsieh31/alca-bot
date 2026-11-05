import { describe, expect, it } from "vitest";
import { mergeBotHarness } from "../src/bot-harness.ts";
import { needsApproveKey } from "../src/ui-session.ts";
import {
  FULL_ACCESS_WARNING,
  fullAccessNext,
  harnessBody,
  harnessDraft,
  levelDraft,
  levelToSend,
  PHONE_REFUSAL,
} from "../ui/bot-advanced-model.ts";
import { ConfirmGate, confirmText, type Snapshot, type SnapshotAction } from "../ui/snapshot-view.ts";
import {
  answerCheck,
  autoAllowedLines,
  budgetRows,
  expiresIn,
  harnessSections,
  needsPerson,
  PHASE_WORD,
  phaseTone,
  sandboxBadge,
  snapshotSkippedLine,
  verificationLine,
  type WorkerHarness,
} from "../ui/worker-view.ts";

/** Phase 6: the worker panel, snapshot and bot-editor rules the desktop UI draws (pure, no DOM). */

const base = (over: Partial<WorkerHarness> = {}): WorkerHarness => ({
  kind: "coding",
  phase: "running",
  budget: { steps: 0, tokens: 0, waitedMs: 0 },
  ...over,
});

describe("worker panel: phase and verification", () => {
  it("names every phase and tones the ones a person must act on", () => {
    for (const p of [
      "running",
      "waiting_input",
      "waiting_event",
      "verifying",
      "done",
      "partial",
      "unverified",
      "needs_review",
    ] as const)
      expect(PHASE_WORD[p]).toBeTruthy();
    expect(PHASE_WORD.verifying).toBe("驗證中");
    expect(PHASE_WORD.waiting_input).toBe("等你回答");
    expect(phaseTone("verifying")).toBe("live");
    expect(phaseTone("waiting_input")).toBe("waiting");
    expect(phaseTone("done")).toBe("ok");
    expect(phaseTone("unverified")).toBe("warn");
    expect(phaseTone("failed")).toBe("bad");
    expect(needsPerson("waiting_input")).toBe(true);
    expect(needsPerson("needs_review")).toBe(true);
    expect(needsPerson("waiting_event")).toBe(false);
  });

  it("says green, red (which check, its exit) or running", () => {
    expect(verificationLine(undefined)).toBeUndefined();
    expect(verificationLine({ state: "running", round: 2, checks: [] })).toBe("驗證中（第 2 次）…");
    expect(
      verificationLine({
        state: "passed",
        round: 1,
        checks: [{ command: "pnpm test", exitCode: 0, ok: true, summary: "" }],
      }),
    ).toBe("綠燈：1 項檢查都通過（第 1 次）");
    expect(
      verificationLine({
        state: "failed",
        round: 1,
        checks: [
          { command: "pnpm lint", exitCode: 0, ok: true, summary: "" },
          { command: "pnpm test", exitCode: 1, ok: false, summary: "1 failed" },
        ],
      }),
    ).toBe("紅燈：pnpm test（exit 1）");
    expect(
      verificationLine({
        state: "failed",
        round: 1,
        checks: [{ command: "pnpm test", exitCode: null, ok: false, summary: "" }],
      }),
    ).toContain("被中斷或逾時");
  });
});

describe("worker panel: budget", () => {
  it("shows steps, tokens and running time against their caps, leaving out time spent waiting", () => {
    const rows = budgetRows(
      { steps: 36, maxSteps: 40, tokens: 1200, maxTokens: 90_000, waitedMs: 60_000, maxRunMs: 600_000 },
      { startedAt: "2026-11-05T01:00:00Z", finishedAt: "2026-11-05T01:06:00Z" },
    );
    expect(rows.map((r) => [r.label, r.text, r.high])).toEqual([
      ["步數", "36 / 40", true],
      ["tokens", "1,200 / 90,000", false],
      ["時間", "5 分 / 10 分", false],
    ]);
    expect(rows[0]?.ratio).toBeCloseTo(0.9);
  });

  it("without a cap there is no ratio", () => {
    const [steps] = budgetRows({ steps: 3, tokens: 0, waitedMs: 0 }, {});
    expect(steps).toMatchObject({ text: "3", ratio: undefined, high: false });
  });
});

describe("worker panel: answering NEEDS_INPUT", () => {
  const qs = [
    { question: "寄平信還是掛號？", options: ["掛號", "平信"], personOnly: false },
    { question: "收件人電話？", personOnly: true },
  ];

  it("sends one answer per question, in order, trimmed", () => {
    expect(answerCheck(qs, [" 掛號 ", "0912-000-000"])).toEqual({
      ok: true,
      answers: ["掛號", "0912-000-000"],
    });
  });

  it("names the question still unanswered and sends nothing", () => {
    expect(answerCheck(qs, ["掛號", "  "])).toEqual({ ok: false, error: "第 2 題還沒回答" });
    expect(answerCheck([qs[0] as (typeof qs)[number]], [])).toEqual({ ok: false, error: "請先回答" });
    expect(answerCheck([], [])).toMatchObject({ ok: false });
    expect(answerCheck(qs, ["掛號", "x".repeat(4001)])).toMatchObject({ ok: false });
  });

  it("text questions say when they expire; questions with options never do", () => {
    const now = Date.parse("2026-11-05T00:00:00Z");
    expect(expiresIn(base({ questionsExpireAt: "2026-11-07T00:00:00Z" }), now)).toBe("48 小時 0 分後過期");
    expect(expiresIn(base({ questionsExpireAt: "2026-11-04T00:00:00Z" }), now)).toBe("已過期");
    expect(expiresIn(base(), now)).toBeUndefined();
  });

  it("answering as the person needs the approve key on the desktop", () => {
    expect(needsApproveKey("POST", "/api/workers/wkr_1/answer")).toBe(true);
    expect(needsApproveKey("POST", "/api/workers/wkr_1/stop")).toBe(false);
  });
});

describe("worker panel: 完全授權 log", () => {
  it("lists the auto-allowed calls newest first", () => {
    const now = Date.parse("2026-11-05T00:10:00Z");
    const lines = autoAllowedLines(
      base({
        autoAllowed: [
          { at: "2026-11-05T00:00:00Z", tool: "bash", summary: "git push" },
          { at: "2026-11-05T00:09:00Z", tool: "delete_file", summary: "rm build/" },
        ],
      }),
      now,
    );
    expect(lines).toEqual([
      { when: "1 分", text: "delete_file：rm build/" },
      { when: "10 分", text: "bash：git push" },
    ]);
  });
});

const snap = (seq: number): Snapshot => ({
  ref: `refs/alca/snapshots/dsp_1/${seq}`,
  repo: "/w/repo",
  dispatchId: "dsp_1",
  seq,
  commit: "0123456789abcdef",
  createdAt: 0,
});

describe("snapshots: confirm before restore and purge", () => {
  it("nothing runs on the first click; confirm runs it once; cancel drops it", async () => {
    const ran: SnapshotAction[] = [];
    let release: () => void = () => undefined;
    const gate = new ConfirmGate(
      (a) =>
        new Promise<void>((r) => {
          ran.push(a);
          release = r;
        }),
    );
    gate.ask({ kind: "restore", snapshot: snap(2) });
    expect(ran).toHaveLength(0);
    expect(gate.pending?.kind).toBe("restore");
    gate.cancel();
    expect(gate.pending).toBeUndefined();
    expect(await gate.confirm()).toBe(false);
    expect(ran).toHaveLength(0);

    gate.ask({ kind: "restore", snapshot: snap(3) });
    const first = gate.confirm();
    // a second click while it runs does nothing, and nothing else can be asked meanwhile
    expect(await gate.confirm()).toBe(false);
    gate.ask({ kind: "purge" });
    expect(gate.busy).toBe(true);
    release();
    expect(await first).toBe(true);
    expect(ran).toEqual([{ kind: "restore", snapshot: snap(3) }]);
    expect(gate.pending).toBeUndefined();
  });

  it("the restore question says what changes and that the current files are kept first", () => {
    const t = confirmText({ kind: "restore", snapshot: snap(3) }, 4);
    expect(t.title).toBe("還原到「第 3 輪之前」？");
    expect(t.body).toContain("另存成一個快照");
    expect(t.yes).toBe("還原");
    expect(confirmText({ kind: "purge" }, 4).title).toBe("清除這件工作的 4 個快照？");
  });
});

describe("bot editor: 完全授權 switch", () => {
  it("turning it on takes a warning and a second, explicit confirm", () => {
    let s = fullAccessNext("off", "toggle");
    expect(s.step).toBe("warn");
    expect(levelToSend("autonomous", s.step)).toBe("autonomous");
    s = fullAccessNext(s.step, "confirm");
    expect(s.step).toBe("on");
    expect(levelToSend("autonomous", s.step)).toBe("full_access");
    expect(fullAccessNext("warn", "cancel").step).toBe("off");
    expect(fullAccessNext("on", "toggle").step).toBe("off");
    // a confirm with no warning open changes nothing
    expect(fullAccessNext("off", "confirm").step).toBe("off");
  });

  it("the warning says payment and outward sends still ask", () => {
    expect(FULL_ACCESS_WARNING).toContain("付款與對外寄送仍會詢問");
    // 11-05: the warning says which folders keep snapshots and which cannot be undone
    expect(FULL_ACCESS_WARNING).toContain("git 資料夾每一輪程式工作前會先留快照");
    expect(FULL_ACCESS_WARNING).toContain("非 git 資料夾沒有快照，改動無法還原");
  });

  it("a phone can turn it off but never on", () => {
    expect(fullAccessNext("off", "toggle", "phone")).toEqual({ step: "off", refused: PHONE_REFUSAL });
    expect(fullAccessNext("on", "toggle", "phone")).toEqual({ step: "off" });
  });

  it("a bot at 完全授權 opens as 自主 with the switch on", () => {
    expect(levelDraft("full_access")).toEqual({ level: "autonomous", full: "on" });
    expect(levelDraft(null)).toEqual({ level: "team", full: "off" });
    expect(levelDraft("confirm_each_step")).toEqual({ level: "confirm_each_step", full: "off" });
  });
});

describe("bot editor: harness settings", () => {
  it("reads the stored JSON and sends default harness, reviewer and caps", () => {
    const d = harnessDraft(
      JSON.stringify({
        default: "coding",
        reviewer: true,
        coding: { engineId: "e1", maxSteps: 80, maxWallSec: 1800 },
      }),
    );
    expect(d).toMatchObject({ default: "coding", reviewer: true });
    expect(d.caps.coding).toEqual({ maxSteps: "80", maxMinutes: "30", maxTokens: "" });
    expect(harnessBody(d)).toEqual({
      ok: true,
      harness: { default: "coding", reviewer: true, coding: { maxSteps: 80, maxWallSec: 1800 } },
    });
  });

  it("auto and reviewer off send nothing; unreadable JSON opens with the defaults", () => {
    const d = harnessDraft("{oops");
    expect(d).toMatchObject({ default: "auto", reviewer: false });
    expect(harnessBody(d)).toEqual({ ok: true, harness: {} });
  });

  it("a cap above the harness default or not a whole number is refused", () => {
    const d = harnessDraft(null);
    d.caps.general.maxSteps = "61";
    expect(harnessBody(d)).toEqual({ ok: false, error: "一般的步數上限不能超過預設的 60" });
    d.caps.general.maxSteps = "1.5";
    expect(harnessBody(d)).toMatchObject({ ok: false });
  });

  it("the server keeps the per-harness engine and model, and drops anything it does not know", () => {
    const stored = JSON.stringify({ coding: { engineId: "e1", model: "m1", maxSteps: 90 }, reviewer: true });
    const merged = JSON.parse(
      mergeBotHarness(stored, { default: "general", coding: { maxSteps: 50 }, level: "full_access" }) ?? "{}",
    );
    expect(merged).toEqual({ default: "general", coding: { engineId: "e1", model: "m1", maxSteps: 50 } });
    expect(mergeBotHarness(null, {})).toBeNull();
    expect(mergeBotHarness(stored, null)).toBe(JSON.stringify({ coding: { engineId: "e1", model: "m1" } }));
    expect(() => mergeBotHarness(null, "coding")).toThrow();
  });
});

describe("11-05: a full-access coding worker without a snapshot", () => {
  it("says so in the 完全授權 list, which shows even with nothing auto-allowed yet", () => {
    expect(snapshotSkippedLine(base({ snapshotSkipped: "not_git" }))).toBe(
      "這個資料夾不是 git，沒有快照可還原",
    );
    expect(snapshotSkippedLine(base({ snapshotSkipped: "snapshot_failed" }))).toBe("本輪快照失敗");
    expect(snapshotSkippedLine(base())).toBeUndefined();
    const hs = { kind: "coding" as const, phase: "running" as const, dispatchId: "d1" };
    expect(harnessSections({ ...hs, snapshotSkipped: "not_git" }, false)).toContain("allowed");
    expect(harnessSections(hs, false)).not.toContain("allowed");
  });
});

describe("next round §5.4/5.7: the worker panel's sandbox label", () => {
  it("names the sandbox, and without one warns but does not stop the work", () => {
    expect(sandboxBadge(base({ sandbox: "seatbelt" }))).toEqual({ text: "沙箱：Seatbelt", tone: "ok" });
    expect(sandboxBadge(base({ sandbox: "bwrap" }))).toEqual({ text: "沙箱：bubblewrap", tone: "ok" });
    expect(sandboxBadge(base({ sandbox: "off" }))).toEqual({ text: "沙箱：關", tone: "quiet" });
    const none = sandboxBadge(base({ sandbox: "unavailable" }));
    expect(none?.tone).toBe("warn");
    expect(none?.warning).toContain("直接以你的權限執行");
    expect(sandboxBadge(base())).toBeUndefined(); // an older core
  });
});
