import { ScriptedEngine } from "@alca/engines";
import { checkSequence } from "@alca/protocol";
import { describe, expect, it } from "vitest";
import { LoopGuard } from "../src/index.ts";
import { isType, makeCore, tool } from "./helpers.ts";

const policy = { warnAfterRepeats: 3, hardStopAfterRepeats: 5 };
const fail = (tool: string, args: unknown = {}) => ({ tool, args, ok: false, output: "nope" });

describe("LoopGuard", () => {
  it("repeated identical failures: warn when attended, stop when unattended", () => {
    const watched = new LoopGuard(policy, true);
    const alone = new LoopGuard(policy, false);
    const w = Array.from({ length: 6 }, () => watched.observe(fail("read")).kind);
    const a = Array.from({ length: 6 }, () => alone.observe(fail("read")).kind);
    expect(w).toEqual(["ok", "ok", "warn", "warn", "warn", "warn"]);
    expect(a).toEqual(["ok", "ok", "warn", "warn", "stop", "stop"]);
  });

  it("detects an A-B cycle of successful calls", () => {
    const g = new LoopGuard(policy, false);
    const verdicts = [];
    for (let i = 0; i < 6; i++) {
      verdicts.push(g.observe({ tool: "open", args: { p: "a" }, ok: true, output: "A" }));
      verdicts.push(g.observe({ tool: "open", args: { p: "b" }, ok: true, output: "B" }));
    }
    // same calls, same results: the alternation is caught (as a cycle and as repeats of seen results)
    expect(verdicts.at(-1)?.kind).toBe("stop");
    expect(verdicts.find((v) => v.kind === "warn")?.fresh).toBe(true);
  });

  it("detects no progress (same call, same result) and resets on new information", () => {
    const g = new LoopGuard(policy, false);
    const same = { tool: "ls", args: {}, ok: true, output: "x" };
    for (let i = 0; i < 3; i++) g.observe(same);
    expect(g.observe(same)).toMatchObject({ kind: "warn", pattern: "no_progress" });
    expect(g.observe({ ...same, output: "y" }).kind).toBe("ok");
  });

  it("an A-B alternation whose results keep changing is not a cycle", () => {
    const g = new LoopGuard(policy, false);
    for (let i = 0; i < 10; i++) {
      expect(g.observe({ tool: "open", args: { p: "a" }, ok: true, output: `a${i}` }).kind).toBe("ok");
      expect(g.observe({ tool: "open", args: { p: "b" }, ok: true, output: `b${i}` }).kind).toBe("ok");
    }
  });

  // Plan §2.10: the counter-examples of the old branch's stop rules (B1–B3) must pass.
  it("B1: polling a long build is not a loop while its output changes", () => {
    const g = new LoopGuard(policy, false);
    g.observe({ tool: "shell", args: { command: "pnpm build" }, ok: true, output: "started: session 1" });
    for (let i = 0; i < 30; i++)
      expect(
        g.observe({ tool: "bash_poll", args: { session: 1 }, ok: true, output: `compiled ${i * 10} files` })
          .kind,
      ).toBe("ok");
    // the same poll with the same output again and again still is
    const v = Array.from({ length: 6 }, () =>
      g.observe({ tool: "bash_poll", args: { session: 1 }, ok: true, output: "still running" }),
    );
    expect(v.at(-1)?.kind).toBe("stop");
  });

  it("B2: two different red test runs are normal failures, not being stuck", () => {
    const g = new LoopGuard(policy, false);
    const test = (out: string) =>
      g.observe({ tool: "shell", args: { command: "pnpm test" }, ok: false, output: out });
    expect(test("exit code 1: 3 failed").kind).toBe("ok");
    g.observe({ tool: "file_edit", args: { path: "a.ts" }, ok: true, output: "edited" });
    expect(test("exit code 1: 2 failed").kind).toBe("ok");
    g.observe({ tool: "file_edit", args: { path: "a.ts" }, ok: true, output: "edited again" });
    expect(test("exit code 1: 1 failed").kind).toBe("ok");
    // an edit is new information: the same red output after it is not "already seen"
    g.observe({ tool: "file_edit", args: { path: "b.ts" }, ok: true, output: "edited" });
    expect(test("exit code 1: 1 failed").kind).toBe("ok");
    for (let i = 0; i < 6; i++)
      g.observe({ tool: "file_edit", args: { path: `c${i}.ts` }, ok: true, output: "ok" });
    expect(test("exit code 1: 1 failed").kind).toBe("ok");
  });

  it("B3: only consecutive errors count; a success in between starts over", () => {
    const g = new LoopGuard(policy, false);
    for (let round = 0; round < 10; round++) {
      expect(g.observe(fail("read", { p: "x" })).kind).toBe("ok");
      expect(g.observe(fail("read", { p: "x" })).kind).toBe("ok");
      expect(g.observe({ tool: "read", args: { p: "y" }, ok: true, output: `fine ${round}` }).kind).toBe(
        "ok",
      );
    }
  });

  it("different arguments do not count as repeats", () => {
    const g = new LoopGuard(policy, false);
    for (let i = 0; i < 10; i++) expect(g.observe(fail("read", { i })).kind).toBe("ok");
  });
});

describe("loop guard in the pipeline", () => {
  const looping = () =>
    new ScriptedEngine(() => [
      { type: "tool.call", id: "x", name: "flaky", input: { q: 1 } },
      { type: "done", stop: "tool_use" },
    ]);

  it("hard-stops an unattended run", async () => {
    const flaky = tool("flaky", "read", () => {
      throw new Error("timeout");
    });
    const { core, events } = makeCore(looping(), { tools: [flaky] });
    const t = core.createThread();
    const { done } = core.send(t.id, "go", {
      initiator: { kind: "schedule", id: "nightly" },
      attended: false,
    });
    expect(await done).toBe("failed");
    expect(flaky.calls).toHaveLength(6); // default hardStopAfterRepeats
    const codes = events.filter(isType("error")).map((e) => e.data.code);
    expect(codes).toEqual(["loop_guard.warn", "loop_guard.stop"]);
    expect(checkSequence(events).ok).toBe(true);
  });

  it("only warns when someone is watching (bounded by max passes)", async () => {
    const flaky = tool("flaky", "read", () => {
      throw new Error("timeout");
    });
    const { core, events } = makeCore(looping(), { tools: [flaky], maxPasses: 10 });
    const t = core.createThread();
    expect(await core.send(t.id, "go", { attended: true }).done).toBe("max_turns");
    expect(flaky.calls).toHaveLength(10);
    expect(events.filter(isType("error")).map((e) => e.data.code)).toEqual(["loop_guard.warn"]);
  });
});
