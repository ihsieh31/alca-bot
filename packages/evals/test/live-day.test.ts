import { describe, expect, it } from "vitest";
import { localDay } from "../src/live.ts";

/** Mac test 2026-11 B11: the live eval report is named for the local day, not the UTC one. */
describe("localDay", () => {
  it("uses the local calendar date", () => {
    const d = new Date(2026, 10, 5, 7, 30);
    expect(localDay(d)).toBe("2026-11-05");
    expect(localDay(new Date(2026, 0, 1, 0, 5))).toBe("2026-01-01");
  });
});
