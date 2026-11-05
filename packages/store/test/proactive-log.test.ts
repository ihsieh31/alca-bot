import { describe, expect, it } from "vitest";
import { openStore, SEALED } from "../src/index.ts";

// Gap analysis 2026-11 P14: 主動留意's per-candidate log (migration 29).

const row = (o: Record<string, unknown> = {}) => ({
  botId: "bot_1",
  scanId: "scan_1",
  via: "scan" as const,
  category: "study",
  sources: ["calendar", "mail", "Not A Word!"],
  evidenceN: 2,
  timeliness: 0.86154,
  relevance: 0.5,
  doable: 1,
  acceptance: 0.5,
  total: 0.6012,
  outcome: "dropped" as const,
  dropReason: "below_threshold",
  dueInHours: 71.94,
  ...o,
});

describe("proactive_candidates", () => {
  it("keeps numbers and fixed words only; updates, summary and prune", () => {
    const s = openStore(":memory:");
    const now = new Date("2026-11-05T00:00:00.000Z");
    const a = s.proactiveLog.add(row(), now);
    const b = s.proactiveLog.add(row({ scanId: "scan_2", outcome: "homework", dropReason: null }), now);
    s.proactiveLog.update(b, { outcome: "queued", offerId: "off_1" }, now);
    expect(s.proactiveLog.get(a)).toMatchObject({
      sources: ["calendar", "mail"],
      timeliness: 0.862,
      total: 0.601,
      dueInHours: 71.9,
      dropReason: "below_threshold",
    });
    expect(s.proactiveLog.byOffer("off_1")?.id).toBe(b);
    expect(s.proactiveLog.summary("bot_1", new Date(0))).toEqual({
      candidates: 2,
      scans: 2,
      outcomes: { dropped: 1, queued: 1 },
      dropped: { below_threshold: 1 },
    });
    // No column that could hold the person's words.
    const cols = (
      s.db.prepare("PRAGMA table_info(proactive_candidates)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    for (const bad of ["fact", "action", "text", "title", "evidence", "evidence_json", "topic"])
      expect(cols).not.toContain(bad);
    expect(SEALED.proactive_candidates).toBeUndefined();
    expect(s.proactiveLog.prune(new Date("2026-11-06T00:00:00.000Z"))).toBe(2);
    expect(s.proactiveLog.list("bot_1", new Date(0))).toEqual([]);
    s.close();
  });

  it("an unknown outcome is refused by the table", () => {
    const s = openStore(":memory:");
    expect(() => s.proactiveLog.add(row({ outcome: "maybe" as never }))).toThrow();
    s.close();
  });
});
