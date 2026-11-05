import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDataKey } from "@alca/os";
import { isSealedText, SealKeyMismatchError, sealStatus } from "@alca/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openVault } from "../src/data-dir.ts";
import { DataKeyStartError } from "../src/data-seal.ts";
import { startDesktop } from "../src/index.ts";

/**
 * Phase F2 through the desktop (next round R7): the data key is made once
 * in the vault and the store seals with it; a database sealed with a key the
 * vault no longer has stops the start without minting a new key; 設定 → 資料
 * shows the state and drops the old plaintext backups only once everything
 * is sealed (approve key; one audit row).
 */

vi.setConfig({ testTimeout: 30_000 });

const MARK = "OKAPI-F2-DESKTOP-3307";
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "alca-seal-desk-"));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

async function boot(dir: string) {
  const app = await startDesktop({ engine: "demo", dataDir: dir, port: 0, agents: "direct", browser: "off" });
  let open = true;
  const close = async () => {
    if (open) await app.close();
    open = false;
  };
  cleanups.push(close);
  const api = (method: string, path: string, o: { key?: boolean } = {}) =>
    fetch(`${app.server.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${app.token}`,
        ...(o.key === false ? {} : app.uiHeaders),
        "content-type": "application/json",
      },
      ...(method === "GET" ? {} : { body: "{}" }),
    });
  // biome-ignore lint/suspicious/noExplicitAny: test helper reads arbitrary JSON
  const json = async (r: Response) => (await r.json()) as any;
  return { app, api, json, close };
}

describe("the data key at start (R7.5)", () => {
  it("is made once in the vault; new messages are sealed; a restart reuses it", async () => {
    const dir = tmp();
    const a = await boot(dir);
    const s = a.app.core.store;
    expect(s.sealer).toBeDefined();
    expect(s.sealCheck).toBe("new");
    const ring = await getDataKey(openVault(dir, "file"));
    expect(ring?.current).toBe(1);
    s.threads.create("thr_a", null);
    s.threads.addMessage({
      id: "msg_a",
      threadId: "thr_a",
      runId: null,
      role: "user",
      content: `${MARK}-msg`,
    });
    const stored = (
      s.db.prepare("SELECT content FROM messages WHERE id = 'msg_a'").get() as { content: string }
    ).content;
    expect(isSealedText(stored)).toBe(true);
    await a.close();
    const b = await boot(dir);
    expect(b.app.core.store.sealCheck).toBe("ok");
    expect(b.app.core.store.threads.messages("thr_a")[0]?.content).toBe(`${MARK}-msg`);
  });

  it("a sealed database whose key left the vault: the start stops, and no new key is made", async () => {
    const dir = tmp();
    const a = await boot(dir);
    await a.close();
    const vault = openVault(dir, "file");
    await vault.delete("core.dbKey");
    await expect(
      startDesktop({ engine: "demo", dataDir: dir, port: 0, agents: "direct", browser: "off" }),
    ).rejects.toThrow(DataKeyStartError);
    expect(await getDataKey(openVault(dir, "file"))).toBeUndefined();
  });

  it("another key in the vault: the store refuses before writing", async () => {
    const dir = tmp();
    const a = await boot(dir);
    await a.close();
    const vault = openVault(dir, "file");
    await vault.set(
      "core.dbKey",
      JSON.stringify({ v: 1, current: 1, keys: { "1": Buffer.alloc(32, 7).toString("base64") } }),
    );
    await expect(
      startDesktop({ engine: "demo", dataDir: dir, port: 0, agents: "direct", browser: "off" }),
    ).rejects.toThrow(SealKeyMismatchError);
  });
});

describe("設定 → 資料 → 加密 (R7.5 step 5)", () => {
  it("shows the state and where the vault key is; drops the old backups only once all is sealed", async () => {
    const dir = tmp();
    const { app, api, json } = await boot(dir);
    const s = app.core.store;
    // Rows from before the key (raw SQL, plaintext) and a backup that holds them.
    const at = new Date(Date.now() - 3_600_000).toISOString();
    s.db
      .prepare("INSERT INTO threads (id, title, created_at, updated_at) VALUES ('thr_x', 't', ?, ?)")
      .run(at, at);
    s.db
      .prepare(
        "INSERT INTO messages (id, thread_id, role, content, created_at) VALUES ('msg_x', 'thr_x', 'user', ?, ?)",
      )
      .run(`${MARK}-old`, at);
    await s.jobs.run("backup", new Date(Date.now() - 60_000).toISOString(), "daily", 7);

    let v = await json(await api("GET", "/api/settings/encryption"));
    expect(v.on).toBe(true);
    expect(v.keyName).toBe("core.dbKey");
    expect(v.vault.where).toBe("file");
    expect(v.vault.text).toContain("vault.key");
    expect(v.remaining).toBe(1);
    expect(v.backups.length).toBe(1);
    expect(v.canDropBackups).toBe(false);

    // The approve key is needed (deleting backups cannot be undone), then the precondition.
    expect(
      (await api("POST", "/api/settings/encryption/drop-plaintext-backups", { key: false })).status,
    ).toBe(403);
    const early = await api("POST", "/api/settings/encryption/drop-plaintext-backups");
    expect(early.status).toBe(409);
    expect((await json(early)).error).toMatch(/尚未加密/);

    await s.jobs.run("sealPass", null);
    expect(sealStatus(s.db).remaining).toBe(0);
    v = await json(await api("GET", "/api/settings/encryption"));
    expect(v.remaining).toBe(0);
    expect(v.canDropBackups).toBe(true);
    const done = await api("POST", "/api/settings/encryption/drop-plaintext-backups");
    expect(done.status).toBe(200);
    expect((await json(done)).removed.length).toBe(1);
    v = await json(await api("GET", "/api/settings/encryption"));
    expect(v.backups).toEqual([]);
    const audit = s.db
      .prepare("SELECT action, detail FROM audit_log WHERE action = 'data.backups_dropped'")
      .all() as Array<{ action: string; detail: string }>;
    expect(audit.length).toBe(1);
    expect(audit[0]?.detail).not.toContain(MARK);
  });
});
