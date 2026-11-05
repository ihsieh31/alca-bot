// Desktop × Alca Browser end to end with the offline demo engine and a real
// headless Chromium. Skips when no Chromium is installed.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChromium } from "@alca/browser";
import type { AlcaEvent, EventOf } from "@alca/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DesktopApp, startDesktop } from "../src/index.ts";

const bin = process.env.ALCA_TEST_CHROMIUM || findChromium();

describe.skipIf(!bin)("desktop × browser (demo engine, real Chromium)", () => {
  let app: DesktopApp;
  let dir: string;
  const events: AlcaEvent[] = [];
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
    // biome-ignore lint/suspicious/noExplicitAny: test JSON
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };
  const until = async <T>(fn: () => T | undefined, ms = 15_000): Promise<T> => {
    const start = Date.now();
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() - start > ms) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  const approval = (pred: (e: EventOf<"approval.requested">) => boolean = () => true) =>
    until(() =>
      events.find((e): e is EventOf<"approval.requested"> => e.type === "approval.requested" && pred(e)),
    );

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "alca-desk-browser-"));
    app = await startDesktop({
      engine: "demo",
      dataDir: dir,
      port: 0,
      // P1/P2 behaviour of a single turn (the router / worker split is tested in agents.test.ts).
      agents: "direct",
      browser: "headless",
      chromium: bin as string,
    });
    app.core.bus.subscribe("*", (e) => events.push(e));
  }, 30_000);
  afterAll(async () => {
    await app?.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it("opens a bot-owned Space, gates the pay button with a payment card, and bridges takeover into the run", async () => {
    const t = (await api("POST", "/api/threads", {})).body;
    await api("POST", `/api/threads/${t.id}/messages`, { text: "幫我在示範商店結帳" });
    // 每步確認 (the default) asks for opening the page too; the pay click is the always-confirm one.
    const first = await approval();
    expect(first.data).toMatchObject({ actionClass: "network" });
    expect(String(first.data.summary)).toContain("開啟 127.0.0.1");
    await api("POST", `/api/approvals/${first.data.approvalId}`, { decision: "approved" });
    const card = await approval((e) => e.data.actionClass === "payment");
    const bot = app.core.store.bots.default()!;
    expect(card.data).toMatchObject({ actionClass: "payment", botId: bot.id });
    expect(String(card.data.summary)).toContain("確認付款");

    const spaces = (await api("GET", "/api/browser/spaces")).body;
    expect(spaces).toHaveLength(1);
    expect(spaces[0]).toMatchObject({
      botId: bot.id,
      threadId: t.id,
      controller: "agent",
      profile: "shared",
    });
    expect(app.core.store.bots.spaces(bot.id).map((s) => s.id)).toEqual([spaces[0].spaceId]);
    const id = spaces[0].spaceId;

    expect((await api("POST", `/api/browser/spaces/${id}/input`, { type: "key", key: "Tab" })).status).toBe(
      409,
    );
    expect((await api("POST", `/api/browser/spaces/${id}/takeover`, {})).body.controller).toBe("user");
    const hof = await until(() => events.find((e) => e.type === "handoff.requested"));
    expect(hof.data).toMatchObject({ to: "user", surface: "browser", targetId: id });
    expect((await api("POST", `/api/browser/spaces/${id}/input`, { type: "key", key: "Tab" })).status).toBe(
      200,
    );
    expect((await api("POST", `/api/browser/spaces/${id}/handback`, {})).body.controller).toBe("agent");

    // After a hand-back every @N is void: the approved click fails safe instead of pressing a changed page.
    await api("POST", `/api/approvals/${card.data.approvalId}`, { decision: "approved" });
    await until(() => events.find((e) => e.type === "run.finished"));
    expect(app.core.messages(t.id).at(-1)?.content).toContain("沒有付款");
    const driver = () => app.browser!.host.activeTab(app.browser!.host.get(id))!.driver;
    expect(await driver().readText()).not.toContain("付款完成");

    // Without a takeover in between, 允許一次 presses it exactly once.
    events.length = 0;
    await api("POST", `/api/threads/${t.id}/messages`, { text: "再結帳一次" });
    const open2 = await approval();
    await api("POST", `/api/approvals/${open2.data.approvalId}`, { decision: "approved" });
    const pay2 = await approval((e) => e.data.actionClass === "payment");
    expect((await api("GET", "/api/browser/spaces")).body).toHaveLength(1); // same thread, same Space
    await api("POST", `/api/approvals/${pay2.data.approvalId}`, { decision: "approved" });
    await until(() => events.find((e) => e.type === "run.finished"));
    expect(app.core.messages(t.id).at(-1)?.content).toContain("已按下付款");
    expect(await driver().readText()).toContain("付款完成");
  }, 60_000);

  it("streams browser events and frames over SSE", async () => {
    const id = (await api("GET", "/api/browser/spaces")).body[0].spaceId;
    const ctrl = new AbortController();
    const res = await fetch(`${app.server.url}/api/browser/events?watch=${id}`, {
      headers: { authorization: `Bearer ${app.token}`, ...app.uiHeaders },
      signal: ctrl.signal,
    });
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    const deadline = Date.now() + 10_000;
    while (!(buf.includes("space.snapshot") && buf.includes("event: frame")) && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
    }
    ctrl.abort();
    expect(buf).toContain("space.snapshot");
    expect(buf).toContain('"type":"space.frame"');
  }, 30_000);
});
