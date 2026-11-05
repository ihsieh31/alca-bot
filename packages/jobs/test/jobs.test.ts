import { describe, expect, it } from "vitest";
import { canAutoRetry, canTransition } from "../src/index.ts";

const failed = { status: "failed" as const, attempt: 1, outboundObserved: false };

describe("job model", () => {
  it("terminal states are final", () => {
    expect(canTransition("queued", "running")).toBe(true);
    expect(canTransition("succeeded", "running")).toBe(false);
    expect(canTransition("cancelled", "queued")).toBe(false);
  });

  it("never auto-retries after outbound activity", () => {
    expect(canAutoRetry(failed)).toBe(true);
    expect(canAutoRetry({ ...failed, outboundObserved: true })).toBe(false);
    expect(canAutoRetry({ ...failed, attempt: 3 })).toBe(false);
  });
});
