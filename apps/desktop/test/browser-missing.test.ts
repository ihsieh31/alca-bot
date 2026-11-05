import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserNotFoundError } from "@alca/browser";
import { openStore } from "@alca/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBrowser } from "../src/browser.ts";

/** Mac test 2026-11-04b C2: with the download off, the error says so and where to turn it on. */
describe("no browser and no download", () => {
  let dir: string;
  const saved = process.env.ALCA_CHROMIUM;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "alca-nobrowser-"));
    // A path that does not exist: findChromium() stops there instead of finding a system Chromium.
    process.env.ALCA_CHROMIUM = join(dir, "no-such-chromium");
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.ALCA_CHROMIUM;
    else process.env.ALCA_CHROMIUM = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  async function openWith(reason: "setting" | "flag" | undefined): Promise<string> {
    const store = openStore(join(dir, "db.sqlite"));
    const setup = createBrowser({
      dataDir: dir,
      store,
      mode: "headless",
      autoInstall: false,
      autoOffReason: () => reason,
    });
    try {
      await setup?.host.open({ botId: "b", title: "t" });
      return "opened";
    } catch (e) {
      expect(e).toBeInstanceOf(BrowserNotFoundError);
      return (e as Error).message;
    } finally {
      await setup?.host.shutdown();
      store.close();
    }
  }

  it("設定 turned it off: names 設定 → 進階 → 瀏覽器 and 下載瀏覽器", async () => {
    const msg = await openWith("setting");
    expect(msg).toContain("自動下載已關閉");
    expect(msg).toContain("設定 → 進階 → 瀏覽器");
    expect(msg).toContain("下載瀏覽器");
  });

  it("--no-browser-download: names the flag", async () => {
    const msg = await openWith("flag");
    expect(msg).toContain("--no-browser-download");
    expect(msg).toContain("設定 → 進階 → 瀏覽器");
  });

  it("no reason given (tests, embedders): the old sentence", async () => {
    expect(await openWith(undefined)).toMatch(/^找不到可用的 Chromium/);
  });
});
