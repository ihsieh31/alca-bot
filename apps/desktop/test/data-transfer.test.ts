import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startDesktop } from "../src/index.ts";
import { transferCli } from "../src/transfer-cli.ts";
import { type PerfView, perfLine } from "../ui/perf-line.ts";

/**
 * Phase F1 through the desktop (R2.2 / R5.6): 設定 → 資料 reads the perf
 * numbers; 現在備份 runs on the database worker; one conversation goes out as
 * a download and comes back as a new one, the import needing the approve key
 * (server and window lists agree); `alca export thread` / `alca import`.
 */

vi.setConfig({ testTimeout: 30_000 });

const MARK = "OKAPI-MARKER-5521-FAKE";
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "alca-transfer-"));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

async function boot(dir = tmp()) {
  const app = await startDesktop({ engine: "demo", dataDir: dir, port: 0, agents: "direct", browser: "off" });
  let open = true;
  const close = async () => {
    if (open) await app.close();
    open = false;
  };
  cleanups.push(close);
  const s = app.core.store;
  const at = new Date(Date.now() - 3_600_000).toISOString();
  s.db
    .prepare("INSERT INTO threads (id, title, created_at, updated_at) VALUES ('thr_x', ?, ?, ?)")
    .run(`${MARK}-title`, at, at);
  for (const [i, role] of ["user", "assistant"].entries())
    s.db
      .prepare("INSERT INTO messages (id, thread_id, role, content, created_at) VALUES (?, 'thr_x', ?, ?, ?)")
      .run(`msg_x${i}`, role, `${MARK}-${role}`, at);
  const api = async (method: string, path: string, body?: unknown, o: { key?: boolean } = {}) => {
    const res = await fetch(`${app.server.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${app.token}`,
        ...(o.key === false ? {} : app.uiHeaders),
        "content-type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : method === "GET" ? {} : { body: "{}" }),
    });
    return res;
  };
  // biome-ignore lint/suspicious/noExplicitAny: test helper reads arbitrary JSON
  const json = async (r: Response) => (await r.json()) as any;
  return { app, api, json, dir, close };
}

describe("設定 → 資料: perf, backup on the worker, export / import (Phase F1)", () => {
  it("GET /api/settings/perf: the loop window, slow calls in the past hour, the thresholds from the settings", async () => {
    const { api, json } = await boot();
    const r = await api("GET", "/api/settings/perf");
    expect(r.status).toBe(200);
    const b = await json(r);
    expect(b.now.loop.samples).toBeGreaterThanOrEqual(0);
    expect(b.now.thresholds).toEqual({
      slowSqlMs: 50,
      warnSqlMs: 200,
      loopP99Ms: 100,
      loopMaxMs: 1000,
      workerBatchMs: 25,
    });
    expect(typeof b.slowLastHour).toBe("number");
    expect(Array.isArray(b.warnings)).toBe(true);
    // The thresholds come from config.json (engineering.perf), read at start.
    const dir = tmp();
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ engineering: { perf: { slowSqlMs: 7, workerBatchMs: 40 } } }),
    );
    const tuned = await boot(dir);
    const t = await json(await tuned.api("GET", "/api/settings/perf"));
    expect(t.now.thresholds).toMatchObject({ slowSqlMs: 7, workerBatchMs: 40 });
    await tuned.close();
    // Paired devices cannot read 設定: no token, no answer.
    expect((await fetch(`${(await boot()).app.server.url}/api/settings/perf`)).status).toBe(401);
  });

  it("the 設定 line: 事件迴圈 p99 from the last closed hour, slow calls of the past hour", () => {
    const snap = (p99: number, samples: number) => ({
      loop: { p50: 1, p99, max: p99, samples },
      slow: [],
      top: [],
      lockWaitMs: { count: 0, max: 0 },
      jobs: {},
    });
    const v = (o: Partial<PerfView>): PerfView => ({
      now: snap(9, 10),
      slowLastHour: 0,
      warnLastHour: 0,
      warnings: [],
      ...o,
    });
    expect(perfLine(v({}))).toBe("事件迴圈：p99 9 ms｜慢查詢 0 筆（過去 1 小時）");
    expect(perfLine(v({ lastHour: snap(12.4, 5), slowLastHour: 3 }))).toBe(
      "事件迴圈：p99 12 ms｜慢查詢 3 筆（過去 1 小時）",
    );
    expect(perfLine(v({ now: snap(0, 0) }))).toBe("事件迴圈：p99 —｜慢查詢 0 筆（過去 1 小時）");
  });

  it("現在備份 runs on the database worker (its time shows in the perf jobs)", async () => {
    const { api, json, dir } = await boot();
    const made = await json(await api("POST", "/api/settings/backups"));
    expect(existsSync(join(dir, "backups", made.made))).toBe(true);
    const perf = await json(await api("GET", "/api/settings/perf"));
    expect(perf.now.jobs.backup).toBeDefined();
  });

  it("export → delete → import: a download the core keeps no copy of, back as a new conversation; import needs the approve key", async () => {
    const { app, api, json, dir } = await boot();
    const r = await api("POST", "/api/export", { scope: "thread", id: "thr_x" }, { key: false });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-disposition")).toMatch(
      /attachment; filename="alca-thread-thr_x-\d{8}\.alca-export"/,
    );
    const file = Buffer.from(await r.arrayBuffer());
    const head = JSON.parse(gunzipSync(file).toString("utf8").split("\n")[0] as string);
    expect(head).toMatchObject({
      format: 1,
      scope: "thread",
      id: "thr_x",
      sealed: false,
      counts: { messages: 2 },
    });
    expect(readdirSync(join(dir, "exports"))).toEqual([]);
    expect(statSync(join(dir, "exports")).mode & 0o777).toBe(0o700);

    expect((await api("DELETE", "/api/threads/thr_x")).status).toBe(200);
    const data = file.toString("base64");
    const refused = await api("POST", "/api/import", { data }, { key: false });
    expect(refused.status).toBe(403);
    const ok = await api("POST", "/api/import", { data });
    expect(ok.status).toBe(200);
    const got = await json(ok);
    expect(got.threadId).not.toBe("thr_x");
    expect(got.note).toMatch(/保留期/);
    expect(app.core.messages(got.threadId).map((m) => m.content)).toEqual([
      `${MARK}-user`,
      `${MARK}-assistant`,
    ]);
    expect(readdirSync(join(dir, "exports"))).toEqual([]);
    expect((await api("POST", "/api/export", { scope: "thread", id: "thr_none" })).status).toBe(404);
    expect((await api("POST", "/api/export", { scope: "bot", id: "bot_1" })).status).toBe(400);
  });

  it("a sealed export: a short passphrase is refused; the wrong one says so in plain words; the right one imports", async () => {
    const { api, json } = await boot();
    expect((await api("POST", "/api/export", { id: "thr_x", options: { passphrase: "short" } })).status).toBe(
      400,
    );
    const r = await api("POST", "/api/export", { id: "thr_x", options: { passphrase: "correct horse" } });
    const data = Buffer.from(await r.arrayBuffer()).toString("base64");
    const none = await api("POST", "/api/import", { data });
    expect((await json(none)).error).toMatch(/密語/);
    const wrong = await api("POST", "/api/import", { data, passphrase: "wrong horse" });
    expect(wrong.status).toBe(400);
    expect((await json(wrong)).error).toBe("密語不對，或檔案被改過");
    expect((await api("POST", "/api/import", { data, passphrase: "correct horse" })).status).toBe(200);
  });

  it("DELETE /api/threads/:id: by default the backups are scrubbed too; ?memories=1&backups=0 is recorded as asked", async () => {
    const { app, api, json, dir } = await boot();
    const made = (await json(await api("POST", "/api/settings/backups"))).made as string;
    const backup = join(dir, "backups", made);
    expect(readFileSync(backup).includes(MARK)).toBe(true);
    expect(await json(await api("DELETE", "/api/threads/thr_x"))).toEqual({
      deleted: true,
      backups: "queued",
    });
    const s = app.core.store;
    for (let i = 0; i < 200 && s.jobs.busy > 0; i++) await new Promise((r) => setTimeout(r, 25));
    expect(s.jobs.busy).toBe(0);
    expect(readFileSync(backup).includes(MARK)).toBe(false);
    expect(s.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE thread_id = 'thr_x'").get()).toEqual({
      n: 0,
    });

    const at = new Date().toISOString();
    s.db
      .prepare("INSERT INTO threads (id, title, created_at, updated_at) VALUES ('thr_y', 'y', ?, ?)")
      .run(at, at);
    const kept = await api("DELETE", "/api/threads/thr_y?memories=1&backups=0");
    expect(await json(kept)).toEqual({ deleted: true, backups: "kept" });
    const audit = s.db
      .prepare("SELECT detail FROM audit_log WHERE action = 'data.erased' ORDER BY id")
      .all() as Array<{ detail: string }>;
    expect(audit.map((r) => JSON.parse(r.detail))).toEqual([
      { scope: "thread", memories: false, backups: true },
      { scope: "thread", memories: true, backups: false },
    ]);
  });

  it("the window's approve-key list is the server's (an import from a plain window opens one that can)", () => {
    const rules = (file: string) => {
      const src = readFileSync(new URL(file, import.meta.url), "utf8");
      const block = /const NEEDS_KEY[^=]*= \[([\s\S]*?)\n\];/.exec(src)?.[1] ?? "";
      return [...block.matchAll(/\["(\w+)", (\/.*\/)\]/g)].map((m) => `${m[1]} ${m[2]}`);
    };
    const server = rules("../src/ui-session.ts");
    expect(server).toContain("POST /^\\/api\\/import$/");
    expect(rules("../ui/api.ts")).toEqual(server);
  });

  it("alca export thread / alca import: through the running core, or straight from the database when it is stopped", async () => {
    const { app, dir, close } = await boot();
    const lines: string[] = [];
    const cli = (cmd: "export" | "import", args: string[], extra: Parameters<typeof transferCli>[2] = {}) =>
      transferCli(cmd, [...args, "--data-dir", dir], { out: (l) => lines.push(l), ...extra });
    const core = { url: app.server.url, token: app.token };
    const viaCore = join(dir, "via-core.alca-export");
    expect(await cli("export", ["thread", "thr_x", "--out", viaCore], { core })).toBe(0);
    expect(statSync(viaCore).mode & 0o777).toBe(0o600);
    expect(lines.join("\n")).toMatch(/含對話全文/);
    // Not over an existing file.
    expect(await cli("export", ["thread", "thr_x", "--out", viaCore], { core })).toBe(1);
    // Importing beside a running core needs its approving window.
    expect(await cli("import", [viaCore])).toBe(3);
    expect(lines.join("\n")).toMatch(/設定 → 資料 → 匯入/);
    await close();

    const sealed = join(dir, "sealed.alca-export");
    const answers = ["correct horse", "correct horse"];
    const ask = async () => answers.shift() ?? "";
    expect(await cli("export", ["thread", "thr_x", "--out", sealed, "--passphrase"], { ask })).toBe(0);
    expect(await cli("import", [sealed, "--passphrase"], { ask: async () => "wrong horse" })).toBe(1);
    expect(lines.at(-1)).toMatch(/密語不對/);
    expect(await cli("import", [sealed, "--passphrase"], { ask: async () => "correct horse" })).toBe(0);
    expect(await cli("import", [viaCore])).toBe(0);
    expect(lines.filter((l) => l.includes("已匯入成新的對話"))).toHaveLength(2);
    expect(await cli("export", ["bot", "bot_1"])).toBe(2);
  });
});
