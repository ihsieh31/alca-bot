import { describe, expect, it } from "vitest";
import { openStore } from "../src/index.ts";

const enc = (s: string) => new TextEncoder().encode(s);

describe("P13 store: bot switches, file snapshots, early work", () => {
  it("bots get a work folder, shell review and early-work settings (off by default)", () => {
    const s = openStore(":memory:");
    const b = s.bots.ensureDefault();
    expect(b.workDir).toBeNull();
    expect(b.shellReview).toBe("off");
    expect(b.earlyWork).toBe("off");
    const u = s.bots.update(b.id, {
      workDir: "/tmp/x",
      shellReview: "on",
      shellReviewEngine: "openrouter",
      shellReviewModel: "small",
      earlyWork: "on",
      quietHours: "22:00-07:30",
    });
    expect(u).toMatchObject({
      workDir: "/tmp/x",
      shellReview: "on",
      shellReviewEngine: "openrouter",
      shellReviewModel: "small",
      earlyWork: "on",
      quietHours: "22:00-07:30",
    });
    expect(() => s.bots.update(b.id, { quietHours: "late" })).toThrow();
    expect(() => s.bots.update(b.id, { shellReview: "maybe" as "on" })).toThrow();
    s.close();
  });

  it("snapshots group by turn, keep the first state per file, are final once undone, and prune by turns and bytes", () => {
    const s = openStore(":memory:");
    const base = { botId: "bot_1", threadId: "thr_1", runId: "run_a", tool: "Write" };
    s.snapshots.add({ ...base, turnRunId: "run_t1", path: "/w/a.txt", existed: true, content: enc("one") });
    expect(s.snapshots.has("run_t1", "/w/a.txt")).toBe(true);
    s.snapshots.add({ ...base, turnRunId: "run_t1", path: "/w/b.txt", existed: false });
    s.snapshots.add({
      ...base,
      turnRunId: "run_t2",
      path: "/w/a.txt",
      existed: true,
      content: enc("two"),
      now: new Date(Date.now() + 1000),
    });
    const turns = s.snapshots.turns("thr_1");
    expect(turns.map((t) => [t.turnRunId, t.files])).toEqual([
      ["run_t2", 1],
      ["run_t1", 2],
    ]);
    const first = s.snapshots.ofTurn("run_t1")[0];
    expect(new TextDecoder().decode(first?.content ?? new Uint8Array())).toBe("one");
    expect(s.snapshots.laterEdit("/w/a.txt", "run_t1", first?.createdAt ?? "")?.turnRunId).toBe("run_t2");
    expect(s.snapshots.markUndone("run_t2")).toBe(1);
    expect(s.snapshots.laterEdit("/w/a.txt", "run_t1", first?.createdAt ?? "")).toBeUndefined();
    expect(() => s.db.prepare("UPDATE file_snapshots SET undone_at = NULL").run()).toThrow();
    expect(() => s.db.prepare("UPDATE file_snapshots SET path = '/etc/x'").run()).toThrow();
    // keep one turn per thread: the older turn loses its content
    s.snapshots.prune({ threadId: "thr_1", keepTurns: 1, maxBytes: 1_000_000 });
    expect(s.snapshots.ofTurn("run_t1").every((x) => x.prunedAt && x.content === null)).toBe(true);
    expect(s.snapshots.ofTurn("run_t2")[0]?.content).not.toBeNull();
    // the byte cap drops the oldest kept content
    s.snapshots.prune({ keepTurns: 50, maxBytes: 1 });
    expect(s.snapshots.ofTurn("run_t2")[0]?.content).toBeNull();
    s.close();
  });

  it("early work: one item per bot and ref, compare-and-set start, final statuses", () => {
    const s = openStore(":memory:");
    const bot = s.bots.ensureDefault();
    s.threads.create("thr_x", "t", new Date(), bot.id);
    const a = s.early.offer({
      botId: bot.id,
      threadId: "thr_x",
      source: "trigger",
      refId: "tev_1",
      title: "會議",
      goal: "g",
    });
    const b = s.early.offer({
      botId: bot.id,
      threadId: "thr_x",
      source: "trigger",
      refId: "tev_1",
      title: "又一次",
      goal: "g",
    });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.item.id).toBe(a.item.id);
    expect(s.early.queued()).toHaveLength(1);
    expect(s.early.started(a.item.id, "wkr_1")).toBe(true);
    expect(s.early.started(a.item.id, "wkr_2")).toBe(false);
    expect(s.early.byWorker("wkr_1")?.id).toBe(a.item.id);
    expect(s.early.startedSince(bot.id, new Date(Date.now() - 60_000))).toBe(1);
    expect(s.early.finish(a.item.id, "ready", { draftIds: ["drf_1"] })).toBe(true);
    expect(s.early.get(a.item.id)?.draftIds).toEqual(["drf_1"]);
    expect(s.early.finish(a.item.id, "failed")).toBe(false);
    expect(() => s.db.prepare("UPDATE early_work SET status = 'queued'").run()).toThrow();
    s.close();
  });
});
