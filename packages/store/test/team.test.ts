import { describe, expect, it } from "vitest";
import { openStore } from "../src/index.ts";

describe("team (migration 8)", () => {
  it("bot profiles: edit, lead, archive (never the default), find by name", () => {
    const s = openStore(":memory:");
    const def = s.bots.default()!;
    const b = s.bots.create("研究員", { role: "查資料", color: "jade", avatar: "研" });
    expect(b).toMatchObject({
      role: "查資料",
      color: "jade",
      avatar: "研",
      memoryMode: "team",
      browserProfile: "shared",
    });
    const e = s.bots.update(b.id, {
      approvalLevel: "autonomous",
      memoryMode: "own",
      instructions: "只用繁體中文",
    });
    expect(e).toMatchObject({ approvalLevel: "autonomous", memoryMode: "own", instructions: "只用繁體中文" });
    expect(e.updatedAt).not.toBeNull();
    expect(() => s.bots.update(b.id, { color: "pink" as never })).toThrow();
    expect(s.bots.find("@研究員")?.id).toBe(b.id);
    s.bots.setLead(b.id);
    expect(s.bots.lead()?.id).toBe(b.id);
    s.bots.setLead(def.id);
    expect(s.bots.lead()?.id).toBe(def.id);
    expect(() => s.bots.archive(def.id)).toThrow(/default bot/);
    expect(s.bots.archive(b.id)).toBe(true);
    expect(s.bots.list().map((x) => x.id)).toEqual([def.id]);
    expect(s.bots.all()).toHaveLength(2);
    expect(() => s.bots.setLead(b.id)).toThrow(/archived/);
    expect(s.bots.restore(b.id)).toBe(true);
    s.close();
  });

  it("team rules have safe defaults and reject out-of-range values", () => {
    const s = openStore(":memory:");
    expect(s.team.rules()).toEqual({ peerApproval: "ask_delegate", maxDepth: 2, maxOpen: 4 });
    expect(s.team.setRules({ peerApproval: "auto", maxDepth: 3 })).toMatchObject({
      peerApproval: "auto",
      maxDepth: 3,
    });
    expect(() => s.team.setRules({ maxDepth: 9 })).toThrow();
    expect(() => s.team.setRules({ peerApproval: "never" as never })).toThrow();
    s.close();
  });

  it("peer requests: who asked whom is fixed, a finished one is final, events are append-only", () => {
    const s = openStore(":memory:");
    const a = s.bots.default()!;
    const b = s.bots.create("寫手");
    const t = s.threads.create("thr_01ARZ3NDEKTSV4RRFFQ69G5FAV", "x", new Date(), a.id);
    const r = s.team.createRequest({
      kind: "delegate",
      fromBotId: a.id,
      toBotId: b.id,
      fromThreadId: t.id,
      fromRunId: null,
      rootThreadId: t.id,
      parentId: null,
      depth: 1,
      chain: [a.id],
      text: "寫稿",
      status: "running",
      initiator: { kind: "agent", id: a.id },
    });
    expect(r.id).toMatch(/^peer_/);
    expect(() =>
      s.db.prepare("UPDATE peer_requests SET to_bot_id = ? WHERE id = ?").run(a.id, r.id),
    ).toThrow();
    expect(s.team.finish(r.id, "done", { result: "好了" })).toBe(true);
    expect(s.team.finish(r.id, "failed", {})).toBe(false);
    expect(() =>
      s.db.prepare("UPDATE peer_requests SET status = 'running' WHERE id = ?").run(r.id),
    ).toThrow();
    const ev = s.team.addEvent({ requestId: r.id, kind: "answered", botId: b.id });
    expect(() => s.db.prepare("DELETE FROM peer_events WHERE id = ?").run(ev.id)).toThrow(/append-only/);
    expect(() => s.team.createRequest({ ...r, toBotId: a.id, status: "running" } as never)).toThrow();
    s.close();
  });
});
