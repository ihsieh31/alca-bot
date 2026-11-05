import { describe, expect, it } from "vitest";
import {
  ACP_CAPABILITIES,
  appServerHarness,
  CLAUDE_CODE_CAPABILITIES,
  CODEX_CAPABILITIES,
  checkHarnessFit,
  HARNESS_MATRIX,
  harnessCapsOf,
  ScriptedEngine,
} from "../src/index.ts";

// Plan §3.1: the capability matrix and the host's fit check.

const caps = (harness: (typeof HARNESS_MATRIX)[keyof typeof HARNESS_MATRIX]) => ({
  capabilities: { ...ACP_CAPABILITIES, harness },
});

describe("harness capability matrix", () => {
  it("coding: own loop, or a CLI that asks before every write and every command", () => {
    expect(checkHarnessFit(new ScriptedEngine([]), "coding")).toEqual({ ok: true });
    for (const r of [
      HARNESS_MATRIX.claudeCoding,
      HARNESS_MATRIX.codexAppServerCoding,
      HARNESS_MATRIX.acpCoding,
    ])
      expect(checkHarnessFit(caps(r), "coding")).toEqual({ ok: true });
    for (const r of [
      HARNESS_MATRIX.codexExec,
      HARNESS_MATRIX.codexAppServerOnRequest,
      HARNESS_MATRIX.acpAtLevel,
    ]) {
      const fit = checkHarnessFit(caps(r), "coding");
      expect(fit).toMatchObject({ ok: false, code: "harness.engine_unfit" });
      expect(fit.ok ? "" : fit.reason).toContain("不能做 coding 工作");
    }
  });

  it("Phase 5: the fit depends on the level — 'some' fits coding only at full access, snapshot each turn", () => {
    const some = caps(HARNESS_MATRIX.codexAppServerOnRequest);
    for (const level of ["confirm_each_step", "autonomous"])
      expect(checkHarnessFit(some, "coding", undefined, { level }).ok, level).toBe(false);
    expect(checkHarnessFit(some, "coding", undefined, { level: "full_access" })).toEqual({
      ok: true,
      snapshotEachTurn: true,
    });
    // an engine that never asks before commands stays unfit, at every level
    expect(
      checkHarnessFit(caps(HARNESS_MATRIX.codexExec), "coding", undefined, { level: "full_access" }).ok,
    ).toBe(false);
    // Mac test B2: engines that always ask are cleared unasked at full access too, so they
    // keep a snapshot every turn where they can (own loop the same). 11-05: a folder that is
    // not git is no longer a reason to refuse; the fit does not look at the folder at all.
    for (const r of [
      HARNESS_MATRIX.claudeCoding,
      HARNESS_MATRIX.acpCoding,
      HARNESS_MATRIX.codexAppServerCoding,
    ]) {
      expect(checkHarnessFit(caps(r), "coding", undefined, { level: "full_access" })).toEqual({
        ok: true,
        snapshotEachTurn: true,
      });
      // other levels: as before, no snapshot
      for (const level of ["confirm_each_step", "autonomous"])
        expect(checkHarnessFit(caps(r), "coding", undefined, { level }), level).toEqual({ ok: true });
    }
    const own = new ScriptedEngine([]);
    expect(checkHarnessFit(own, "coding", undefined, { level: "full_access" })).toEqual({
      ok: true,
      snapshotEachTurn: true,
    });
    expect(checkHarnessFit(own, "coding", undefined, { level: "autonomous" })).toEqual({ ok: true });
    // general is never widened by the level
    expect(checkHarnessFit(some, "general", undefined, { level: "full_access" }).ok).toBe(false);
    expect(
      checkHarnessFit(caps(HARNESS_MATRIX.acpAtLevel), "general", undefined, { level: "full_access" }).ok,
    ).toBe(false);
  });

  it("coding: an engine that cannot write at all is refused with its own reason", () => {
    const fit = checkHarnessFit(caps({ ...HARNESS_MATRIX.codexExec, writes: "none" }), "coding");
    expect(fit.ok ? "" : fit.reason).toContain("現在不能改檔");
  });

  it("general: read-only / host-tool engines fit; native writes must ask every time", () => {
    for (const r of [
      HARNESS_MATRIX.claudeGeneral,
      HARNESS_MATRIX.codexExec,
      HARNESS_MATRIX.codexAppServerReadOnly,
      HARNESS_MATRIX.acpGeneral,
      HARNESS_MATRIX.claudeCoding,
    ])
      expect(checkHarnessFit(caps(r), "general")).toEqual({ ok: true });
    expect(checkHarnessFit(caps(HARNESS_MATRIX.acpAtLevel), "general")).toMatchObject({ ok: false });
    expect(checkHarnessFit(caps(HARNESS_MATRIX.codexAppServerOnRequest), "general")).toMatchObject({
      ok: false,
    });
  });

  it("each driver declares its row; an undeclared tool-owning engine is assumed not to ask", () => {
    expect(harnessCapsOf({ capabilities: CLAUDE_CODE_CAPABILITIES })).toBe(HARNESS_MATRIX.claudeCoding);
    expect(harnessCapsOf({ capabilities: CODEX_CAPABILITIES })).toBe(HARNESS_MATRIX.codexExec);
    expect(appServerHarness("workspace-write", "untrusted")).toBe(HARNESS_MATRIX.codexAppServerCoding);
    expect(appServerHarness("workspace-write", "on-request")).toBe(HARNESS_MATRIX.codexAppServerOnRequest);
    expect(appServerHarness("read-only", "never")).toBe(HARNESS_MATRIX.codexAppServerReadOnly);
    const undeclared = harnessCapsOf({ ...ACP_CAPABILITIES });
    expect(undeclared).toMatchObject({ loop: "cli", writes: "native", asksBeforeWrite: "some" });
    expect(harnessCapsOf(new ScriptedEngine([]))).toMatchObject({ loop: "own", writes: "host_tools" });
  });
});
