import { type BrowserEvent, newId, type SpaceFrameT } from "@alca/protocol";
import { ToolRegistryImpl } from "@alca/tools";
import { describe, expect, it } from "vitest";
import {
  BrowserAgent,
  BrowserHost,
  browserTools,
  runScript,
  SensitiveActionError,
  SpaceOwnershipError,
  StaleRefError,
} from "../src/index.ts";
import { type FakePage, fakeBrowser } from "../testing/fake-cdp.ts";

const SITE: Record<string, FakePage> = {
  "https://shop.test/": {
    title: "商店首頁",
    nodes: [
      { role: "heading", name: "今日精選", id: 1 },
      { role: "link", name: "購物車", id: 2, href: "https://shop.test/cart" },
      { role: "searchbox", name: "搜尋商品", id: 3, facts: { tag: "input", form: { isSearch: true } } },
      { role: "combobox", name: "排序", id: 4, options: ["最新", "價格"] },
    ],
  },
  "https://shop.test/cart": {
    title: "購物車",
    nodes: [
      { role: "text", name: "小計 NT$1,280", id: 1 },
      { role: "button", name: "確認付款", id: 5, facts: { tag: "button", form: { method: "post" } } },
      { role: "button", name: "繼續購物", id: 6 },
    ],
  },
};

const BOT = "bot_00000000000000000000000001";
const OTHER = "bot_00000000000000000000000002";
const ctl = () => new AbortController().signal;

function setup() {
  const { cdp, proc } = fakeBrowser(SITE);
  const records: string[] = [];
  const host = new BrowserHost({
    launchShared: async () => proc,
    records: {
      openSpace: (s) => records.push(`open:${s.id}:${s.botId}`),
      closeSpace: (id) => records.push(`close:${id}`),
    },
  });
  const events: BrowserEvent[] = [];
  host.subscribe((e) => events.push(e));
  return { cdp, host, agent: new BrowserAgent(host), events, records };
}

describe("browser host", () => {
  it("opens a bot-owned Space with its own window and refuses other bots", async () => {
    const { host, agent, cdp, records } = setup();
    const st = await host.open({ botId: BOT, title: "查價格", url: "https://shop.test/" });
    expect(st).toMatchObject({ botId: BOT, profile: "shared", controller: "agent", title: "查價格" });
    expect(st.tabs[0]?.url).toBe("https://shop.test/");
    expect(cdp.calls.find((c) => c.method === "Target.createTarget")?.params).toMatchObject({
      newWindow: true,
    });
    expect(records).toEqual([`open:${st.spaceId}:${BOT}`]);
    expect(host.list(OTHER)).toEqual([]);
    await expect(
      agent.step(st.spaceId, OTHER, { do: "snapshot" }, { signal: ctl(), granted: "read" }),
    ).rejects.toBeInstanceOf(SpaceOwnershipError);
    const iso = await host.open({ botId: OTHER, title: "隔離", profile: "isolated" });
    expect(iso.profile).toBe("isolated");
    expect(cdp.calls.filter((c) => c.method === "Target.createBrowserContext")).toHaveLength(1);
    await host.close(iso.spaceId);
    expect(cdp.calls.some((c) => c.method === "Target.disposeBrowserContext")).toBe(true);
    expect(records.at(-1)).toBe(`close:${iso.spaceId}`);
  });

  it("snapshots with @N refs, acts on them, and voids them after navigation", async () => {
    const { host, agent } = setup();
    const { spaceId } = await host.open({ botId: BOT, title: "t", url: "https://shop.test/" });
    const opts = { signal: ctl(), granted: "write" as const };
    const snap = await agent.step(spaceId, BOT, { do: "snapshot" }, { ...opts, granted: "read" });
    expect(snap.output).toContain('link "購物車" @1 → https://shop.test/cart');
    expect(snap.output).toContain('trust="untrusted"');
    await agent.step(spaceId, BOT, { do: "type", target: { ref: "@2" }, text: "耳機" }, opts);
    expect(
      (await agent.step(spaceId, BOT, { do: "select", target: { ref: "@3" }, option: "價格" }, opts)).output,
    ).toBe("已選擇「價格」");
    await expect(
      agent.step(spaceId, BOT, { do: "select", target: { ref: "@3" }, option: "熱門" }, opts),
    ).rejects.toThrow(/最新、價格/);
    await agent.step(spaceId, BOT, { do: "click", target: { ref: "@1" } }, opts);
    await new Promise((r) => setTimeout(r, 10));
    expect(host.state(spaceId).tabs[0]?.url).toBe("https://shop.test/cart");
    await expect(
      agent.step(spaceId, BOT, { do: "click", target: { ref: "@1" } }, opts),
    ).rejects.toBeInstanceOf(StaleRefError);
    // Locators re-snapshot on their own.
    const r = await agent.step(
      spaceId,
      BOT,
      { do: "click", target: { role: "button", name: "繼續購物" } },
      opts,
    );
    expect(r.output).toContain("繼續購物");
    expect(agent.recording(spaceId, BOT).steps.map((s) => s.do)).toEqual([
      "type",
      "select",
      "click",
      "click",
    ]);
  });

  it("gates always-confirm steps on the live element", async () => {
    const { host, agent, events } = setup();
    const { spaceId } = await host.open({ botId: BOT, title: "t", url: "https://shop.test/cart" });
    await agent.step(spaceId, BOT, { do: "snapshot" }, { signal: ctl(), granted: "read" });
    const step = { do: "click" as const, target: { ref: "@1" } };
    const ins = await agent.inspect(spaceId, BOT, step);
    expect(ins).toMatchObject({ actionClass: "payment", target: "https://shop.test/cart" });
    expect(ins.summary).toContain("在 shop.test 按下「確認付款」");
    await expect(agent.step(spaceId, BOT, step, { signal: ctl(), granted: "write" })).rejects.toBeInstanceOf(
      SensitiveActionError,
    );
    await expect(agent.step(spaceId, BOT, step, { signal: ctl(), granted: "send" })).rejects.toBeInstanceOf(
      SensitiveActionError,
    );
    const ok = await agent.step(spaceId, BOT, step, { signal: ctl(), granted: "payment" });
    expect(ok.gated).toBe("payment");
    const acts = events.filter((e) => e.type === "space.action");
    expect(
      acts.map((e) => (e.type === "space.action" ? [e.data.kind, e.data.ok, e.data.gated] : [])),
    ).toEqual([
      ["snapshot", true, undefined],
      ["click", false, "payment"],
      ["click", false, "payment"],
      ["click", true, "payment"],
    ]);
  });

  it("takeover: agent commands queue while a person drives, then run after hand-back", async () => {
    const { host, agent, events } = setup();
    const { spaceId } = await host.open({ botId: BOT, title: "t", url: "https://shop.test/" });
    host.takeOver(spaceId, { kind: "user", id: "desktop" }, "我來登入");
    expect(host.state(spaceId)).toMatchObject({
      controller: "user",
      status: "waiting_user",
      handoffReason: "我來登入",
    });
    let done = false;
    const p = agent.step(spaceId, BOT, { do: "snapshot" }, { signal: ctl(), granted: "read" }).then((r) => {
      done = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false);
    expect(host.state(spaceId).status).toBe("queued");
    await host.userInput(spaceId, { type: "click", x: 0.5, y: 0.03 });
    host.handBack(spaceId, { kind: "user", id: "desktop" });
    expect((await p).output).toContain("今日精選");
    const control = events
      .filter((e) => e.type === "space.control")
      .map((e) => (e.type === "space.control" ? e.data.controller : ""));
    expect(control).toEqual(["user", "agent"]);
    await expect(host.userInput(spaceId, { type: "text", text: "x" })).rejects.toThrow(/接手/);
    // Interrupting a queued command rejects it.
    host.takeOver(spaceId, { kind: "user", id: "desktop" });
    const ac = new AbortController();
    const q = agent.step(spaceId, BOT, { do: "snapshot" }, { signal: ac.signal, granted: "read" });
    ac.abort();
    await expect(q).rejects.toThrow(/中斷/);
  });

  it("streams frames only while watched", async () => {
    const { host, cdp } = setup();
    const { spaceId } = await host.open({ botId: BOT, title: "t" });
    const frames: SpaceFrameT[] = [];
    const stop = host.watch(spaceId, (f) => frames.push(f));
    await new Promise((r) => setTimeout(r, 15));
    expect(frames[0]).toMatchObject({ type: "space.frame", spaceId, botId: BOT, mime: "image/jpeg" });
    stop();
    expect(cdp.calls.some((c) => c.method === "Page.stopScreencast")).toBe(true);
  });
});

describe("script mode", () => {
  it("runs deterministic steps in one call and stops at a step that needs approval", async () => {
    const { host, agent } = setup();
    const { spaceId } = await host.open({ botId: BOT, title: "t" });
    const script = {
      version: 1 as const,
      steps: [
        { do: "navigate" as const, url: "https://shop.test/" },
        { do: "click" as const, target: { role: "link", name: "購物車" } },
        { do: "wait" as const, text: "小計" },
        { do: "click" as const, target: { role: "button", name: "確認付款" } },
        { do: "read" as const },
      ],
    };
    const r = await runScript(agent, spaceId, BOT, script, { signal: ctl(), granted: "write" });
    expect(r.steps.map((s) => s.ok)).toEqual([true, true, true, false]);
    expect(r.needsApproval).toMatchObject({ index: 3, actionClass: "payment" });
    // Replay of the recording reaches the same place.
    const rec = agent.recording(spaceId, BOT);
    const again = await runScript(agent, spaceId, BOT, rec as never, { signal: ctl(), granted: "write" });
    expect(again.ok).toBe(true);
  });
});

describe("tool surface in @alca/tools", () => {
  it("registers, opens the thread's Space on first use and inspects before the gate", async () => {
    const { host } = setup();
    const reg = new ToolRegistryImpl().registerAll(browserTools(host));
    expect((await reg.search("網頁 快照")).map((t) => t.name)).toContain("browser_snapshot");
    const ctx = { signal: ctl(), threadId: newId("thread"), botId: BOT };
    const run = (name: string, args: Record<string, unknown>, actionClass = "write" as const) =>
      reg.get(name)!.run(args, { ...ctx, actionClass });
    expect(
      await run("browser_open", { url: "https://shop.test/cart", title: "結帳" }, "network" as never),
    ).toContain("共用登入");
    expect(host.list(BOT)).toHaveLength(1);
    await run("browser_snapshot", {}, "read" as never);
    const ins = await reg.get("browser_click")!.inspect!({ ref: "@1" }, ctx);
    expect(ins.actionClass).toBe("payment");
    await expect(run("browser_click", { ref: "@1" })).rejects.toBeInstanceOf(SensitiveActionError);
    const s = await reg.get("browser_run_script")!.inspect!(
      { script: { version: 1, steps: [{ do: "click", target: { name: "Place order" } }] } },
      ctx,
    );
    expect(s.actionClass).toBe("payment");
    // Another bot on the same thread gets its own Space, never this one.
    await reg.get("browser_open")!.run({}, { ...ctx, botId: OTHER, actionClass: "network" });
    expect(host.list(OTHER)).toHaveLength(1);
    expect(host.list()).toHaveLength(2);
  });
});

describe("gate bypasses (P13 A4)", () => {
  it("a new tab's address goes through the navigate gate like browser_navigate", async () => {
    const { proc } = fakeBrowser(SITE);
    const host = new BrowserHost({
      launchShared: async () => proc,
      rules: () => [{ id: "pay-nav", actionClass: "payment", domain: "shop.test", steps: ["navigate"] }],
    });
    const reg = new ToolRegistryImpl().registerAll(browserTools(host));
    const ctx = { signal: ctl(), threadId: newId("thread"), botId: BOT };
    await reg.get("browser_open")!.run({}, { ...ctx, actionClass: "network" });
    await expect(
      reg.get("browser_navigate")!.run({ url: "https://shop.test/cart" }, { ...ctx, actionClass: "network" }),
    ).rejects.toBeInstanceOf(SensitiveActionError);
    await expect(
      reg
        .get("browser_tabs")!
        .run({ action: "new", url: "https://shop.test/cart" }, { ...ctx, actionClass: "network" }),
    ).rejects.toBeInstanceOf(SensitiveActionError);
    const space = host.list(BOT)[0];
    expect(space?.tabs.every((t) => t.url !== "https://shop.test/cart")).toBe(true);
  });
});

describe("script validation", () => {
  it("rejects malformed scripts with readable problems", async () => {
    const { scriptProblems } = await import("../src/index.ts");
    expect(scriptProblems({ version: 1, steps: [] })).toEqual(["steps 必須是非空陣列"]);
    expect(
      scriptProblems({
        version: 1,
        steps: [{ do: "eval", code: "x" }, { do: "click" }, { do: "type", target: { ref: "@1" } }],
      }),
    ).toEqual(["第 1 步: 不認得的動作 eval", "第 2 步: target 必須是物件", "第 3 步: type 需要 text"]);
  });
});

describe("browser host: service and shared workers (R3)", () => {
  const attached = (cdp: ReturnType<typeof setup>["cdp"], sessionId: string, info: Record<string, unknown>) =>
    cdp.fire("Target.attachedToTarget", { sessionId, targetInfo: info, waitingForDebugger: true });
  const settle = () => new Promise((r) => setTimeout(r, 10));
  const on = (cdp: ReturnType<typeof setup>["cdp"], sessionId: string) =>
    cdp.calls.filter((c) => c.sessionId === sessionId).map((c) => c.method);

  it("auto-attaches service and shared workers at the browser level, paused", async () => {
    const { host, cdp } = setup();
    await host.open({ botId: BOT, title: "t", url: "https://shop.test/" });
    const auto = cdp.calls.find((c) => c.method === "Target.setAutoAttach" && !c.sessionId);
    expect(auto?.params).toEqual({
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
      filter: [{ type: "service_worker" }, { type: "shared_worker" }],
    });
  });

  it("gates a Space's worker before it runs, by context or by origin; leaves everyone else's alone", async () => {
    const { host, cdp } = setup();
    await host.open({ botId: BOT, title: "shared", url: "https://shop.test/" });
    const iso = await host.open({ botId: OTHER, title: "iso", profile: "isolated" });
    const ctx = String(
      cdp.calls.filter((c) => c.method === "Target.createTarget").at(-1)?.params.browserContextId ?? "",
    );
    expect(ctx).not.toBe("");
    attached(cdp, "SW1", { targetId: "W1", type: "service_worker", url: "https://shop.test/sw.js" });
    attached(cdp, "SW2", {
      targetId: "W2",
      type: "shared_worker",
      url: "https://x.test/w.js",
      browserContextId: ctx,
    });
    attached(cdp, "SW3", { targetId: "W3", type: "service_worker", url: "https://person.test/sw.js" });
    attached(cdp, "SW4", { targetId: "W4", type: "page", url: "https://shop.test/" });
    await settle();
    expect(on(cdp, "SW1")).toEqual(["Fetch.enable", "Runtime.runIfWaitingForDebugger"]);
    expect(on(cdp, "SW2")).toEqual(["Fetch.enable", "Runtime.runIfWaitingForDebugger"]);
    expect(on(cdp, "SW3")).toEqual(["Runtime.runIfWaitingForDebugger"]);
    expect(
      cdp.calls.some((c) => c.method === "Target.detachFromTarget" && c.params.sessionId === "SW3"),
    ).toBe(true);
    expect(on(cdp, "SW4")).toEqual([]);
    await host.close(iso.spaceId);
  });

  it("closes a Space's worker the gate could not attach to", async () => {
    const { host, cdp } = setup();
    await host.open({ botId: BOT, title: "shared", url: "https://shop.test/" });
    cdp.intercept = (method, _params, _t) => {
      if (method === "Fetch.enable" && cdp.calls.at(-1)?.sessionId === "SWX") throw new Error("detached");
      return undefined;
    };
    attached(cdp, "SWX", { targetId: "WX", type: "service_worker", url: "https://shop.test/sw.js" });
    await settle();
    expect(on(cdp, "SWX")).toEqual(["Fetch.enable"]);
    expect(cdp.calls.some((c) => c.method === "Target.closeTarget" && c.params.targetId === "WX")).toBe(true);
  });
});
