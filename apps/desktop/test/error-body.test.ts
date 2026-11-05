// G2 batch 5 (R9.3): an error answer carries its i18n key and params when the
// text is one of the table's core.* texts; other text goes out as before.
import { tSource } from "@alca/design/i18n";
import { describe, expect, it } from "vitest";
import { errorBody } from "../src/http.ts";

describe("errorBody", () => {
  it("adds code and params to a table text", () => {
    expect(errorBody(tSource("core.team.nameTaken", { name: "A" }))).toEqual({
      error: "已經有叫「A」的 bot 了",
      code: "core.team.nameTaken",
      params: { name: "A" },
    });
  });
  it("leaves any other text as it was", () => {
    expect(errorBody("body too large")).toEqual({ error: "body too large" });
  });
});
