import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BatchSizer,
  drainSync,
  MIGRATIONS,
  migrate,
  openStore,
  readSealProgress,
  SEALED,
  Sealer,
  sealStatus,
  sealSteps,
} from "../src/index.ts";
import { botOf } from "./seed-conversation.ts";

// Proactivity item 4 (migration 30): an offer's text and action are written
// from mail / calendar facts, so they are sealed like a message.

const newKey = () => new Sealer({ current: 1, keys: { "1": randomBytes(32).toString("base64") } });
const dirs: string[] = [];
const tmpDb = () => {
  const d = mkdtempSync(join(tmpdir(), "alca-seal-offers-"));
  dirs.push(d);
  return join(d, "state.sqlite");
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const M = "OKAPI-OFFER-5521";
const offer = (bot: string) => ({
  botId: bot,
  threadId: null,
  source: "addon:proactive" as const,
  category: "errand" as const,
  topic: "quote-reply",
  text: `${M}-text 週五前要回王小明的報價信`,
  action: `${M}-action 草擬回覆王小明，附上報價單`,
  evidence: ["gmail:msg_1"],
});

const raw = (s: ReturnType<typeof openStore>, id: string) =>
  s.db.prepare("SELECT text, action, topic FROM offers WHERE id = ?").get(id) as {
    text: string;
    action: string;
    topic: string;
  };

describe("offers.text / offers.action are sealed (migration 30)", () => {
  it("is listed in SEALED and has a closed gate row", () => {
    expect(SEALED.offers).toEqual({ cols: ["text", "action", "topic"], pk: ["id"] });
    const s = openStore(":memory:");
    const gates = s.db.prepare("SELECT tbl, open FROM seal_gate ORDER BY tbl").all() as Array<{
      tbl: string;
      open: number;
    }>;
    expect(gates.map((g) => g.tbl)).toEqual([
      "approvals",
      "job_events",
      "memories",
      "offers",
      "run_events",
      "spills",
      "trigger_events",
    ]);
    expect(gates.every((g) => g.open === 0)).toBe(true);
    expect(() => s.db.prepare("INSERT INTO seal_gate (tbl, open) VALUES ('messages', 0)").run()).toThrow();
    expect(() => s.db.prepare("DELETE FROM seal_gate").run()).toThrow(/fixed/);
    s.close();
  });

  it("the repo writes the sealed form and every reader gives the text back", () => {
    const s = openStore(":memory:", undefined, { sealer: newKey() });
    const o = s.offers.add(offer(botOf(s)));
    const r = raw(s, o.id);
    expect(r.text).not.toContain("OKAPI");
    expect(r.action).not.toContain("OKAPI");
    expect(r.text.startsWith('{"$enc":1')).toBe(true);
    expect(r.topic.startsWith('{"$enc":1')).toBe(true); // review 2026-11-05 #2: sealed too (migration 31)
    expect(s.offers.get(o.id)?.topic).toBe("quote-reply");
    expect(s.offers.get(o.id)?.text).toBe(offer("").text);
    expect(s.offers.get(o.id)?.action).toBe(offer("").action);
    expect(s.offers.list({ botId: o.botId })[0]?.text).toBe(offer("").text);
    // Decisions still work on a sealed row (the owner trigger only guards text / owner columns).
    expect(s.offers.decide(o.id, "accepted")).toBe(true);
    expect(s.offers.get(o.id)?.status).toBe("accepted");
    expect(sealStatus(s.db).plaintext.offers).toBeUndefined();
    s.close();
  });

  it("the text is still never rewritten in plaintext, nor sealed → another value, with the gate closed or open", () => {
    const k = newKey();
    const s = openStore(":memory:", undefined, { sealer: k });
    const o = s.offers.add(offer(botOf(s)));
    const set = (v: string) => () => s.db.prepare("UPDATE offers SET text = ? WHERE id = ?").run(v, o.id);
    expect(set("改寫")).toThrow(/not rewritten/);
    s.db.exec("BEGIN");
    s.db.prepare("UPDATE seal_gate SET open = 1 WHERE tbl = 'offers'").run();
    expect(set("改寫")).toThrow(/not rewritten/);
    expect(set(k.seal("offers", "text", o.id, "x"))).toThrow(/not rewritten/); // already sealed
    s.db.prepare("UPDATE seal_gate SET open = 0 WHERE tbl = 'offers'").run();
    s.db.exec("COMMIT");
    s.close();
  });

  it("offers written before the key are sealed by the background pass; reads are unchanged", () => {
    const path = tmpDb();
    const a = openStore(path);
    const bot = botOf(a);
    const ids = [a.offers.add(offer(bot)).id, a.offers.add({ ...offer(bot), action: "" }).id];
    a.offers.decide(ids[0] as string, "declined"); // a decided offer is sealed too
    a.close();

    const k = newKey();
    const s = openStore(path, undefined, { sealer: k });
    const before = ids.map((id) => s.offers.get(id));
    expect(sealStatus(s.db).plaintext.offers).toBe(2);
    const r = drainSync(sealSteps(s.db, new BatchSizer({ targetMs: 50 })));
    expect(r.done).toBe(true);
    expect(r.sealed.offers).toBe(2);
    expect(sealStatus(s.db).remaining).toBe(0);
    expect(ids.map((id) => s.offers.get(id))).toEqual(before);
    for (const id of ids) expect(raw(s, id).text).not.toContain("OKAPI");
    expect(raw(s, ids[0] as string).action).not.toContain("OKAPI");
    expect(raw(s, ids[1] as string).action).toBe(""); // nothing to seal
    expect((s.db.prepare("SELECT SUM(open) AS n FROM seal_gate").get() as { n: number }).n).toBe(0);
    s.close();
    // Nothing readable is left in the file (WAL checkpointed on close).
    expect(readFileSync(path).toString("utf8")).not.toContain(`${M}-text`);
  });

  it("migration 30 on a database that finished the pass: the pass runs again and old backups count as plaintext", () => {
    const path = tmpDb();
    const v29 = MIGRATIONS.filter((m) => m.version <= 29);
    const upTo30 = MIGRATIONS.filter((m) => m.version <= 30);
    const a = openStore(path, v29);
    const at = new Date().toISOString();
    a.db
      .prepare("INSERT INTO meta (k, v) VALUES ('seal_progress', ?)")
      .run(JSON.stringify({ messages: "3", offers: "7", done: at, clean: "[]" }));
    const bot = botOf(a);
    a.db
      .prepare(
        `INSERT INTO offers (id, bot_id, source, category, text, action, created_at, updated_at)
         VALUES ('ofr_old', ?, 'addon:proactive', 'errand', ?, ?, ?, ?)`,
      )
      .run(bot, `${M}-old`, `${M}-oldaction`, at, at);
    a.close();
    const s = openStore(path, upTo30, { sealer: newKey() });
    expect(s.migration.applied).toEqual([30]);
    const p = readSealProgress(s.db);
    expect(p.done).toBeUndefined();
    expect(p.clean).toBeUndefined();
    expect(p.offers).toBeUndefined();
    expect(p.messages).toBe("3");
    expect(drainSync(sealSteps(s.db, new BatchSizer({ targetMs: 50 }))).sealed.offers).toBe(1);
    expect(s.offers.get("ofr_old")?.text).toBe(`${M}-old`);
    expect(migrate(s.db, upTo30).applied).toEqual([]);
    s.close();
  });
});
