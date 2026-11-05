import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type DesktopApp, startDesktop } from "../src/index.ts";

/** Phase 6: the routes behind the worker panel, the snapshot list and the bot editor's harness settings. */

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function boot(): Promise<DesktopApp> {
  const dir = mkdtempSync(join(tmpdir(), "alca-worker-panel-"));
  const app = await startDesktop({
    engine: "demo",
    dataDir: dir,
    port: 0,
    agents: "router",
    browser: "off",
    openUrl: () => true,
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

describe("worker panel routes (Phase 6)", () => {
  it("answering a worker as the person needs the approve key", async () => {
    const app = await boot();
    const bare = await call(app, "POST", "/api/workers/wkr_nope/answer", { answers: ["好"] });
    expect(bare.status).toBe(403);
    const keyed = await call(app, "POST", "/api/workers/wkr_nope/answer", { answers: ["好"] }, app.uiHeaders);
    expect(keyed.status).toBe(404);
  });

  it("snapshots: a filter is required; an unknown snapshot is never restored", async () => {
    const app = await boot();
    expect((await call(app, "GET", "/api/snapshots")).status).toBe(400);
    const list = await call(app, "GET", "/api/snapshots?dispatch=dsp_nope");
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual([]);
    const restore = await call(app, "POST", "/api/snapshots/restore", {
      repo: "/nowhere",
      ref: "refs/alca/snapshots/dsp_nope/1",
    });
    expect(restore.status).toBe(409);
    expect((await call(app, "POST", "/api/snapshots/purge", {})).status).toBe(400);
    expect((await call(app, "POST", "/api/snapshots/purge", { ref: "refs/x" })).status).toBe(400);
    const purged = await call(app, "POST", "/api/snapshots/purge", { dispatchId: "dsp_nope" });
    expect(await purged.json()).toEqual({ purged: 0 });
  });

  it("the bot editor's harness settings are checked and stored; caps are clamped, unknown keys dropped", async () => {
    const app = await boot();
    const id = app.core.defaultBotId;
    const res = await call(app, "PATCH", `/api/bots/${id}`, {
      harness: {
        default: "coding",
        reviewer: true,
        coding: { maxSteps: 9999 },
        approvalLevel: "full_access",
      },
    });
    expect(res.status).toBe(200);
    const stored = JSON.parse(app.core.store.bots.get(id)?.harness ?? "{}");
    expect(stored).toEqual({ default: "coding", reviewer: true, coding: { maxSteps: 500 } });
    // the level was not touched by anything inside `harness`
    expect(app.core.store.bots.get(id)?.approvalLevel).not.toBe("full_access");
    expect((await call(app, "PATCH", `/api/bots/${id}`, { harness: "coding" })).status).toBe(400);
    await call(app, "PATCH", `/api/bots/${id}`, { harness: null });
    expect(app.core.store.bots.get(id)?.harness).toBeNull();
  });

  it("turning 完全授權 on without the approve key is refused", async () => {
    const app = await boot();
    const id = app.core.defaultBotId;
    const bare = await call(app, "PATCH", `/api/bots/${id}`, { approvalLevel: "full_access" });
    expect(bare.status).toBe(403);
    expect(app.core.store.bots.get(id)?.approvalLevel).not.toBe("full_access");
    const created = await call(app, "POST", "/api/bots", { name: "全權", approvalLevel: "full_access" });
    expect(created.status).toBe(403);
    expect(app.core.store.bots.list().some((b) => b.name === "全權")).toBe(false);
    const wrong = await call(
      app,
      "PATCH",
      `/api/bots/${id}`,
      { approvalLevel: "full_access" },
      { "x-alca-approve": "0".repeat(64), origin: app.server.url },
    );
    expect(wrong.status).toBe(403);
  });

  it("turning 完全授權 on with the approve key is allowed", async () => {
    const app = await boot();
    const id = app.core.defaultBotId;
    const keyed = await call(
      app,
      "PATCH",
      `/api/bots/${id}`,
      { approvalLevel: "full_access" },
      app.uiHeaders,
    );
    expect(keyed.status).toBe(200);
    expect(app.core.store.bots.get(id)?.approvalLevel).toBe("full_access");
    const made = await call(
      app,
      "POST",
      "/api/bots",
      { name: "全權", approvalLevel: "full_access" },
      app.uiHeaders,
    );
    expect(made.status).toBe(201);
  });

  it("keeping 完全授權 on or turning it off needs no approve key", async () => {
    const app = await boot();
    const id = app.core.defaultBotId;
    const level = () => app.core.store.bots.get(id)?.approvalLevel;
    await call(app, "PATCH", `/api/bots/${id}`, { approvalLevel: "full_access" }, app.uiHeaders);
    const kept = await call(app, "PATCH", `/api/bots/${id}`, {
      role: "寫程式",
      approvalLevel: "full_access",
    });
    expect(kept.status).toBe(200);
    expect(level()).toBe("full_access");
    const off = await call(app, "PATCH", `/api/bots/${id}`, { approvalLevel: "autonomous" });
    expect(off.status).toBe(200);
    expect(level()).toBe("autonomous");
  });
});
