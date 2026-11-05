import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { anchorPath, appendAudit, auditTail, backupNow, openStore, writeAnchor } from "@alca/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dbCli, writeCorePid } from "../src/db-cli.ts";
import { startDesktop } from "../src/index.ts";

// Next round §3: `alca db verify` and 設定 → 資料 drain the store's one
// verifier. Fake audit rows only.

vi.setConfig({ testTimeout: 30_000 });

const dirs: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "alca-dbverify-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function run(args: string[]): { code: number; out: string } {
  const lines: string[] = [];
  const code = dbCli(args, (l) => lines.push(l));
  return { code, out: lines.join("\n") };
}

function seeded(n: number): { root: string; dbPath: string } {
  const root = tmp();
  const dbPath = join(root, "state.sqlite");
  const s = openStore(dbPath);
  for (let i = 0; i < n; i++)
    appendAudit(s.db, {
      initiator: { kind: "user", id: "u_fake" },
      actor: { kind: "bot", id: "b_fake" },
      action: "browser_click",
      actionClass: "write",
      decision: "allow",
      detail: { secret: "do-not-show", i },
    });
  s.close();
  return { root, dbPath };
}

function tamper(dbPath: string, sql: string) {
  const s = openStore(dbPath);
  s.db.exec("DROP TRIGGER audit_log_no_update; DROP TRIGGER audit_log_no_delete;");
  s.db.exec(sql);
  s.close();
}

describe("alca db verify", () => {
  it("exit 0 when the chain holds, with the anchor and quick_check; also beside a running core", () => {
    const { root, dbPath } = seeded(12);
    const s = openStore(dbPath);
    const t = auditTail(s.db);
    s.close();
    writeAnchor(anchorPath(dbPath), {
      lastId: t?.id ?? 0,
      lastHash: t?.hash ?? "",
      count: 12,
      at: new Date().toISOString(),
    });
    const drop = writeCorePid(root);
    const r = run(["verify", "--data-dir", root]);
    drop();
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/稽核紀錄：12 筆，hash 鏈完整；與錨點一致/);
    expect(r.out).toContain("資料庫檢查：ok");
  });

  it("exit 1 and the row, time, action and reason when a row was changed; --json has the shape", () => {
    const { root, dbPath } = seeded(10);
    tamper(dbPath, "UPDATE audit_log SET target = 'x' WHERE id = 7");
    const r = run(["verify", "--data-dir", root]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/✗ 稽核紀錄在第 7 筆（.*action=browser_click）斷開：hash 不符/);
    expect(r.out).toContain("alca db verify --file");
    expect(r.out).not.toContain("do-not-show");
    const j = JSON.parse(run(["verify", "--data-dir", root, "--json"]).out) as Record<string, unknown>;
    expect(j).toMatchObject({ ok: false, brokenAt: { id: 7, reason: "hash" }, total: 10, integrity: "ok" });
  });

  it("exit 1 when the log ends before the anchor (a cut-off tail or an older backup)", () => {
    const { root, dbPath } = seeded(20);
    const s = openStore(dbPath);
    const t = auditTail(s.db);
    s.close();
    writeAnchor(anchorPath(dbPath), {
      lastId: t?.id ?? 0,
      lastHash: t?.hash ?? "",
      count: 20,
      at: "2026-11-05T01:00:00.000Z",
    });
    tamper(dbPath, "DELETE FROM audit_log WHERE id > 17");
    const r = run(["verify", "--data-dir", root]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("比錨點少 3 筆");
  });

  it("--file checks a backup without the anchor; exit 3 without a database; exit 2 on bad usage", () => {
    const { root, dbPath } = seeded(4);
    const s = openStore(dbPath);
    const file = backupNow(s.db, dbPath);
    s.close();
    tamper(dbPath, "DELETE FROM audit_log WHERE id = 2");
    expect(run(["verify", "--data-dir", root]).code).toBe(1);
    const b = run(["verify", "--data-dir", root, "--file", file]);
    expect(b.code).toBe(0);
    expect(b.out).toContain("備份檔不比對錨點");
    expect(run(["verify", "--data-dir", tmp()]).code).toBe(3);
    expect(run(["verify", "--data-dir", root, "--bogus"]).code).toBe(2);
  });
});

describe("設定 → 資料", () => {
  async function boot() {
    const dir = tmp();
    const app = await startDesktop({ engine: "demo", dataDir: dir, port: 0, agents: "direct" });
    cleanups.push(() => app.close());
    const api = async (method: string, path: string) => {
      const res = await fetch(`${app.server.url}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${app.token}`,
          ...app.uiHeaders,
          "content-type": "application/json",
        },
        ...(method === "GET" ? {} : { body: "{}" }),
      });
      // biome-ignore lint/suspicious/noExplicitAny: test helper reads arbitrary JSON
      return { status: res.status, body: (await res.json()) as any };
    };
    return { app, api, dir };
  }

  it("shows the retention policy; without the agents clock it says nothing runs hourly", async () => {
    const { api } = await boot();
    const d = await api("GET", "/api/settings/data");
    expect(d.status).toBe(200);
    expect(d.body).toMatchObject({
      retention: { runEventsDays: 90, jobEventsDays: 90, externalDays: 90, dailyBackups: 7 },
      hourly: false,
    });
    const b = await api("GET", "/api/settings/backups");
    expect(b.body).toMatchObject({ keep: 5, keepDaily: 7 });
  });

  it("驗證稽核紀錄 answers a green line, then a red one with a diagnostic that carries no detail", async () => {
    const { app, api } = await boot();
    for (let i = 0; i < 3; i++)
      appendAudit(app.core.store.db, {
        initiator: { kind: "user", id: "u_fake" },
        actor: { kind: "bot", id: "b_fake" },
        action: "shell",
        actionClass: "write",
        decision: "allow",
        detail: { secret: "do-not-show" },
      });
    const ok = await api("POST", "/api/settings/verify");
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);
    expect(ok.body.lines[0]).toMatch(/hash 鏈完整/);
    app.core.store.db.exec("DROP TRIGGER audit_log_no_update");
    app.core.store.db.prepare("UPDATE audit_log SET actor_id = 'someone' WHERE id = 2").run();
    const bad = await api("POST", "/api/settings/verify");
    expect(bad.body.ok).toBe(false);
    expect(bad.body.lines[0]).toMatch(/第 2 筆.*action=shell/);
    expect(JSON.parse(bad.body.diagnostic)).toMatchObject({ brokenAt: { id: 2, reason: "hash" } });
    expect(bad.body.diagnostic).not.toContain("do-not-show");
  });

  it("an unreadable data folder answers a plain error, not a crash", async () => {
    const root = tmp();
    writeFileSync(join(root, "state.sqlite"), "not a database");
    expect(run(["verify", "--data-dir", root]).code).toBe(3);
  });
});
