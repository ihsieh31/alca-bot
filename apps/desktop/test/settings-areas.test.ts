import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateIdentity, pairDevice } from "@alca/link";
import { startRendezvous } from "@alca/rendezvous";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startDesktop } from "../src/index.ts";

/**
 * 設定's other areas (P13 B3), through the same HTTP calls the dialog makes:
 * 模型與供應商 (the default bot), 連線 (devices + 撤銷), 瀏覽器 (the
 * auto-download switch, live), 備份 (list, 現在備份), 關於 (version, folders).
 */

vi.setConfig({ testTimeout: 30_000 });

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function boot(o: { relay?: string; browserDownload?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "alca-settings-areas-"));
  const opened: string[] = [];
  // A path that "exists" as far as the lookup goes, so nothing is ever downloaded here.
  const fakeChromium = join(dir, "chromium-stand-in");
  writeFileSync(fakeChromium, "");
  const app = await startDesktop({
    engine: "demo",
    dataDir: dir,
    port: 0,
    agents: "direct",
    browser: "headless",
    chromium: fakeChromium,
    ...(o.browserDownload !== undefined ? { browserDownload: o.browserDownload } : {}),
    ...(o.relay ? { rendezvous: o.relay } : {}),
    openFolder: (d) => {
      opened.push(d);
      return true;
    },
  });
  cleanups.push(
    () => rmSync(dir, { recursive: true, force: true }),
    () => app.close(),
  );
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${app.server.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${app.token}`, ...app.uiHeaders, "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : method === "GET" ? {} : { body: "{}" }),
    });
    // biome-ignore lint/suspicious/noExplicitAny: test helper reads arbitrary JSON
    return { status: res.status, body: (await res.json()) as any };
  };
  return { app, api, dir, opened };
}

describe("設定 areas (P13 B3)", () => {
  it("備份: lists none, 現在備份 makes a real copy, the list shows it; restore is not an endpoint", async () => {
    const { api, dir } = await boot();
    const none = await api("GET", "/api/settings/backups");
    expect(none.body).toMatchObject({ backups: [], keep: 5, dir: join(dir, "backups") });
    expect(none.body.restoreHint).toMatch(/alca db restore/);
    const made = await api("POST", "/api/settings/backups");
    expect(made.status).toBe(200);
    expect(made.body.made).toMatch(/^state-v\d+-\d{8}T\d{6}Z/);
    expect(existsSync(join(dir, "backups", made.body.made))).toBe(true);
    const list = await api("GET", "/api/settings/backups");
    expect(list.body.backups).toHaveLength(1);
    expect(list.body.backups[0]).toMatchObject({ name: made.body.made });
    expect(list.body.backups[0].bytes).toBeGreaterThan(0);
    expect(list.body.backups[0].file).toBeUndefined(); // names only
    expect((await api("POST", "/api/settings/backups/restore")).status).toBe(404);
  });

  it("關於: version and folders; 打開記錄檔資料夾 / 打開資料夾 open the real folders", async () => {
    const { api, dir, opened } = await boot();
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const a = await api("GET", "/api/settings/about");
    expect(a.body).toMatchObject({
      version: pkg.version,
      dataDir: dir,
      logsDir: join(dir, "logs"),
      logFileExists: false,
    });
    expect((await api("POST", "/api/settings/open-logs")).body).toEqual({
      opened: true,
      dir: join(dir, "logs"),
    });
    expect(existsSync(join(dir, "logs"))).toBe(true);
    await api("POST", "/api/settings/open-data");
    expect(opened).toEqual([join(dir, "logs"), dir]);
    writeFileSync(join(dir, "logs", "core.log"), "x\n");
    expect((await api("GET", "/api/settings/about")).body.logFileExists).toBe(true);
  });

  it("瀏覽器: the auto-download switch is saved and read live by the browser", async () => {
    const { api, dir } = await boot({ browserDownload: true });
    expect((await api("GET", "/api/settings")).body.advanced).toMatchObject({
      browserAutoDownload: true,
      browserAutoDownloadLocked: false,
    });
    expect((await api("GET", "/api/browser/status")).body.install.auto).toBe(true);
    const off = await api("PATCH", "/api/settings", { browserAutoDownload: false });
    expect(off.body.advanced.browserAutoDownload).toBe(false);
    expect(off.body.pendingRestart).toEqual([]);
    expect((await api("GET", "/api/browser/status")).body.install.auto).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).advanced.browserAutoDownload).toBe(
      false,
    );
    await api("PATCH", "/api/settings", { browserAutoDownload: true });
    expect((await api("GET", "/api/browser/status")).body.install.auto).toBe(true);
  });

  it("瀏覽器: with --no-browser-download the switch is shown locked and changes nothing this run", async () => {
    const { api, dir } = await boot({ browserDownload: false });
    expect((await api("GET", "/api/settings")).body.advanced.browserAutoDownloadLocked).toBe(true);
    // Mac test 2026-11-04b B6: the window was locked but the API still wrote config.json.
    const r = await api("PATCH", "/api/settings", { browserAutoDownload: false });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/--no-browser-download.*重新啟動後再改/);
    expect(
      existsSync(join(dir, "config.json")) ? readFileSync(join(dir, "config.json"), "utf8") : "",
    ).not.toContain("browserAutoDownload");
    expect((await api("GET", "/api/browser/status")).body.install.auto).toBe(false);
  });

  it("自架會合伺服器: http:// is refused with a sentence that says https (B5)", async () => {
    const { api, dir } = await boot();
    const r = await api("PATCH", "/api/settings", { rendezvousUrl: "http://relay.example.org" });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/只接受 https:\/\//);
    expect(
      existsSync(join(dir, "config.json")) ? readFileSync(join(dir, "config.json"), "utf8") : "",
    ).not.toContain("rendezvousUrl");
  });

  it("模型與供應商: the default bot's provider and model change through the bot API the dialog uses", async () => {
    const { api } = await boot();
    const team = (await api("GET", "/api/team")).body;
    const id = team.defaultBotId;
    const engine = team.engines.find((e: { id: string }) => e.id !== "default")?.id ?? "default";
    const r = await api("PATCH", `/api/bots/${id}`, { engineId: engine, model: "some-model" });
    expect(r.status).toBe(200);
    let bot = (await api("GET", "/api/team")).body.bots.find((b: { id: string }) => b.id === id);
    expect(bot).toMatchObject({ engineId: engine === "default" ? null : engine, model: "some-model" });
    await api("PATCH", `/api/bots/${id}`, { engineId: null, model: null });
    bot = (await api("GET", "/api/team")).body.bots.find((b: { id: string }) => b.id === id);
    expect(bot).toMatchObject({ engineId: null, model: null });
  });

  it("連線: the paired device is listed with the relay, and 撤銷 removes it for good", async () => {
    const relay = await startRendezvous({ port: 0 });
    cleanups.push(() => relay.close());
    const { api } = await boot({ relay: relay.url });
    const p = (await api("POST", "/api/link/pairings")).body;
    await pairDevice({
      relayUrl: relay.url,
      code: p.display,
      identity: await generateIdentity(),
      device: { name: "測試 iPhone", kind: "phone", platform: "headless" },
      expectFingerprint: p.coreFingerprint,
    });
    const link = (await api("GET", "/api/link")).body;
    expect(link.enabled).toBe(true);
    expect(new URL(link.connection.relayUrl).host).toBe(new URL(relay.url).host);
    expect(link.devices.map((d: { name: string }) => d.name)).toEqual(["測試 iPhone"]);
    expect((await api("GET", "/api/link/remote")).status).toBe(200);
    const id = link.devices[0].id;
    expect((await api("POST", `/api/link/devices/${id}/revoke`)).status).toBe(200);
    expect((await api("GET", "/api/link")).body.devices).toEqual([]);
  });
});
