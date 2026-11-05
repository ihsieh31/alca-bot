import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MIGRATIONS, openStore } from "../src/index.ts";

/** Next round R8: migration 23 widens the account provider and adds the MCP server table. */
describe("integration providers (migration 23)", () => {
  it("keeps accounts, grants and triggers across the rebuild, with their constraints", () => {
    const dir = mkdtempSync(join(tmpdir(), "alca-m23-"));
    const path = join(dir, "alca.db");
    const old = openStore(
      path,
      MIGRATIONS.filter((m) => m.version < 23),
    );
    const bot = old.bots.ensureDefault().id;
    const th = old.threads.create("thr_TEST0000000000000000000001", "t", new Date(), bot);
    const trg = old.triggers.create({
      botId: bot,
      threadId: th.id,
      name: "信",
      source: "email",
      config: {},
      rule: {},
      semantic: null,
    });
    const acc = old.connectors.addAccount({
      remoteId: "ca_1",
      toolkit: "gmail",
      label: "工作",
      status: "active",
      identity: "me@example.com",
    });
    old.connectors.grant(bot, acc.id, "act");
    const now = new Date().toISOString();
    old.db.exec(
      `INSERT INTO connector_triggers (id, account_id, slug, remote_id, trigger_id, config, status, created_at) VALUES ('ct_a', '${acc.id}', 'GMAIL_NEW_GMAIL_MESSAGE', 'ti_1', '${trg.id}', '{}', 'active', '${now}')`,
    );
    const ins = (id: string, provider: string) =>
      `INSERT INTO connector_accounts (id, provider, remote_id, toolkit, label, status, created_at, updated_at) VALUES ('${id}', '${provider}', '${id}-r', 'google', 'G', 'active', '${now}', '${now}')`;
    expect(() => old.db.exec(ins("acc_g", "google"))).toThrow(/CHECK/);
    old.close();

    const s = openStore(path);
    const db = s.db;
    // 23 runs on a version-22 database (later migrations may follow it).
    expect(s.migration.applied[0]).toBe(23);
    expect(db.prepare("SELECT provider, remote_id, label, identity FROM connector_accounts").all()).toEqual([
      { provider: "composio", remote_id: "ca_1", label: "工作", identity: "me@example.com" },
    ]);
    expect(s.connectors.usable(bot).map((a) => [a.id, a.access])).toEqual([[acc.id, "act"]]);
    expect(db.prepare("SELECT id, remote_id FROM connector_triggers").all()).toEqual([
      { id: "ct_a", remote_id: "ti_1" },
    ]);
    // new providers fit; others do not
    db.exec(ins("acc_g", "google"));
    db.exec(ins("acc_m", "mcp"));
    expect(() => db.exec(ins("acc_x", "zapier"))).toThrow(/CHECK/);
    // foreign keys still hold, and migration 7's triggers are back
    expect(() =>
      db.exec(
        `INSERT INTO connector_grants (bot_id, account_id, access, created_at) VALUES ('${bot}', 'acc_nope', 'read', '${now}')`,
      ),
    ).toThrow(/FOREIGN KEY/);
    expect(() => db.exec(`UPDATE connector_accounts SET provider = 'mcp' WHERE id = '${acc.id}'`)).toThrow(
      /never changes/,
    );
    db.exec("UPDATE connector_accounts SET status = 'removed' WHERE id = 'acc_g'");
    expect(() => db.exec("UPDATE connector_accounts SET status = 'active' WHERE id = 'acc_g'")).toThrow(
      /stays removed/,
    );
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("stores MCP servers with secret names only, and accounts per provider", () => {
    const s = openStore(":memory:");
    const sv = s.connectors.saveServer({
      id: "notes",
      label: "筆記",
      transport: "stdio",
      command: "/usr/local/bin/notes-mcp",
      args: ["--root", "~/notes"],
      cwd: null,
      url: null,
      secretNames: ["NOTES_TOKEN"],
      enabled: true,
    });
    expect(sv).toMatchObject({
      id: "notes",
      args: ["--root", "~/notes"],
      secretNames: ["NOTES_TOKEN"],
      enabled: true,
    });
    expect(() => s.connectors.saveServer({ ...sv, id: "bad", transport: "http", url: null })).toThrow(
      /CHECK/,
    );
    const a = s.connectors.addAccount({
      provider: "mcp",
      remoteId: "notes",
      toolkit: "mcp-notes",
      label: "筆記",
      status: "active",
    });
    expect(a.provider).toBe("mcp");
    expect(s.connectors.byRemote("notes")).toBeUndefined();
    expect(s.connectors.byRemote("notes", "mcp")?.id).toBe(a.id);
    s.connectors.removeServer("notes");
    expect(s.connectors.servers()).toEqual([]);
    s.close();
  });
});

/** Google direct removed 2026-11-05: migration 27 disconnects any account it left behind. */
describe("drop google direct (migration 27)", () => {
  it("removes Google-direct accounts (grants, app triggers, their P3 triggers) and leaves the rest", () => {
    const dir = mkdtempSync(join(tmpdir(), "alca-m27-"));
    const path = join(dir, "alca.db");
    const old = openStore(
      path,
      MIGRATIONS.filter((m) => m.version < 27),
    );
    const bot = old.bots.ensureDefault().id;
    const th = old.threads.create("thr_TEST0000000000000000000027", "t", new Date(), bot);
    const trigger = (name: string) =>
      old.triggers.create({
        botId: bot,
        threadId: th.id,
        name,
        source: "email",
        config: {},
        rule: {},
        semantic: null,
      });
    const tg = trigger("Google 新信");
    const tc = trigger("Composio 新信");
    const at = new Date().toISOString();
    old.db.exec(
      `INSERT INTO connector_accounts (id, provider, remote_id, toolkit, label, status, created_at, updated_at) VALUES ('acc_g27', 'google', 'g1', 'google', 'G', 'active', '${at}', '${at}')`,
    );
    const g = { id: "acc_g27" };
    const c = old.connectors.addAccount({
      remoteId: "ca_1",
      toolkit: "gmail",
      label: "工作",
      status: "active",
    });
    const m = old.connectors.addAccount({
      provider: "mcp",
      remoteId: "notes",
      toolkit: "mcp-notes",
      label: "筆記",
      status: "active",
    });
    for (const a of [g, c, m]) old.connectors.grant(bot, a.id, "read");
    old.connectors.addTrigger({
      accountId: g.id,
      slug: "GMAIL_NEW_MESSAGE",
      remoteId: null,
      triggerId: tg.id,
      config: {},
      status: "active",
    });
    old.connectors.addTrigger({
      accountId: c.id,
      slug: "GMAIL_NEW_GMAIL_MESSAGE",
      remoteId: "ti_1",
      triggerId: tc.id,
      config: {},
      status: "active",
    });
    old.close();

    const s = openStore(path);
    expect(s.migration.applied).toEqual([27, 28, 29, 30, 31, 32]);
    expect(s.connectors.account(g.id)?.status).toBe("removed");
    expect(
      s.connectors
        .accounts()
        .map((a) => a.id)
        .sort(),
    ).toEqual([c.id, m.id].sort());
    expect(s.connectors.grants({ accountId: g.id })).toEqual([]);
    expect(
      s.connectors
        .usable(bot)
        .map((a) => a.id)
        .sort(),
    ).toEqual([c.id, m.id].sort());
    expect(s.connectors.triggers(g.id).map((t) => t.status)).toEqual(["removed"]);
    expect(s.connectors.triggers(c.id).map((t) => t.status)).toEqual(["active"]);
    expect(s.triggers.get(tg.id)?.enabled).toBe(false);
    expect(s.triggers.get(tc.id)?.enabled).toBe(true);
    expect(s.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

/** Mac device test 2026-11-05 BUG-4: jobs no longer keep message text or a worker goal in plaintext. */
describe("seal jobs (migration 28)", () => {
  it("drops the copied text, keeps the rest, and makes the seal pass walk jobs again", () => {
    const dir = mkdtempSync(join(tmpdir(), "alca-m28-"));
    const path = join(dir, "alca.db");
    const old = openStore(
      path,
      MIGRATIONS.filter((m) => m.version < 28),
    );
    const at = new Date().toISOString();
    const ins = old.db.prepare(
      "INSERT INTO jobs (id, kind, status, title, input, result, created_at, updated_at) VALUES (?, ?, 'succeeded', ?, ?, ?, ?, ?)",
    );
    ins.run("j_turn", "turn", "請記住暗號 ZZQ77", "{}", '{"texts":1}', at, at);
    ins.run("j_sub", "subagent", "查天氣", '{"goal":"查明天台北的天氣","speculative":false}', null, at, at);
    ins.run("j_tool", "tool", "keep", '{"x":1}', null, at, at);
    old.db
      .prepare("INSERT INTO meta (k, v) VALUES ('seal_progress', ?)")
      .run(JSON.stringify({ jobs: "9", messages: "3", done: at, clean: "[]" }));
    old.close();

    const s = openStore(path);
    expect(s.migration.applied).toEqual([28, 29, 30, 31, 32]);
    const row = (id: string) =>
      s.db.prepare("SELECT title, input, result FROM jobs WHERE id = ?").get(id) as Record<
        string,
        string | null
      >;
    expect(row("j_turn")).toEqual({ title: "turn", input: "{}", result: '{"texts":1}' });
    expect(row("j_sub")).toEqual({ title: null, input: '{"speculative":false}', result: null });
    expect(row("j_tool")).toEqual({ title: "keep", input: '{"x":1}', result: null });
    expect(
      JSON.parse((s.db.prepare("SELECT v FROM meta WHERE k = 'seal_progress'").get() as { v: string }).v),
    ).toEqual({
      messages: "3",
    });
    s.close();
  });
});
