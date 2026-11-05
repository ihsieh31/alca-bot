import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore, type Store } from "../src/index.ts";

let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "alca-conn-"));
  store = openStore(join(dir, "s.sqlite"));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("connector repo", () => {
  it("accounts, grants per bot, removal is final and drops grants", () => {
    const bot = store.bots.ensureDefault().id;
    const a = store.connectors.addAccount({ remoteId: "ca_1", toolkit: "gmail", label: "工作" });
    expect(a.status).toBe("pending");
    store.connectors.setStatus(a.id, "active", "me@work.example");
    store.connectors.grant(bot, a.id, "act");
    expect(store.connectors.usable(bot).map((x) => [x.label, x.access])).toEqual([["工作", "act"]]);
    store.connectors.grant(bot, a.id, "read");
    expect(store.connectors.usable(bot)[0]?.access).toBe("read");
    store.connectors.remove(a.id);
    expect(store.connectors.usable(bot)).toEqual([]);
    expect(() => store.connectors.setStatus(a.id, "active")).toThrow(/stays removed/);
    expect(() =>
      store.db.prepare("UPDATE connector_accounts SET toolkit = 'x' WHERE id = ?").run(a.id),
    ).toThrow();
  });

  it("daily quota reserve stops at the limit", () => {
    const bot = store.bots.ensureDefault().id;
    expect(store.connectors.reserve("2026-11-03", bot, "send", 2)).toBe(true);
    expect(store.connectors.reserve("2026-11-03", bot, "send", 2)).toBe(true);
    expect(store.connectors.reserve("2026-11-03", bot, "send", 2)).toBe(false);
    expect(store.connectors.usage("2026-11-03", bot, "send")).toBe(2);
    expect(store.connectors.reserve("2026-11-04", bot, "send", 2)).toBe(true);
  });

  it("an event id is seen once", () => {
    expect(store.connectors.markSeen("msg_1")).toBe(true);
    expect(store.connectors.markSeen("msg_1")).toBe(false);
  });
});

describe("routine repo", () => {
  it("cursor moves only when the AI result is saved; runs are append-only", () => {
    const bot = store.bots.ensureDefault().id;
    const th = store.threads.create("thr_TEST0000000000000000000001", "t", new Date(), bot);
    const r = store.routines.create({
      botId: bot,
      threadId: th.id,
      name: "信箱",
      kind: "interval",
      intervalSec: 300,
      check: { kind: "tool" },
      nextDueAt: new Date(0).toISOString(),
    });
    expect(store.routines.due(new Date().toISOString()).map((x) => x.id)).toEqual([r.id]);
    store.routines.aiStarted(r.id, "wkr_x", { seen: ["a"] });
    expect(store.routines.due(new Date().toISOString())).toEqual([]);
    store.routines.aiEnded(r.id, { fail: "boom" });
    expect(store.routines.get(r.id)?.cursor).toEqual({});
    store.routines.aiStarted(r.id, "wkr_y", { seen: ["a"] });
    const row = store.routines.aiEnded(r.id, {
      save: { output: { quiet: true }, items: 1, workerId: "wkr_y" },
    });
    expect(row?.outcome).toBe("ai_done");
    expect(store.routines.get(r.id)?.cursor).toEqual({ seen: ["a"] });
    expect(() => store.db.prepare("DELETE FROM routine_runs").run()).toThrow(/append-only/);
  });

  it("trigger routines are due only with queued items past the cursor", () => {
    const bot = store.bots.ensureDefault().id;
    const th = store.threads.create("thr_TEST0000000000000000000001", "t", new Date(), bot);
    const trg = store.triggers.create({
      botId: bot,
      threadId: th.id,
      name: "信",
      source: "email",
      config: {},
      rule: {},
      semantic: null,
    });
    const r = store.routines.create({
      botId: bot,
      threadId: th.id,
      name: "新信",
      kind: "trigger",
      triggerId: trg.id,
      check: { kind: "queue" },
      nextDueAt: null,
    });
    const now = new Date().toISOString();
    expect(store.routines.due(now)).toEqual([]);
    expect(store.routines.enqueueItem(r.id, "m1", { text: "hi" })).toBe(true);
    expect(store.routines.enqueueItem(r.id, "m1", { text: "hi" })).toBe(false);
    expect(store.routines.due(now).map((x) => x.id)).toEqual([r.id]);
    store.routines.aiStarted(r.id, "wkr_1", { seq: 1 });
    store.routines.aiEnded(r.id, { save: { output: {}, items: 1, workerId: "wkr_1" } });
    expect(store.routines.due(now)).toEqual([]);
  });

  it("drafts end used or discarded", () => {
    const bot = store.bots.ensureDefault().id;
    const th = store.threads.create("thr_TEST0000000000000000000001", "t", new Date(), bot);
    const d = store.routines.addDraft({
      botId: bot,
      threadId: th.id,
      kind: "reply",
      title: "回覆",
      body: "好的",
    });
    store.routines.setDraftStatus(d.id, "discarded");
    expect(() => store.routines.setDraftStatus(d.id, "ready")).toThrow(/stays/);
  });
});
