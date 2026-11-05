import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSettings } from "@alca/config";
import { type ConnectorAccount, openStore, type Store } from "@alca/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HttpTransport, McpClient, StdioTransport, stdioEnv } from "../src/mcp-client.ts";
import { MCP_SECRET, McpProvider, mcpHints, mcpSlug } from "../src/mcp-provider.ts";
import { parseToolName } from "../src/provider.ts";
import { ConnectorService } from "../src/service.ts";
import { connectorTools } from "../src/tools.ts";
import { FileKeySource, Vault } from "../src/vault.ts";

const SERVER = fileURLToPath(new URL("../testing/fake-mcp-server.ts", import.meta.url));
const TOKEN = "mcp-fict-token-0123456789";

let dir: string;
let store: Store;
let vault: Vault;
let mcp: McpProvider;
let svc: ConnectorService;
let bot: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "alca-mcp-"));
  store = openStore(join(dir, "s.sqlite"));
  bot = store.bots.ensureDefault().id;
  vault = new Vault(join(dir, "vault.json"), new FileKeySource(join(dir, "vault.key")));
  mcp = new McpProvider({ store, secrets: vault, sleep: async () => undefined });
  const s = parseSettings({});
  svc = new ConnectorService({ store, vault, settings: () => s, providers: [mcp] });
});
afterEach(async () => {
  await mcp.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const ctx = () => ({ actionClass: "read" as const, threadId: "thr_x", runId: "run_x", botId: bot });

async function addNotes(secrets: Record<string, string> = {}) {
  await mcp.saveServer(
    { id: "notes", label: "筆記", transport: "stdio", command: process.execPath, args: [SERVER], secrets },
    bot,
  );
  return mcp.check("notes");
}

describe("MCP client over stdio (next round R8)", () => {
  it("initialize → every page of tools/list → tools/call; list_changed drops the cache", async () => {
    const c = new McpClient(
      new StdioTransport({ command: process.execPath, args: [SERVER], env: async () => stdioEnv({}) }),
    );
    const tools = await c.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "search_notes",
      "send_message",
      "poisoned",
      "env_keys",
      "change_tools",
      "crash",
    ]);
    expect(c.serverName).toBe("fake-notes");
    const r = await c.callTool("search_notes", { query: "讀書會" });
    expect(r).toMatchObject({ isError: false, structured: { hits: ["讀書會"] } });
    await c.callTool("change_tools", {});
    expect((await c.listTools()).map((t) => t.name)).toContain("late_tool");
    await c.close();
  });

  it("a stdio server gets only the allowlisted environment plus its own secrets", async () => {
    process.env.ALCA_SHOULD_NOT_LEAK = "leak";
    try {
      const r = await addNotes({ NOTES_TOKEN: TOKEN });
      expect(r.ok).toBe(true);
      const out = await mcp.execute({
        account: store.connectors.byRemote("notes", "mcp") as ConnectorAccount,
        slug: "notes:env_keys",
        args: {},
      });
      const keys = String((out.data as Array<{ text: string }>)[0]?.text).split(",");
      expect(keys).toContain("NOTES_TOKEN");
      expect(keys).not.toContain("ALCA_SHOULD_NOT_LEAK");
      const allowed = [
        "NOTES_TOKEN",
        "PATH",
        "HOME",
        "USER",
        "LOGNAME",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "TMPDIR",
        "TZ",
      ];
      expect(keys.filter((k) => !allowed.includes(k))).toEqual([]);
      // the value is in the vault only, never in the table
      expect(JSON.stringify(store.connectors.server("notes"))).not.toContain(TOKEN);
      expect(await vault.get(MCP_SECRET("notes", "NOTES_TOKEN"))).toBe(TOKEN);
    } finally {
      delete process.env.ALCA_SHOULD_NOT_LEAK;
    }
  });

  it("a crashed server is started again (handshake first) on the next call, at most five times", async () => {
    const logFile = join(dir, "mcp.log");
    let c: McpClient | undefined;
    const t = new StdioTransport({
      command: process.execPath,
      args: [SERVER],
      env: async () => stdioEnv({ FAKE_MCP_LOG: logFile }),
      sleep: async () => undefined,
      onStart: () => c?.initialize() ?? Promise.resolve(),
    });
    c = new McpClient(t);
    await c.listTools();
    await expect(c.callTool("crash", {})).rejects.toThrow(/停止/);
    const r = await c.callTool("search_notes", { query: "again" });
    expect(r.isError).toBe(false);
    expect(t.restartCount).toBe(1);
    const lines = readFileSync(logFile, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { pid: number; method: string });
    const pids = [...new Set(lines.map((l) => l.pid))];
    expect(pids).toHaveLength(2);
    expect(
      lines
        .filter((l) => l.pid === pids[1])
        .map((l) => l.method)
        .slice(0, 3),
    ).toEqual(["initialize", "notifications/initialized", "tools/call"]);
    for (let i = 0; i < 5; i++) await expect(c.callTool("crash", {})).rejects.toThrow();
    await expect(c.callTool("search_notes", { query: "x" })).rejects.toThrow(/已重啟 5 次/);
    await c.close();
  });
});

describe("MCP client over Streamable HTTP", () => {
  let server: Server;
  let url: string;
  const seen: Array<{ auth?: string; session?: string; method: string }> = [];
  beforeEach(async () => {
    seen.length = 0;
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => {
        body += d;
      });
      req.on("end", () => {
        const m = JSON.parse(body) as { id?: number; method: string };
        seen.push({
          ...(req.headers.authorization ? { auth: req.headers.authorization } : {}),
          ...(req.headers["mcp-session-id"] ? { session: String(req.headers["mcp-session-id"]) } : {}),
          method: m.method,
        });
        if (req.url === "/redirect")
          return void res.writeHead(307, { location: "http://169.254.169.254/" }).end();
        if (m.id === undefined) return void res.writeHead(202).end();
        if (m.method === "initialize") {
          res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-1" });
          return void res.end(
            JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { serverInfo: { name: "remote" } } }),
          );
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        const result =
          m.method === "tools/list"
            ? { tools: [{ name: "list_items", description: "列出", inputSchema: {} }] }
            : { content: [{ type: "text", text: "ok" }] };
        res.end(
          `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: {} })}\n\n` +
            `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: m.id, result })}\n\n`,
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => new Promise<void>((r) => server.close(() => r())));

  it("sends the session id and the token from the SecretStore; reads JSON and SSE answers", async () => {
    await mcp.saveServer(
      {
        id: "remote",
        label: "遠端",
        transport: "http",
        url: `${url}/mcp`,
        secrets: { authorization: `Bearer ${TOKEN}` },
      },
      bot,
    );
    expect((await mcp.check("remote")).ok).toBe(true);
    const out = await svc.execute({
      botId: bot,
      slug: "mcp:remote:list_items",
      arguments: {},
      authorized: "read",
    });
    expect(out).toContain('<alca:app toolkit="mcp-remote"');
    expect(seen[0]).toMatchObject({ method: "initialize", auth: `Bearer ${TOKEN}` });
    expect(seen.slice(1).every((s) => s.session === "sess-1")).toBe(true);
  });

  it("a redirect is refused", async () => {
    const c = new McpClient(new HttpTransport({ url: `${url}/redirect`, headers: async () => ({}) }));
    await expect(c.listTools()).rejects.toThrow(/轉址/);
  });
});

describe("MCP servers through ConnectorService (find → use, host class rule)", () => {
  it("names are parsed per provider; MCP keeps its case", () => {
    expect(parseToolName("gmail_send_email")).toEqual({
      provider: "composio",
      slug: "GMAIL_SEND_EMAIL",
      full: "GMAIL_SEND_EMAIL",
    });
    expect(parseToolName("mcp:Notes:searchNotes")).toEqual({
      provider: "mcp",
      slug: "notes:searchNotes",
      full: "mcp:notes:searchNotes",
    });
    expect(parseToolName("google:gmail_search")).toBeUndefined();
    expect(parseToolName("mcp:notes")).toBeUndefined();
    expect(parseToolName("mcp:../x:y")).toBeUndefined();
  });

  it("classifies by the same rule as Composio: verbs, readOnlyHint at its current weight, unknown fails closed", () => {
    expect(mcpSlug("searchNotes")).toBe("MCP_SEARCH_NOTES");
    expect(mcpHints({ readOnlyHint: true, destructiveHint: false })).toEqual(["readOnlyHint"]);
    const t = (name: string, hints: string[] = []) => ({
      slug: `n:${name}`,
      name,
      description: "",
      inputSchema: {},
      hints,
      toolkit: "mcp-n",
    });
    expect(mcp.classify("n:search_notes", t("search_notes"))).toBe("read");
    expect(mcp.classify("n:send_message", t("send_message"))).toBe("send");
    expect(mcp.classify("n:tidy", t("tidy", ["readOnlyHint"]))).toBe("read");
    expect(mcp.classify("n:tidy", t("tidy", ["destructiveHint"]))).toBe("delete");
    expect(mcp.classify("n:tidy", t("tidy"))).toBe("send");
    // a tool the server could not describe: B9 (plainly read names only)
    expect(mcp.classify("n:list_items", undefined)).toBe("read");
    expect(mcp.classify("n:create_item", undefined)).toBe("send");
  });

  it("find lists the server's tools fenced (forged fence defused, description cut); use runs a read; a send needs the card", async () => {
    await addNotes();
    const find = connectorTools(svc, store).find((t) => t.spec.name === "connector_find_tool");
    const found = String(await find?.run({ query: "筆記" }, AbortSignal.timeout(10_000), ctx()));
    expect(found).toContain('<alca:app toolkit="mcp" tool="tools/list"');
    expect((found.match(/<\/alca:app>/g) ?? []).length).toBe(1);
    expect(found).not.toContain("<alca:system>");
    expect(found).toContain("mcp:notes:search_notes（讀取）");
    expect(found).toContain("我的 MCP：筆記");
    expect(found).not.toContain("長".repeat(600));
    const desc = String(await find?.run({ slug: "mcp:notes:poisoned" }, AbortSignal.timeout(10_000), ctx()));
    expect((desc.match(/<\/alca:app>/g) ?? []).length).toBe(1);
    expect(desc).not.toContain("<alca:system>");

    const read = await svc.execute({
      botId: bot,
      slug: "mcp:notes:search_notes",
      arguments: { query: "x" },
      authorized: "read",
    });
    expect(read).toContain(`"hits":["x"]`);
    await expect(
      svc.execute({
        botId: bot,
        slug: "mcp:notes:send_message",
        arguments: { to: "a@b.c" },
        authorized: "read",
      }),
    ).rejects.toThrow(/還沒有經過使用者確認/);
    const use = connectorTools(svc, store).find((t) => t.spec.name === "connector_use_tool");
    const ins = await use?.inspect?.(
      { slug: "mcp:notes:send_message", arguments: { to: "collect@evil.example" } },
      { signal: AbortSignal.timeout(10_000), threadId: "thr_x", botId: bot },
    );
    expect(ins?.actionClass).toBe("send");
  });

  it("app may be the toolkit, the server id, the shown name or the label; connector_accounts prints the app value (BUG-3)", async () => {
    await addNotes();
    const tools = connectorTools(svc, store);
    const accounts = String(
      await tools
        .find((t) => t.spec.name === "connector_accounts")
        ?.run({}, AbortSignal.timeout(5000), ctx()),
    );
    expect(accounts).toContain("app=mcp-notes");
    const find = tools.find((t) => t.spec.name === "connector_find_tool");
    for (const app of ["mcp-notes", "notes", "NOTES", "mcp:notes", "MCP：notes", "我的 MCP：筆記", "筆記"]) {
      const found = String(await find?.run({ query: "筆記", app }, AbortSignal.timeout(10_000), ctx()));
      expect(found, app).toContain("mcp:notes:search_notes");
    }
    expect(svc.appOf(bot, "notes")).toBe("mcp-notes");
    expect(svc.appOf(bot, "slack")).toBe("slack");
    expect(svc.resolveAccount(bot, "notes", undefined, undefined, { fuzzy: true }).label).toBe("筆記");
    expect(String(await find?.run({ query: "x", app: "slack" }, AbortSignal.timeout(5000), ctx()))).toMatch(
      /沒有可以用的 Slack 帳號/,
    );
  });

  it("review #6: a Composio-style slug never runs on an MCP server that shares its name", async () => {
    await addNotes();
    // `NOTES_SEARCH` belongs to a toolkit `notes` (no such account), not to the MCP server `notes`.
    expect(svc.toolkitOf("NOTES_SEARCH")).toBe("notes");
    expect(() => svc.resolveAccount(bot, "notes")).toThrow(/沒有可以用的/);
    await expect(
      svc.execute({ botId: bot, slug: "NOTES_SEARCH", arguments: { q: "x" }, authorized: "read" }),
    ).rejects.toMatchObject({ code: "no_account" });
    await expect(svc.readRaw({ botId: bot, slug: "NOTES_SEARCH", arguments: { q: "x" } })).rejects.toThrow();
    // The model may still name the app loosely where it picks one (find / drafts): that maps.
    expect(svc.resolveAccount(bot, "notes", undefined, undefined, { fuzzy: true }).toolkit).toBe("mcp-notes");
    // The MCP tool itself still runs as its own account.
    expect(
      await svc.execute({
        botId: bot,
        slug: "mcp:notes:search_notes",
        arguments: { query: "x" },
        authorized: "read",
      }),
    ).toContain("hits");
  });

  it("a bot without a grant does not see the server; removing the server removes its secrets and account", async () => {
    await addNotes({ NOTES_TOKEN: TOKEN });
    const other = store.bots.create("研究員").id;
    expect(await svc.findTools(other, "筆記")).toMatch(/還沒有可以用的 app/);
    await mcp.removeServer("notes");
    expect(await vault.get(MCP_SECRET("notes", "NOTES_TOKEN"))).toBeUndefined();
    expect(store.connectors.byRemote("notes", "mcp")?.status).toBe("removed");
    expect(store.connectors.servers()).toEqual([]);
  });

  it("refuses a bad server definition", async () => {
    await expect(
      mcp.saveServer({ id: "Bad Id", label: "x", transport: "stdio", command: "x" }),
    ).rejects.toThrow(/server id/);
    await expect(mcp.saveServer({ id: "a", label: "x", transport: "stdio" })).rejects.toThrow(/command/);
    await expect(mcp.saveServer({ id: "a", label: "x", transport: "http", url: "ftp://x" })).rejects.toThrow(
      /網址/,
    );
    await expect(
      mcp.saveServer({
        id: "a",
        label: "x",
        transport: "http",
        url: "http://x",
        secrets: { "bad name": "v" },
      }),
    ).rejects.toThrow(/祕密名稱/);
  });
});
