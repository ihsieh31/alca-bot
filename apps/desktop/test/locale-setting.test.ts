// G2 (R9.3): advanced.locale takes only auto / zh-Hant-TW / en; anything else
// is refused when saved, and a value that still reaches a reader means 繁中.
import { SettingsSchema } from "@alca/config";
import { resolveLocale } from "@alca/design/i18n";
import { describe, expect, it } from "vitest";

describe("advanced.locale", () => {
  it("accepts the three choices, defaulting to auto", () => {
    expect(SettingsSchema.parse({}).advanced.locale).toBe("auto");
    for (const l of ["auto", "zh-Hant-TW", "en"] as const)
      expect(SettingsSchema.parse({ advanced: { locale: l } }).advanced.locale).toBe(l);
  });
  it("refuses any other value", () => {
    for (const l of ["fr", "EN", "zh", "", 1]) {
      const r = SettingsSchema.safeParse({ advanced: { locale: l } });
      expect(r.success, String(l)).toBe(false);
    }
  });
  it("a value that is not a choice follows the system; C/POSIX/unknown systems stay 繁中", () => {
    expect(resolveLocale("fr", "en-US")).toBe("en");
    expect(resolveLocale("fr", undefined)).toBe("zh-Hant-TW");
    expect(resolveLocale("auto", "zh-TW")).toBe("zh-Hant-TW");
  });
});
