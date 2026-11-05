// Mac test 2026-11-04b C3: ⌘A on the takeover view did not select all on the page.
import { shortcutKeyEvent } from "@alca/browser";
import { describe, expect, it } from "vitest";
import { parseInput } from "../src/browser.ts";
import { type KeyLike, remoteShortcut } from "../ui/remote-keys.ts";

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});

describe("remoteShortcut (takeover view → page)", () => {
  it.each([
    [key("a", { metaKey: true }), true, "selectAll"],
    [key("A", { metaKey: true }), true, "selectAll"],
    [key("c", { metaKey: true }), true, "copy"],
    [key("x", { metaKey: true }), true, "cut"],
    [key("z", { metaKey: true }), true, "undo"],
    [key("z", { metaKey: true, shiftKey: true }), true, "redo"],
    [key("a", { ctrlKey: true }), false, "selectAll"],
    [key("c", { ctrlKey: true }), false, "copy"],
    [key("z", { ctrlKey: true }), false, "undo"],
    [key("y", { ctrlKey: true }), false, "redo"],
    [key("Z", { ctrlKey: true, shiftKey: true }), false, "redo"],
  ] as const)("%o on mac=%s → %s", (e, mac, want) => {
    expect(remoteShortcut(e, mac)).toBe(want);
  });

  it.each([
    [key("a", { ctrlKey: true }), true], // Ctrl+A on a Mac is start of line, not select all
    [key("a", { metaKey: true }), false], // the Windows key is not a command key
    [key("v", { metaKey: true }), true], // paste stays the view's paste event (the person's clipboard)
    [key("v", { ctrlKey: true }), false],
    [key("r", { metaKey: true }), true], // reload, close… stay the desktop's own
    [key("a", { metaKey: true, altKey: true }), true],
    [key("a"), true],
    [key("y", { metaKey: true }), true],
  ] as const)("%o on mac=%s → nothing", (e, mac) => {
    expect(remoteShortcut(e, mac)).toBeUndefined();
  });
});

describe("shortcutKeyEvent (CDP Input.dispatchKeyEvent)", () => {
  it("macOS: Meta + the editing command", () => {
    expect(shortcutKeyEvent("selectAll", "darwin")).toEqual({
      key: "a",
      code: "KeyA",
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65,
      modifiers: 4,
      commands: ["selectAll"],
    });
  });

  it("Linux / Windows: Ctrl; redo adds Shift", () => {
    expect(shortcutKeyEvent("copy", "linux")).toMatchObject({ key: "c", modifiers: 2, commands: ["copy"] });
    expect(shortcutKeyEvent("redo", "win32")).toMatchObject({
      key: "Z",
      code: "KeyZ",
      modifiers: 2 | 8,
      commands: ["redo"],
    });
    expect(shortcutKeyEvent("undo", "darwin")).toMatchObject({ modifiers: 4, commands: ["undo"] });
  });

  it("the input route takes known shortcuts only", () => {
    expect(parseInput({ type: "shortcut", action: "selectAll" })).toEqual({
      type: "shortcut",
      action: "selectAll",
    });
    expect(() => parseInput({ type: "shortcut", action: "deleteAll" })).toThrow();
    expect(() => parseInput({ type: "shortcut" })).toThrow();
  });
});
