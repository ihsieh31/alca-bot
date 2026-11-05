import { describe, expect, it } from "vitest";
import { MIGRATIONS, migrate, openDatabase, openStore } from "../src/index.ts";

const base = { kind: "preference" as const, origin: "inferred" as const, confidence: 0.6 };

function fresh() {
  const s = openStore(":memory:");
  const botId = s.bots.ensureDefault().id;
  return { s, botId };
}

describe("memories (migration 6)", () => {
  it("keeps provenance and supersedes instead of overwriting", () => {
    const { s, botId } = fresh();
    const a = s.memory.add({
      ...base,
      botId,
      scope: "shared",
      subject: "飲品",
      body: "喜歡燕麥奶拿鐵",
      quote: "我喜歡燕麥奶拿鐵",
      source: { kind: "chat", threadId: "thr_x", messageId: "msg_y", runId: "run_z" },
    });
    expect(a.source).toEqual({
      kind: "chat",
      threadId: "thr_x",
      messageId: "msg_y",
      runId: "run_z",
      workerId: null,
    });
    expect(a.confirmedAt).toBeNull();
    expect(() => s.db.prepare("UPDATE memories SET body = 'x' WHERE id = ?").run(a.id)).toThrow(
      /superseded, not overwritten/,
    );
    const b = s.memory.add({
      ...base,
      botId,
      scope: "shared",
      subject: "飲品",
      body: "改喝豆漿",
      origin: "user",
      confidence: 1,
      source: { kind: "chat" },
      supersedes: a.id,
    });
    expect(s.memory.get(a.id)?.status).toBe("superseded");
    expect(s.memory.get(a.id)?.supersededBy).toBe(b.id);
    expect(s.memory.activeBySubject(botId, "shared", "飲品")?.id).toBe(b.id);
    expect(s.memory.chain(b.id).map((m) => m.id)).toEqual([a.id, b.id]);
    expect(() =>
      s.memory.add({ ...base, botId, scope: "shared", body: "x", source: { kind: "ui" }, supersedes: a.id }),
    ).toThrow(/already superseded/);
    expect(() =>
      s.db.prepare("UPDATE memories SET status = 'active', superseded_by = NULL WHERE id = ?").run(a.id),
    ).toThrow(/stays superseded/);
    s.close();
  });

  it("confirms an inferred item once and never back", () => {
    const { s, botId } = fresh();
    const a = s.memory.add({ ...base, botId, scope: "shared", body: "住在高雄", source: { kind: "chat" } });
    expect(s.memory.confirm(a.id)).toBe(true);
    expect(s.memory.get(a.id)).toMatchObject({ origin: "user", confidence: 1 });
    expect(() => s.db.prepare("UPDATE memories SET origin = 'inferred' WHERE id = ?").run(a.id)).toThrow(
      /cannot become inferred/,
    );
    s.close();
  });

  it("forgets the whole chain and keeps only hashed tombstones", () => {
    const { s, botId } = fresh();
    const a = s.memory.add({ ...base, botId, scope: "shared", body: "喜歡貓", source: { kind: "chat" } });
    const b = s.memory.add({
      ...base,
      botId,
      scope: "shared",
      body: "喜歡橘貓",
      source: { kind: "chat" },
      supersedes: a.id,
    });
    expect(
      s.memory
        .forgetChain(a.id)
        .map((m) => m.id)
        .sort(),
    ).toEqual([a.id, b.id].sort());
    expect(s.memory.count({ includeSuperseded: true })).toBe(0);
    const key = s.memory.tombstoneKey();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    s.memory.addTombstone({ botId, digest: "d1", shingles: ["aa", "bb"], reason: "forget" });
    s.memory.addTombstone({ botId, digest: "d1", shingles: ["aa"], reason: "forget" });
    expect(s.memory.tombstones()).toHaveLength(1);
    expect(() => s.db.prepare("UPDATE memory_tombstones SET digest = 'x'").run()).toThrow(/final/);
    expect(s.memory.clearTombstones()).toBe(1);
    s.close();
  });

  it("stores and reads embeddings per model", () => {
    const { s, botId } = fresh();
    const a = s.memory.add({
      ...base,
      botId,
      scope: "bot",
      body: "專案：Alca 重構",
      kind: "project",
      source: { kind: "ui" },
    });
    s.memory.setEmbedding(a.id, new Float32Array([0.5, -1, 2]), "local-test");
    expect(s.memory.embeddings(botId, "local-test")[0]?.vector).toEqual(new Float32Array([0.5, -1, 2]));
    expect(s.memory.embeddings(botId, "other")).toEqual([]);
    expect(s.memory.get(a.id)?.embedded).toBe(true);
    s.close();
  });

  it("folds P0 memory_items into memories and drops the old tables", () => {
    const db = openDatabase({ path: ":memory:" });
    migrate(db, MIGRATIONS.slice(0, 5));
    db.prepare(
      "INSERT INTO bots (id, name, is_default, created_at) VALUES ('bot_0000000000AAAAAAAAAAAAAAAA', 'Alca', 1, '2026-01-01T00:00:00.000Z')",
    ).run();
    db.prepare(
      "INSERT INTO memory_items (id, scope, kind, body, search_terms, created_at, updated_at) VALUES ('mem_old', 'user_model', 'fact', '喜歡烏龍茶', '烏龍 龍茶 茶', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
    ).run();
    migrate(db, MIGRATIONS);
    const rows = db.prepare("SELECT id, bot_id, scope, origin, source_kind FROM memories").all() as Array<
      Record<string, string>
    >;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      bot_id: "bot_0000000000AAAAAAAAAAAAAAAA",
      scope: "shared",
      origin: "user",
      source_kind: "migrated",
    });
    expect(rows[0]?.id).toMatch(/^mem_[0-9A-HJKMNP-TV-Z]{26}$/);
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(names).not.toContain("memory_items");
    db.close();
  });
});

describe("skills (migration 6)", () => {
  const content = {
    name: "示範商店結帳",
    description: "在示範商店結帳",
    triggers: ["結帳", "示範商店"],
    steps: [{ text: "開啟商店", tool: "browser_open", args: { url: "http://x" }, actionClass: "network" }],
    actionClasses: ["network", "payment"],
  };

  it("is saved only after approval, versioned, editable, disable-able, deletable", () => {
    const { s, botId } = fresh();
    const p = s.skills.propose({ ...content, botId, sourceWorkerId: "wkr_x" });
    expect(p).toMatchObject({ status: "proposed", version: 0 });
    expect(p.current).toBeUndefined();
    expect(p.pending?.version).toBe(1);
    const a = s.skills.approve(p.id);
    expect(a).toMatchObject({ status: "active", version: 1 });
    expect(a?.current?.actionClasses).toEqual(["network", "payment"]);
    const rev = s.skills.proposeRevision(
      p.id,
      { ...content, steps: [...content.steps, { text: "先確認購物車" }] },
      "使用者更正",
    );
    expect(rev?.version).toBe(2);
    expect(s.skills.get(p.id)?.version).toBe(1);
    const e = s.skills.edit(p.id, { ...content, name: "結帳（我改的）" });
    expect(e).toMatchObject({ version: 3 });
    expect(e?.current?.author).toBe("user");
    expect(s.skills.versions(p.id).map((v) => v.state)).toEqual(["approved", "rejected", "approved"]);
    expect(() => s.db.prepare("UPDATE skill_versions SET steps = '[]' WHERE skill_id = ?").run(p.id)).toThrow(
      /append-only/,
    );
    expect(s.skills.setEnabled(p.id, false)?.status).toBe("disabled");
    expect(s.skills.list({ botId, status: ["active"] })).toHaveLength(0);
    expect(s.skills.delete(p.id)).toBe(true);
    expect(s.skills.versions(p.id)).toEqual([]);
    s.close();
  });

  it("rejecting a never-approved proposal rejects the skill", () => {
    const { s, botId } = fresh();
    const p = s.skills.propose({ ...content, botId });
    expect(s.skills.reject(p.id)?.status).toBe("rejected");
    expect(() => s.db.prepare("UPDATE skills SET status = 'active' WHERE id = ?").run(p.id)).toThrow(/CHECK/);
    s.close();
  });
});
