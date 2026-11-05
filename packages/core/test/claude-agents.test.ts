// Router and workers on the Claude Code engine (fake CLI over real MCP stdio).
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSettings } from "@alca/config";
import { FAKE_CLAUDE_SCRIPT } from "@alca/engines";
import type { AlcaEvent } from "@alca/protocol";
import { openStore } from "@alca/store";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentSystem,
  AlcaCore,
  claudeAgentEngines,
  DEFAULT_PROFILE,
  routerProfile,
  workerProfile,
} from "../src/index.ts";
import { until } from "./agents-helpers.ts";
import { tool } from "./helpers.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function setup(extraEnv: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "alca-cc-agents-"));
  const log = join(dir, "launches.ndjson");
  const store = openStore(":memory:");
  const settings = parseSettings({ permissions: { level: "autonomous" } });
  const notes = tool("read_note", "read", (a) => `筆記「${String(a.title)}」：牛奶、雞蛋`);
  const del = tool("delete_note", "delete");
  const browse = tool("browser_open", "read", () => {
    throw new Error("瀏覽器開不起來：找不到可用的 Chromium。");
  });
  const tools = [notes, del, browse];
  const engines = claudeAgentEngines({
    command: [process.execPath, "--disable-warning=ExperimentalWarning", FAKE_CLAUDE_SCRIPT],
    cwd: dir,
    store,
    routerProfile: routerProfile(DEFAULT_PROFILE),
    workerProfile: workerProfile(DEFAULT_PROFILE),
    workerToolNames: tools.map((t) => t.spec.name),
    baseEnv: { FAKE_CLAUDE_LOG: log, ...extraEnv },
  });
  const core = new AlcaCore({ store, engine: engines.router, settings: () => settings, tools });
  const agents = new AgentSystem({
    core,
    routerEngine: engines.router,
    workerEngine: engines.worker,
    settings: () => settings,
    tickMs: 0,
  });
  const events: AlcaEvent[] = [];
  core.bus.subscribe("*", (e) => events.push(e));
  cleanups.push(
    async () => {
      await agents.close();
      await core.close();
    },
    () => rmSync(dir, { recursive: true, force: true }),
  );
  const launches = () =>
    readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { args: string[]; toolSearch: string | null });
  return { core, agents, store, events, notes, del, launches, engines };
}

const directive = (tool: string, args: unknown) => `[mcp:${tool} ${JSON.stringify(args)}]`;

describe("router / workers × Claude Code (fake CLI)", () => {
  it("the router dispatches two workers over MCP; each runs in its own CLI process and its calls are gated", async () => {
    const { core, store, events, notes, del, launches, engines } = setup();
    const t = core.createThread();
    const text =
      directive("worker_start", { title: "讀筆記", goal: directive("read_note", { title: "購物清單" }) }) +
      directive("worker_start", { title: "刪筆記", goal: directive("delete_note", { title: "舊清單" }) });
    await core.send(t.id, text).done;
    const ws = store.workers.byThread(t.id);
    expect(ws.map((w) => w.title)).toEqual(["讀筆記", "刪筆記"]);

    const card = await until(
      () =>
        events.find(
          (e): e is Extract<AlcaEvent, { type: "approval.requested" }> => e.type === "approval.requested",
        ),
      15_000,
    );
    expect(card.data).toMatchObject({ actionClass: "delete", workerId: ws[1]!.id, botId: ws[1]!.botId });
    await until(() => store.workers.get(ws[0]!.id)?.status === "succeeded", 15_000);
    expect(notes.calls).toEqual([{ title: "購物清單" }]);
    expect(store.workers.get(ws[0]!.id)?.result?.summary).toContain("牛奶、雞蛋");
    core.answerApproval(card.data.approvalId, "denied");
    await until(() => store.workers.get(ws[1]!.id)?.status === "succeeded", 15_000);
    expect(del.calls).toHaveLength(0);

    // Router: one process with every built-in tool removed; each worker: its own process.
    await until(() => store.workers.pendingInbox().length === 0 && !core.isBusy(t.id), 15_000);
    const all = await until(() => {
      const l = launches();
      return l.length >= 3 ? l : undefined;
    }, 15_000);
    const router = all.filter((l) => l.args.includes("--tools"));
    expect(router).toHaveLength(1);
    expect(router[0]!.args[router[0]!.args.indexOf("--disallowedTools") + 1]).toContain("Bash");
    expect(all.length - router.length).toBe(2);
    // Each conversation's CLI session id is kept for --resume (router key and worker keys).
    expect(store.workers.conversation(store.workers.routerSession(ws[0]!.botId), "claude-code")).toBeTruthy();
    expect(store.workers.conversation(ws[0]!.id, "claude-code")).toBeTruthy();
    // A finished worker's process is released.
    await until(() => !engines.worker.hasProcess(ws[0]!.id), 15_000);
  }, 30_000);

  it("the router has no shell or file tools", async () => {
    const { core, store } = setup();
    const t = core.createThread();
    await core.send(t.id, "[bash:ls -la]").done;
    await core.send(t.id, "[read:/etc/hostname]").done;
    const said = store.threads
      .messages(t.id)
      .filter((m) => m.role === "assistant")
      .map((m) => m.content);
    expect(said).toEqual(["這個工作階段沒有 Bash 工具。", "這個工作階段沒有 Read 工具。"]);
  }, 30_000);

  // Mac test 2026-11-04: Claude Code 2.1.316 calls its built-in ToolSearch to load
  // mcp__alcatools__* before the first dispatch; that must not count as the router acting.
  it("a router that loads its tools with ToolSearch still dispatches (Claude Code ≥ 2.1)", async () => {
    const { core, store, events, notes } = setup({ FAKE_CLAUDE_TOOL_SEARCH: "always" });
    const t = core.createThread();
    const end = await core.send(
      t.id,
      directive("worker_start", { title: "讀筆記", goal: directive("read_note", { title: "清單" }) }),
    ).done;
    expect(end).toBe("completed");
    expect(events.some((e) => e.type === "error")).toBe(false);
    const [w] = store.workers.byThread(t.id);
    expect(w?.title).toBe("讀筆記");
    await until(() => store.workers.get(w!.id)?.status === "succeeded", 15_000);
    expect(notes.calls).toEqual([{ title: "清單" }]);
  }, 30_000);

  it("the CLI is started with ENABLE_TOOL_SEARCH=false, so it does not defer Alca's tools", async () => {
    const { core, store, launches } = setup({ FAKE_CLAUDE_TOOL_SEARCH: "1" });
    const t = core.createThread();
    await core.send(
      t.id,
      directive("worker_start", { title: "讀", goal: directive("read_note", { title: "a" }) }),
    ).done;
    const [w] = store.workers.byThread(t.id);
    await until(() => store.workers.get(w!.id)?.status === "succeeded", 15_000);
    const all = launches();
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(all.every((l) => l.toolSearch === "false")).toBe(true);
  }, 30_000);

  // Mac test 2026-11-04b C2: the browser never started, the worker's turn ended
  // normally with its explanation, and the router said "done".
  it("a worker whose last step failed reports ok=false; a router that still says done gets a note", async () => {
    const { core, store } = setup({ FAKE_CLAUDE_REPORT_REPLY: "「示範商店結帳」完成了。" });
    const t = core.createThread();
    await core.send(
      t.id,
      directive("worker_start", { title: "示範商店結帳", goal: directive("browser_open", { url: "shop" }) }),
    ).done;
    const [w] = store.workers.byThread(t.id);
    await until(() => store.workers.get(w!.id)?.status === "succeeded", 15_000);
    const done = store.workers.get(w!.id)!;
    expect(done.toolErrors.count).toBe(1);
    expect(done.toolErrors.last).toContain("找不到可用的 Chromium");
    await until(() => store.workers.pendingInbox().length === 0 && !core.isBusy(t.id), 15_000);
    const msgs = await until(() => {
      const m = store.threads.messages(t.id);
      return m.some((x) => x.role === "system" && x.content.startsWith("Alca 註記")) ? m : undefined;
    }, 15_000);
    const report = msgs.find((m) => m.role === "system" && m.content.startsWith("<alca:worker"));
    expect(report?.content).toMatch(/ ok="false"/);
    expect(report?.content).toContain("失敗的步驟：瀏覽器開不起來");
    expect(report?.content).toContain("不要說「完成了」");
    const note = msgs.find((m) => m.role === "system" && m.content.startsWith("Alca 註記"));
    expect(note?.content).toContain("「示範商店結帳」其實沒有做成");
    expect(note?.content).toContain("找不到可用的 Chromium");
  }, 30_000);

  it("a worker that recovers from a failed step is still ok, and an honest router gets no note", async () => {
    const { core, store } = setup({ FAKE_CLAUDE_REPORT_REPLY: "沒有完成：瀏覽器開不起來。" });
    const t = core.createThread();
    await core.send(
      t.id,
      directive("worker_start", {
        title: "讀",
        // Phase 5: every dispatch runs under a harness (general here); done comes through report_result.
        goal:
          directive("browser_open", { url: "x" }) +
          directive("read_note", { title: "清單" }) +
          directive("report_result", { status: "done", summary: "讀好了：牛奶、雞蛋" }),
      }),
    ).done;
    const [w] = store.workers.byThread(t.id);
    await until(() => store.workers.get(w!.id)?.status === "succeeded", 15_000);
    expect(store.workers.get(w!.id)!.toolErrors).toEqual({ count: 1, last: null });
    await until(() => store.workers.pendingInbox().length === 0 && !core.isBusy(t.id), 15_000);
    const msgs = store.threads.messages(t.id);
    expect(msgs.find((m) => m.content.startsWith("<alca:worker"))?.content).toMatch(/ ok="true"/);
    expect(msgs.some((m) => m.content.startsWith("Alca 註記"))).toBe(false);
  }, 30_000);
});
