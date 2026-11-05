// Desktop × Claude Code engine (fake CLI) × Alca Browser (real headless
// Chromium) against the demo shop. The fake CLI calls the browser tools over
// our `alcatools` MCP server for real; every call comes back into this
// process and goes through the gateway, cards and the sensitive-action gate.
// Skips when no Chromium is installed.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChromium } from "@alca/browser";
import { FAKE_CLAUDE_SCRIPT } from "@alca/engines";
import type { AlcaEvent, BrowserEvent, EventOf } from "@alca/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDemoShop } from "../src/demo-shop.ts";
import { type DesktopApp, startDesktop } from "../src/index.ts";

const bin = process.env.ALCA_TEST_CHROMIUM || findChromium();

describe.skipIf(!bin)("desktop × Claude Code × browser (fake CLI, real Chromium)", () => {
  let app: DesktopApp;
  let dir: string;
  let shop: Awaited<ReturnType<typeof startDemoShop>>;
  let log: string;
  const events: AlcaEvent[] = [];
  const browserEvents: BrowserEvent[] = [];
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
    // biome-ignore lint/suspicious/noExplicitAny: test JSON
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };
  const until = async <T>(fn: () => T | undefined, ms = 15_000): Promise<T> => {
    const start = Date.now();
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() - start > ms) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  const approval = (pred: (e: EventOf<"approval.requested">) => boolean = () => true) =>
    until(() =>
      events.find((e): e is EventOf<"approval.requested"> => e.type === "approval.requested" && pred(e)),
    );
  const finished = (runId: string) =>
    until(() => events.find((e) => e.type === "run.finished" && e.runId === runId));
  const send = async (threadId: string, text: string): Promise<string> =>
    (await api("POST", `/api/threads/${threadId}/messages`, { text })).body.runId;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "alca-desk-cc-browser-"));
    log = join(dir, "claude-launches.ndjson");
    process.env.FAKE_CLAUDE_LOG = log;
    shop = await startDemoShop();
    app = await startDesktop({
      engine: "claude-code",
      // P1/P2 behaviour of a single turn (the router / worker split is tested in agents.test.ts).
      agents: "direct",
      claudeCommand: [process.execPath, "--disable-warning=ExperimentalWarning", FAKE_CLAUDE_SCRIPT],
      workdir: dir,
      dataDir: join(dir, "data"),
      port: 0,
      browser: "headless",
      chromium: bin as string,
    });
    app.core.bus.subscribe("*", (e) => events.push(e));
    app.browser!.host.subscribe((e) => browserEvents.push(e));
  }, 30_000);
  afterAll(async () => {
    delete process.env.FAKE_CLAUDE_LOG;
    await app?.close();
    await shop?.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  let threadId = "";
  let spaceId = "";
  const driver = () => app.browser!.host.activeTab(app.browser!.host.get(spaceId))!.driver;

  it("opens a bot-owned Space through MCP, gates 確認付款 with a payment card, and a denial never pays", async () => {
    threadId = (await api("POST", "/api/threads", {})).body.id;
    const runId = await send(
      threadId,
      `[mcp:browser_open {"url":"${shop.url}"}][mcp:browser_snapshot {}][mcp:browser_click {"ref":"$ref(確認付款)"}]`,
    );
    expect(runId).toMatch(/^run_/);
    // 每步確認 (default) asks for opening the page; the snapshot is a read.
    const open = await approval();
    expect(open.data).toMatchObject({ actionClass: "network" });
    expect(String(open.data.summary)).toContain("開啟 127.0.0.1");
    await api("POST", `/api/approvals/${open.data.approvalId}`, { decision: "approved" });

    const pay = await approval((e) => e.data.actionClass === "payment");
    const bot = app.core.store.bots.default()!;
    expect(pay.data).toMatchObject({ actionClass: "payment", botId: bot.id });
    expect(String(pay.data.summary)).toContain("確認付款");

    // Calls are the host's own tool names, and the click card belongs to the click call.
    const requested = events.filter((e): e is EventOf<"tool.requested"> => e.type === "tool.requested");
    expect(requested.map((e) => e.data.tool)).toEqual(["browser_open", "browser_snapshot", "browser_click"]);
    expect(pay.data.callId).toBe(requested[2]!.data.callId);
    // Page text reaches the model fenced as untrusted data.
    const snap = events.find(
      (e): e is EventOf<"tool.completed"> =>
        e.type === "tool.completed" && e.data.callId === requested[1]!.data.callId,
    )!;
    expect(snap.data.ok).toBe(true);
    expect(String(snap.data.result)).toContain('trust="untrusted"');
    expect(String(snap.data.result)).toContain("確認付款");

    const spaces = (await api("GET", "/api/browser/spaces")).body;
    expect(spaces).toHaveLength(1);
    expect(spaces[0]).toMatchObject({ botId: bot.id, threadId, controller: "agent", profile: "shared" });
    spaceId = spaces[0].spaceId;
    // Browser channel events for the UI, attributed to the bot.
    const actions = browserEvents.filter((e) => e.type === "space.action");
    expect(actions.length).toBeGreaterThanOrEqual(2);
    expect(actions.every((e) => e.type === "space.action" && e.data.botId === bot.id)).toBe(true);

    // While the card is open nothing is pressed.
    await new Promise((r) => setTimeout(r, 300));
    expect(await driver().readText()).not.toContain("付款完成");
    await api("POST", `/api/approvals/${pay.data.approvalId}`, { decision: "denied" });
    await finished(runId);
    expect(app.core.messages(threadId).at(-1)?.content).toContain("沒有執行");
    expect(await driver().readText()).not.toContain("付款完成");
  }, 60_000);

  it("queues the agent's step while a person drives, and runs it after hand-back", async () => {
    expect((await api("POST", `/api/browser/spaces/${spaceId}/takeover`, {})).body.controller).toBe("user");
    events.length = 0;
    const runId = await send(threadId, "[mcp:browser_snapshot {}]");
    await until(() => (app.browser!.host.state(spaceId).status === "queued" ? true : undefined));
    expect(events.some((e) => e.type === "run.finished")).toBe(false);
    expect((await api("POST", `/api/browser/spaces/${spaceId}/handback`, {})).body.controller).toBe("agent");
    await finished(runId);
    const done = events.find((e): e is EventOf<"tool.completed"> => e.type === "tool.completed")!;
    expect(done.data.ok).toBe(true);
    expect(String(done.data.result)).toContain("確認付款");
  }, 60_000);

  it("允許一次 presses the pay button exactly once", async () => {
    events.length = 0;
    const runId = await send(
      threadId,
      '[mcp:browser_snapshot {}][mcp:browser_click {"ref":"$ref(確認付款)"}]',
    );
    const pay = await approval((e) => e.data.actionClass === "payment");
    expect((await api("GET", "/api/browser/spaces")).body).toHaveLength(1); // same thread, same Space
    await api("POST", `/api/approvals/${pay.data.approvalId}`, { decision: "approved" });
    await finished(runId);
    expect(app.core.messages(threadId).at(-1)?.content).toContain("完成");
    expect(await driver().readText()).toContain("付款完成");
  }, 60_000);

  it("never hands the model a credential: no local token on the CLI command line or in the tool list", () => {
    const launches = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { args: string[] });
    expect(launches.length).toBeGreaterThanOrEqual(1);
    for (const l of launches) {
      const argv = l.args.join(" ");
      expect(argv).not.toContain(app.token);
      const cfg = JSON.parse(l.args[l.args.indexOf("--mcp-config") + 1]!) as {
        mcpServers: Record<string, { env: Record<string, string> }>;
      };
      const tools = readFileSync(cfg.mcpServers.alcatools!.env.ALCA_TOOLS_FILE!, "utf8");
      expect(tools).not.toContain(app.token);
      expect(JSON.parse(tools).map((t: { name: string }) => t.name)).toContain("browser_click");
      expect(l.args[l.args.indexOf("--append-system-prompt") + 1]).toContain('trust="untrusted"');
    }
  });
});
