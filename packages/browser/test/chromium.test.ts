// Integration test against a real Chromium. Uses $ALCA_TEST_CHROMIUM, then the
// usual lookup (ALCA_CHROMIUM, system paths). Skips when none is installed.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActionClass } from "@alca/policy";
import type { SpaceFrameT } from "@alca/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BrowserAgent,
  BrowserHost,
  type ChromiumProcess,
  findChromium,
  launchChromium,
  SensitiveActionError,
  StaleRefError,
} from "../src/index.ts";
import { startSite } from "./fixtures/site.ts";

const bin = process.env.ALCA_TEST_CHROMIUM || findChromium();
const BOT = "bot_00000000000000000000000001";
const sig = () => AbortSignal.timeout(30_000);

describe.skipIf(!bin)("Alca Browser × real Chromium", () => {
  let site: Awaited<ReturnType<typeof startSite>>;
  let dir: string;
  let host: BrowserHost;
  let agent: BrowserAgent;
  const procs: ChromiumProcess[] = [];

  beforeAll(async () => {
    site = await startSite();
    dir = mkdtempSync(join(tmpdir(), "alca-chromium-"));
    host = new BrowserHost({
      launchShared: async () => {
        const p = await launchChromium({
          executablePath: bin as string,
          userDataDir: join(dir, "shared"),
          headless: true,
        });
        procs.push(p);
        return p;
      },
      launchIsolated: async (id) => {
        const p = await launchChromium({
          executablePath: bin as string,
          userDataDir: join(dir, id),
          headless: true,
        });
        procs.push(p);
        return p;
      },
    });
    agent = new BrowserAgent(host);
  }, 30_000);

  afterAll(async () => {
    await host?.shutdown();
    for (const p of procs) await p.close();
    site?.server.close();
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  const step = (spaceId: string, s: Parameters<BrowserAgent["step"]>[2], granted: ActionClass = "write") =>
    agent.step(spaceId, BOT, s, { signal: sig(), granted });
  const refOf = (out: string, label: string) => {
    const m = new RegExp(`"${label}" @(\\d+)`).exec(out);
    if (!m) throw new Error(`no ref for ${label} in\n${out}`);
    return `@${m[1]}`;
  };

  it("snapshots across shadow DOM, same-origin and cross-site iframes, and acts on @N", async () => {
    const { spaceId } = await host.open({ botId: BOT, title: "測試", url: `${site.url}/` });
    let snap = (await step(spaceId, { do: "snapshot" }, "read")).output;
    expect(snap).toContain('heading "今日精選"');
    expect(snap).toContain('button "影子按鈕"');
    expect(snap.match(/button "框內按鈕"/g)?.length).toBe(2);

    await step(spaceId, { do: "select", target: { ref: refOf(snap, "排序") }, option: "價格" });
    expect((await step(spaceId, { do: "read" }, "read")).output).toContain("排序：價格");

    await step(spaceId, { do: "click", target: { ref: refOf(snap, "影子按鈕") } });
    const frames = [...snap.matchAll(/button "框內按鈕" @(\d+)/g)].map((m) => `@${m[1]}`);
    for (const r of frames) await step(spaceId, { do: "click", target: { ref: r } });
    snap = (await step(spaceId, { do: "snapshot" }, "read")).output;
    expect(snap).toContain('button "影子已按"');
    expect(snap.match(/button "框內已按"/g)?.length).toBe(2);

    await step(spaceId, {
      do: "type",
      target: { ref: refOf(snap, "搜尋商品") },
      text: "降噪耳機",
      submit: true,
    });
    await step(spaceId, { do: "wait", text: "搜尋結果" }, "read");
    expect((await step(spaceId, { do: "read" }, "read")).output).toContain("搜尋結果：降噪耳機");
    await expect(
      step(spaceId, { do: "click", target: { ref: refOf(snap, "影子已按") } }),
    ).rejects.toBeInstanceOf(StaleRefError);
  }, 60_000);

  it("never presses 確認付款 or types card data without a payment approval", async () => {
    const { spaceId } = await host.open({ botId: BOT, title: "結帳", url: `${site.url}/cart` });
    const snap = (await step(spaceId, { do: "snapshot" }, "read")).output;
    const pay = { do: "click" as const, target: { ref: refOf(snap, "確認付款") } };
    expect((await agent.inspect(spaceId, BOT, pay)).actionClass).toBe("payment");
    const card = { do: "type" as const, target: { ref: refOf(snap, "卡號") }, text: "4242" };
    expect((await agent.inspect(spaceId, BOT, card)).actionClass).toBe("payment");
    await expect(step(spaceId, card)).rejects.toBeInstanceOf(SensitiveActionError);
    await expect(step(spaceId, pay)).rejects.toBeInstanceOf(SensitiveActionError);
    expect((await step(spaceId, { do: "read" }, "read")).output).not.toContain("付款完成");
    await agent.step(spaceId, BOT, pay, { signal: sig(), granted: "payment" });
    expect((await step(spaceId, { do: "read" }, "read")).output).toContain("付款完成");
    // An ordinary button is fine.
    await step(spaceId, { do: "click", target: { role: "button", name: "繼續購物" } });
  }, 60_000);

  it("lets a person take over (input goes to the same page), then hands back", async () => {
    const { spaceId } = await host.open({ botId: BOT, title: "接手", url: `${site.url}/cart` });
    const frames: SpaceFrameT[] = [];
    const stop = host.watch(spaceId, (f) => frames.push(f));
    host.takeOver(spaceId, { kind: "user", id: "test" });
    const queued = step(spaceId, { do: "read" }, "read");
    // The person's input goes to the same page the agent was on.
    await host.userInput(spaceId, { type: "key", key: "Tab" });
    await host.userInput(spaceId, { type: "text", text: "4242" });
    host.handBack(spaceId, { kind: "user", id: "test" });
    expect((await queued).output).toContain("購物車");
    const shot = await step(spaceId, { do: "screenshot" }, "read");
    expect(shot.frame?.data.startsWith("iVBOR")).toBe(true);
    for (let i = 0; i < 40 && frames.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    expect(frames.length).toBeGreaterThan(0);
    stop();
  }, 60_000);

  // Mac test 2026-11-04b C3: ⌘A on the takeover view must select the field's text, not append to it.
  it("a person's select-all shortcut replaces the field's text", async () => {
    const { spaceId } = await host.open({ botId: BOT, title: "全選", url: `${site.url}/` });
    const snap = (await step(spaceId, { do: "snapshot" }, "read")).output;
    await step(spaceId, { do: "type", target: { ref: refOf(snap, "搜尋商品") }, text: "舊的字" });
    host.takeOver(spaceId, { kind: "user", id: "test" });
    await host.userInput(spaceId, { type: "shortcut", action: "selectAll" });
    await host.userInput(spaceId, { type: "text", text: "降噪耳機" });
    await host.userInput(spaceId, { type: "key", key: "Enter" });
    host.handBack(spaceId, { kind: "user", id: "test" });
    await step(spaceId, { do: "wait", text: "搜尋結果" }, "read");
    const out = (await step(spaceId, { do: "read" }, "read")).output;
    expect(out).toContain("搜尋結果：降噪耳機");
    expect(out).not.toContain("舊的字");
  }, 60_000);

  it("isolated Spaces do not share the shared profile's cookies", async () => {
    const shared = await host.open({ botId: BOT, title: "共用", url: `${site.url}/setcookie` });
    await step(shared.spaceId, { do: "navigate", url: `${site.url}/whoami` }, "network");
    expect((await step(shared.spaceId, { do: "read" }, "read")).output).toContain("cookie=有");
    const iso = await host.open({
      botId: BOT,
      title: "隔離",
      profile: "isolated",
      url: `${site.url}/whoami`,
    });
    expect((await step(iso.spaceId, { do: "read" }, "read")).output).toContain("cookie=無");
    const kept = await host.open({
      botId: BOT,
      title: "保留",
      profile: "isolated",
      persistent: true,
      url: `${site.url}/whoami`,
    });
    expect((await step(kept.spaceId, { do: "read" }, "read")).output).toContain("cookie=無");
    await host.close(kept.spaceId);
  }, 60_000);
});
