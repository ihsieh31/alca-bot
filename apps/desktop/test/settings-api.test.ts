import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startDesktop } from "../src/index.ts";
import { logLevel } from "../src/log.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function boot(config?: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "alca-settings-"));
  if (config) writeFileSync(join(dir, "config.json"), JSON.stringify(config));
  const app = await startDesktop({ engine: "demo", dataDir: dir, port: 0, agents: "direct", browser: "off" });
  cleanups.push(
    () => rmSync(dir, { recursive: true, force: true }),
    () => app.close(),
  );
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${app.server.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${app.token}`,
        ...app.uiHeaders,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    // biome-ignore lint/suspicious/noExplicitAny: test helper reads arbitrary JSON
    return { status: res.status, body: (await res.json()) as any };
  };
  return { app, api, dir };
}

describe("設定 API (P13 B3)", () => {
  it("reads and changes the simple and 進階 fields, writes config.json, applies live ones at once", async () => {
    const { api, dir } = await boot({
      models: { defaultEngine: "claude-code" },
      engineering: { turnTimeoutSec: 321 },
    });
    const v = await api("GET", "/api/settings");
    expect(v.body.simple).toEqual({ level: "confirm_each_step", learning: true, pushPreview: "notify_only" });
    expect(v.body.advanced).toMatchObject({ allowPairing: true, logLevel: "info", rendezvousUrl: null });
    expect(v.body.pendingRestart).toEqual([]);

    const r = await api("PATCH", "/api/settings", { level: "autonomous", learning: false, logLevel: "warn" });
    expect(r.status).toBe(200);
    expect(r.body.simple).toMatchObject({ level: "autonomous", learning: false });
    expect(logLevel()).toBe("warn");
    // Live: the session's level is the new one without a restart.
    expect((await api("GET", "/api/session")).body.level).toBe("autonomous");
    const file = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    expect(file.engineering.turnTimeoutSec).toBe(321); // kept
    expect(file.models.defaultEngine).toBeUndefined(); // an old key is dropped on save
    expect(statSync(join(dir, "config.json")).mode & 0o777).toBe(0o600);

    const later = await api("PATCH", "/api/settings", {
      allowPairing: false,
      rendezvousUrl: "https://relay.example.org",
    });
    expect(later.body.pendingRestart.sort()).toEqual(["advanced.rendezvousUrl", "devices.allowPairing"]);
    await api("PATCH", "/api/settings", { logLevel: "info" });
  });

  it("refuses what is not a setting here, and invalid values, leaving the file alone", async () => {
    const { api, dir } = await boot();
    expect((await api("PATCH", "/api/settings", { alwaysConfirm: [] })).status).toBe(400);
    expect((await api("PATCH", "/api/settings", { engineering: { port: 1 } })).status).toBe(400);
    expect((await api("PATCH", "/api/settings", { level: "full_access" })).status).toBe(400);
    expect(
      (await api("PATCH", "/api/settings", { defaultScopes: ["chat", "control_computer"] })).status,
    ).toBe(400);
    expect((await api("PATCH", "/api/settings", { rendezvousUrl: "http://plain.example" })).status).toBe(400);
    expect(() => readFileSync(join(dir, "config.json"))).toThrow();
  });
});
