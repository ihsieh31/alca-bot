// Desktop × Telegram reply channel (P13), offline: the demo engine and a
// local fake of the Telegram Bot API. Token in → checked and sealed in the
// vault (never returned) → allow-list + bot → a chat message reaches the
// bot's thread and the reply goes back; a stranger is listed, not answered.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FakeTelegram, startFakeTelegram } from "@alca/channel-telegram/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DesktopApp, startDesktop } from "../src/index.ts";

// biome-ignore lint/suspicious/noExplicitAny: test JSON
type Json = any;

describe("desktop × Telegram (fake Bot API)", () => {
  let app: DesktopApp;
  let tg: FakeTelegram;
  let dir: string;
  const api = async (
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: Json }> => {
    const res = await fetch(`${app.server.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${app.token}`,
        ...app.uiHeaders,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const until = async <T>(fn: () => T | undefined | false, ms = 15_000): Promise<T> => {
    const start = Date.now();
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() - start > ms) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  beforeAll(async () => {
    tg = await startFakeTelegram();
    dir = mkdtempSync(join(tmpdir(), "alca-desk-tg-"));
    app = await startDesktop({
      engine: "demo",
      dataDir: dir,
      port: 0,
      browser: "off",
      vaultKeySource: "file",
      telegramApiBase: tg.base,
    });
  }, 30_000);
  afterAll(async () => {
    await app?.close();
    await tg?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("off by default; needs the local token", async () => {
    const st = await api("GET", "/api/telegram");
    expect(st.status).toBe(200);
    expect(st.body).toMatchObject({ enabled: false, tokenSet: false, running: false, allowChatIds: [] });
    const anon = await fetch(`${app.server.url}/api/telegram`);
    expect(anon.status).toBe(401);
  });

  it("a wrong token is refused and not kept; the right one is sealed in the vault and never returned", async () => {
    const bad = await api("PUT", "/api/telegram/token", { token: "not a token" });
    expect(bad.status).toBe(400);
    const ok = await api("PUT", "/api/telegram/token", { token: tg.token });
    expect(ok.status).toBe(200);
    expect(ok.body.tokenSet).toBe(true);
    expect(ok.body.botUsername).toBe("my_alca_bot");
    expect(JSON.stringify(ok.body)).not.toContain(tg.token);
    expect(readFileSync(join(dir, "vault.json"), "utf8")).not.toContain(tg.token);
  });

  it("an allowed chat talks to the chosen bot; a stranger is listed for the person to add", async () => {
    const bad = await api("PUT", "/api/telegram", { allowChatIds: [-1001] });
    expect(bad.status).toBe(400);
    const bot = app.core.defaultBotId;
    const on = await api("PUT", "/api/telegram", { enabled: true, allowChatIds: [4242], botId: bot });
    expect(on.body).toMatchObject({ enabled: true, running: true, allowChatIds: [4242], botId: bot });
    tg.say({ id: 99, first_name: "路人" }, "hi");
    tg.say({ id: 4242, first_name: "小明" }, "你好");
    await until(() => tg.sent.find((s) => s.chatId === 4242));
    expect(tg.sent.every((s) => s.chatId === 4242)).toBe(true);
    const thread = app.core.listThreads().find((t) => t.title === "Telegram · 小明");
    expect(thread?.botId).toBe(bot);
    expect(readFileSync(join(dir, "telegram.json"), "utf8")).not.toContain(tg.token);
    const st = await api("GET", "/api/telegram");
    expect(st.body.unknown.map((u: Json) => u.chatId)).toEqual([99]);
    const off = await api("DELETE", "/api/telegram/token");
    expect(off.body).toMatchObject({ tokenSet: false, running: false });
  });
});
