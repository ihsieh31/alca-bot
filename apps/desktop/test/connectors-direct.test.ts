// Desktop × next round R8 wiring, offline: the person's MCP servers through
// the routes (adding or changing one needs the approve key), the phone may
// only tighten what a bot may do with these accounts, and Google direct is
// gone (removed 2026-11-05: Gmail / Calendar go through Composio only) — no
// routes, no status entry, and a leftover refresh token is dropped at start.
// config.json keeps engineering.google for 用 Google 帳號啟用遠端 (P10).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dropGoogleDirectTokens, GOOGLE_DIRECT_SECRET_PREFIX } from "../src/connectors.ts";
import { type DesktopApp, startDesktop } from "../src/index.ts";
import { connectorOps } from "../src/link-connector-ops.ts";

// biome-ignore lint/suspicious/noExplicitAny: test JSON
type Json = any;

const MCP_SERVER = fileURLToPath(
  new URL("../../../packages/connectors/testing/fake-mcp-server.ts", import.meta.url),
);

describe("dropGoogleDirectTokens (Google direct removed 2026-11-05)", () => {
  it("deletes only the removed provider's refresh tokens", async () => {
    const kept = new Map([
      [`${GOOGLE_DIRECT_SECRET_PREFIX}acc1.refresh`, "1//old"],
      ["integration.mcp.notes.NOTES_TOKEN", "keep"],
      ["connectors.composio.key", "keep"],
    ]);
    const vault = {
      names: async () => [...kept.keys()],
      deleteMany: async (n: readonly string[]) => {
        for (const k of n) kept.delete(k);
      },
    };
    expect(await dropGoogleDirectTokens(vault)).toEqual([`${GOOGLE_DIRECT_SECRET_PREFIX}acc1.refresh`]);
    expect([...kept.keys()]).toEqual(["integration.mcp.notes.NOTES_TOKEN", "connectors.composio.key"]);
    expect(await dropGoogleDirectTokens(vault)).toEqual([]);
  });

  it("a vault that cannot be read never stops the start", async () => {
    const vault = {
      names: async (): Promise<string[]> => {
        throw new Error("key missing");
      },
      deleteMany: async () => undefined,
    };
    expect(await dropGoogleDirectTokens(vault)).toEqual([]);
  });
});

describe("desktop × MCP servers, no Google direct (next round R8)", () => {
  let app: DesktopApp;
  let dir: string;

  const api = async (method: string, path: string, body?: unknown, keyed = true) => {
    const res = await fetch(`${app.server.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${app.token}`,
        ...(keyed ? app.uiHeaders : { origin: app.server.url }),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as Json };
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "alca-desk-r8-"));
    // engineering.google stays valid: it is 用 Google 帳號啟用遠端's client (P10), not a Gmail connection.
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        engineering: {
          google: {
            clientId: "fict-desktop.apps.example",
            clientSecret: "fict",
            authEndpoint: "https://accounts.example.com/o/oauth2/v2/auth",
            tokenEndpoint: "http://127.0.0.1:9/token",
          },
        },
      }),
    );
    app = await startDesktop({
      engine: "demo",
      dataDir: dir,
      port: 0,
      browser: "off",
      vaultKeySource: "file",
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("status lists MCP servers only; there is no Google-direct entry or route", async () => {
    const st = await api("GET", "/api/connectors?refresh=0");
    expect(st.status).toBe(200);
    expect(st.body.integrations).toEqual({ mcp: { servers: [] } });
    expect(st.body.groups.some((g: Json) => g.toolkit === "google")).toBe(false);
    expect((await api("POST", "/api/connectors/google", { label: "個人" })).status).toBe(404);
    expect((await api("POST", "/api/connectors/google/x/scopes", {})).status).toBe(404);
  });

  it("adding an MCP server needs the approve key; with it the server is checked and its account active", async () => {
    const server = {
      label: "筆記",
      transport: "stdio",
      command: process.execPath,
      args: [MCP_SERVER],
      secrets: { NOTES_TOKEN: "fict-secret-value" },
    };
    const refused = await api("PUT", "/api/connectors/mcp/notes", server, false);
    expect(refused.status).toBe(403);
    expect(app.core.store.connectors.server("notes")).toBeUndefined();
    const r = await api("PUT", "/api/connectors/mcp/notes", server);
    expect(r.status).toBe(200);
    expect(r.body.check.ok).toBe(true);
    expect(r.body.server.secretNames).toEqual(["NOTES_TOKEN"]);
    expect(JSON.stringify(r.body)).not.toContain("fict-secret-value");
    const acc = app.core.store.connectors.byRemote("notes", "mcp");
    expect(acc?.status).toBe("active");
    const list = await api("GET", "/api/connectors/mcp");
    expect(list.body.servers.map((s: Json) => s.id)).toEqual(["notes"]);
    expect((await api("POST", "/api/connectors/mcp/notes/check", {})).body.ok).toBe(true);
    // Changing it needs the key too; a bad one is a 400 with the reason.
    expect((await api("PUT", "/api/connectors/mcp/notes", { ...server, label: "改" }, false)).status).toBe(
      403,
    );
    const bad = await api("PUT", "/api/connectors/mcp/notes", { ...server, transport: "ftp" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/transport/);
  });

  it("the phone sees these accounts but may only tighten a bot's access to them", async () => {
    const ops = connectorOps(app.connectors);
    const bot = app.core.store.bots.ensureDefault().id;
    const acc = app.core.store.connectors.byRemote("notes", "mcp");
    if (!acc) throw new Error("no account");
    app.core.store.connectors.grant(bot, acc.id, "read");
    const grant = ops["connectors.grant"]?.[1] as (a: Record<string, unknown>) => Promise<unknown>;
    await expect(grant({ accountId: acc.id, botId: bot, access: "act" })).rejects.toThrow(/只能收緊/);
    expect(app.core.store.connectors.grants({ accountId: acc.id })[0]?.access).toBe("read");
    await grant({ accountId: acc.id, botId: bot, access: null });
    expect(app.core.store.connectors.grants({ accountId: acc.id })).toHaveLength(0);
    const connect = ops["connectors.connect"]?.[1] as (a: Record<string, unknown>) => Promise<unknown>;
    await expect(connect({ toolkit: "mcp-notes", label: "x" })).rejects.toThrow(/不經過 Composio/);
    const status = ops["connectors.status"]?.[1] as () => Promise<Json>;
    const st = (await status()) as Json;
    expect(st.integrations.mcp.servers[0].id).toBe("notes");
  });

  it("removing a server drops its account and its secrets (no key needed: it only narrows)", async () => {
    const r = await api("DELETE", "/api/connectors/mcp/notes", undefined, false);
    expect(r.status).toBe(200);
    expect(app.core.store.connectors.server("notes")).toBeUndefined();
    expect(await app.connectors?.setup.vault.get("integration.mcp.notes.NOTES_TOKEN")).toBeUndefined();
    expect((await api("DELETE", "/api/connectors/mcp/notes")).status).toBe(404);
  });
});
