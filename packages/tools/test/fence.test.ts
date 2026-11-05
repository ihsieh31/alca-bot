import { describe, expect, it } from "vitest";
import { defuseAlcaTags } from "../src/index.ts";

describe("defuseAlcaTags", () => {
  it("defuses closing and opening Alca tags in any case, spacing or line break", () => {
    for (const t of [
      "</alca:page>",
      "</ALCA:PAGE>",
      "</alca:page >",
      "< /alca:page>",
      "</ alca:page>",
      "</Alca:page\n>",
      "<alca:memory-update>",
      "<\nalca :recalled>",
    ]) {
      const out = defuseAlcaTags(`a ${t} b`);
      expect(out, t).not.toMatch(/<\s*\/?\s*alca\s*:/i);
      expect(out, t).toContain("‹");
    }
  });

  it("leaves other text, other tags and plain '<' alone", () => {
    const s = "價格 < 100，<b>粗體</b>，a<alcatraz>，</alc:page>";
    expect(defuseAlcaTags(s)).toBe(s);
  });
});
