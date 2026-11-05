import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hashIntents, ModalStack, modalKey } from "../ui/modal-keys.ts";

const base = { open: true, nativeDialog: false, count: 3, active: 1, inside: true };

describe("overlay dialogs: Esc and Tab (mac test 2026-11-04b A7)", () => {
  it("Esc closes the top dialog wherever focus is, even outside the sheet", () => {
    expect(modalKey("Escape", false, base)).toEqual({ kind: "close" });
    expect(modalKey("Escape", false, { ...base, inside: false, active: -1 })).toEqual({ kind: "close" });
  });

  it("does nothing with no overlay open, or with a native <dialog> on top", () => {
    expect(modalKey("Escape", false, { ...base, open: false })).toEqual({ kind: "none" });
    expect(modalKey("Escape", false, { ...base, nativeDialog: true })).toEqual({ kind: "none" });
    expect(modalKey("Tab", false, { ...base, nativeDialog: true, active: 2 })).toEqual({ kind: "none" });
  });

  it("Tab wraps from the last control to the first, Shift+Tab from the first to the last", () => {
    expect(modalKey("Tab", false, { ...base, active: 2 })).toEqual({ kind: "focus", target: "first" });
    expect(modalKey("Tab", true, { ...base, active: 0 })).toEqual({ kind: "focus", target: "last" });
    expect(modalKey("Tab", false, base)).toEqual({ kind: "none" });
    expect(modalKey("Tab", true, base)).toEqual({ kind: "none" });
  });

  it("Tab from outside the sheet (focus left on the sidebar button) pulls focus in", () => {
    const out = { ...base, inside: false, active: -1 };
    expect(modalKey("Tab", false, out)).toEqual({ kind: "focus", target: "first" });
    expect(modalKey("Tab", true, out)).toEqual({ kind: "focus", target: "last" });
  });

  it("a sheet with no controls keeps focus on itself; other keys pass through", () => {
    expect(modalKey("Tab", false, { ...base, count: 0, active: -1 })).toEqual({
      kind: "focus",
      target: "sheet",
    });
    expect(modalKey("a", false, base)).toEqual({ kind: "none" });
    expect(modalKey("Enter", false, base)).toEqual({ kind: "none" });
  });

  it("the stack closes newest first, and a pop runs once", () => {
    const s = new ModalStack<string>();
    const popA = s.push("providers");
    const popB = s.push("bot editor");
    expect(s.top()).toBe("bot editor");
    expect(popB()).toBe(true);
    expect(popB()).toBe(false);
    expect(s.top()).toBe("providers");
    expect(popA()).toBe(true);
    expect(s.top()).toBeUndefined();
    expect(s.size).toBe(0);
  });

  it("模型與供應商 and the bot editor go through trapDialog, not a key handler on the overlay", () => {
    for (const f of ["apps/desktop/ui/providers.ts", "apps/desktop/ui/bot-edit.ts"]) {
      const src = readFileSync(f, "utf8");
      expect(src, f).toContain("trapDialog(");
      expect(src, f).toContain("this.untrap?.()");
      expect(src, f).not.toMatch(/overlay\.addEventListener\("keydown"/);
    }
  });
});

describe("the address opens a dialog (mac test 2026-11-04b B0)", () => {
  it("reads open=settings next to the token, with or without an area", () => {
    expect(hashIntents("#token=abc123&open=settings").settings).toBe("");
    expect(hashIntents("#token=abc123&open=settings:advanced").settings).toBe("advanced");
    expect(hashIntents("#open=settings:devices&x=1").settings).toBe("devices");
    expect(hashIntents("#token=abc123").settings).toBeNull();
    expect(hashIntents("#open=settingsx").settings).toBeNull();
  });

  it("reads pair and providers the same way", () => {
    expect(hashIntents("#token=abc&open=pair")).toEqual({ pair: true, providers: false, settings: null });
    expect(hashIntents("#open=providers&token=abc")).toEqual({
      pair: false,
      providers: true,
      settings: null,
    });
    expect(hashIntents("").pair).toBe(false);
  });

  it("app.ts reads the address before takeToken() clears it, and opens 設定 after its hooks are set", () => {
    const src = readFileSync("apps/desktop/ui/app.ts", "utf8");
    const read = src.indexOf("hashIntents(location.hash)");
    const take = src.indexOf("= takeToken()");
    expect(read).toBeGreaterThan(0);
    expect(read).toBeLessThan(take);
    const hook = src.indexOf("settingsDlg.hooks.openProviders =");
    const open = src.indexOf("settingsDlg.open(intents.settings");
    expect(hook).toBeGreaterThan(0);
    expect(open).toBeGreaterThan(hook);
  });
});
