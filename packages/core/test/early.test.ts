import { afterEach, describe, expect, it } from "vitest";
import { parseQuietHours, quietUntil, WorkspaceGuards } from "../src/index.ts";
import { call, type Harness, makeAgents, say, until } from "./agents-helpers.ts";
import { tool } from "./helpers.ts";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const wake = { judge: async () => ({ wake: true, reason: "有一個會議邀請" }) };

/** Minutes since midnight in Taipei, as HH:MM, shifted. */
function taipei(shiftMin: number): string {
  const d = new Date(Date.now() + shiftMin * 60_000);
  const p = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Taipei",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(d);
  return p;
}

function harness(
  o: {
    worker?: Parameters<typeof makeAgents>[0]["worker"];
    level?: "autonomous" | "confirm_each_step";
    maxPerDay?: number;
    tools?: ReturnType<typeof tool>[];
  } = {},
) {
  const routerSaw: string[] = [];
  const hh = makeAgents({
    router: ({ req }) => {
      routerSaw.push(req.userMessage);
      return say("收到");
    },
    worker:
      o.worker ?? (({ pass }) => (pass === 0 ? say("行程沒有衝突。建議回覆：週四下午可以。") : say("x"))),
    judge: wake,
    ...(o.level ? { level: o.level } : {}),
    ...(o.tools ? { tools: o.tools } : {}),
    earlyWork: { maxPerDay: o.maxPerDay ?? 6, maxConcurrent: 1 },
  });
  hh.core.useGuards(
    new WorkspaceGuards({ store: hh.store, background: (id) => hh.agents.early.background(id) }),
  );
  const bot = hh.store.bots.ensureDefault().id;
  const t = hh.core.createThread("信箱");
  const trg = hh.agents.triggers.create({
    threadId: t.id,
    name: "信箱",
    source: "manual",
    config: { early: true },
  });
  return { h: hh, bot, t, trg, routerSaw };
}

describe("P13 提前做 (early work)", () => {
  it("a trigger candidate on a bot with early work on becomes a background worker and a draft; the router is not woken", async () => {
    const x = harness();
    h = x.h;
    x.h.store.bots.update(x.bot, { earlyWork: "on" });
    const e = await x.h.agents.triggers.fire(x.trg.id, {
      text: "會議邀請：週四 14:00 產品討論",
      from: "boss@example.com",
    });
    expect(e.outcome).toBe("workers");
    const item = await until(() => x.h.store.early.list().find((i) => i.status === "ready"));
    expect(item.refId).toBe(e.id);
    const w = x.h.store.workers.get(item.workerId as string);
    expect(w?.speculative).toBe(true);
    expect(w?.goal).toContain('trust="untrusted"');
    const drafts = x.h.store.routines.drafts({ workerId: w?.id as string });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ kind: "note", status: "ready" });
    expect(drafts[0]?.body).toContain("週四下午可以");
    expect(item.draftIds).toEqual([drafts[0]?.id]);
    expect(x.h.agentEvents.some((a) => a.type === "draft.ready")).toBe(true);
    expect(x.routerSaw).toEqual([]);
    // The same event offered again is the same item.
    const again = x.h.agents.early.offer({
      botId: x.bot,
      threadId: x.t.id,
      source: "trigger",
      refId: e.id,
      title: "x",
      goal: "x",
    });
    expect(again.id).toBe(item.id);
  }, 20_000);

  it("an explicit request still goes to the router, and a bot with early work off wakes the router as before", async () => {
    const x = harness();
    h = x.h;
    await x.h.agents.triggers.fire(x.trg.id, { text: "會議邀請", from: "a@example.com" });
    expect(x.h.store.early.list()).toEqual([]);
    await until(() => x.routerSaw.length === 1);
    x.h.store.bots.update(x.bot, { earlyWork: "on" });
    const ex = await x.h.agents.triggers.fire(x.trg.id, { text: "@alca 幫我回覆" });
    expect(ex.outcome).toBe("router");
  }, 20_000);

  it("in the background nothing waits for a person: a write under 逐步確認 and a send under 自主 are denied without a card", async () => {
    for (const [level, name, cls] of [
      ["confirm_each_step", "note_write", "write"],
      ["autonomous", "mail_send", "send"],
    ] as const) {
      const t = tool(name, cls);
      const x = harness({
        level,
        tools: [t],
        // Plan §5: early work is a general-harness worker — it ends with report_result.
        worker: ({ pass, req }) =>
          pass === 0
            ? call("w1", name, { to: "boss" })
            : pass === 1
              ? call("r", "report_result", {
                  status: "blocked",
                  summary: `結果：${req.toolResults?.[0]?.output ?? ""}`,
                  unblock: "需要使用者決定",
                })
              : say("完成"),
      });
      h = x.h;
      x.h.store.bots.update(x.bot, { earlyWork: "on" });
      x.h.agents.early.offer({
        botId: x.bot,
        threadId: x.t.id,
        source: "request",
        title: "回信",
        goal: "回信",
      });
      const item = await until(() => x.h.store.early.list().find((i) => i.status === "ready"));
      expect(t.calls).toEqual([]);
      expect(x.h.store.human.pendingApprovals()).toEqual([]);
      const body = x.h.store.routines.draft(item.draftIds[0] as string)?.body ?? "";
      expect(body).toContain("提前做在背景進行");
      const denied = x.h.store.db
        .prepare("SELECT decision FROM audit_log WHERE action = ?")
        .all(name) as Array<{ decision: string }>;
      expect(denied).toEqual([{ decision: "deny" }]);
      await x.h.close();
      h = undefined;
    }
  }, 30_000);

  it("quiet hours hold an item; the daily cap skips the rest", async () => {
    const x = harness({ maxPerDay: 1 });
    h = x.h;
    x.h.store.bots.update(x.bot, { earlyWork: "on", quietHours: `${taipei(-60)}-${taipei(60)}` });
    const held = x.h.agents.early.offer({
      botId: x.bot,
      threadId: x.t.id,
      source: "request",
      title: "a",
      goal: "a",
    });
    expect(held.status).toBe("queued");
    expect(held.notBefore).toBeTruthy();
    expect(held.workerId).toBeNull();
    x.h.store.bots.update(x.bot, { quietHours: null });
    x.h.store.db.prepare("UPDATE early_work SET not_before = NULL").run();
    x.h.agents.early.tick();
    await until(() => x.h.store.early.get(held.id)?.status === "ready");
    const capped = x.h.agents.early.offer({
      botId: x.bot,
      threadId: x.t.id,
      source: "request",
      title: "b",
      goal: "b",
    });
    expect(capped).toMatchObject({ status: "skipped", detail: expect.stringContaining("上限") });
  }, 20_000);

  it("parses quiet hours, across midnight too", () => {
    expect(parseQuietHours("22:00-07:00")).toEqual({ from: 1320, to: 420 });
    expect(parseQuietHours("25:00-07:00")).toBeUndefined();
    expect(parseQuietHours("07:00-07:00")).toBeUndefined();
    const at = new Date("2026-11-04T15:30:00Z"); // 23:30 in Taipei
    expect(quietUntil("22:00-07:00", at, "Asia/Taipei")?.toISOString()).toBe("2026-11-04T23:00:00.000Z");
    expect(quietUntil("08:00-12:00", at, "Asia/Taipei")).toBeUndefined();
  });
});
