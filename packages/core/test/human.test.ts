import { ScriptedEngine, type ScriptStep, streamText } from "@alca/engines";
import { checkSequence } from "@alca/protocol";
import { describe, expect, it } from "vitest";
import { ASK_USER_TOOL } from "../src/index.ts";
import { isType, makeCore, tool, types, waitFor } from "./helpers.ts";

const callThen = (name: string, input: Record<string, unknown>) =>
  new ScriptedEngine(({ pass, req }): ScriptStep[] =>
    pass === 0
      ? [
          { type: "tool.call", id: "e1", name, input },
          { type: "done", stop: "tool_use" },
        ]
      : streamText(`結果：${req.toolResults?.map((r) => `${r.ok ? "ok" : "fail"}:${r.output}`).join(",")}`),
  );

describe("approval cards (host-loop)", () => {
  it("confirm_each_step: a write waits for 允許一次, then runs once", async () => {
    const write = tool("write_note", "write");
    const { core, events, store } = makeCore(callThen("write_note", { path: "/n.md" }), { tools: [write] });
    const t = core.createThread();
    const { runId, done } = core.send(t.id, "寫筆記");
    const req = await waitFor(events, isType("approval.requested"));
    expect(req.data).toMatchObject({ actionClass: "write" });
    expect(store.runs.get(runId)?.status).toBe("waiting");
    expect(core.threadState(t.id).pendingApprovals.map((a) => a.id)).toEqual([req.data.approvalId]);
    expect(write.calls).toEqual([]);
    expect(core.answerApproval(req.data.approvalId, "approved")).toEqual({ resolved: true });
    expect(core.answerApproval(req.data.approvalId, "denied")).toEqual({ resolved: false });
    expect(await done).toBe("completed");
    expect(write.calls).toHaveLength(1);
    expect(events.find(isType("approval.resolved"))?.data).toMatchObject({
      decision: "approved",
      by: { kind: "user" },
    });
    expect(core.messages(t.id).at(-1)?.content).toBe("結果：ok:write_note ok");
    expect(checkSequence(events).ok).toBe(true);
  });

  it("拒絕: the tool never runs and the engine is told", async () => {
    const write = tool("write_note", "write");
    const { core, events } = makeCore(callThen("write_note", {}), { tools: [write] });
    const t = core.createThread();
    const { done } = core.send(t.id, "寫");
    const req = await waitFor(events, isType("approval.requested"));
    core.answerApproval(req.data.approvalId, "denied");
    await done;
    expect(write.calls).toEqual([]);
    expect(core.messages(t.id).at(-1)?.content).toBe("結果：fail:使用者拒絕了這個動作");
  });

  it("autonomous still asks for always-confirm classes and marks the job outbound", async () => {
    const send = tool("send_mail", "send");
    const read = tool("read_note", "read");
    const { core, events } = makeCore(callThen("send_mail", { to: "a@b" }), {
      tools: [send, read],
      level: "autonomous",
    });
    const t = core.createThread();
    const { done } = core.send(t.id, "寄信");
    const req = await waitFor(events, isType("approval.requested"));
    expect(req.data.actionClass).toBe("send");
    core.answerApproval(req.data.approvalId, "approved");
    await done;
    const job = core.jobs.byStatus("succeeded")[0]!;
    expect(job.outboundObserved).toBe(true);
    expect(core.jobs.events(job.id).map((e) => e.type)).toContain("outbound.sent");
  });

  it("deny rules win even in autonomous mode; audit precedes execution", async () => {
    const del = tool("delete_note", "delete");
    const { core, store } = makeCore(callThen("delete_note", {}), {
      tools: [del],
      level: "autonomous",
      rules: () => [{ id: "no-delete", effect: "deny", action: "delete_note" }],
    });
    const t = core.createThread();
    await core.send(t.id, "刪").done;
    expect(del.calls).toEqual([]);
    const audit = store.db.prepare("SELECT action, decision FROM audit_log").all();
    expect(audit).toEqual([{ action: "delete_note", decision: "deny" }]);
  });

  it("interrupting while an approval card is open closes the run", async () => {
    const write = tool("write_note", "write");
    const { core, events } = makeCore(callThen("write_note", {}), { tools: [write] });
    const t = core.createThread();
    const { done } = core.send(t.id, "寫");
    await waitFor(events, isType("approval.requested"));
    await core.interrupt(t.id);
    expect(await done).toBe("interrupted");
    expect(write.calls).toEqual([]);
  });
});

describe("question cards", () => {
  it("host-loop ask_user puts up a card and returns the answer to the engine", async () => {
    const { core, events } = makeCore(
      callThen(ASK_USER_TOOL, { prompt: "要哪一種？", choices: ["紅茶", "綠茶"] }),
    );
    const t = core.createThread();
    const { done } = core.send(t.id, "點飲料");
    const q = await waitFor(events, isType("question.asked"));
    expect(q.data).toMatchObject({ prompt: "要哪一種？", choices: ["紅茶", "綠茶"] });
    expect(core.answerQuestion(q.data.questionId, "綠茶")).toEqual({ resolved: true });
    expect(core.answerQuestion(q.data.questionId, "紅茶")).toEqual({ resolved: false });
    await done;
    expect(core.messages(t.id).at(-1)?.content).toBe("結果：ok:綠茶");
    expect(types(events)).toContain("question.answered");
    expect(checkSequence(events).ok).toBe(true);
  });
});

describe("tool-owning engines (permission prompts)", () => {
  it("routes the engine's permission prompt through the gateway and an approval card", async () => {
    const engine = new ScriptedEngine(
      () => [
        {
          type: "permission",
          call: { id: "tu1", name: "Bash", input: { command: "rm -rf build" } },
          allowedOutput: "removed",
        },
        ...streamText("清好了"),
      ],
      { capabilities: { ownsToolLoop: true, permissionPrompt: "mcp_tool" } },
    );
    const { core, events } = makeCore(engine, { level: "autonomous" });
    const t = core.createThread();
    const { done } = core.send(t.id, "清 build");
    const req = await waitFor(events, isType("approval.requested"));
    expect(req.data.actionClass).toBe("delete");
    const requested = events.find(isType("tool.requested"))!;
    expect(req.data.callId).toBe(requested.data.callId);
    core.answerApproval(req.data.approvalId, "approved");
    expect(await done).toBe("completed");
    expect(engine.permissionAnswers).toEqual([{ behavior: "allow" }]);
    expect(events.find(isType("tool.completed"))?.data).toMatchObject({
      callId: requested.data.callId,
      ok: true,
      result: "removed",
    });
    expect(checkSequence(events).ok).toBe(true);
  });

  it("the CLI's question tool becomes a question card", async () => {
    const engine = new ScriptedEngine(
      () => [
        {
          type: "permission",
          call: {
            id: "q",
            name: "AskUserQuestion",
            input: { questions: [{ question: "哪個？", options: [{ label: "A" }, { label: "B" }] }] },
          },
        },
      ],
      { capabilities: { ownsToolLoop: true } },
    );
    const { core, events } = makeCore(engine);
    const t = core.createThread();
    const { done } = core.send(t.id, "問我");
    const q = await waitFor(events, isType("question.asked"));
    expect(q.data.choices).toEqual(["A", "B"]);
    core.answerQuestion(q.data.questionId, "B");
    await done;
    expect(engine.permissionAnswers[0]).toEqual({ behavior: "deny", message: "使用者的回答：B" });
  });
});
