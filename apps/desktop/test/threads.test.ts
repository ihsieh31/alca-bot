import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startDesktop } from "../src/index.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), "alca-threads-"));
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
  return { app, api };
}

describe("desktop thread list: paging, archive, delete (P13 A6)", () => {
  it("pages with ?limit and ?before, and the pages add up to every thread once", async () => {
    const { app, api } = await boot();
    for (let i = 0; i < 7; i++) app.core.createThread(`對話 ${i}`);
    const ids: string[] = [];
    let before = "";
    for (let n = 0; n < 5; n++) {
      const r = await api(
        "GET",
        `/api/threads?limit=3${before ? `&before=${encodeURIComponent(before)}` : ""}`,
      );
      expect(r.status).toBe(200);
      ids.push(...r.body.map((t: { id: string }) => t.id));
      if (r.body.length < 3) break;
      const last = r.body.at(-1);
      before = `${last.updatedAt}~${last.id}`;
    }
    expect(ids).toHaveLength(7);
    expect(new Set(ids).size).toBe(7);
    // A malformed cursor is ignored, not an error.
    expect((await api("GET", "/api/threads?before=nope")).status).toBe(200);
  });

  it("archives, lists archived, brings back; deletes for good; refuses a thread a trigger still uses", async () => {
    const { app, api } = await boot();
    const a = app.core.createThread("要封存的");
    const b = app.core.createThread("要刪的");
    expect((await api("POST", `/api/threads/${a.id}/archive`, {})).body.archivedAt).not.toBeNull();
    expect((await api("GET", "/api/threads")).body.map((t: { id: string }) => t.id)).not.toContain(a.id);
    expect((await api("GET", "/api/threads?archived=1")).body.map((t: { id: string }) => t.id)).toEqual([
      a.id,
    ]);
    await api("POST", `/api/threads/${a.id}/archive`, { archived: false });
    expect((await api("GET", "/api/threads")).body.map((t: { id: string }) => t.id)).toContain(a.id);

    app.core.store.db
      .prepare(
        "INSERT INTO triggers (id, bot_id, thread_id, name, source, created_at) VALUES ('trg_1', ?, ?, '看信', 'manual', ?)",
      )
      .run(b.botId as string, b.id, new Date().toISOString());
    const refused = await api("DELETE", `/api/threads/${b.id}`);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain("觸發器");
    app.core.store.db.prepare("UPDATE triggers SET enabled = 0 WHERE id = 'trg_1'").run();
    expect((await api("DELETE", `/api/threads/${b.id}`)).body).toEqual({ deleted: true, backups: "queued" });
    expect((await api("GET", `/api/threads/${b.id}`)).status).toBe(404);
    expect((await api("DELETE", `/api/threads/${b.id}`)).status).toBe(404);
    expect((await api("POST", `/api/threads/${b.id}/messages`, { text: "還在嗎" })).status).toBe(404);
  });
});
