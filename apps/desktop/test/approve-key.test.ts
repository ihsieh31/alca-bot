import { spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { type DesktopApp, startDesktop } from "../src/index.ts";

/**
 * Review 2026-11-04b S2.2 (approving needs a key the bot cannot read), S2.3
 * (the token is not printed) and M5 (owner-only data folder on every start).
 */
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function boot(
  o: { dir?: string; uiCodes?: NodeJS.ReadableStream } = {},
): Promise<DesktopApp & { opened: string[] }> {
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), "alca-approve-key-"));
  const opened: string[] = [];
  const app = await startDesktop({
    engine: "demo",
    dataDir: dir,
    port: 0,
    agents: "direct",
    browser: "off",
    ...(o.uiCodes ? { uiCodes: o.uiCodes } : {}),
    openUrl: (u) => {
      opened.push(u);
      return true;
    },
  });
  cleanups.push(
    () => rmSync(dir, { recursive: true, force: true }),
    () => app.close(),
  );
  return Object.assign(app, { opened });
}

/** What a bot that read secrets.json could send: the token, nothing else. */
const withToken = (app: DesktopApp, method: string, path: string, body?: unknown, extra = {}) =>
  fetch(`${app.server.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${app.token}`, "content-type": "application/json", ...extra },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

const pendingPayment = (app: DesktopApp) =>
  app.core.gateway.authorize(
    {
      initiator: { kind: "agent", id: "b" },
      actor: { kind: "agent", id: app.core.defaultBotId },
      action: "pay_now",
      actionClass: "payment",
    },
    {},
  ).approvalId as string;

describe("S2.2: the local token alone cannot approve", () => {
  it("a token-only POST /api/approvals/:id is refused and the payment card stays pending", async () => {
    const app = await boot();
    const id = pendingPayment(app);
    // At b096d22 this approved the payment (the token was all it took).
    const res = await withToken(app, "POST", `/api/approvals/${id}`, { decision: "approved" });
    expect(res.status).toBe(403);
    expect(app.core.gateway.approval(id)?.status).toBe("pending");
    // A same-origin header the bot could forge is not enough either: the key is what counts.
    const forged = await withToken(
      app,
      "POST",
      `/api/approvals/${id}`,
      { decision: "approved" },
      {
        origin: app.server.url,
      },
    );
    expect(forged.status).toBe(403);
    // The key without an Origin (curl) is refused too.
    const noOrigin = await withToken(
      app,
      "POST",
      `/api/approvals/${id}`,
      { decision: "approved" },
      {
        "x-alca-approve": app.uiHeaders["x-alca-approve"],
      },
    );
    expect(noOrigin.status).toBe(403);
    // A window the core opened (key + same origin) can.
    const ok = await withToken(app, "POST", `/api/approvals/${id}`, { decision: "approved" }, app.uiHeaders);
    expect(ok.status).toBe(200);
    expect(app.core.gateway.approval(id)?.status).toBe("approved");
  });

  it("pairing a new device and widening a device's scopes need the key too (a fake phone could approve)", async () => {
    const app = await boot();
    expect((await withToken(app, "POST", "/api/link/pairings", {})).status).toBe(403);
    expect((await withToken(app, "POST", "/api/link/enrollments/enr_x", { code: "123456" })).status).toBe(
      403,
    );
    expect(
      (await withToken(app, "POST", "/api/link/devices/dev_x/scopes", { scopes: ["approve"] })).status,
    ).toBe(403);
    // Reading and chatting with the token still work.
    expect((await withToken(app, "GET", "/api/threads")).status).toBe(200);
  });

  it("a launch code is traded once for the key; a second try (someone else's) fails and is counted", async () => {
    const app = await boot();
    const url = app.openUrl;
    const code = /[#&]ui=([0-9a-f]+)/.exec(url)?.[1];
    expect(code).toBeTruthy();
    const first = await withToken(app, "POST", "/api/ui/session", { code });
    expect(first.status).toBe(200);
    const { approveKey } = (await first.json()) as { approveKey: string };
    expect(approveKey).toBe(app.uiHeaders["x-alca-approve"]);
    expect((await withToken(app, "POST", "/api/ui/session", { code })).status).toBe(403);
    expect((await withToken(app, "POST", "/api/ui/session", { code: "00".repeat(24) })).status).toBe(403);
    // The key is in no file of the data folder.
    for (const f of readdirSync(app.dataDir, { withFileTypes: true }))
      if (f.isFile()) expect(readFileSync(join(app.dataDir, f.name)).includes(approveKey)).toBe(false);
  });

  it("POST /api/ui/open asks the core to open a window with a fresh code (throttled)", async () => {
    const app = await boot();
    const r = await withToken(app, "POST", "/api/ui/open", { open: "pair" });
    expect(r.status).toBe(200);
    expect(app.opened.at(-1)).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#token=[0-9a-f]+&ui=[0-9a-f]+&open=pair$/);
    expect((await withToken(app, "POST", "/api/ui/open", {})).status).toBe(429);
  });
});

describe("S2.2: the desktop shell's window (launch codes over stdin)", () => {
  const approve = (app: DesktopApp, id: string, key: string) =>
    withToken(
      app,
      "POST",
      `/api/approvals/${id}`,
      { decision: "approved" },
      {
        "x-alca-approve": key,
        origin: app.server.url,
      },
    );

  it("a code the shell wrote on stdin is traded once for the key, which approves", async () => {
    const stdin = new PassThrough();
    const app = await boot({ uiCodes: stdin });
    const code = "ab".repeat(24);
    stdin.write(`${code}\n`);
    const r = await withToken(app, "POST", "/api/ui/session", { code });
    expect(r.status).toBe(200);
    const { approveKey } = (await r.json()) as { approveKey: string };
    const id = pendingPayment(app);
    expect((await approve(app, id, approveKey)).status).toBe(200);
    expect(app.core.gateway.approval(id)?.status).toBe("approved");
    // Once only.
    expect((await withToken(app, "POST", "/api/ui/session", { code })).status).toBe(403);
  });

  it("waits briefly for a line still on its way; refuses malformed lines and unknown codes", async () => {
    const stdin = new PassThrough();
    const app = await boot({ uiCodes: stdin });
    const late = "cd".repeat(24);
    const pending = withToken(app, "POST", "/api/ui/session", { code: late });
    setTimeout(() => stdin.write(`${late}\r\n`), 150);
    expect((await pending).status).toBe(200);
    // Not hex / too short: never registered, so trading it fails (after the grace).
    stdin.write("not-a-code\nabc\n");
    expect((await withToken(app, "POST", "/api/ui/session", { code: "abc" })).status).toBe(403);
    expect((await withToken(app, "POST", "/api/ui/session", { code: "ef".repeat(24) })).status).toBe(403);
  });

  it("without the shell's pipe no code comes from stdin", async () => {
    const app = await boot();
    const r = await withToken(app, "POST", "/api/ui/session", { code: "ab".repeat(24) });
    expect(r.status).toBe(403);
  });
});

describe("S2.3: the token is not printed", () => {
  it("main.ts prints the address without the token (as a service this is core.log)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alca-banner-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
    const child = spawn(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        main,
        "--data-dir",
        dir,
        "--port",
        "0",
        "--browser",
        "off",
        "--no-open",
      ],
      { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ALCA_OFFICIAL_SITE: "" } },
    );
    let out = "";
    child.stdout.on("data", (c: Buffer) => {
      out += c.toString("utf8");
    });
    child.stderr.on("data", (c: Buffer) => {
      out += c.toString("utf8");
    });
    const start = Date.now();
    while (!out.includes("按 Ctrl+C") && Date.now() - start < 25_000)
      await new Promise((r) => setTimeout(r, 50));
    child.kill("SIGTERM");
    await new Promise((r) => child.once("exit", r));
    const token = (JSON.parse(readFileSync(join(dir, "secrets.json"), "utf8")) as Record<string, string>)[
      "core.localToken"
    ] as string;
    expect(out).toContain("網址：http://127.0.0.1:");
    // At b096d22 the banner was 「開啟：http://127.0.0.1:4317/#token=<token>」.
    expect(out.includes(token)).toBe(false);
    expect(out).not.toContain("#token=");
  }, 40_000);
});

describe("E3: core.log as launchd writes it (mac test 2026-11-04b)", () => {
  it("the core's own output in <data>/logs/core.log carries no token and the file ends up 0600", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alca-corelog-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, "logs"), { recursive: true, mode: 0o700 });
    const log = join(dir, "logs", "core.log");
    // launchd opens StandardOutPath itself, with the umask (0644 at b0343040), and hands the fd over.
    writeFileSync(log, "");
    chmodSync(log, 0o644);
    const fd = openSync(log, "a");
    const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
    const child = spawn(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        main,
        "--data-dir",
        dir,
        "--port",
        "0",
        "--browser",
        "off",
        "--no-open",
      ],
      {
        stdio: ["ignore", fd, fd],
        env: { ...process.env, ALCA_OFFICIAL_SITE: "", ALCA_SUPERVISED: "launchd" },
      },
    );
    closeSync(fd);
    const start = Date.now();
    while (!readFileSync(log, "utf8").includes("按 Ctrl+C") && Date.now() - start < 25_000)
      await new Promise((r) => setTimeout(r, 50));
    child.kill("SIGTERM");
    await new Promise((r) => child.once("exit", r));
    const text = readFileSync(log, "utf8");
    const token = (JSON.parse(readFileSync(join(dir, "secrets.json"), "utf8")) as Record<string, string>)[
      "core.localToken"
    ] as string;
    expect(text).toContain("網址：http://127.0.0.1:");
    expect(text.includes(token)).toBe(false);
    expect(text).not.toContain("#token=");
    expect(statSync(log).mode & 0o777).toBe(0o600);
  }, 40_000);
});

describe("M5: owner-only on every start", () => {
  it("fixes a data folder, database, log and backup someone else made readable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alca-perms-"));
    mkdirSync(join(dir, "logs"), { recursive: true });
    mkdirSync(join(dir, "backups"), { recursive: true });
    writeFileSync(join(dir, "logs", "core.log"), "old line\n");
    writeFileSync(join(dir, "backups", "state-v1-20260101T000000Z.sqlite"), "");
    for (const p of [dir, join(dir, "logs"), join(dir, "backups")]) chmodSync(p, 0o755);
    chmodSync(join(dir, "logs", "core.log"), 0o644);
    chmodSync(join(dir, "backups", "state-v1-20260101T000000Z.sqlite"), 0o644);
    const app = await boot({ dir });
    const mode = (p: string) => statSync(join(dir, p)).mode & 0o777;
    // At b096d22 all of these kept 0755 / 0644, and state.sqlite was made with the umask.
    expect(mode(".")).toBe(0o700);
    expect(mode("logs")).toBe(0o700);
    expect(mode("backups")).toBe(0o700);
    expect(mode("logs/core.log")).toBe(0o600);
    expect(mode("backups/state-v1-20260101T000000Z.sqlite")).toBe(0o600);
    expect(mode("state.sqlite")).toBe(0o600);
    expect(mode("secrets.json")).toBe(0o600);
    void app;
  });
});
