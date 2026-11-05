import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isSealedText, openStore, RunRepo, Sealer, type Store } from "../src/index.ts";

/**
 * Next round R7.7 (Phase F2): stream chunks of a run are batched in memory
 * and written as one row; every event still comes back on its own, equal to
 * what was appended, and every other event is written at once.
 */

const user = { kind: "user" as const, id: "local" };
const key = () => new Sealer({ current: 1, keys: { "1": randomBytes(32).toString("base64") } });

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function file(): string {
  const d = mkdtempSync(join(tmpdir(), "alca-batch-"));
  dirs.push(d);
  return join(d, "state.sqlite");
}

function fresh(path = ":memory:", sealer?: Sealer): Store {
  const s = openStore(path, undefined, sealer ? { sealer } : {});
  s.threads.create("t1", "batch");
  s.runs.start({ id: "r1", threadId: "t1", initiator: user });
  return s;
}

let ts = Date.parse("2026-11-05T10:00:00.000Z");
function ev(seq: number, type: string, data: Record<string, unknown>) {
  ts += 7;
  const payload = {
    v: 1,
    type,
    seq,
    runId: "r1",
    threadId: "t1",
    ts: new Date(ts).toISOString(),
    actor: { kind: "agent", id: "bot_x" },
    data,
  };
  return { runId: "r1", seq, type, payload };
}
const delta = (seq: number, text: string, messageId = "message_a") =>
  ev(seq, "message.delta", { messageId, role: "assistant", delta: text });

/** run.started, 5 chunks of message_a, a tool call, 3 chunks of message_b, 1 of message_a, run.finished. */
function stream() {
  const out = [ev(0, "run.started", { engine: "x" })];
  for (let i = 1; i <= 5; i++) out.push(delta(i, `第${i}段 `));
  out.push(ev(6, "tool.requested", { callId: "c1", tool: "web.search", args: { q: "天氣" } }));
  out.push(ev(7, "tool.completed", { callId: "c1", ok: true, result: "晴", durationMs: 3 }));
  for (let i = 8; i <= 10; i++) out.push(delta(i, `b${i}`, "message_b"));
  out.push(delta(11, "back to a"));
  out.push(ev(12, "run.finished", { reason: "completed" }));
  return out;
}

const rows = (s: Store) =>
  s.db.prepare("SELECT seq, type, payload FROM run_events WHERE run_id = 'r1' ORDER BY seq").all() as Array<{
    seq: number;
    type: string;
    payload: string;
  }>;

describe("run events: stream chunks batched (R7.7)", () => {
  it("every event comes back on its own, equal to what was appended, in fewer rows", () => {
    const s = fresh();
    const list = stream();
    for (const e of list) s.runs.appendEvent(e);
    const back = s.runs.events("r1");
    expect(back).toEqual(list.map((e) => ({ runId: e.runId, seq: e.seq, type: e.type, payload: e.payload })));
    // run.started, [1..5], 6, 7, [8..11], 12: one row per batch.
    expect(rows(s).map((r) => r.seq)).toEqual([0, 1, 6, 7, 8, 12]);
    s.close();
  });

  it("a replay from the middle of a batch starts right after it", () => {
    const s = fresh();
    for (const e of stream()) s.runs.appendEvent(e);
    expect(s.runs.events("r1", 2).map((e) => e.seq)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(s.runs.events("r1", 5).map((e) => e.seq)).toEqual([6, 7, 8, 9, 10, 11, 12]);
    expect(s.runs.events("r1", 9).map((e) => e.seq)).toEqual([10, 11, 12]);
    expect(s.runs.events("r1", 12)).toEqual([]);
    s.close();
  });

  it("any other event writes what is held first, then itself, at once", () => {
    const s = fresh();
    const list = stream();
    for (const e of list.slice(0, 6)) s.runs.appendEvent(e);
    expect(rows(s).map((r) => r.seq)).toEqual([0]); // the chunks are held
    // A read sees the held chunks (it writes them first).
    expect(s.runs.events("r1", 0).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(rows(s).map((r) => r.seq)).toEqual([0, 1]);
    s.runs.appendEvent(list[6] as (typeof list)[number]);
    expect(rows(s).map((r) => r.seq)).toEqual([0, 1, 6]);
    s.close();
  });

  it("a held batch is written by the timer, at the cap, and on close", async () => {
    const s = fresh();
    const repo = new RunRepo(s.db, { batch: { windowMs: 20, maxEvents: 4 } });
    repo.appendEvent(delta(0, "a"));
    repo.appendEvent(delta(1, "b"));
    expect(rows(s)).toEqual([]);
    await new Promise((r) => setTimeout(r, 60));
    expect(rows(s).map((r) => r.seq)).toEqual([0]);
    for (let i = 2; i < 6; i++) repo.appendEvent(delta(i, "c"));
    expect(rows(s).map((r) => r.seq)).toEqual([0, 2]); // four chunks: the cap
    s.close();

    const path = file();
    const a = fresh(path);
    a.runs.appendEvent(delta(0, "kept at close"));
    a.close();
    const b = openStore(path);
    expect(b.runs.events("r1").map((e) => (e.payload as { data: { delta: string } }).data.delta)).toEqual([
      "kept at close",
    ]);
    b.close();
  });

  it("a reader that names types gets only those and never opens a chunk batch", () => {
    const s = fresh(":memory:", key());
    for (const e of stream()) s.runs.appendEvent(e);
    const tools = ["tool.requested", "tool.completed"];
    expect(s.runs.events("r1", -1, { types: tools }).map((e) => e.seq)).toEqual([6, 7]);
    expect(s.runs.events("r1", 6, { types: tools }).map((e) => e.seq)).toEqual([7]);
    expect(s.runs.events("r1", 2, { types: ["message.delta"] }).map((e) => e.seq)).toEqual([
      3, 4, 5, 8, 9, 10, 11,
    ]);
    // A batch row that does not open would throw if it were read.
    s.db.exec("DROP TRIGGER run_events_no_update");
    s.db.prepare("UPDATE run_events SET payload = ? WHERE seq = 1").run('{"$enc":1,"k":1,"d":"AAAA"}');
    expect(s.runs.events("r1", -1, { types: tools }).map((e) => e.seq)).toEqual([6, 7]);
    expect(() => s.runs.events("r1")).toThrow();
    s.close();
  });

  it("a duplicate seq still throws when it is appended", () => {
    const s = fresh();
    s.runs.appendEvent(delta(0, "a"));
    s.runs.appendEvent(delta(1, "b"));
    expect(() => s.runs.appendEvent(delta(1, "again"))).toThrow();
    expect(() => s.runs.appendEvent(delta(0, "again"))).toThrow();
    s.runs.flush();
    expect(() => s.runs.appendEvent(ev(1, "tool.requested", { callId: "c", tool: "t", args: {} }))).toThrow();
    expect(s.runs.events("r1").map((e) => e.seq)).toEqual([0, 1]);
    s.close();
  });

  it("sealed: one sealed row per batch, no chunk text on disk, the same events back", () => {
    const s = fresh(":memory:", key());
    const list = stream();
    for (const e of list) s.runs.appendEvent(e);
    s.runs.flush();
    const raw = rows(s);
    expect(raw).toHaveLength(6);
    for (const r of raw) {
      expect(isSealedText(r.payload)).toBe(true);
      expect(r.payload).not.toContain("段");
      expect(r.payload).not.toContain("back to a");
    }
    expect(s.runs.events("r1")).toEqual(
      list.map((e) => ({ runId: e.runId, seq: e.seq, type: e.type, payload: e.payload })),
    );
    s.close();
  });
});

describe("sealed form parsing (R7.7: one parse per read)", () => {
  it("the written form, the same object in another key order, and nothing else", () => {
    const k = key();
    const v = k.seal("messages", "content", "m1", "hi");
    expect(isSealedText(v)).toBe(true);
    const o = JSON.parse(v) as { k: number; d: string };
    const reordered = JSON.stringify({ $enc: 1, d: o.d, k: o.k });
    expect(isSealedText(reordered)).toBe(true);
    expect(k.open("messages", "content", "m1", reordered)).toBe("hi");
    expect(isSealedText(`{"$enc":1,"k":1,"d":"ab"c"}`)).toBe(false);
    expect(isSealedText(`{"$enc":1,"k":x,"d":"ab"}`)).toBe(false);
    expect(isSealedText(`{"$enc":2,"k":1,"d":"ab"}`)).toBe(false);
    expect(isSealedText(`{"$enc":1,"k":1.5,"d":"ab"}`)).toBe(false);
    expect(k.open("messages", "content", "m1", `{"$enc":1,"k":1,"d":"ab"c"}`)).toBe(
      `{"$enc":1,"k":1,"d":"ab"c"}`,
    );
  });
});
