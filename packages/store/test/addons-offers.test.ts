import { describe, expect, it } from "vitest";
import { openStore } from "../src/index.ts";

describe("migration 17: add-ons, usage, offers, memory applies_to / due_at", () => {
  it("an add-on row keeps settings and state when turned off; turning on stamps enabled_at", () => {
    const s = openStore(":memory:");
    const bot = s.bots.default()!.id;
    expect(s.addons.get(bot, "proactive")).toBeUndefined();
    const on = s.addons.set(
      bot,
      "proactive",
      { enabled: true, settings: { maxPerDay: 3 } },
      new Date("2026-11-04T01:00:00Z"),
    );
    expect(on).toMatchObject({
      enabled: true,
      settings: { maxPerDay: 3 },
      enabledAt: "2026-11-04T01:00:00.000Z",
    });
    s.addons.setState(bot, "proactive", { cursor: "x" });
    const off = s.addons.set(bot, "proactive", { enabled: false });
    expect(off).toMatchObject({ enabled: false, settings: { maxPerDay: 3 }, state: { cursor: "x" } });
    const again = s.addons.set(bot, "proactive", { enabled: true }, new Date("2026-11-05T01:00:00Z"));
    expect(again.enabledAt).toBe("2026-11-05T01:00:00.000Z");
    expect(s.addons.enabledFor("proactive").map((r) => r.botId)).toEqual([bot]);
    s.close();
  });

  it("usage adds up per day; capped is marked once", () => {
    const s = openStore(":memory:");
    const bot = s.bots.default()!.id;
    s.addons.charge(bot, "reply-check", "2026-11-04", { runs: 1, inputTokens: 100, outputTokens: 20 });
    const u = s.addons.charge(bot, "reply-check", "2026-11-04", { runs: 1, inputTokens: 50 });
    expect(u).toMatchObject({ runs: 2, inputTokens: 150, outputTokens: 20, cappedAt: null });
    expect(s.addons.usage(bot, "reply-check", "2026-11-05").runs).toBe(0);
    expect(s.addons.markCapped(bot, "reply-check", "2026-11-04")).toBe(true);
    expect(s.addons.markCapped(bot, "reply-check", "2026-11-04")).toBe(false);
    s.close();
  });

  it("an offer is decided once; stats count decided offers per category; evidence is found", () => {
    const s = openStore(":memory:");
    const bot = s.bots.default()!.id;
    const t = s.threads.create("A", bot);
    const a = s.offers.add({
      botId: bot,
      threadId: t.id,
      source: "chat_end",
      category: "project",
      text: "要我整理嗎？",
    });
    expect(a.status).toBe("pending");
    expect(s.offers.latestPending(t.id)?.id).toBe(a.id);
    expect(s.offers.decide(a.id, "accepted")).toBe(true);
    expect(s.offers.decide(a.id, "declined")).toBe(false);
    expect(() => s.db.prepare("UPDATE offers SET status = 'declined' WHERE id = ?").run(a.id)).toThrow(
      /final/,
    );
    expect(() => s.db.prepare("UPDATE offers SET text = 'x' WHERE id = ?").run(a.id)).toThrow(/rewritten/);
    const b = s.offers.add({
      botId: bot,
      source: "addon:proactive",
      category: "errand",
      text: "x",
      evidence: ["cal:1"],
      queued: true,
    });
    expect(b.queued).toBe(true);
    expect(b.shownAt).toBeNull();
    expect(s.offers.evidenceUsed(bot, "cal:1")).toBe(true);
    expect(s.offers.evidenceUsed(bot, "cal:2")).toBe(false);
    expect(s.offers.markShown(b.id)).toBe(true);
    s.offers.decide(b.id, "declined");
    const since = new Date(Date.now() - 86_400_000);
    expect(s.offers.stats(bot, "project", since)).toEqual({ accepted: 1, declined: 0, ignored: 0, total: 1 });
    expect(s.offers.stats(bot, undefined, since).total).toBe(2);
    expect(s.offers.shownSince(bot, "addon:proactive", since)).toBe(1);
    s.close();
  });

  it("pending offers go ignored after the window and expired past their deadline", () => {
    const s = openStore(":memory:");
    const bot = s.bots.default()!.id;
    const old = s.offers.add(
      { botId: bot, source: "chat_end", category: "other", text: "a" },
      new Date("2026-11-01T00:00:00Z"),
    );
    const due = s.offers.add({
      botId: bot,
      source: "addon:proactive",
      category: "errand",
      text: "b",
      dueAt: "2026-11-02T00:00:00Z",
    });
    expect(s.offers.ignoreStale(new Date("2026-11-02T00:00:00Z"), "chat_end").map((o) => o.id)).toEqual([
      old.id,
    ]);
    expect(s.offers.expireOverdue(new Date("2026-11-03T00:00:00Z")).map((o) => o.id)).toEqual([due.id]);
    s.close();
  });

  it("memories carry applies_to and due_at, set on insert only", () => {
    const s = openStore(":memory:");
    const bot = s.bots.default()!.id;
    const source = { kind: "chat" as const };
    const m = s.memory.add({
      botId: bot,
      scope: "shared",
      kind: "preference",
      body: "寫信不要提到自己的學校",
      origin: "user",
      confidence: 1,
      source,
      appliesTo: ["send_message", "send_message"],
    });
    expect(m.appliesTo).toEqual(["send_message"]);
    s.memory.add({
      botId: bot,
      scope: "bot",
      kind: "project",
      body: "下週三交報告",
      origin: "inferred",
      confidence: 0.6,
      source,
      dueAt: "2026-11-11T09:00:00.000Z",
    });
    expect(s.memory.applying(bot, ["send_message"]).map((x) => x.id)).toEqual([m.id]);
    expect(s.memory.applying(bot, ["purchase"])).toEqual([]);
    expect(
      s.memory.dueBetween(bot, new Date("2026-11-10T00:00:00Z"), new Date("2026-11-12T00:00:00Z")),
    ).toHaveLength(1);
    expect(() => s.db.prepare("UPDATE memories SET applies_to = '[]' WHERE id = ?").run(m.id)).toThrow();
    s.close();
  });
});
