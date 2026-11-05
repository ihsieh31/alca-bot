import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type DesktopApp, startDesktop } from "../src/index.ts";

/**
 * Design §0.2.3: resuming the ledger and a run's steps after a cursor; a
 * cursor whose rows were pruned answers 410 with the oldest kept seq and
 * how to start over, never a silent empty list.
 */

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function boot(): Promise<DesktopApp> {
  const dir = mkdtempSync(join(tmpdir(), "alca-dispatch-events-"));
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

const get = (app: DesktopApp, path: string) =>
  fetch(`${app.server.url}${path}`, { headers: { authorization: `Bearer ${app.token}` } });

describe("ledger and step resume (design §0.2.3)", () => {
  it("dispatch events resume after a cursor; a pruned dispatch is 410 for a cursor, 404 without one", async () => {
    const app = await boot();
    const s = app.core.store;
    const d = s.dispatches.open({ botId: app.core.defaultBotId, threadId: "thr_x", level: "autonomous" });
    s.dispatches.event(d.id, "outward", Date.now(), { detail: { tool: "mail_send", summary: "私密內容" } });
    const all = await get(app, `/api/dispatches/${d.id}/events`);
    expect(all.status).toBe(200);
    const body = (await all.json()) as {
      events: Array<{ seq: number; kind: string; detail?: object }>;
      next: number;
    };
    expect(body.events.map((e) => e.kind)).toEqual(["queued", "outward"]);
    // Whitelisted detail only.
    expect(body.events[1]?.detail).toEqual({ tool: "mail_send" });
    const first = body.events[0]!.seq;
    const after = await get(app, `/api/dispatches/${d.id}/events?after=${first}`);
    expect(((await after.json()) as typeof body).events.map((e) => e.kind)).toEqual(["outward"]);
    // Prune it (past the 30-day ledger retention).
    s.db
      .prepare("UPDATE dispatches SET status = 'settled', outcome = 'done', finished_at = 1 WHERE id = ?")
      .run(d.id);
    s.dispatches.prune(Date.now());
    const gone = await get(app, `/api/dispatches/${d.id}/events?after=${body.next}`);
    expect(gone.status).toBe(410);
    expect(await gone.json()).toMatchObject({
      error: "gone",
      minSeq: null,
      refetch: expect.stringContaining("重新讀取"),
    });
    expect((await get(app, `/api/dispatches/${d.id}/events`)).status).toBe(404);
  });

  it("a run's steps: a cursor removed with the conversation is 410; no cursor still says expired", async () => {
    const app = await boot();
    const s = app.core.store;
    const t = app.core.createThread();
    s.runs.start({ id: "run_gone", threadId: t.id, initiator: { kind: "user", id: "u" } });
    for (let seq = 0; seq < 3; seq++)
      s.runs.appendEvent({ runId: "run_gone", seq, type: "x", payload: { seq } });
    const ok = await get(app, "/api/runs/run_gone/events?after=0");
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as unknown[]).length).toBe(2);
    s.runs.finish("run_gone", "completed");
    s.threads.erase(t.id);
    const gone = await get(app, "/api/runs/run_gone/events?after=1");
    expect(gone.status).toBe(410);
    expect(await gone.json()).toMatchObject({ error: "gone", minSeq: null });
    expect(await (await get(app, "/api/runs/run_gone/events")).json()).toEqual({ expired: true });
  });
});
