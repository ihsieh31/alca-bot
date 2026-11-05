import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcError } from "@alca/link";
import { afterEach, describe, expect, it } from "vitest";
import { type DesktopApp, startDesktop } from "../src/index.ts";
import { teamOps } from "../src/link-team-ops.ts";
import { sandboxBody, sandboxDraft } from "../ui/bot-sandbox-model.ts";

/**
 * Next round §5.4: a bot's OS sandbox through the team API — the probe in
 * words on every bot, loosening only with the approve key (like turning
 * 完全授權 on), tightening freely, the phone never.
 */

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function boot(): Promise<DesktopApp> {
  const dir = mkdtempSync(join(tmpdir(), "alca-sandbox-routes-"));
  const app = await startDesktop({
    engine: "demo",
    dataDir: dir,
    port: 0,
    agents: "router",
    browser: "off",
    openUrl: () => true,
    sandboxProbe: async () => ({ kind: "bwrap", ok: false, reason: "apparmor userns" }),
  });
  cleanups.push(
    () => rmSync(dir, { recursive: true, force: true }),
    () => app.close(),
  );
  return app;
}

const call = (app: DesktopApp, method: string, path: string, body?: unknown, extra = {}) =>
  fetch(`${app.server.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${app.token}`, "content-type": "application/json", ...extra },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

describe("bot sandbox through the team API (next round §5.4)", () => {
  it("every bot carries this computer's probe in words", async () => {
    const app = await boot();
    const res = await call(app, "GET", "/api/bots");
    const bots = (await res.json()) as Array<{ sandboxProbe?: { ok: boolean; text: string } }>;
    expect(bots[0]?.sandboxProbe).toMatchObject({ ok: false });
    expect(bots[0]?.sandboxProbe?.text).toContain("bubblewrap 不可用：apparmor userns");
  });

  it("tightening needs no approve key; loosening without it is refused and nothing is stored", async () => {
    const app = await boot();
    const id = app.core.defaultBotId;
    const stored = () => app.core.store.bots.get(id)?.sandbox ?? null;
    const on = await call(app, "PATCH", `/api/bots/${id}`, { sandbox: { mode: "on", network: "none" } });
    expect(on.status).toBe(200);
    expect(JSON.parse(stored() ?? "{}")).toMatchObject({ mode: "on", network: "none" });
    for (const loosen of [{ mode: "off" }, { network: "open" }, { extraWritable: ["/opt/cache"] }]) {
      const res = await call(app, "PATCH", `/api/bots/${id}`, { sandbox: loosen });
      expect(res.status).toBe(403);
      expect(JSON.parse(stored() ?? "{}")).toMatchObject({ mode: "on", network: "none" });
      expect(JSON.parse(stored() ?? "{}").extraWritable).toBeUndefined();
    }
    const made = await call(app, "POST", "/api/bots", { name: "沙箱關", sandbox: { mode: "off" } });
    expect(made.status).toBe(403);
  });

  it("loosening with the approve key is allowed; back to the default stores null", async () => {
    const app = await boot();
    const id = app.core.defaultBotId;
    await call(app, "PATCH", `/api/bots/${id}`, { sandbox: { mode: "on", network: "none" } });
    const res = await call(
      app,
      "PATCH",
      `/api/bots/${id}`,
      { sandbox: { mode: "auto", network: "open", extraWritable: [] } },
      app.uiHeaders,
    );
    expect(res.status).toBe(200);
    expect(app.core.store.bots.get(id)?.sandbox ?? null).toBeNull();
  });

  it("the whole disk or home folder is never a writable folder; bad values are a 400", async () => {
    const app = await boot();
    const id = app.core.defaultBotId;
    for (const sandbox of [{ extraWritable: ["/"] }, { mode: "sometimes" }, { extraWritable: ["rel/dir"] }]) {
      const res = await call(app, "PATCH", `/api/bots/${id}`, { sandbox }, app.uiHeaders);
      expect(res.status).toBe(400);
    }
  });

  it("the phone cannot send a sandbox setting at all", async () => {
    const app = await boot();
    const ops = teamOps(app.team);
    const update = ops["team.bots.update"];
    expect(update).toBeDefined();
    await expect(
      Promise.resolve().then(() => update?.[1]({ botId: app.core.defaultBotId, sandbox: { mode: "on" } })),
    ).rejects.toBeInstanceOf(RpcError);
  });
});

describe("the bot editor's sandbox draft (pure)", () => {
  it("reads the stored text, and sends only a change", () => {
    expect(sandboxDraft(null)).toEqual({ mode: "auto", network: "open", extra: "" });
    expect(sandboxDraft("not json")).toEqual({ mode: "auto", network: "open", extra: "" });
    const start = sandboxDraft(JSON.stringify({ mode: "on", network: "none", extraWritable: ["/a", "/b"] }));
    expect(start).toEqual({ mode: "on", network: "none", extra: "/a\n/b" });
    expect(sandboxBody(start, { ...start, extra: " /a \n\n/b" })).toBeUndefined();
    expect(sandboxBody(start, { ...start, mode: "off" })).toEqual({
      mode: "off",
      network: "none",
      extraWritable: ["/a", "/b"],
    });
  });
});
