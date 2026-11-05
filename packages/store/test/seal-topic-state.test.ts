import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BatchSizer,
  drainSync,
  MIGRATIONS,
  openStore,
  readSealProgress,
  SEALED,
  Sealer,
  sealStatus,
  sealSteps,
} from "../src/index.ts";
import { botOf } from "./seed-conversation.ts";

// Review 2026-11-05 #2 / #3 (migration 31): offers.topic and an add-on's state
// (主動留意's queue of candidate facts) are sealed columns. Fake data only.

const newKey = () => new Sealer({ current: 1, keys: { "1": randomBytes(32).toString("base64") } });
const dirs: string[] = [];
const tmpDb = () => {
  const d = mkdtempSync(join(tmpdir(), "alca-seal-ts-"));
  dirs.push(d);
  return join(d, "state.sqlite");
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const M = "OKAPI-TOPICSTATE-4417";
const queueState = {
  lastScanAt: "2026-11-05T00:00:00.000Z",
  queue: [
    { kind: "runner_up", candidate: { fact: `${M}-fact 週五前回王小明`, action: `${M}-action 草擬回覆` } },
  ],
};
const rawState = (s: ReturnType<typeof openStore>, bot: string) =>
  (
    s.db
      .prepare("SELECT state_json FROM bot_addons WHERE bot_id = ? AND addon_id = 'proactive'")
      .get(bot) as {
      state_json: string;
    }
  ).state_json;
const rawTopic = (s: ReturnType<typeof openStore>, id: string) =>
  (s.db.prepare("SELECT topic FROM offers WHERE id = ?").get(id) as { topic: string }).topic;

describe("migration 31: offers.topic and bot_addons.state_json are sealed", () => {
  it("both are listed in SEALED", () => {
    expect(SEALED.offers?.cols).toContain("topic");
    expect(SEALED.bot_addons).toEqual({ cols: ["state_json"], pk: ["bot_id", "addon_id"] });
  });

  it("the add-on state is written sealed (also the empty state of a new row) and read back", () => {
    const s = openStore(":memory:", undefined, { sealer: newKey() });
    const bot = botOf(s);
    s.addons.set(bot, "proactive", { enabled: true });
    expect(rawState(s, bot).startsWith('{"$enc":1')).toBe(true);
    expect(s.addons.get(bot, "proactive")?.state).toEqual({});
    s.addons.setState(bot, "proactive", queueState);
    expect(rawState(s, bot)).not.toContain("OKAPI");
    expect(s.addons.get(bot, "proactive")?.state).toEqual(queueState);
    expect(s.addons.enabledFor("proactive")[0]?.state).toEqual(queueState);
    expect(s.addons.list(bot)[0]?.state).toEqual(queueState);
    // Settings change keeps the sealed state as it was.
    s.addons.set(bot, "proactive", { settings: { maxPerDay: 2 } });
    expect(s.addons.get(bot, "proactive")?.state).toEqual(queueState);
    expect(sealStatus(s.db).plaintext.bot_addons).toBeUndefined();
    s.close();
  });

  it("rows written before migration 31 / before the key are sealed by the pass; nothing readable is left", () => {
    const path = tmpDb();
    const a = openStore(
      path,
      MIGRATIONS.filter((m) => m.version <= 30),
    );
    const bot = botOf(a);
    a.addons.set(bot, "proactive", { enabled: true });
    a.addons.setState(bot, "proactive", queueState);
    const o = a.offers.add({
      botId: bot,
      source: "addon:proactive",
      category: "errand",
      topic: `${M}-topic 回王小明`,
      text: "t",
      action: "a",
    });
    a.db
      .prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('seal_progress', ?)")
      .run(JSON.stringify({ offers: "99", bot_addons: "99", messages: "4", done: new Date().toISOString() }));
    expect(rawTopic(a, o.id)).toContain(M);
    a.close();

    const s = openStore(path, undefined, { sealer: newKey() });
    expect(s.migration.applied).toEqual([31, 32]);
    const p = readSealProgress(s.db);
    expect([p.done, p.offers, p.bot_addons]).toEqual([undefined, undefined, undefined]);
    expect(p.messages).toBe("4");
    expect(sealStatus(s.db).plaintext).toMatchObject({ offers: 1, bot_addons: 1 });
    const r = drainSync(sealSteps(s.db, new BatchSizer({ targetMs: 50 })));
    expect(r.done).toBe(true);
    expect(sealStatus(s.db).remaining).toBe(0);
    expect(rawTopic(s, o.id)).not.toContain(M);
    expect(rawState(s, bot)).not.toContain(M);
    expect(s.offers.get(o.id)?.topic).toBe(`${M}-topic 回王小明`);
    expect(s.addons.get(bot, "proactive")?.state).toEqual(queueState);
    s.close();
    expect(readFileSync(path).toString("utf8")).not.toContain(M);
  });
});
