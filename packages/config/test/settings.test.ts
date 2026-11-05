import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALWAYS_CONFIRM_ACTIONS,
  defaultSettings,
  loadSettingsFile,
  parseSettings,
  REMOVED_KEYS,
  requiresConfirmation,
  SETTINGS_PAGES,
  SettingsError,
  SettingsSchema,
  userFacingSettings,
} from "../src/index.ts";

describe("settings pages", () => {
  it("has exactly 5 user-facing pages, only 進階 collapsed", () => {
    expect(SETTINGS_PAGES.map((p) => p.title)).toEqual(["模型", "連接", "權限", "裝置", "進階"]);
    expect(SETTINGS_PAGES.filter((p) => p.collapsed).map((p) => p.id)).toEqual(["advanced"]);
  });

  it("pages map 1:1 onto the schema's user-facing sections; engineering is hidden", () => {
    const keys = Object.keys(SettingsSchema.shape).filter((k) => k !== "version" && k !== "engineering");
    expect(SETTINGS_PAGES.map((p) => p.id).sort()).toEqual(keys.sort());
    const ui = userFacingSettings(defaultSettings());
    expect(Object.keys(ui)).toHaveLength(5);
    expect("engineering" in ui).toBe(false);
  });
});

describe("defaults", () => {
  it("everything has a safe default", () => {
    const s = defaultSettings();
    expect(s.permissions.level).toBe("confirm_each_step");
    expect(s.engineering.bindHost).toBe("127.0.0.1");
    expect(s.devices.defaultScopes).toEqual(["chat", "approve"]);
    expect(s.devices.pushPreview).toBe("notify_only");
    expect(s.advanced.learning).toBe(true);
    expect(s.engineering.loopGuard).toEqual({ warnAfterRepeats: 3, hardStopAfterRepeats: 6 });
    expect(s.models.engines[0]?.id).toBe("claude-code");
  });

  it("partial input is merged with defaults", () => {
    const s = parseSettings({ permissions: { level: "autonomous" }, engineering: { port: 9000 } });
    expect(s.permissions.level).toBe("autonomous");
    expect(s.engineering.port).toBe(9000);
    expect(s.engineering.pairingCodeTtlSec).toBe(120);
  });
});

describe("validation", () => {
  it("rejects unknown keys, bad levels and bad values", () => {
    expect(() => parseSettings({ themes: {} })).toThrow(SettingsError);
    expect(() => parseSettings({ permissions: { level: "full_access" } })).toThrow(SettingsError);
    expect(() => parseSettings({ engineering: { port: 70000 } })).toThrow(SettingsError);
    expect(() => parseSettings({ advanced: { rendezvousUrl: "http://plain.example" } })).toThrow(
      SettingsError,
    );
    expect(() =>
      parseSettings({ engineering: { loopGuard: { warnAfterRepeats: 5, hardStopAfterRepeats: 5 } } }),
    ).toThrow(SettingsError);
  });

  it("never lets remote control be a default device scope", () => {
    expect(() => parseSettings({ devices: { defaultScopes: ["chat", "control_computer"] } })).toThrow(
      /control_computer/,
    );
  });

  it("loads config.json, treating a missing file as defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "alca-cfg-"));
    try {
      expect(loadSettingsFile(join(dir, "missing.json"))).toEqual(defaultSettings());
      const p = join(dir, "config.json");
      writeFileSync(p, JSON.stringify({ advanced: { learning: false } }));
      expect(loadSettingsFile(p).advanced.learning).toBe(false);
      writeFileSync(p, "{oops");
      expect(() => loadSettingsFile(p)).toThrow(SettingsError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("keys earlier versions wrote (P13 B1)", () => {
  it("an old config.json with removed keys still opens; each one is a warning; other unknown keys still fail", () => {
    const dir = mkdtempSync(join(tmpdir(), "alca-cfg-old-"));
    try {
      const p = join(dir, "config.json");
      writeFileSync(
        p,
        JSON.stringify({
          models: { defaultEngine: "claude-code", suggestFallbackOnQuota: true },
          connections: { accounts: [] },
          permissions: { level: "autonomous" },
          advanced: { dataDir: "/x", learning: false },
          engineering: {
            engineIdleShutdownSec: 1800,
            promptCacheKeepWarmSec: 0,
            offlineMailboxHours: 24,
            // PAKE v1 removed: an old escape hatch is dropped with a warning, never honoured.
            link: { pakeV1: "allow" },
          },
        }),
      );
      const warned: string[] = [];
      const s = loadSettingsFile(p, (l) => warned.push(l));
      expect(s.permissions.level).toBe("autonomous");
      expect(s.advanced.learning).toBe(false);
      expect(warned).toHaveLength(REMOVED_KEYS.length);
      expect(warned.join("\n")).toContain("models.defaultEngine");
      writeFileSync(p, JSON.stringify({ permissions: { alwaysConfirm: [] } }));
      expect(() => loadSettingsFile(p, () => undefined)).toThrow(SettingsError);
      expect(() => parseSettings({ models: { defaultEngine: "x" } })).toThrow(SettingsError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("always-confirm actions cannot be disabled", () => {
  it("there is no settings key that could switch them off", () => {
    for (const attempt of [
      { permissions: { alwaysConfirm: [] } },
      { permissions: { level: "autonomous", payment: false } },
      { permissions: { level: "autonomous", overrides: { send: "allow" } } },
      { advanced: { alwaysConfirm: [] } },
      { engineering: { alwaysConfirm: [] } },
      { alwaysConfirm: [] },
    ]) {
      expect(() => parseSettings(attempt)).toThrow(SettingsError);
    }
  });

  it("payment/send/delete/publish need confirmation even when autonomous", () => {
    const autonomous = parseSettings({ permissions: { level: "autonomous" } });
    for (const a of ["payment", "send", "delete", "publish"]) {
      expect(requiresConfirmation(autonomous, a)).toBe(true);
    }
    expect(requiresConfirmation(autonomous, "write")).toBe(false);
    expect(requiresConfirmation(autonomous, "read")).toBe(false);
  });

  it("confirm_each_step confirms every non-read step", () => {
    const s = defaultSettings();
    expect(requiresConfirmation(s, "write")).toBe(true);
    expect(requiresConfirmation(s, "execute")).toBe(true);
    expect(requiresConfirmation(s, "read")).toBe(false);
  });

  it("the list is frozen at runtime", () => {
    expect(Object.isFrozen(ALWAYS_CONFIRM_ACTIONS)).toBe(true);
    expect(() => (ALWAYS_CONFIRM_ACTIONS as unknown as string[]).pop()).toThrow(TypeError);
    expect(ALWAYS_CONFIRM_ACTIONS).toEqual(["payment", "send", "delete", "publish"]);
  });
});
