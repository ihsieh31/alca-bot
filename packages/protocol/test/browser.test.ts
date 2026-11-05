import { describe, expect, it } from "vitest";
import { BrowserChannelEmitter, BrowserEventSchema, newId, SpaceFrame } from "../src/index.ts";

describe("browser channel", () => {
  const space = {
    spaceId: newId("space"),
    botId: newId("bot"),
    title: "查訂單",
    profile: "shared" as const,
    persistent: false,
    controller: "agent" as const,
    status: "idle" as const,
    tabs: [{ tabId: newId("tab"), title: "首頁", url: "https://example.test/", loading: false }],
  };
  it("sequences validated events and rejects unknown keys", () => {
    const em = new BrowserChannelEmitter(() => new Date("2026-11-03T01:00:00Z"));
    const a = em.emit("space.updated", { space });
    const b = em.emit("space.control", {
      spaceId: space.spaceId,
      botId: space.botId,
      controller: "user",
      by: { kind: "user", id: "desktop" },
      reason: "接手",
    });
    expect([a.seq, b.seq]).toEqual([0, 1]);
    expect(BrowserEventSchema.safeParse({ ...a, extra: 1 }).success).toBe(false);
    expect(() =>
      em.emit("space.updated", { space: { ...space, controller: "robot" as unknown as "agent" } }),
    ).toThrow();
  });
  it("frames carry a tab id and base64 data", () => {
    const ok = SpaceFrame.safeParse({
      v: 0,
      type: "space.frame",
      spaceId: space.spaceId,
      botId: space.botId,
      tabId: space.tabs[0]?.tabId,
      mime: "image/jpeg",
      data: "AAAA",
      width: 800,
      height: 600,
    });
    expect(ok.success).toBe(true);
  });
});
