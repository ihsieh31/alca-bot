// BUG-9 / BUG-11: the keyboard and rotation (viewport.ts, pure part).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isEditable, KB_MIN, NO_KEYBOARD, sameState, viewportState } from "../app/viewport-calc.ts";

const base = { layoutHeight: 852, vvHeight: 852, vvOffsetTop: 0, vvScale: 1, editing: false };

describe("phone viewport: keyboard and rotation", () => {
  it("no field focused → no keyboard, whatever the visual viewport says (a stale value after rotation)", () => {
    expect(viewportState({ ...base, vvHeight: 500 })).toEqual(NO_KEYBOARD);
    expect(viewportState({ ...base, vvHeight: 500, vvOffsetTop: 300 })).toEqual(NO_KEYBOARD);
  });

  it("iOS keeps the layout viewport: the app takes the visual height above the keyboard", () => {
    expect(viewportState({ ...base, vvHeight: 516, editing: true })).toEqual({
      kb: 336,
      height: 516,
      top: 0,
    });
  });

  it("iOS pans the visual viewport: the app follows the pan (the old formula gave ~0 here)", () => {
    // Old: innerHeight − vv.height − vv.offsetTop = 852 − 516 − 336 = 0 → dock under the keyboard.
    expect(viewportState({ ...base, vvHeight: 516, vvOffsetTop: 336, editing: true })).toEqual({
      kb: 336,
      height: 516,
      top: 336,
    });
    // A pan can never exceed the keyboard (overscroll readings are clamped).
    expect(viewportState({ ...base, vvHeight: 516, vvOffsetTop: 400, editing: true }).top).toBe(336);
    expect(viewportState({ ...base, vvHeight: 516, vvOffsetTop: -20, editing: true }).top).toBe(0);
  });

  it("resizes-content: the browser shrank the layout viewport, so the keyboard counts as 0", () => {
    expect(viewportState({ ...base, layoutHeight: 516, vvHeight: 516, editing: true })).toEqual(NO_KEYBOARD);
  });

  it("small differences (toolbars, rounding) and pinch-zoom are not a keyboard", () => {
    expect(viewportState({ ...base, vvHeight: 852 - (KB_MIN - 1), editing: true })).toEqual(NO_KEYBOARD);
    expect(viewportState({ ...base, vvHeight: 400, vvScale: 2, editing: true })).toEqual(NO_KEYBOARD);
    expect(viewportState({ ...base, vvHeight: undefined, editing: true })).toEqual(NO_KEYBOARD);
  });

  it("landscape: the same rule with the landscape heights; back to portrait without a field → full screen", () => {
    expect(
      viewportState({ layoutHeight: 393, vvHeight: 180, vvOffsetTop: 0, vvScale: 1, editing: true }),
    ).toEqual({
      kb: 213,
      height: 180,
      top: 0,
    });
    expect(viewportState({ ...base, editing: false })).toEqual(NO_KEYBOARD);
  });

  it("knows which elements bring up the keyboard", () => {
    expect(isEditable({ tagName: "TEXTAREA" })).toBe(true);
    expect(isEditable({ tagName: "INPUT", type: "text" })).toBe(true);
    expect(isEditable({ tagName: "INPUT", type: "search" })).toBe(true);
    expect(isEditable({ tagName: "INPUT" })).toBe(true);
    expect(isEditable({ tagName: "INPUT", type: "checkbox" })).toBe(false);
    expect(isEditable({ tagName: "INPUT", type: "text", readOnly: true })).toBe(false);
    expect(isEditable({ tagName: "BUTTON" })).toBe(false);
    expect(isEditable({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isEditable({ tagName: "DIV" })).toBe(false);
    expect(isEditable(null)).toBe(false);
  });

  it("compares states", () => {
    expect(sameState(NO_KEYBOARD, { kb: 0, height: undefined, top: 0 })).toBe(true);
    expect(sameState(NO_KEYBOARD, { kb: 300, height: 500, top: 0 })).toBe(false);
  });

  it("one module owns the viewport: the dock no longer adds a keyboard margin, #app and the sheets follow --vvh/--vvt", () => {
    const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
    expect(read("styles/chat.css")).not.toContain("--kb");
    expect(read("styles/device.css")).not.toContain("--kb");
    // Review #19: nothing reads --kb, so nothing writes it either.
    expect(read("app/viewport.ts")).not.toContain("--kb");
    expect(read("app/chat.ts")).not.toMatch(/visualViewport/);
    expect(read("app/device.ts")).not.toMatch(/visualViewport/);
    expect(read("styles/base.css")).toMatch(
      /#app \{[^}]*top: var\(--vvt, 0px\);[^}]*height: var\(--vvh, auto\);/,
    );
    expect(read("styles/sheet.css")).toMatch(
      /\.sheet-layer \{[^}]*top: var\(--vvt, 0px\);[^}]*height: var\(--vvh, auto\);/,
    );
  });
});
