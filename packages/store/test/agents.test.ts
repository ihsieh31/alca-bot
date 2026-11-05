import { describe, expect, it } from "vitest";
import { openStore } from "../src/index.ts";

function seed() {
  const store = openStore(":memory:");
  const bot = store.bots.ensureDefault();
  const t = store.threads.create("thr_01M6FS56CMD82Z8TY2D17VNKX0", "t", new Date(), bot.id);
  store.db
    .prepare("INSERT INTO jobs (id, kind, created_at, updated_at) VALUES ('j1','subagent','x','x')")
    .run();
  const w = store.workers.create({
    botId: bot.id,
    threadId: t.id,
    jobId: "j1",
    title: "工作",
    goal: "做事",
    initiator: { kind: "user", id: "me" },
  });
  return { store, bot, t, w };
}

describe("agents schema (migration 4)", () => {
  it("workers: store-made ids, owner fixed, runs must exist", () => {
    const { store, w } = seed();
    expect(w.id).toMatch(/^wkr_[0-9A-Z]{26}$/);
    const other = store.bots.create("b2");
    expect(() => store.db.prepare("UPDATE workers SET bot_id = ? WHERE id = ?").run(other.id, w.id)).toThrow(
      /owner cannot change/,
    );
    expect(() => store.workers.started(w.id, "run_x", new Date(1000))).toThrow(/FOREIGN KEY/);
  });

  it("finish is once; spills, trigger events and the watchdog log are append-only", () => {
    const { store, bot, t, w } = seed();
    store.workers.setWaiting(w.id, true, new Date(1_000));
    store.db
      .prepare("UPDATE workers SET status = 'waiting', waiting_since = ? WHERE id = ?")
      .run(new Date(1_000).toISOString(), w.id);
    store.workers.setWaiting(w.id, false, new Date(4_000));
    expect(store.workers.get(w.id)).toMatchObject({ status: "running", waitedMs: 3000 });
    expect(
      store.workers.finish(w.id, "succeeded", new Date(), {
        result: { mode: "inline", summary: "好", chars: 1 },
      }),
    ).toBe(true);
    expect(store.workers.finish(w.id, "failed")).toBe(false);
    expect(() => store.db.prepare("UPDATE workers SET status = 'running' WHERE id = ?").run(w.id)).toThrow(
      /finished/,
    );

    const s = store.workers.addSpill({
      botId: bot.id,
      ownerKind: "worker",
      ownerId: w.id,
      title: "x",
      body: "全文",
    });
    expect(s).toMatchObject({ chars: 2 });
    expect(() => store.db.prepare("DELETE FROM spills").run()).toThrow(/append-only/);

    const trg = store.triggers.create({
      botId: bot.id,
      threadId: t.id,
      name: "n",
      source: "manual",
      config: {},
      rule: {},
    });
    const e = store.triggers.addEvent({
      triggerId: trg.id,
      streamId: null,
      payload: { text: "hi" },
      ruleVerdict: "candidate",
      judged: "skip",
      judgeReason: "無",
      outcome: "dropped",
    });
    expect(() =>
      store.db.prepare("UPDATE trigger_events SET outcome = 'router' WHERE id = ?").run(e.id),
    ).toThrow(/append-only/);
    store.triggers.addWatchdog({ workerId: w.id, botId: bot.id, kind: "looping", detail: "x" });
    expect(() => store.db.prepare("DELETE FROM watchdog_events").run()).toThrow(/append-only/);
  });

  it("streams are one per (bot, key); inbox items are delivered once and re-delivered after an interrupted run", () => {
    const { store, bot, t, w } = seed();
    const a = store.triggers.ensureStream(bot.id, "mail:123", "信");
    expect(store.triggers.ensureStream(bot.id, "mail:123", "別的標題").id).toBe(a.id);
    store.triggers.subscribe(a.id, w.id);
    store.triggers.subscribe(a.id, w.id);
    expect(store.triggers.subscribers(a.id)).toEqual([w.id]);

    const item = store.workers.addInbox({
      botId: bot.id,
      threadId: t.id,
      kind: "worker_report",
      refId: w.id,
      body: "回報",
      initiator: { kind: "agent", id: w.id },
    });
    store.runs.start({ id: "run_1", threadId: t.id, initiator: { kind: "agent", id: w.id } });
    expect(store.workers.delivered(item.id, "run_1")).toBe(true);
    expect(store.workers.delivered(item.id, "run_1")).toBe(false);
    store.runs.finish("run_1", "interrupted");
    expect(store.workers.redeliverInterrupted()).toBe(1);
    expect(store.workers.pendingInbox(bot.id).map((i) => i.id)).toEqual([item.id]);
    expect(store.workers.routerSession(bot.id)).toBe(store.workers.routerSession(bot.id));
  });

  it("worker runs stay out of the thread's chat", () => {
    const { store, t, w } = seed();
    store.runs.start({ id: "run_r", threadId: t.id, initiator: { kind: "user", id: "me" } });
    store.runs.start({ id: "run_w", threadId: t.id, initiator: { kind: "user", id: "me" }, workerId: w.id });
    store.threads.addMessage({ id: "m1", threadId: t.id, runId: "run_r", role: "user", content: "嗨" });
    store.threads.addMessage({
      id: "m2",
      threadId: t.id,
      runId: "run_w",
      role: "assistant",
      content: "工人的字",
    });
    expect(store.threads.messages(t.id).map((m) => m.content)).toEqual(["嗨"]);
    expect(store.workers.byRun("run_w")?.id).toBe(w.id);
  });
});
