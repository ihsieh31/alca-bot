import { parseSettings } from "@alca/config";
import { type Engine, ScriptedEngine, streamText } from "@alca/engines";
import { openStore } from "@alca/store";
import { describe, expect, it } from "vitest";
import { AlcaCore, parseVerdict, ShellReviewer, shellCommandOf, WorkspaceGuards } from "../src/index.ts";
import { isType, waitFor } from "./helpers.ts";

const bash = (command: string) =>
  new ScriptedEngine(
    () => [
      { type: "permission", call: { id: "tu1", name: "Bash", input: { command } }, allowedOutput: "ran" },
      ...streamText("好了"),
    ],
    { capabilities: { ownsToolLoop: true, permissionPrompt: "mcp_tool" } },
  );

function setup(o: {
  reply?: string | (() => never);
  review?: "on" | "off";
  level?: "autonomous" | "confirm_each_step";
  timeoutSec?: number;
  noEngine?: boolean;
  command?: string;
}) {
  const store = openStore(":memory:");
  const bot = store.bots.ensureDefault();
  store.bots.update(bot.id, { shellReview: o.review ?? "on" });
  const settings = parseSettings({
    permissions: { level: o.level ?? "autonomous" },
    engineering: { shellReview: { timeoutSec: o.timeoutSec ?? 20 } },
  });
  const asked: string[] = [];
  const reviewEngine = new ScriptedEngine(({ req }) => {
    asked.push(req.userMessage);
    const reply = o.reply;
    if (typeof reply === "function") return reply();
    if (reply === "SLOW") return [{ type: "wait", ms: 60_000 }, ...streamText("LOW")];
    return streamText(reply ?? "LOW\n只是列出檔案");
  });
  const reviewer = new ShellReviewer({
    engineFor: () => (o.noEngine ? undefined : (reviewEngine as Engine)),
    timeoutMs: () => settings.engineering.shellReview.timeoutSec * 1000,
  });
  const engine = bash(o.command ?? "ls -la");
  const core = new AlcaCore({
    store,
    engine,
    settings: () => settings,
    guards: new WorkspaceGuards({ store, reviewer }),
  });
  const events: Parameters<Parameters<typeof core.bus.subscribe>[1]>[0][] = [];
  core.bus.subscribe("*", (e) => events.push(e));
  const audit = () =>
    store.db.prepare("SELECT decision, detail FROM audit_log WHERE action = 'shell_review'").all() as Array<{
      decision: string;
      detail: string;
    }>;
  return { store, core, engine, events, asked, audit };
}

describe("P13 small-model shell review", () => {
  it("LOW: the command runs without a card; the review is in the audit log", async () => {
    const h = setup({});
    const t = h.core.createThread();
    expect(await h.core.send(t.id, "列出").done).toBe("completed");
    expect(h.engine.permissionAnswers).toEqual([{ behavior: "allow" }]);
    expect(h.events.some(isType("approval.requested"))).toBe(false);
    expect(h.asked[0]).toContain("ls -la");
    expect(h.audit()).toEqual([expect.objectContaining({ decision: "allow" })]);
  });

  it("HIGH: escalated to a card naming the review; a denial means the command never ran", async () => {
    const h = setup({ reply: "HIGH\n會把憑證送出去", command: "cat ~/.ssh/id_rsa > out.txt" });
    const t = h.core.createThread();
    const { done } = h.core.send(t.id, "做事");
    const card = await waitFor(h.events, isType("approval.requested"));
    expect(card.data.summary).toContain("指令審查：風險高");
    h.core.answerApproval(card.data.approvalId, "denied");
    await done;
    expect(h.engine.permissionAnswers[0]?.behavior).toBe("deny");
    expect(h.audit()).toEqual([expect.objectContaining({ decision: "ask" })]);
  });

  it("fails closed: an unreadable answer, an engine error, a timeout or no engine all ask", async () => {
    for (const o of [
      { reply: "sure, looks fine" },
      {
        reply: () => {
          throw new Error("boom");
        },
      },
      { reply: "SLOW", timeoutSec: 2 },
      { noEngine: true },
    ] as const) {
      const h = setup(o);
      const t = h.core.createThread();
      const { done } = h.core.send(t.id, "做事");
      const card = await waitFor(h.events, isType("approval.requested"), 6000);
      expect(card.data.summary).toContain("指令審查沒有結果");
      h.core.answerApproval(card.data.approvalId, "approved");
      expect(await done).toBe("completed");
    }
  }, 30_000);

  it("off by default, and never asked outside 自主 (逐步確認 asks anyway) or for always-confirm classes", async () => {
    const off = setup({ review: "off" });
    await off.core.send(off.core.createThread().id, "x").done;
    expect(off.asked).toEqual([]);
    expect(openStore(":memory:").bots.ensureDefault().shellReview).toBe("off");

    const step = setup({ level: "confirm_each_step" });
    const t = step.core.createThread();
    const { done } = step.core.send(t.id, "x");
    const card = await waitFor(step.events, isType("approval.requested"));
    expect(step.asked).toEqual([]);
    step.core.answerApproval(card.data.approvalId, "approved");
    await done;

    // git push is publish: always confirmed before any review would run.
    const push = setup({ command: "git push origin main" });
    const t2 = push.core.createThread();
    const p = push.core.send(t2.id, "x");
    const c2 = await waitFor(push.events, isType("approval.requested"));
    expect(c2.data.actionClass).toBe("publish");
    expect(push.asked).toEqual([]);
    push.core.answerApproval(c2.data.approvalId, "denied");
    await p.done;
  });

  it("finds shell commands in Bash, ACP execute tools and hands_run; parses verdicts strictly", () => {
    expect(shellCommandOf("Bash", { command: "ls" })).toBe("ls");
    expect(shellCommandOf("hands_run", { command: "make" })).toBe("make");
    expect(shellCommandOf("npm test", { kind: "execute" })).toBe("npm test");
    expect(shellCommandOf("x", { kind: "execute", command: "pnpm i" })).toBe("pnpm i");
    expect(shellCommandOf("Write", { file_path: "/a" })).toBeUndefined();
    expect(parseVerdict("**HIGH**\n原因")).toEqual({ risk: "high", reason: "原因" });
    expect(parseVerdict("low")).toEqual({ risk: "low", reason: "LOW" });
    expect(parseVerdict("I think it is fine")).toMatchObject({ risk: "high", failed: true });
  });
});
