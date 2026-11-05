import { describe, expect, it } from "vitest";
import { BotRepo, MIGRATIONS, migrate, openDatabase, openStore } from "../src/index.ts";

describe("bots (a single-agent user is a team of one)", () => {
  it("creates exactly one default bot on first launch and back-fills older rows", () => {
    const db = openDatabase({ path: ":memory:" });
    migrate(db, MIGRATIONS.slice(0, 2));
    db.prepare("INSERT INTO threads (id, title, created_at, updated_at) VALUES ('t1', null, 'x', 'x')").run();
    migrate(db, MIGRATIONS);
    const s = openStore(":memory:");
    const first = s.bots.ensureDefault();
    expect(s.bots.ensureDefault().id).toBe(first.id);
    expect(first.id).toMatch(/^bot_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(s.bots.list()).toHaveLength(1);
    // the old-store path: back-fill
    const repo = new BotRepo(db);
    const d = repo.ensureDefault();
    expect(
      (db.prepare("SELECT bot_id FROM threads WHERE id = 't1'").get() as { bot_id: string }).bot_id,
    ).toBe(d.id);
    s.close();
  });

  it("threads, jobs and approvals carry the bot; a Space's owner never changes", () => {
    const s = openStore(":memory:");
    const a = s.bots.default()!;
    const b = s.bots.create("研究員");
    const t = s.threads.create("thr_1", null, new Date(), b.id);
    expect(t.botId).toBe(b.id);
    expect(s.threads.create("thr_2", null).botId).toBeNull();
    s.human.requestApproval({
      id: "apr_1",
      runId: null,
      callId: null,
      actionClass: "payment",
      summary: "x",
      botId: b.id,
    });
    expect(s.human.approval("apr_1")?.botId).toBe(b.id);
    const sp = s.bots.openSpace({
      id: "spc_1",
      botId: a.id,
      threadId: null,
      title: "查",
      profile: "shared",
      persistent: false,
    });
    expect(s.bots.spaces(a.id).map((x) => x.id)).toEqual([sp.id]);
    expect(s.bots.spaces(b.id)).toEqual([]);
    expect(() => s.db.prepare("UPDATE browser_spaces SET bot_id = ? WHERE id = 'spc_1'").run(b.id)).toThrow(
      /owner/,
    );
    expect(() =>
      s.bots.openSpace({
        id: "spc_2",
        botId: a.id,
        threadId: null,
        title: "x",
        profile: "shared",
        persistent: true,
      }),
    ).toThrow();
    s.bots.closeSpace(sp.id);
    expect(s.bots.spaces()).toEqual([]);
    s.close();
  });
});
