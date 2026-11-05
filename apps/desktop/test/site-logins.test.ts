import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SiteLogins } from "@alca/connectors";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type DesktopApp, startDesktop } from "../src/index.ts";
import { connectorOps } from "../src/link-connector-ops.ts";
import { setLogLevel, setLogSink } from "../src/log.ts";
import { formOrigin, loginBody, loginLine } from "../ui/site-logins-model.ts";

/**
 * Design §0.2.7: the way in for website passwords. Saving and removing need
 * the approve key; the password never shows up in a response (list, save,
 * an error), a log line, the audit log, the phone's list, or any file in the
 * data folder in the clear — the vault keeps it sealed, and the browser's
 * `SecretSource` still gets it back for exactly that origin.
 */

// biome-ignore lint/suspicious/noExplicitAny: test JSON
type Json = any;

const PASSWORD = "Pw-only-in-the-vault-7f3c9e1a";
const SITE = "https://hr.example.com";

/** Every file under the data folder (db, wal, logs, vault, backups). */
function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else out.push(p);
  }
  return out;
}

/** The password in any form a careless write would leave it: raw, base64, hex, JSON-escaped. */
const leaks = (text: Buffer): string[] =>
  [
    PASSWORD,
    Buffer.from(PASSWORD).toString("base64"),
    Buffer.from(PASSWORD).toString("hex"),
    JSON.stringify(PASSWORD).slice(1, -1),
  ].filter((form) => text.includes(form));

describe("website logins (design §0.2.7)", () => {
  let app: DesktopApp;
  let dir: string;
  const lines: string[] = [];
  let restoreSink: () => void;
  const call = async (method: string, path: string, body?: unknown, approve = true) => {
    const res = await fetch(`${app.server.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${app.token}`,
        ...(approve ? app.uiHeaders : { origin: app.server.url }),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, text, body: (text ? JSON.parse(text) : null) as Json };
  };
  const responses: string[] = [];

  beforeAll(async () => {
    restoreSink = setLogSink({ err: (l) => lines.push(l), out: (l) => lines.push(l) });
    // Anything that bypasses the core's log (a stray console call) is caught too.
    for (const m of ["log", "info", "warn", "error", "debug"] as const)
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" ")));
    setLogLevel("debug");
    dir = mkdtempSync(join(tmpdir(), "alca-site-logins-"));
    app = await startDesktop({
      engine: "demo",
      dataDir: dir,
      port: 0,
      browser: "off",
      vaultKeySource: "file",
    });
  }, 30_000);
  afterAll(async () => {
    await app?.close();
    restoreSink?.();
    vi.restoreAllMocks();
    setLogLevel("info");
    rmSync(dir, { recursive: true, force: true });
  });

  it("saving needs the approve key; nothing is kept without it", async () => {
    const r = await call("POST", "/api/connectors/logins", { origin: SITE, password: PASSWORD }, false);
    expect(r.status).toBe(403);
    responses.push(r.text);
    expect((await call("GET", "/api/connectors/logins")).body).toEqual([]);
  });

  it("refuses http and an empty password without echoing what was sent", async () => {
    const http = await call("POST", "/api/connectors/logins", {
      origin: "http://hr.example.com",
      password: PASSWORD,
    });
    expect(http.status).toBe(400);
    const empty = await call("POST", "/api/connectors/logins", { origin: SITE, password: "" });
    expect(empty.status).toBe(400);
    const bot = await call("POST", "/api/connectors/logins", {
      origin: SITE,
      password: PASSWORD,
      botIds: ["bot_nope"],
    });
    expect(bot.status).toBe(400);
    responses.push(http.text, empty.text, bot.text);
  });

  it("saves, lists and removes; the password only comes back out of the vault for that origin", async () => {
    const botId = app.core.defaultBotId;
    const saved = await call("POST", "/api/connectors/logins", {
      origin: `${SITE}/login?next=/home`,
      username: "mei@example.com",
      password: PASSWORD,
      label: "公司 HR",
      botIds: [botId],
    });
    expect(saved.status).toBe(201);
    responses.push(saved.text);
    expect(saved.body).toHaveLength(1);
    const row = saved.body[0];
    expect(row).toMatchObject({
      origin: SITE,
      username: "mei@example.com",
      label: "公司 HR",
      botIds: [botId],
    });
    expect(row.bots[0].id).toBe(botId);
    expect(Object.keys(row).sort()).toEqual(["botIds", "bots", "id", "label", "origin", "username"]);

    const list = await call("GET", "/api/connectors/logins");
    responses.push(list.text);
    // The phone's list (Link op, chat scope) is the same view.
    const phone = await connectorOps(app.connectors)["connectors.logins"]?.[1]({});
    responses.push(JSON.stringify(phone));
    expect(JSON.stringify(phone)).toContain(row.id);

    // Sealed, but the browser's SecretSource still gets it — for exactly that origin and bot.
    const source = new SiteLogins(app.connectors.setup.vault);
    expect(await source.value(botId, row.id, `${SITE}/anything`)).toBe(PASSWORD);
    expect(await source.value(botId, row.id, "https://evil.example.com")).toBeUndefined();
    expect(await source.value("bot_other", row.id, SITE)).toBeUndefined();

    const audit = app.core.store.db
      .prepare("SELECT action, target, detail FROM audit_log WHERE action LIKE 'site_login.%' ORDER BY id")
      .all() as Array<{ action: string; target: string; detail: string }>;
    expect(audit.map((a) => a.action)).toEqual(["site_login.saved"]);
    expect(audit[0]?.target).toBe(row.id);

    const noKey = await call("DELETE", `/api/connectors/logins/${row.id}`, undefined, false);
    expect(noKey.status).toBe(403);
    const removed = await call("DELETE", `/api/connectors/logins/${row.id}`);
    expect(removed.status).toBe(200);
    expect(removed.body).toEqual([]);
    expect((await call("DELETE", `/api/connectors/logins/${row.id}`)).status).toBe(404);
    expect(await source.value(botId, row.id, SITE)).toBeUndefined();
  });

  it("the password is in no response, log line, audit row or file in the clear", async () => {
    // Save one more so the vault on disk holds it while we look.
    const again = await call("POST", "/api/connectors/logins", { origin: SITE, password: PASSWORD });
    expect(again.status).toBe(201);
    responses.push(again.text);
    for (const r of responses) expect(leaks(Buffer.from(r))).toEqual([]);
    // The sink did capture the core's lines, including the save / remove lines.
    expect(lines.some((l) => l.includes("site login saved"))).toBe(true);
    expect(lines.some((l) => l.includes("site login removed"))).toBe(true);
    expect(leaks(Buffer.from(lines.join("\n")))).toEqual([]);
    const auditAll = app.core.store.db.prepare("SELECT * FROM audit_log").all();
    expect(leaks(Buffer.from(JSON.stringify(auditAll)))).toEqual([]);
    // Flush the WAL so the db file holds every row, then read every file in the data folder.
    app.core.store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const all = files(dir);
    expect(all.some((f) => f.endsWith("vault.json"))).toBe(true);
    for (const f of all) expect({ f, leaks: leaks(readFileSync(f)) }).toEqual({ f, leaks: [] });
  });
});

describe("the 網站登入 form (pure)", () => {
  it("https only; a bare host counts as https; the error never echoes the password", () => {
    expect(formOrigin("example.com/login")).toBe("https://example.com");
    expect(formOrigin("http://example.com")).toBeUndefined();
    expect(formOrigin("")).toBeUndefined();
    const bad = loginBody({
      origin: "http://x.com",
      username: "",
      password: PASSWORD,
      label: "",
      botIds: [],
    });
    expect(JSON.stringify(bad)).not.toContain(PASSWORD);
    expect(loginBody({ origin: "x.com", username: "", password: "", label: "", botIds: [] })).toEqual({
      error: "需要密碼",
    });
    expect(
      loginBody({ origin: " x.com ", username: " a ", password: "p", label: "", botIds: ["b", "b"] }),
    ).toEqual({ body: { origin: "https://x.com", password: "p", username: "a", botIds: ["b"] } });
  });

  it("the row says who may use it", () => {
    const l = { id: "login_1", origin: "https://hr.example.com", bots: [] };
    expect(loginLine(l)).toEqual({
      title: "hr.example.com",
      account: "沒有帳號名稱",
      who: "所有 bot 都能用",
    });
    expect(loginLine({ ...l, label: "HR", username: "mei", bots: [{ id: "b", name: "小幫手" }] })).toEqual({
      title: "HR（hr.example.com）",
      account: "帳號 mei",
      who: "只給 小幫手",
    });
  });
});
