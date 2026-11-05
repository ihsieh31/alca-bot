import type { ScriptContext } from "@alca/engines";
import { afterEach, describe, expect, it } from "vitest";
import { ReadCheck, ROUTINE_NO_ASK, type RoutineItem, WorkspaceGuards } from "../src/index.ts";
import { call, type Harness, makeAgents, say, until } from "./agents-helpers.ts";
import { tool } from "./helpers.ts";

/**
 * Research audit B4: a routine's AI run is a background worker like 提前做 —
 * nobody is there to answer a card, so a call that would ask (a send, or any
 * write under 逐步確認) is denied with the reason and no card goes up.
 * Fictional mail only.
 */

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const source: RoutineItem[] = [{ id: "m1", title: "請回覆報價", from: "wang@example.com", text: "報價單" }];
const check = new ReadCheck(
  "inbox",
  async () => source,
  () => "信箱",
);

function setup(level: "autonomous" | "confirm_each_step", name: string, cls: "send" | "write") {
  const t = tool(name, cls);
  const seen = { result: "" };
  const worker = ({ req, pass }: ScriptContext) => {
    if (req.userMessage.includes("<alca:records") && pass === 0) return call("m", name, { to: "wang" });
    if (pass === 1) {
      seen.result = req.toolResults?.[0]?.output ?? "";
      return call("r", "report_result", {
        status: "done",
        summary: "沒有要告訴使用者的",
        data: { quiet: true },
      });
    }
    return say("好");
  };
  h = makeAgents({
    router: () => say("收到"),
    worker,
    tools: [t],
    checks: [check],
    level,
  });
  const hh = h;
  hh.core.useGuards(new WorkspaceGuards({ store: hh.store, background: (id) => hh.agents.background(id) }));
  const th = hh.core.createThread("例行");
  const r = hh.agents.routines.create({
    threadId: th.id,
    name: "看信箱",
    kind: "interval",
    intervalSec: 300,
    check: { kind: "inbox" },
  });
  return { t, seen, th, r, hh };
}

describe("routine runs never put a card up (research audit B4)", () => {
  for (const [level, name, cls] of [
    ["autonomous", "mail_send", "send"],
    ["confirm_each_step", "note_write", "write"],
  ] as const) {
    it(`${level}: ${name} is denied with the reason, no card, no call`, async () => {
      const { t, seen, th, r, hh } = setup(level, name, cls);
      expect((await hh.agents.routines.runNow(r.id))?.outcome).toBe("new");
      await until(() => hh.store.routines.runs(r.id).some((x) => x.outcome === "ai_done"), 15_000);
      expect(t.calls).toEqual([]);
      expect(seen.result).toContain("例行工作在背景執行");
      expect(hh.store.human.pendingApprovals()).toEqual([]);
      expect(hh.events.filter((e) => e.type === "approval.requested")).toEqual([]);
      const rows = hh.store.db.prepare("SELECT decision FROM audit_log WHERE action = ?").all(name) as Array<{
        decision: string;
      }>;
      expect(rows).toEqual([{ decision: "deny" }]);
      expect(hh.store.workers.byThread(th.id)).toHaveLength(1);
    }, 20_000);
  }

  it("background() names routine runs and early work only", () => {
    const { hh } = setup("autonomous", "mail_send", "send");
    expect(hh.agents.background("wkr_nobody")).toBeUndefined();
    expect(hh.agents.routines.background("wkr_nobody")).toBeUndefined();
    expect(ROUTINE_NO_ASK).toContain("沒有人可以批准");
  });
});
