// R9.6 (migration 26): a bot's rules language — auto by default, zh / en pinned, nothing else.
import { describe, expect, it } from "vitest";
import { openStore } from "../src/index.ts";

describe("bots.language", () => {
  it("defaults to auto, keeps zh / en, and the column refuses anything else", () => {
    const s = openStore(":memory:");
    const b = s.bots.create("小幫手");
    expect(b.language).toBe("auto");
    expect(s.bots.update(b.id, { language: "en" }).language).toBe("en");
    expect(s.bots.get(b.id)?.language).toBe("en");
    expect(s.bots.update(b.id, { language: "zh" }).language).toBe("zh");
    expect(() => s.db.prepare("UPDATE bots SET language = 'fr' WHERE id = ?").run(b.id)).toThrow(/CHECK/);
    s.close();
  });
});
