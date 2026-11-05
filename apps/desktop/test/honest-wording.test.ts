// Mac test 2026-11-04b: UI text that promised "always asks" without saying which actions.
// The honest version: what Alca recognizes as payment / send / delete / publish always asks;
// everything else follows the level.
import { describe, expect, it } from "vitest";
import { uiText } from "./ui-text.ts";

// G2: the words live in the string table; uiText shows each t("key") as its text.
const read = uiText;
const FILES = [
  "apps/desktop/ui/bot-edit.ts",
  "apps/desktop/ui/workers.ts",
  "apps/desktop/ui/team.ts",
  "apps/phone-pwa/app/bot-form.ts",
];

describe("level wording", () => {
  it.each(FILES)(
    "%s: an always-ask promise names what Alca recognizes and that the rest follows the level",
    (f) => {
      const src = read(f);
      const promises = [...src.matchAll(/"[^"\n]*付款、寄送、刪除、發布[^"\n]*一律先問你[^"\n]*"/g)].map(
        (m) => m[0],
      );
      expect(promises.length, f).toBeGreaterThan(0);
      for (const p of promises) {
        expect(p, f).toContain("Alca 認得的");
        expect(p, f).toMatch(/其他動作依/);
      }
    },
  );

  it("no unqualified promise is left", () => {
    for (const f of FILES) expect(read(f), f).not.toMatch(/"付款、寄送、刪除、發布(不管|一律)/);
  });
});
