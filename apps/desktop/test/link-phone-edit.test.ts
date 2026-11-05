import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateIdentity, LinkClient, pairDevice } from "@alca/link";
import { startRendezvous } from "@alca/rendezvous";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type DesktopApp, startDesktop } from "../src/index.ts";

/**
 * P13: the phone adds and edits bots (simple fields only) and creates
 * routines over Alca Link — with `approve`, through the same TeamApi /
 * ConnectorsApi as the desktop, so the same validation; anything the phone
 * may not set is refused, not silently dropped.
 */

vi.setConfig({ testTimeout: 30_000 });

const until = async (f: () => boolean | Promise<boolean>, ms = 8000) => {
  const t = Date.now();
  while (!(await f())) {
    if (Date.now() - t > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe("phone × create / edit bots and routines", () => {
  let app: DesktopApp;
  let relay: Awaited<ReturnType<typeof startRendezvous>>;
  let dir: string;
  const clients: LinkClient[] = [];
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${app.server.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${app.token}`, ...app.uiHeaders, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    // biome-ignore lint/suspicious/noExplicitAny: test JSON
    return { status: res.status, body: (await res.json()) as any };
  };
  const phone = async (scopes: string[]) => {
    const p = (await api("POST", "/api/link/pairings", { scopes })).body;
    const identity = await generateIdentity();
    const credentials = await pairDevice({
      relayUrl: relay.url,
      code: String(p.display),
      identity,
      device: { name: "測試 iPhone", kind: "phone", platform: "headless" },
      expectFingerprint: String(p.coreFingerprint),
    });
    const client = new LinkClient({ credentials, identity, pingSec: 0, backoff: { first: 50, max: 300 } });
    client.start();
    clients.push(client);
    await until(() => client.status === "online");
    return client;
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "alca-link-edit-"));
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ engineering: { routines: { startDelaySec: 3600 } } }),
    );
    relay = await startRendezvous({ port: 0 });
    app = await startDesktop({
      engine: "demo",
      dataDir: dir,
      port: 0,
      browser: "off",
      composioMock: true,
      vaultKeySource: "file",
      rendezvous: relay.url,
    });
    await api("PUT", "/api/connectors/key", { key: app.composioMock?.key });
    const r = (await api("POST", "/api/connectors/accounts", { toolkit: "gmail", label: "工作" })).body;
    await fetch(r.redirectUrl);
    await api("POST", "/api/connectors/refresh");
  }, 30_000);
  afterAll(async () => {
    for (const c of clients) c.stop();
    await app?.close();
    await relay?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("chat cannot add, edit or schedule anything", async () => {
    const c = await phone(["chat"]);
    const before = app.core.store.bots.list().length;
    for (const [op, args] of [
      ["team.bots.create", { name: "偷加的" }],
      ["team.bots.update", { botId: app.core.defaultBotId, name: "改名" }],
      [
        "routines.create",
        { name: "x", kind: "interval", intervalSec: 3600, check: { kind: "app", app: "gmail" } },
      ],
    ] as const)
      await expect(c.request(op, args)).rejects.toMatchObject({ code: "forbidden" });
    expect(app.core.store.bots.list()).toHaveLength(before);
    expect(app.core.store.routines.list()).toHaveLength(0);
  });

  it("approve adds a bot with the desktop's validation; only simple fields", async () => {
    const c = await phone(["chat", "approve"]);
    const b = await c.request<{ id: string; name: string; color: string; role: string; approvalLevel: null }>(
      "team.bots.create",
      { name: "寫手", role: "寫文章", avatar: "寫", instructions: "簡短" },
    );
    expect(b).toMatchObject({ name: "寫手", role: "寫文章" });
    expect(b.color).toBeTruthy();
    // Same rules as the desktop's POST /api/bots.
    const desk = await api("POST", "/api/bots", { name: "寫手" });
    expect(desk.status).toBe(400);
    await expect(c.request("team.bots.create", { name: "寫手" })).rejects.toMatchObject({
      code: "bad_request",
      message: expect.stringContaining("已經有"),
    });
    await expect(c.request("team.bots.create", { role: "沒名字" })).rejects.toMatchObject({
      code: "bad_request",
    });
    await expect(c.request("team.bots.create", { name: "彩色", color: "neon" })).rejects.toThrow(/顏色/);
    await expect(c.request("team.bots.create", { name: "等級", approvalLevel: "yolo" })).rejects.toThrow(
      /權限/,
    );
    // Provider, model, browser profile, memory: on the computer only — refused, not ignored.
    for (const extra of [
      { engineId: "openai" },
      { model: "gpt-x" },
      { browserProfile: "isolated" },
      { memoryMode: "off" },
    ])
      await expect(c.request("team.bots.create", { name: "多欄位", ...extra })).rejects.toThrow(/電腦/);
    expect(app.core.store.bots.list().some((x) => x.name === "多欄位")).toBe(false);

    const edited = await c.request<{ name: string; role: string; approvalLevel: string }>(
      "team.bots.update",
      {
        botId: b.id,
        name: "寫手二號",
        approvalLevel: "confirm_each_step",
      },
    );
    expect(edited).toMatchObject({ name: "寫手二號", approvalLevel: "confirm_each_step" });
    expect(app.core.store.bots.get(b.id)?.approvalLevel).toBe("confirm_each_step");
    await expect(c.request("team.bots.update", { botId: b.id, engineId: "openai" })).rejects.toThrow(/電腦/);
    // Phase 5: 完全授權 only from the bot's settings on the computer.
    await expect(
      c.request("team.bots.update", { botId: b.id, approvalLevel: "full_access" }),
    ).rejects.toThrow(/完全授權只能在電腦/);
    await expect(
      c.request("team.bots.create", { name: "全權", approvalLevel: "full_access" }),
    ).rejects.toThrow(/電腦/);
    expect(app.core.store.bots.get(b.id)?.approvalLevel).toBe("confirm_each_step");
    await expect(c.request("team.bots.update", { botId: b.id })).rejects.toThrow(/沒有要改/);
    await expect(c.request("team.bots.update", { botId: "bot_nope", name: "x" })).rejects.toMatchObject({
      code: "not_found",
    });
    // The desktop sees it on its own roster.
    const team = (await api("GET", "/api/team")).body;
    expect(team.bots.some((x: { name: string }) => x.name === "寫手二號")).toBe(true);
  });

  it("approve creates a routine with the desktop's checks; a picked bot gets the conversation", async () => {
    const c = await phone(["chat", "approve"]);
    const writer = app.core.store.bots.list().find((x) => x.name === "寫手二號");
    const r = await c.request<{ id: string; name: string; threadId: string; kind: string; enabled: boolean }>(
      "routines.create",
      {
        name: "工作信箱",
        kind: "interval",
        intervalSec: 1800,
        check: { kind: "app", app: "gmail", account: "工作" },
        instructions: "有新信就摘要",
        botId: writer?.id,
      },
    );
    expect(r).toMatchObject({ name: "工作信箱", kind: "interval", enabled: true });
    expect(app.core.store.threads.get(r.threadId)?.botId).toBe(writer?.id);
    const daily = await c.request<{ kind: string; schedule: string }>("routines.create", {
      name: "早安",
      kind: "cron",
      cron: "0 8 * * *",
      tz: "Asia/Taipei",
      check: { kind: "app", app: "gmail" },
    });
    expect(daily.kind).toBe("cron");
    const bad: Array<[Record<string, unknown>, RegExp]> = [
      [{ name: "太快", kind: "interval", intervalSec: 30, check: { kind: "app", app: "gmail" } }, /60/],
      [
        {
          name: "時區",
          kind: "cron",
          cron: "0 8 * * *",
          tz: "Mars/Base",
          check: { kind: "app", app: "gmail" },
        },
        /時區/,
      ],
      [{ name: "單次", kind: "once", check: { kind: "app", app: "gmail" } }, /時間/],
      [{ name: "", kind: "interval", intervalSec: 600, check: { kind: "app", app: "gmail" } }, /名字/],
      [{ name: "事件", kind: "trigger", triggerId: "trg_x", check: { kind: "queue" } }, /不能設定/],
      [{ name: "事件二", kind: "trigger", check: { kind: "queue" } }, /手機上可以建立/],
      [
        { name: "沒 app", kind: "interval", intervalSec: 600, check: { kind: "shell", cmd: "rm -rf /" } },
        /app/,
      ],
      [
        { name: "多", kind: "interval", intervalSec: 600, check: { kind: "app", app: "gmail" }, cursor: "x" },
        /不能設定/,
      ],
    ];
    for (const [args, msg] of bad)
      await expect(c.request("routines.create", args), String(args.name)).rejects.toThrow(msg);
    const listed = (await api("GET", "/api/routines")).body.routines.map((x: { name: string }) => x.name);
    expect(listed.sort()).toEqual(["工作信箱", "早安"].sort());
  });
});
