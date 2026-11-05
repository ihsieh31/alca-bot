import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeEngine, FAKE_CLAUDE_SCRIPT } from "@alca/engines";
import { checkSequence } from "@alca/protocol";
import { openStore } from "@alca/store";
import { afterEach, describe, expect, it } from "vitest";
import { buildStablePrompt, DEFAULT_PROFILE } from "../src/index.ts";
import { isType, makeCore, waitFor } from "./helpers.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function claudeCore(level: "autonomous" | "confirm_each_step" = "confirm_each_step") {
  const dir = mkdtempSync(join(tmpdir(), "alca-cc-core-"));
  const store = openStore(":memory:");
  const engine = new ClaudeCodeEngine({
    command: [process.execPath, "--disable-warning=ExperimentalWarning", FAKE_CLAUDE_SCRIPT],
    launch: () => ({
      engineId: "claude-code",
      cwd: dir,
      stablePrompt: buildStablePrompt(DEFAULT_PROFILE),
      env: {},
      approvalMode: "default",
    }),
    sessions: {
      get: (t) => store.threads.getSession(t, "claude-code"),
      set: (t, s) => store.threads.setSession(t, "claude-code", s),
    },
  });
  const h = makeCore(engine, { store, level });
  cleanups.push(
    () => h.core.close(),
    () => rmSync(dir, { recursive: true, force: true }),
  );
  return { ...h, engine };
}

describe("core × Claude Code engine (fake CLI)", () => {
  it("streams a reply and stores the CLI session id on the thread", async () => {
    const { core, events, store } = claudeCore();
    const t = core.createThread();
    expect(await core.send(t.id, "你好").done).toBe("completed");
    expect(core.messages(t.id).at(-1)?.content).toBe("收到：你好");
    expect(store.threads.getSession(t.id, "claude-code")).toMatch(/-/);
    expect(events.at(-1)).toMatchObject({ type: "run.finished", data: { usage: { cachedInputTokens: 30 } } });
    expect(checkSequence(events).ok).toBe(true);
  });

  it("a Bash permission prompt becomes an approval card; 允許一次 lets it run", async () => {
    const { core, events } = claudeCore("autonomous");
    const t = core.createThread();
    const { done } = core.send(t.id, "[bash:git push origin main]");
    const req = await waitFor(events, isType("approval.requested"), 8000);
    expect(req.data.actionClass).toBe("publish");
    core.answerApproval(req.data.approvalId, "approved");
    expect(await done).toBe("completed");
    expect(core.messages(t.id).at(-1)?.content).toBe("完成：ran: git push origin main");
    expect(core.jobs.byStatus("succeeded")[0]?.outboundObserved).toBe(true);
    expect(checkSequence(events).ok).toBe(true);
  });

  it("拒絕 is passed back to the CLI as a denial", async () => {
    const { core, events } = claudeCore();
    const t = core.createThread();
    const { done } = core.send(t.id, "[bash:rm -rf dist]");
    const req = await waitFor(events, isType("approval.requested"), 8000);
    core.answerApproval(req.data.approvalId, "denied");
    await done;
    expect(core.messages(t.id).at(-1)?.content).toMatch(/^沒有執行：使用者沒有同意/);
  });

  it("hard-stops an unattended CLI turn that keeps failing the same call", async () => {
    const { core, events } = claudeCore();
    const t = core.createThread();
    const { done } = core.send(t.id, "[fail-read:20]", {
      initiator: { kind: "schedule", id: "s" },
      attended: false,
    });
    expect(await done).toBe("failed");
    const codes = events.filter(isType("error")).map((e) => e.data.code);
    expect(codes).toContain("loop_guard.stop");
    expect(events.filter(isType("tool.completed")).length).toBeLessThan(20);
    expect(checkSequence(events).ok).toBe(true);
  });
});
