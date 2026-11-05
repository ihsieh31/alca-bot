import {
  APPROVAL_LEVELS,
  BOT_LEVEL_CHOICES,
  effectiveLevel,
  LEVEL_WORDS,
  nativeLevel,
  parseSettings,
  strictestLevel,
} from "@alca/config";
import { PROVIDERS } from "@alca/engines";
import { describe, expect, it } from "vitest";
import { uiText } from "./ui-text.ts";

/** P13: one approval-level vocabulary across config, bots, engines and both UIs. */
describe("approval levels", () => {
  it("resolve a bot's choice and a chain", () => {
    expect(effectiveLevel(null, "autonomous")).toBe("autonomous");
    expect(effectiveLevel("team", "confirm_each_step")).toBe("confirm_each_step");
    expect(effectiveLevel("autonomous", "confirm_each_step")).toBe("autonomous");
    expect(strictestLevel(["autonomous", "confirm_each_step"], "autonomous")).toBe("confirm_each_step");
    expect(strictestLevel([], "autonomous")).toBe("autonomous");
  });

  it("Phase 5: full access is a bot's own level only — never a team level; a chain takes the strictest", () => {
    expect(APPROVAL_LEVELS).not.toContain("full_access");
    expect(BOT_LEVEL_CHOICES).toContain("full_access");
    expect(() => parseSettings({ permissions: { level: "full_access" } })).toThrow();
    expect(effectiveLevel(null, "autonomous")).toBe("autonomous");
    expect(effectiveLevel("full_access", "confirm_each_step")).toBe("full_access");
    expect(strictestLevel(["full_access", "autonomous"], "full_access")).toBe("autonomous");
    expect(strictestLevel(["full_access"], "confirm_each_step")).toBe("full_access");
    expect(nativeLevel("full_access")).toBe("autonomous");
  });

  it("engines map exactly the config levels (no stray 'default' or 'team' key)", () => {
    for (const p of PROVIDERS)
      for (const k of Object.keys(p.modes ?? {})) expect(APPROVAL_LEVELS, `${p.id}: ${k}`).toContain(k);
  });

  it("the desktop and phone word tables carry the same choices and words", () => {
    for (const file of ["apps/desktop/ui/api-team.ts", "apps/phone-pwa/app/team-view.ts"]) {
      const src = uiText(file); // G2: words through the string table
      const table = src.slice(src.indexOf("LEVEL_WORD"), src.indexOf("};", src.indexOf("LEVEL_WORD")));
      for (const c of BOT_LEVEL_CHOICES)
        expect(table, `${file}: ${c}`).toContain(`${c}: "${LEVEL_WORDS[c]}"`);
    }
  });
});
