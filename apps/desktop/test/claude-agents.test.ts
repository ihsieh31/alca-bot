// Desktop router mode on the Claude Code engine (fake CLI, real Chromium):
// the router CLI dispatches a worker over MCP; the worker's own CLI drives the
// demo shop in the worker's Space and stops at a payment card naming it.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChromium } from "@alca/browser";
import { FAKE_CLAUDE_SCRIPT } from "@alca/engines";
import type { AlcaEvent, EventOf } from "@alca/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDemoShop } from "../src/demo-shop.ts";
import { type DesktopApp, startDesktop } from "../src/index.ts";

const bin = process.env.ALCA_TEST_CHROMIUM || findChromium();

describe.skipIf(!bin)("desktop router mode × Claude Code (fake CLI, real Chromium)", () => {
  let app: DesktopApp;
  let dir: string;
  let log: string;
  let shop: Awaited<ReturnType<typeof startDemoShop>>;
  const events: AlcaEvent[] = [];
  const until = async <T>(fn: () => T | undefined | false, ms = 20_000): Promise<T> => {
    const start = Date.now();
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() - start > ms) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "alca-desk-cc-agents-"));
    log = join(dir, "launches.ndjson");
    process.env.FAKE_CLAUDE_LOG = log;
    mkdirSync(join(dir, "data"));
    writeFileSync(join(dir, "data", "config.json"), JSON.stringify({ permissions: { level: "autonomous" } }));
    shop = await startDemoShop();
    app = await startDesktop({
      engine: "claude-code",
      claudeCommand: [process.execPath, "--disable-warning=ExperimentalWarning", FAKE_CLAUDE_SCRIPT],
      workdir: dir,
      dataDir: join(dir, "data"),
      port: 0,
      browser: "headless",
      chromium: bin as string,
    });
    app.core.bus.subscribe("*", (e) => events.push(e));
  }, 30_000);
  afterAll(async () => {
    delete process.env.FAKE_CLAUDE_LOG;
    await app?.close();
    await shop?.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it("router CLI → worker CLI → payment card with bot + worker; the router CLI has no browser and no shell", async () => {
    const t = app.core.createThread();
    // A general worker reaches the less common browser tools through the lazy catalog.
    const goal =
      `[mcp:browser_open {"url":"${shop.url}"}]` +
      `[mcp:tool_describe {"names":["browser_snapshot","browser_click"]}]` +
      `[mcp:tool_call {"name":"browser_snapshot","arguments":{}}]` +
      `[mcp:tool_call {"name":"browser_click","arguments":{"ref":"$ref(確認付款)"}}]`;
    // A JSON "\u0024" in the router's directive keeps the router's own CLI from expanding the worker's $ref(...).
    const text = `[mcp:worker_start {"title":"結帳","goal":${JSON.stringify(goal).replace("$ref", "\\u0024ref")}}]`;
    await app.core.send(t.id, text).done;
    const w = app.core.store.workers.byThread(t.id)[0]!;
    const pay = await until(() =>
      events.find(
        (e): e is EventOf<"approval.requested"> =>
          e.type === "approval.requested" && e.data.actionClass === "payment",
      ),
    );
    expect(pay.data).toMatchObject({ workerId: w.id, botId: w.botId });
    const space = app.browser!.host.list().find((s) => s.workerId === w.id);
    expect(space?.botId).toBe(w.botId);
    app.core.answerApproval(pay.data.approvalId, "denied");
    await until(() => app.core.store.workers.get(w.id)?.status === "succeeded");
    expect(app.core.store.workers.get(w.id)?.result?.summary).toContain("沒有執行");

    const launches = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { args: string[] });
    const router = launches.find((l) => l.args.includes("--tools"))!;
    const tools = (cfg: { args: string[] }) => {
      const mcp = JSON.parse(cfg.args[cfg.args.indexOf("--mcp-config") + 1]!) as {
        mcpServers: { alcatools: { env: { ALCA_TOOLS_FILE: string } } };
      };
      return (
        JSON.parse(readFileSync(mcp.mcpServers.alcatools.env.ALCA_TOOLS_FILE, "utf8")) as Array<{
          name: string;
        }>
      ).map((x) => x.name);
    };
    expect(tools(router).sort()).toEqual([
      "memory_search",
      "peer_ask",
      "peer_delegate",
      "peer_status",
      "recall",
      "skill_load",
      "worker_answer",
      "worker_start",
      "worker_status",
      "worker_stop",
    ]);
    const worker = launches.find((l) => !l.args.includes("--tools"))!;
    expect(tools(worker)).toContain("browser_open");
    expect(tools(worker)).toContain("tool_call");
    expect(tools(worker)).not.toContain("worker_start");
  }, 60_000);
});
