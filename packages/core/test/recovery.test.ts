import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedEngine } from "@alca/engines";
import { openStore } from "@alca/store";
import { afterEach, describe, expect, it } from "vitest";
import type { HostTool } from "../src/index.ts";
import { isType, makeCore, tool, waitFor } from "./helpers.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("restart recovery", () => {
  it("closes runs left open, expires their cards, and never re-runs a turn that sent something", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alca-core-"));
    dirs.push(dir);
    const path = join(dir, "state.sqlite");
    let started = 0;
    const hangingSend: HostTool = {
      spec: { name: "send_mail", description: "send", inputSchema: {} },
      actionClass: "send",
      run: () => {
        started++;
        return new Promise(() => {}); // the mail is "on the wire" when we crash
      },
    };
    const engine = new ScriptedEngine([
      [
        { type: "tool.call", id: "a", name: "send_mail", input: { to: "x" } },
        { type: "done", stop: "tool_use" },
      ],
    ]);
    const one = makeCore(engine, { store: openStore(path), tools: [hangingSend] });
    const t = one.core.createThread();
    const { runId } = one.core.send(t.id, "寄信");
    const req = await waitFor(one.events, isType("approval.requested"));
    one.core.answerApproval(req.data.approvalId, "approved");
    for (let i = 0; i < 100 && started === 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(started).toBe(1);

    // A second, idle thread with an unanswered card.
    const other = makeCore(
      new ScriptedEngine([
        [
          { type: "tool.call", id: "w", name: "write_note", input: {} },
          { type: "done", stop: "tool_use" },
        ],
      ]),
      {
        store: one.store,
        tools: [tool("write_note", "write")],
      },
    );
    const t2 = other.core.createThread();
    other.core.send(t2.id, "寫");
    await waitFor(other.events, isType("approval.requested"));
    one.store.close(); // crash: persist never ran

    const two = makeCore(new ScriptedEngine([]), { store: openStore(path) });
    const out = two.core.recover();
    expect(out).toMatchObject({ runs: 2, approvals: 1 });
    expect(two.store.runs.get(runId)).toMatchObject({ status: "finished", finishReason: "interrupted" });
    expect(two.store.human.pendingApprovals()).toEqual([]);
    const parked = two.core.jobs.needingReview();
    expect(parked).toHaveLength(1);
    expect(parked[0]).toMatchObject({ kind: "turn", runId, outboundObserved: true, status: "waiting" });
    expect(two.core.jobs.byStatus("cancelled")).toHaveLength(1); // the quiet turn is just cancelled
    two.store.close();
  });
});
