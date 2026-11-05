import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendJobEvent,
  isSealedText,
  jobEvents,
  openStore,
  SealError,
  Sealer,
  SealKeyMismatchError,
  type Store,
  toMatchQuery,
  toSearchTerms,
} from "../src/index.ts";
import { botOf } from "./seed-conversation.ts";

/**
 * Next round R7.4 / R7.5 (Phase F2): the Sealer, the repos writing sealed
 * columns, the key check at start, and migration 25's seal gate.
 */

export const newKey = () => new Sealer({ current: 1, keys: { "1": randomBytes(32).toString("base64") } });

const dirs: string[] = [];
export function tmpDb(): string {
  const d = mkdtempSync(join(tmpdir(), "alca-seal-"));
  dirs.push(d);
  return join(d, "state.sqlite");
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const raw = (s: Store, sql: string, ...a: string[]) => s.db.prepare(sql).get(...a) as Record<string, unknown>;

describe("Sealer", () => {
  it("round-trips, and the stored form is the one JSON shape", () => {
    const k = newKey();
    const v = k.seal("messages", "content", "m1", "你好 OKAPI");
    expect(isSealedText(v)).toBe(true);
    expect(JSON.parse(v)).toMatchObject({ $enc: 1, k: 1 });
    expect(v).not.toContain("OKAPI");
    expect(k.open("messages", "content", "m1", v)).toBe("你好 OKAPI");
    // A fresh nonce each time.
    expect(k.seal("messages", "content", "m1", "x")).not.toBe(k.seal("messages", "content", "m1", "x"));
    // Plaintext passes through open.
    expect(k.open("messages", "content", "m1", "plain")).toBe("plain");
  });

  it("does not open under another row, column, table or key", () => {
    const k = newKey();
    const v = k.seal("messages", "content", "m1", "secret");
    expect(() => k.open("messages", "content", "m2", v)).toThrow(SealError);
    expect(() => k.open("messages", "body", "m1", v)).toThrow(SealError);
    expect(() => k.open("spills", "content", "m1", v)).toThrow(SealError);
    expect(() => newKey().open("messages", "content", "m1", v)).toThrow(SealError);
    const tampered = v.replace(/"d":"(.)/, (_m, c: string) => `"d":"${c === "A" ? "B" : "A"}`);
    expect(() => k.open("messages", "content", "m1", tampered)).toThrow(SealError);
  });

  it("keeps old key ids readable after a rotation (D1 key ring)", () => {
    const k1 = Buffer.from(randomBytes(32)).toString("base64");
    const a = new Sealer({ current: 1, keys: { "1": k1 } });
    const v = a.seal("messages", "content", "m1", "old row");
    const b = new Sealer({ current: 2, keys: { "1": k1, "2": randomBytes(32).toString("base64") } });
    expect(b.open("messages", "content", "m1", v)).toBe("old row");
    expect(JSON.parse(b.seal("messages", "content", "m1", "new"))).toMatchObject({ k: 2 });
    expect(() => a.open("messages", "content", "m1", b.seal("messages", "content", "m1", "new"))).toThrow(
      /金鑰 2/,
    );
  });

  it("sealed run_events / job_events payloads still pass CHECK (json_valid)", () => {
    const s = openStore(":memory:", undefined, { sealer: newKey() });
    s.threads.create("t1", null);
    s.runs.start({ id: "r1", threadId: "t1", initiator: { kind: "user", id: "u" } });
    s.runs.appendEvent({ runId: "r1", seq: 0, type: "text", payload: { text: "hi" } });
    const r = raw(s, "SELECT payload, json_valid(payload) AS ok FROM run_events");
    expect(r.ok).toBe(1);
    expect(isSealedText(r.payload)).toBe(true);
    s.close();
  });
});

describe("repos write sealed columns and read them back", () => {
  it("every sealed column holds the sealed form; every reader gives the text", () => {
    const s = openStore(":memory:", undefined, { sealer: newKey() });
    const bot = botOf(s);
    const M = "OKAPI-SEAL-7731";
    s.threads.create("t1", null);
    s.runs.start({ id: "r1", threadId: "t1", initiator: { kind: "user", id: "u" } });
    s.threads.addMessage({ id: "m1", threadId: "t1", runId: "r1", role: "user", content: `${M} message` });
    s.runs.appendEvent({ runId: "r1", seq: 0, type: "text", payload: { text: `${M} event` } });
    s.db
      .prepare(
        "INSERT INTO jobs (id, kind, thread_id, status, title, created_at, updated_at) VALUES ('j1','turn','t1','running','t','x','x')",
      )
      .run();
    appendJobEvent(s.db, "j1", "tool", { out: `${M} jobevent` }, "x");
    const w = s.workers.create({
      botId: bot,
      threadId: "t1",
      jobId: "j1",
      title: "w",
      goal: `${M} goal`,
      initiator: { kind: "user", id: "u" },
    });
    s.workers.finish(w.id, "succeeded", new Date(), {
      result: { mode: "inline", summary: `${M} result`, chars: 3 },
    });
    const sp = s.workers.addSpill({
      botId: bot,
      ownerKind: "worker",
      ownerId: w.id,
      title: "s",
      body: `${M} spill`,
    });
    const ib = s.workers.addInbox({
      botId: bot,
      threadId: "t1",
      kind: "worker_report",
      refId: w.id,
      body: `${M} inbox`,
      initiator: { kind: "user", id: "u" },
    });
    s.workers.addWorkerInbox({ workerId: w.id, streamId: null, eventId: null, body: `${M} winbox` });
    s.human.requestApproval({
      id: "a1",
      runId: "r1",
      callId: null,
      actionClass: "send",
      summary: `${M} approval`,
    });
    const mem = s.memory.add({
      botId: bot,
      scope: "bot",
      kind: "fact",
      body: `${M} 長期記憶 memory`,
      quote: `${M} quote`,
      origin: "inferred",
      confidence: 0.5,
      source: { kind: "chat", threadId: "t1" },
    });
    const dr = s.routines.addDraft({
      botId: bot,
      threadId: "t1",
      kind: "note",
      title: "d",
      body: `${M} draft`,
    });

    // Nothing readable in the sealed columns.
    const dump = s.db
      .prepare(
        `SELECT content AS v FROM messages UNION ALL SELECT payload FROM run_events UNION ALL SELECT payload FROM job_events
         UNION ALL SELECT goal FROM workers UNION ALL SELECT result_summary FROM workers UNION ALL SELECT body FROM spills
         UNION ALL SELECT body FROM router_inbox UNION ALL SELECT body FROM worker_inbox UNION ALL SELECT summary FROM approvals
         UNION ALL SELECT body FROM memories UNION ALL SELECT quote FROM memories UNION ALL SELECT search_terms FROM memories
         UNION ALL SELECT body FROM drafts`,
      )
      .all() as Array<{ v: string }>;
    expect(dump.length).toBe(13);
    for (const r of dump) expect(r.v).not.toContain("OKAPI");

    // Every reader opens them.
    expect(s.threads.messages("t1")[0]?.content).toBe(`${M} message`);
    expect(s.runs.events("r1")[0]?.payload).toEqual({ text: `${M} event` });
    expect(jobEvents(s.db, "j1")[0]?.payload).toEqual({ out: `${M} jobevent` });
    expect(s.workers.get(w.id)?.goal).toBe(`${M} goal`);
    expect(s.workers.get(w.id)?.result?.summary).toBe(`${M} result`);
    expect(s.workers.spill(sp.id)?.body).toBe(`${M} spill`);
    expect(s.workers.inboxItem(ib.id)?.body).toBe(`${M} inbox`);
    expect(s.workers.pendingWorkerInbox(w.id)[0]?.body).toBe(`${M} winbox`);
    expect(s.human.approval("a1")?.summary).toBe(`${M} approval`);
    expect(s.memory.get(mem.id)?.body).toBe(`${M} 長期記憶 memory`);
    expect(s.memory.get(mem.id)?.quote).toBe(`${M} quote`);
    expect(s.routines.draft(dr.id)?.body).toBe(`${M} draft`);
    // Keyed FTS still finds it.
    expect(s.memory.search("記憶").map((h) => h.id)).toEqual([mem.id]);
    expect(s.memory.search("memory").map((h) => h.id)).toEqual([mem.id]);
    s.close();
  });

  it("a 2000-character memory body (CJK) fits once sealed; 2001 is still refused", () => {
    const s = openStore(":memory:", undefined, { sealer: newKey() });
    const add = (body: string) =>
      s.memory.add({
        botId: botOf(s),
        scope: "bot",
        kind: "fact",
        body,
        origin: "user",
        confidence: 1,
        source: { kind: "ui" },
      });
    expect(add("記".repeat(2000)).body.length).toBe(2000);
    expect(() => add("記".repeat(2001))).toThrow(/CHECK/);
    s.close();
  });
});

describe("the data key check at start (R7.5 step 2)", () => {
  it("writes seal_check once, accepts the same key, stops on another key or no key", () => {
    const path = tmpDb();
    const k = newKey();
    const a = openStore(path, undefined, { sealer: k });
    expect(a.sealCheck).toBe("new");
    a.threads.create("t1", null);
    a.close();
    const b = openStore(path, undefined, { sealer: new Sealer(k.toWire()) });
    expect(b.sealCheck).toBe("ok");
    b.close();
    expect(() => openStore(path, undefined, { sealer: newKey() })).toThrow(SealKeyMismatchError);
    expect(() => openStore(path)).toThrow(SealKeyMismatchError);
    // Nothing was written by the refused starts: the right key still opens it.
    const c = openStore(path, undefined, { sealer: new Sealer(k.toWire()) });
    expect(c.sealCheck).toBe("ok");
    c.close();
  });

  it("a database that never had a key opens without one (nothing sealed)", () => {
    const s = openStore(":memory:");
    expect(s.sealCheck).toBe("none");
    s.threads.create("t1", null);
    s.threads.addMessage({ id: "m1", threadId: "t1", runId: null, role: "user", content: "plain" });
    expect(raw(s, "SELECT content FROM messages").content).toBe("plain");
    s.close();
  });
});

describe("migration 25: the seal gate", () => {
  function seeded() {
    const s = openStore(":memory:");
    s.threads.create("t1", null);
    s.runs.start({ id: "r1", threadId: "t1", initiator: { kind: "user", id: "u" } });
    s.runs.appendEvent({ runId: "r1", seq: 0, type: "text", payload: { text: "plain" } });
    const k = newKey();
    return { s, k, sealed: k.seal("run_events", "payload", "r1:0", JSON.stringify({ text: "plain" })) };
  }
  const upd =
    (s: Store, sql: string, ...a: string[]) =>
    () =>
      s.db.prepare(sql).run(...a);

  it("with the gate closed, append-only tables still refuse every UPDATE", () => {
    const { s, sealed } = seeded();
    expect(upd(s, "UPDATE run_events SET payload = ?", sealed)).toThrow(/append-only/);
    s.close();
  });

  it("with the gate open, only plaintext → sealed with every other column unchanged", () => {
    const { s, k, sealed } = seeded();
    s.db.exec("BEGIN");
    s.db.prepare("UPDATE seal_gate SET open = 1 WHERE tbl = 'run_events'").run();
    expect(upd(s, 'UPDATE run_events SET payload = \'{"text":"other"}\'')).toThrow(/append-only/);
    expect(upd(s, "UPDATE run_events SET payload = ?, type = 'x'", sealed)).toThrow(/append-only/);
    upd(s, "UPDATE run_events SET payload = ?", sealed)();
    // Already sealed: sealed → another sealed value is refused too.
    expect(
      upd(s, "UPDATE run_events SET payload = ?", k.seal("run_events", "payload", "r1:0", "{}")),
    ).toThrow(/append-only/);
    s.db.prepare("UPDATE seal_gate SET open = 0 WHERE tbl = 'run_events'").run();
    s.db.exec("COMMIT");
    s.close();
  });

  it("gates are fixed rows; a resolved approval and a memory are guarded the same way", () => {
    const { s, k } = seeded();
    expect(upd(s, "INSERT INTO seal_gate (tbl, open) VALUES ('messages', 1)")).toThrow();
    expect(upd(s, "DELETE FROM seal_gate")).toThrow(/fixed/);
    s.db
      .prepare(
        "INSERT INTO approvals (id, run_id, action_class, summary, status, requested_at, resolved_at) VALUES ('a1','r1','send','plain','approved','x','x')",
      )
      .run();
    const m = s.memory.add({
      botId: botOf(s),
      scope: "bot",
      kind: "fact",
      body: "plain",
      origin: "user",
      confidence: 1,
      source: { kind: "ui" },
    });
    expect(upd(s, "UPDATE approvals SET summary = ?", k.seal("approvals", "summary", "a1", "plain"))).toThrow(
      /already resolved/,
    );
    expect(upd(s, "UPDATE memories SET body = ?", k.seal("memories", "body", m.id, "plain"))).toThrow(
      /superseded/,
    );
    s.db.exec("BEGIN");
    s.db.prepare("UPDATE seal_gate SET open = 1").run();
    upd(s, "UPDATE approvals SET summary = ?", k.seal("approvals", "summary", "a1", "plain"))();
    expect(upd(s, "UPDATE approvals SET summary = ?, status = 'denied'", "x")).toThrow(/already resolved/);
    upd(s, "UPDATE memories SET body = ?", k.seal("memories", "body", m.id, "plain"))();
    expect(upd(s, "UPDATE memories SET subject = 'x'")).toThrow(/superseded/);
    s.db.prepare("UPDATE seal_gate SET open = 0").run();
    s.db.exec("COMMIT");
    s.close();
  });
});

describe("keyed FTS (R7.4)", () => {
  const texts = [
    "使用者希望長期記憶系統全部 agent 共用",
    "週五要交報告給主管",
    "Claude Code memory notes",
    "記帳",
  ];
  function both() {
    const out = [undefined, newKey()].map((sealer) => {
      const s = openStore(":memory:", undefined, sealer ? { sealer } : {});
      const ids = texts.map(
        (body) =>
          s.memory.add({
            botId: botOf(s),
            scope: "shared",
            kind: "fact",
            body,
            origin: "user",
            confidence: 1,
            source: { kind: "ui" },
          }).id,
      );
      const find = (q: string) =>
        s.memory
          .search(q)
          .map((h) => ids.indexOf(h.id))
          .sort();
      return { s, find };
    });
    return { plain: out[0] as (typeof out)[0], keyed: out[1] as (typeof out)[0] };
  }

  it("Chinese words, single characters and whole latin words give the same hits as plaintext", () => {
    const { plain, keyed } = both();
    for (const q of ["記憶", "長期記憶", "報告", "記", "交", "memory", "claude code", "agent 共用"]) {
      expect(keyed.find(q), q).toEqual(plain.find(q));
      expect(keyed.find(q).length, q).toBeGreaterThan(0);
    }
    plain.s.close();
    keyed.s.close();
  });

  it("a latin prefix no longer matches (documented trade-off); the index holds no readable word", () => {
    const { plain, keyed } = both();
    expect(plain.find("mem")).toEqual([2]);
    expect(keyed.find("mem")).toEqual([]);
    const terms = keyed.s.db.prepare("SELECT search_terms AS t FROM memories").all() as Array<{ t: string }>;
    for (const r of terms) expect(r.t).toMatch(/^[0-9a-f]{10}( [0-9a-f]{10})*$/);
    expect(toSearchTerms("記憶", newKey()).split(" ").length).toBe(4); // 記憶 憶 + unigrams 記 憶
    expect(toMatchQuery("mem", newKey())).not.toContain("*");
    plain.s.close();
    keyed.s.close();
  });
});
