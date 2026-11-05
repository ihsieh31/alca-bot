// Desktop × router / workers end to end (P3) with the offline demo engines
// and a real headless Chromium: the person asks the router, it dispatches two
// workers at once; one drives the demo shop in its own Space and stops at a
// payment card, the other finishes and is spilled, the router recalls it; a
// looping worker started meanwhile is stopped by the watchdog.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChromium } from "@alca/browser";
import type { AgentsEvent, AlcaEvent, EventOf, WorkerStateT } from "@alca/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEMO_LOOP_REQUEST, DEMO_PARALLEL_REQUEST } from "../src/demo-agents.ts";
import { type DesktopApp, startDesktop } from "../src/index.ts";

const bin = process.env.ALCA_TEST_CHROMIUM || findChromium();

describe.skipIf(!bin)("desktop × router / workers (demo engines, real Chromium)", () => {
  let app: DesktopApp;
  let dir: string;
  const events: AlcaEvent[] = [];
  const agentEvents: AgentsEvent[] = [];
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
  const until = async <T>(
    fn: () => T | undefined | false | Promise<T | undefined | false>,
    ms = 20_000,
  ): Promise<T> => {
    const start = Date.now();
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() - start > ms) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  const card = (pred: (e: EventOf<"approval.requested">) => boolean) =>
    until(() =>
      events.find((e): e is EventOf<"approval.requested"> => e.type === "approval.requested" && pred(e)),
    );
  const workers = async (threadId: string): Promise<WorkerStateT[]> =>
    (await api("GET", `/api/threads/${threadId}/workers`)).body;
  const said = async (threadId: string) =>
    ((await api("GET", `/api/threads/${threadId}`)).body.messages as Array<{ role: string; content: string }>)
      .filter((m) => m.role === "assistant")
      .map((m) => m.content);

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "alca-desk-agents-"));
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        engineering: {
          workers: { watchdogSec: 1, loopWindow: 6, loopRepeats: 4 },
          // The in-turn LoopGuard would hard-stop the same loop at its 6th repeat; this test is about the watchdog.
          loopGuard: { warnAfterRepeats: 3, hardStopAfterRepeats: 50 },
        },
      }),
    );
    app = await startDesktop({
      engine: "demo",
      dataDir: dir,
      port: 0,
      browser: "headless",
      chromium: bin as string,
    });
    app.core.bus.subscribe("*", (e) => events.push(e));
    app.agents?.subscribe((e) => agentEvents.push(e));
  }, 30_000);
  afterAll(async () => {
    await app?.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it("router → two parallel workers → payment card in a worker's Space, spill + recall, watchdog stops a loop", async () => {
    expect((await api("GET", "/api/session")).body.mode).toBe("router");
    const t = (await api("POST", "/api/threads", {})).body.id as string;
    expect((await api("POST", `/api/threads/${t}/messages`, { text: DEMO_PARALLEL_REQUEST })).status).toBe(
      202,
    );

    // Two workers, dispatched in one router turn, run at the same time.
    const [shop, report] = await until(async () => {
      const ws = await workers(t);
      return ws.length === 2 ? ws : undefined;
    });
    expect([shop!.title, report!.title]).toEqual(["示範商店結帳", "藍牙耳機比價"]);
    expect(shop!.parentRunId).toBe(report!.parentRunId);

    // 每步確認: opening the page asks first; the card names the bot and the worker.
    const open = await card((e) => e.data.actionClass === "network");
    expect(open.data).toMatchObject({ workerId: shop!.workerId, botId: shop!.botId });
    await api("POST", `/api/approvals/${open.data.approvalId}`, { decision: "approved" });
    const pay = await card((e) => e.data.actionClass === "payment");
    expect(pay.data.workerId).toBe(shop!.workerId);
    expect(pay.data.summary).toContain("確認付款");
    // The Space belongs to the bot and is the worker's own.
    const spaces = (await api("GET", "/api/browser/spaces")).body as Array<{
      workerId?: string;
      botId: string;
    }>;
    expect(spaces.find((s) => s.workerId === shop!.workerId)?.botId).toBe(shop!.botId);
    // A reloading chat still gets the worker's pending card.
    const detail = (await api("GET", `/api/threads/${t}`)).body;
    expect(detail.thread.waiting).toBe(true);
    expect(detail.workerCards.some((e: AlcaEvent) => e.type === "approval.requested")).toBe(true);

    // Meanwhile the report worker finished: its result was spilled and the router recalled it.
    const done = await until(async () =>
      (await workers(t)).find((w) => w.workerId === report!.workerId && w.status === "succeeded"),
    );
    expect(done.result?.mode).toBe("spill");
    expect(done.result?.spillId).toMatch(/^spl_/);
    await until(async () =>
      (await said(t)).some((m) => m.includes("比價報告整理好了") && m.includes("結論：北岸電器最便宜")),
    );
    const toolCalls = events
      .filter((e) => e.threadId === t && e.type === "tool.requested")
      .map((e) => (e.data as { tool: string }).tool);
    // The chain of recall: page one, then the page its pointer names.
    expect(toolCalls.filter((x) => x === "recall")).toHaveLength(2);
    expect(toolCalls).not.toContain("browser_open"); // the router itself never touched the browser

    // Full duplex: while the payment card waits, the person asks for something else.
    expect((await api("POST", `/api/threads/${t}/messages`, { text: DEMO_LOOP_REQUEST })).status).toBe(202);
    const loop = await until(async () => (await workers(t)).find((w) => w.title === "盯信箱"));
    const stopped = await until(
      async () => (await workers(t)).find((w) => w.workerId === loop.workerId && w.status === "stopped"),
      20_000,
    );
    expect(stopped.stopReason).toMatch(/^watchdog\.looping/);
    expect(agentEvents.some((e) => e.type === "watchdog.flagged" && e.data.workerId === loop.workerId)).toBe(
      true,
    );
    await until(async () => (await said(t)).some((m) => m.includes("被看門狗停下了")));

    // The payment worker is still waiting for the person; 允許一次 lets it pay once.
    expect((await workers(t)).find((w) => w.workerId === shop!.workerId)?.status).toBe("waiting");
    await api("POST", `/api/approvals/${pay.data.approvalId}`, { decision: "approved" });
    await until(async () =>
      (await workers(t)).find((w) => w.workerId === shop!.workerId && w.status === "succeeded"),
    );
    await until(async () => (await said(t)).some((m) => m.includes("「示範商店結帳」完成了")));
    // Worker text never lands in the chat itself.
    expect((await said(t)).some((m) => m.includes("購物車兩件"))).toBe(false);
  }, 60_000);

  it("streams a worker on its own SSE channel, and stops one on request", async () => {
    const t = (await api("POST", "/api/threads", {})).body.id as string;
    await api("POST", `/api/threads/${t}/messages`, { text: DEMO_LOOP_REQUEST });
    const w = await until(async () => (await workers(t)).find((x) => x.status === "running"));
    const ac = new AbortController();
    const res = await fetch(`${app.server.url}/api/workers/${w.workerId}/events`, {
      headers: { authorization: `Bearer ${app.token}`, ...app.uiHeaders },
      signal: ac.signal,
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    while (!buf.includes("check_inbox")) buf += (await reader.read()).value ?? "";
    ac.abort();
    expect(buf).toContain(`"runId":"${w.runId}"`);
    const stop = await api("POST", `/api/workers/${w.workerId}/stop`, {});
    expect(stop.body).toMatchObject({ stopped: true });
    await until(async () =>
      (await workers(t)).find((x) => x.workerId === w.workerId && x.status === "stopped"),
    );
    expect((await api("GET", `/api/workers/${w.workerId}`)).body.stopReason).toBe("user");
    expect((await api("POST", "/api/workers/wkr_nope/stop", {})).status).toBe(404);
  }, 30_000);

  it("manual triggers: stage 1 drops, the judge skips or wakes the router", async () => {
    const t = (await api("POST", "/api/threads", {})).body.id as string;
    const trg = (
      await api("POST", "/api/triggers", {
        threadId: t,
        name: "信箱",
        source: "manual",
        rule: { block: ["ads@shop"] },
      })
    ).body;
    const fire = (body: Record<string, unknown>) => api("POST", `/api/triggers/${trg.id}/fire`, body);
    expect((await fire({ text: "限時特價", from: "ads@shop" })).body).toMatchObject({
      outcome: "dropped",
      judged: null,
    });
    expect((await fire({ text: "電子報：本週新聞" })).body).toMatchObject({
      outcome: "dropped",
      judged: "skip",
    });
    expect((await fire({ text: "請今天回覆合約" })).body).toMatchObject({
      outcome: "router",
      judged: "wake",
    });
    await until(async () => (await said(t)).some((m) => m.includes("有新的觸發事件")));
    expect((await api("POST", "/api/triggers", { threadId: t, source: "email" })).status).toBe(400);
  }, 30_000);
});
