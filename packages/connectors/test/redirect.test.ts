import { describe, expect, it } from "vitest";
import { safeRedirect } from "../src/index.ts";

describe("Connect Link check", () => {
  it("lets only https (or a loopback stand-in) through", () => {
    expect(safeRedirect("https://connect.composio.dev/link/abc")).toBe(true);
    expect(safeRedirect("http://127.0.0.1:5000/connect/x")).toBe(true);
    expect(safeRedirect("javascript:alert(1)")).toBe(false);
    expect(safeRedirect("data:text/html,<script>1</script>")).toBe(false);
    expect(safeRedirect("http://evil.example/connect")).toBe(false);
    expect(safeRedirect("not a url")).toBe(false);
  });
});
