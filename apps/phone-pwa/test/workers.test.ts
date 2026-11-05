import { describe, expect, it } from "vitest";
import { botArgs, botDraft, fullAccessOff, PHONE_FULL_ACCESS_REFUSAL } from "../app/forms-view.ts";
import type { TeamBot } from "../app/team-view.ts";
import {
  answerCheck,
  budgetLine,
  canAnswer,
  cardStatus,
  PHASE_WORD,
  sandboxBadge,
  snapshotSkippedLine,
  verificationLine,
  type WorkerHarness,
} from "../app/worker-view.ts";

/** Phase 6: the phone's worker sheet and the 完全授權 rule on the phone (pure, no DOM). */

const hs = (over: Partial<WorkerHarness> = {}): WorkerHarness => ({
  kind: "general",
  phase: "waiting_input",
  budget: { steps: 4, maxSteps: 60, tokens: 1500, waitedMs: 0 },
  questions: [{ question: "寄平信還是掛號？", options: ["掛號", "平信"], personOnly: false }],
  ...over,
});

describe("phone × worker sheet (Phase 6)", () => {
  it("shows the phase in the card's colours: a finished worker waiting on you is waiting", () => {
    expect(PHASE_WORD.waiting_input).toBe("等你回答");
    expect(PHASE_WORD.verifying).toBe("驗證中");
    expect(cardStatus("waiting_input")).toBe("waiting");
    expect(cardStatus("verifying")).toBe("running");
    expect(cardStatus("done")).toBe("succeeded");
    expect(cardStatus("unverified")).toBe("stopped");
    expect(cardStatus("failed")).toBe("failed");
  });

  it("one budget line and the verification result", () => {
    expect(budgetLine(hs().budget)).toBe("4/60 步 · 1,500 tokens");
    expect(
      verificationLine({
        state: "failed",
        round: 1,
        checks: [{ command: "pnpm test", exitCode: 1, ok: false, summary: "" }],
      }),
    ).toEqual({ text: "檢查紅燈：pnpm test", ok: false });
    expect(verificationLine({ state: "passed", round: 1, checks: [] })).toEqual({
      text: "檢查綠燈",
      ok: true,
    });
  });

  it("answers in place only with the approve scope, and only while it waits", () => {
    expect(canAnswer(hs(), (s) => s === "approve")).toBe(true);
    expect(canAnswer(hs(), (s) => s === "chat")).toBe(false);
    expect(canAnswer(hs({ phase: "continued" }), () => true)).toBe(false);
    expect(canAnswer(undefined, () => true)).toBe(false);
  });

  it("sends one answer per question or says which is missing", () => {
    const qs = hs().questions ?? [];
    expect(answerCheck(qs, ["掛號"])).toEqual({ ok: true, answers: ["掛號"] });
    expect(answerCheck(qs, [""])).toEqual({ ok: false, error: "請先回答" });
  });
});

const bot = (over: Partial<TeamBot> = {}): TeamBot => ({
  id: "bot_a",
  name: "研究員",
  isDefault: false,
  avatar: "研",
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

describe("phone × 完全授權 (Phase 5 rule, Phase 6 form)", () => {
  it("cannot turn it on: neither on a new bot nor on an edit", () => {
    expect(botArgs({ ...botDraft(), name: "新", approvalLevel: "full_access" })).toEqual({
      ok: false,
      error: PHONE_FULL_ACCESS_REFUSAL,
    });
    const b = bot({ approvalLevel: "autonomous" });
    expect(botArgs({ ...botDraft(b), approvalLevel: "full_access" }, b)).toEqual({
      ok: false,
      error: PHONE_FULL_ACCESS_REFUSAL,
    });
  });

  it("can turn it off: the bot goes back to 自主", () => {
    const b = bot({ approvalLevel: "full_access" });
    const off = fullAccessOff(botDraft(b));
    expect(off.approvalLevel).toBe("autonomous");
    expect(botArgs(off, b)).toEqual({ ok: true, args: { approvalLevel: "autonomous" } });
    // editing something else on a bot already at 完全授權 does not touch the level
    expect(botArgs({ ...botDraft(b), role: "查資料" }, b)).toEqual({ ok: true, args: { role: "查資料" } });
  });
});

describe("11-05: a full-access coding worker without a snapshot (phone)", () => {
  it("has the same line as the desktop panel", () => {
    expect(snapshotSkippedLine(hs({ snapshotSkipped: "not_git" }))).toBe(
      "這個資料夾不是 git，沒有快照可還原",
    );
    expect(snapshotSkippedLine(hs({ snapshotSkipped: "snapshot_failed" }))).toBe("本輪快照失敗");
    expect(snapshotSkippedLine(hs())).toBeUndefined();
  });
});

describe("next round §5.7: the phone shows the computer's sandbox state", () => {
  it("labels it, and warns when the computer has none", () => {
    expect(sandboxBadge(hs({ sandbox: "bwrap" }))?.text).toBe("沙箱：bubblewrap");
    const none = sandboxBadge(hs({ sandbox: "unavailable" }));
    expect(none?.tone).toBe("warn");
    expect(none?.warning).toContain("電腦上的 bot 設定");
    expect(sandboxBadge(hs())).toBeUndefined();
  });
});
