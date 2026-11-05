import { describe, expect, it } from "vitest";
import { unwrapCatalogCall } from "../src/learning.ts";

describe("learning × lazy catalog", () => {
  it("a tool_call step is learned as the inner tool with its own arguments", () => {
    expect(unwrapCatalogCall("tool_call", { name: "write_note", arguments: { title: "週報" } })).toEqual({
      tool: "write_note",
      args: { title: "週報" },
    });
  });

  it("odd arguments fall back to an empty object; other tools pass through", () => {
    expect(unwrapCatalogCall("tool_call", { name: "read_note", arguments: [1] })).toEqual({
      tool: "read_note",
      args: {},
    });
    expect(unwrapCatalogCall("tool_call", {})).toEqual({ tool: "tool_call", args: {} });
    expect(unwrapCatalogCall("read_note", { title: "a" })).toEqual({
      tool: "read_note",
      args: { title: "a" },
    });
  });
});
