import { parseSettings } from "@alca/config";
import { describe, expect, it } from "vitest";
import {
  assertSafeStartup,
  checkStartupSafety,
  isForwardJump,
  isLoopbackHost,
  requiredSecrets,
  StartupRefusedError,
  secretsFromMap,
  TURN_PHASES,
} from "../src/index.ts";

const strong = "a".repeat(64);
const goodSecrets = secretsFromMap({ "core.localToken": strong, "link.identityKey": strong });

describe("isLoopbackHost", () => {
  it.each(["127.0.0.1", "127.1.2.3", "localhost", "LOCALHOST", "::1", "[::1]", "::ffff:127.0.0.1"])(
    "accepts %s",
    (h) => expect(isLoopbackHost(h)).toBe(true),
  );
  it.each([
    "0.0.0.0",
    "::",
    "192.168.1.10",
    "10.0.0.1",
    "::ffff:10.0.0.1",
    "example.com",
    "localhost.evil.com",
    "",
  ])("rejects %s", (h) => expect(isLoopbackHost(h)).toBe(false));
});

describe("startup safety check", () => {
  it("starts with defaults + secrets", () => {
    expect(checkStartupSafety(parseSettings({}), goodSecrets)).toEqual([]);
    expect(() => assertSafeStartup(parseSettings({}), goodSecrets)).not.toThrow();
  });

  it("refuses a non-loopback bind", () => {
    const s = parseSettings({ engineering: { bindHost: "0.0.0.0" } });
    expect(() => assertSafeStartup(s, goodSecrets)).toThrow(StartupRefusedError);
    expect(checkStartupSafety(s, goodSecrets).map((p) => p.code)).toEqual(["non_loopback_bind"]);
  });

  it("refuses when required secrets are missing, blank or weak", () => {
    const s = parseSettings({});
    expect(checkStartupSafety(s, secretsFromMap({})).map((p) => p.detail)).toEqual([
      "core.localToken",
      "link.identityKey",
    ]);
    expect(
      checkStartupSafety(s, secretsFromMap({ "core.localToken": "  ", "link.identityKey": "short" })),
    ).toEqual([
      { code: "missing_secret", detail: "core.localToken" },
      { code: "weak_secret", detail: "link.identityKey shorter than 32 chars" },
    ]);
  });

  it("derives required secrets from settings", () => {
    const s = parseSettings({
      devices: { allowPairing: false },
      models: {
        engines: [
          { id: "openrouter", kind: "api" },
          { id: "off", kind: "api", enabled: false },
        ],
      },
    });
    expect(requiredSecrets(s)).toEqual(["core.localToken", "engine.openrouter.apiKey"]);
    const err = (() => {
      try {
        assertSafeStartup(s, secretsFromMap({ "core.localToken": strong }));
      } catch (e) {
        return e as StartupRefusedError;
      }
    })();
    expect(err?.problems).toEqual([{ code: "missing_secret", detail: "engine.openrouter.apiKey" }]);
    expect(err?.message).not.toContain(strong);
  });

  it("reports every problem at once", () => {
    const s = parseSettings({ engineering: { bindHost: "192.168.0.2" } });
    expect(checkStartupSafety(s, secretsFromMap({}))).toHaveLength(3);
  });
});

describe("turn pipeline contract", () => {
  it("has the planned phase order and only allows forward jumps", () => {
    expect(TURN_PHASES).toEqual([
      "prepare",
      "recall",
      "infer",
      "plan_tools",
      "gate",
      "execute",
      "reflect",
      "persist",
    ]);
    expect(isForwardJump("plan_tools", "reflect")).toBe(true);
    expect(isForwardJump("execute", "infer")).toBe(false);
  });
});
