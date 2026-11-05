import { newId } from "@alca/protocol";
import { ToolRegistryImpl } from "@alca/tools";
import { describe, expect, it } from "vitest";
import {
  BrowserAgent,
  BrowserHost,
  browserTools,
  generalBrowserTools,
  redactSecrets,
  runSandbox,
  SANDBOX_LIMITS,
  SandboxStop,
  stepOf,
} from "../src/index.ts";
import { type FakePage, fakeBrowser } from "../testing/fake-cdp.ts";

const SITE: Record<string, FakePage> = {
  "https://shop.test/": {
    title: "商店首頁",
    nodes: [
      { role: "heading", name: "今日精選", id: 1 },
      { role: "link", name: "購物車", id: 2, href: "https://shop.test/cart" },
      { role: "searchbox", name: "搜尋商品", id: 3, facts: { tag: "input", form: { isSearch: true } } },
    ],
  },
  "https://shop.test/cart": {
    title: "購物車",
    nodes: [
      { role: "text", name: "小計 NT$1,280", id: 1 },
      { role: "button", name: "確認付款", id: 5, facts: { tag: "button", form: { method: "post" } } },
    ],
  },
  "https://login.test/": {
    title: "登入",
    nodes: [
      { role: "textbox", name: "帳號", id: 1, facts: { tag: "input" } },
      { role: "textbox", name: "密碼", id: 2, facts: { tag: "input", type: "password" } },
    ],
  },
  "http://plain.test/": {
    title: "沒有加密的登入",
    nodes: [{ role: "textbox", name: "密碼", id: 2, facts: { tag: "input", type: "password" } }],
  },
  "https://form.test/": {
    title: "設定",
    nodes: [
      { role: "button", name: "選單", id: 1, css: ["#menu", ".nav button"] },
      { role: "checkbox", name: "深色模式", id: 2, checked: false, css: ["#news"] },
      { role: "checkbox", name: "記住我", id: 3, checked: true, css: ["#remember"] },
      { role: "text", name: "說明文字", id: 4, css: ["p.help"] },
      { role: "button", name: "儲存", id: 5, css: [".nav button"] },
    ],
  },
};

const BOT = "bot_00000000000000000000000001";
const ctl = () => new AbortController().signal;

function setup(o: Parameters<typeof generalBrowserTools>[1] = {}) {
  const { proc, cdp } = fakeBrowser(SITE);
  const host = new BrowserHost({ launchShared: async () => proc });
  const reg = new ToolRegistryImpl().registerAll([...browserTools(host), ...generalBrowserTools(host, o)]);
  const ctx = { signal: ctl(), threadId: newId("thread"), botId: BOT };
  const run = (name: string, args: Record<string, unknown>, actionClass: string = "write") =>
    reg.get(name)!.run(args, { ...ctx, actionClass: actionClass as "write" });
  return { host, reg, ctx, run, cdp };
}

describe("browser_script sandbox (plan §5)", () => {
  const step = async (req: { action: string; ms?: unknown }) => {
    if (req.action === "sleep") return null;
    if (req.action === "stop") throw new SandboxStop("user_control", "使用者接手");
    return { did: req.action };
  };

  it("runs helpers as steps and returns a JSON value with the log", async () => {
    const r = await runSandbox({
      script:
        "const a = await navigate('https://x.test'); log('看到', a); await sleep(10); return { a, n: 1 + 1 };",
      step,
    });
    expect(r).toMatchObject({ status: "completed", value: { a: { did: "navigate" }, n: 2 }, steps: 2 });
    expect(r.log[0]).toContain("看到");
  });

  it("enforces the limits: 200 steps, wall time, memory, returned bytes, source length", async () => {
    expect((await runSandbox({ script: "for (;;) await snapshot();", step })).status).toBe("step_limit");
    expect((await runSandbox({ script: "while (true) {}", step, timeoutMs: 1000 })).status).toBe("timeout");
    const mem = await runSandbox({
      script: "const x = 'a'.repeat(100 * 1024 * 1024); return x.length",
      step,
    });
    expect(mem.status).toBe("failed");
    expect(mem.error).toMatch(/memory/);
    const big = await runSandbox({ script: `return 'x'.repeat(${SANDBOX_LIMITS.valueBytes + 1})`, step });
    expect(big.error).toContain("位元組");
    const long = await runSandbox({ script: "x".repeat(SANDBOX_LIMITS.scriptChars + 1), step });
    expect(long.status).toBe("failed");
  });

  it("has no network, files, process or timers; awaiting anything else is stuck", async () => {
    const r = await runSandbox({
      script: "return [typeof require, typeof process, typeof fetch, typeof setTimeout, typeof import.meta]",
      step,
    }).catch((e) => ({ status: "failed", error: String(e) }));
    expect(
      r.status === "failed" || JSON.stringify((r as { value?: unknown }).value).includes("undefined"),
    ).toBe(true);
    const stuck = await runSandbox({ script: "await new Promise(() => {}); return 1", step });
    expect(stuck.status).toBe("failed");
    expect(stuck.error).toContain("helper");
  });

  it("a host stop ends the script with its status; host errors can be caught", async () => {
    expect((await runSandbox({ script: "await step({ action: 'stop' }); return 1", step })).status).toBe(
      "user_control",
    );
    const caught = await runSandbox({
      script: "try { await click(text('x')) } catch (e) { return 'caught: ' + e.message }",
      step: async () => {
        throw new Error("找不到");
      },
    });
    expect(caught.value).toBe("caught: 找不到");
  });

  it("maps only whitelisted steps; secrets, uploads and takeovers do not exist in a script", () => {
    expect(stepOf({ action: "click", target: { role: "button", name: "搜尋" } })).toEqual({
      do: "click",
      target: { role: "button", name: "搜尋" },
    });
    expect(stepOf({ action: "sleep", ms: 99_999 })).toEqual({ do: "wait", ms: 5000 });
    for (const action of ["fill_secret", "fill_card", "upload", "takeover", "screenshot", "new_tab"])
      expect(() => stepOf({ action })).toThrow();
    expect(stepOf({ action: "click", target: { css: "#a" } })).toEqual({
      do: "click",
      target: { css: "#a" },
    });
    expect(stepOf({ action: "hover", target: { css: "#a" } })).toEqual({
      do: "hover",
      target: { css: "#a" },
    });
    expect(stepOf({ action: "set_checked", target: { ref: "@2" }, checked: true })).toEqual({
      do: "check",
      target: { ref: "@2" },
      checked: true,
    });
    expect(() => stepOf({ action: "evaluate", expr: "document.cookie" })).toThrow(/evaluate 不支援/);
  });

  it("a submit / pay step inside a script still stops at the gate", async () => {
    const { run } = setup();
    await run("browser_open", { url: "https://shop.test/cart" }, "network");
    const out = JSON.parse(
      await run("browser_script", {
        script: "await click(role('button', '確認付款')); return 'paid'",
        finalSnapshot: false,
      }),
    );
    expect(out.status).toBe("failed");
    expect(out.error).toContain("批准");
    expect(out.value).toBeUndefined();
  });

  it("a script step while the person holds the Space ends with user_control", async () => {
    const { run, host } = setup();
    await run("browser_open", { url: "https://shop.test/" }, "network");
    const s = host.list(BOT)[0]!;
    host.takeOver(s.spaceId, { kind: "user", id: "me" });
    const out = JSON.parse(
      await run("browser_script", { script: "await snapshot(); return 1", finalSnapshot: false }),
    );
    expect(out.status).toBe("user_control");
  });
});

describe("vault fill and takeover (plan §5)", () => {
  it("fills by vault id: the value never appears in the result, and a scripted site is refused", async () => {
    const secret = "hunter2-very-secret";
    const { run } = setup({ secrets: { value: async (_b, id) => (id === "login_1" ? secret : undefined) } });
    await run("browser_open", { url: "https://login.test/" }, "network");
    await run("browser_snapshot", {}, "read");
    const out = await run("browser_fill_secret", { ref: "@2", secretId: "login_1" });
    expect(out).not.toContain(secret);
    expect(out).toContain("金庫");
    await expect(run("browser_fill_secret", { ref: "@2", secretId: "nope" })).rejects.toThrow(/takeover/);
    await run("browser_script", { script: "await snapshot(); return 1", finalSnapshot: false });
    await expect(run("browser_fill_secret", { ref: "@2", secretId: "login_1" })).rejects.toThrow(/腳本/);
  });

  it("takeover waits for the hand-back; background work is refused", async () => {
    const { run, host } = setup({ interactive: () => true });
    await run("browser_open", { url: "https://shop.test/" }, "network");
    const s = host.list(BOT)[0]!;
    const p = run("browser_request_takeover", { reason: "captcha" }, "read");
    await new Promise((r) => setTimeout(r, 20));
    expect(host.list(BOT)[0]?.controller).toBe("user");
    host.handBack(s.spaceId, { kind: "user", id: "me" });
    expect(JSON.parse(await p)).toEqual({ status: "completed", next: "take_fresh_snapshot" });
    const bg = setup({ interactive: () => false });
    await bg.run("browser_open", { url: "https://shop.test/" }, "network");
    await expect(bg.run("browser_request_takeover", { reason: "captcha" }, "read")).rejects.toThrow(
      /needs_input/,
    );
    const short = setup({ takeoverMaxMs: 30 });
    await short.run("browser_open", { url: "https://shop.test/" }, "network");
    expect(JSON.parse(await short.run("browser_request_takeover", { reason: "other" }, "read")).status).toBe(
      "timeout",
    );
    expect(short.host.list(BOT)[0]?.controller).toBe("agent");
  });

  it("redacts known values, card numbers and bearer tokens", () => {
    expect(
      redactSecrets("pw=abcd1234 card 4111 1111 1111 1111 Authorization: Bearer xyz.abc", ["abcd1234"]),
    ).toBe("pw=•••• card •••• Authorization: ••••");
  });
});

describe("browser_script hover / setChecked / css (plan §5)", () => {
  it("hovers, sets checkboxes idempotently and targets by css; evaluate does not exist", async () => {
    const { run, cdp } = setup();
    await run("browser_open", { url: "https://form.test/" }, "network");
    const out = JSON.parse(
      await run("browser_script", {
        script: [
          "await hover(css('#menu'));",
          "const a = await setChecked(css('#news'), true);",
          "const b = await setChecked(role('checkbox', '記住我'), true);",
          "const c = await setChecked(css('#remember'), false);",
          "await click(css('.nav button', 1));",
          "let e; try { await evaluate('document.cookie') } catch (x) { e = x.message }",
          "let f; try { await click(css('p.help')) } catch (x) { f = x.message }",
          "return { a, b, c, e, f };",
        ].join("\n"),
        finalSnapshot: false,
      }),
    );
    expect(out.error ?? out.status).toBe("completed");
    expect(out.value.a).toContain("已勾選");
    expect(out.value.b).toContain("本來就勾選");
    expect(out.value.c).toContain("已取消勾選");
    expect(out.value.e).toMatch(/evaluate 不支援/);
    expect(out.value.f).toMatch(/css/);
    const moved = cdp.calls.filter(
      (c) => c.method === "Input.dispatchMouseEvent" && c.params.type === "mouseMoved",
    );
    expect(moved.some((c) => Number(c.params.y) >= 10 && Number(c.params.y) < 20)).toBe(true);
    expect(
      cdp.calls.some(
        (c) => c.method === "Runtime.evaluate" && String(c.params.expression).includes("cookie"),
      ),
    ).toBe(false);
  });

  it("an invalid css selector is an error the script can catch", async () => {
    const { run } = setup();
    await run("browser_open", { url: "https://form.test/" }, "network");
    const out = JSON.parse(
      await run("browser_script", {
        script: "try { await click(css('!!bad')) } catch (e) { return e.message }",
        finalSnapshot: false,
      }),
    );
    expect(out.value).toMatch(/css 選擇器無效/);
  });

  it("the tool description lists exactly the helpers the sandbox has", () => {
    const { reg } = setup();
    const d = reg.get("browser_script")!.summary;
    for (const h of [
      "navigate",
      "click",
      "type",
      "press",
      "hover",
      "scroll",
      "selectOption",
      "setChecked",
      "waitFor",
      "snapshot",
      "sleep",
      "log",
      "css(",
    ])
      expect(d, h).toContain(h);
    expect(d).toContain("沒有 evaluate");
  });
});

describe("vault fill: password only, https and the item's own origin (plan §5)", () => {
  const secret = "s3cret-Passw0rd!";
  const vault = {
    value: async (_b: string, id: string, origin: string) =>
      id === "login_1" && origin === "https://login.test" ? secret : undefined,
  };

  it("never puts the value in a result, a later snapshot, the recording or a space event", async () => {
    const { run, host } = setup({ secrets: vault });
    const events: unknown[] = [];
    host.subscribe((e) => events.push(e));
    await run("browser_open", { url: "https://login.test/" }, "network");
    await run("browser_snapshot", {}, "read");
    const out = await run("browser_fill_secret", { ref: "@2", secretId: "login_1" });
    const snap = await run("browser_snapshot", {}, "read");
    const s = host.list(BOT)[0]!;
    const rec = JSON.stringify(new BrowserAgent(host).recording(s.spaceId, BOT));
    for (const text of [out, snap, rec, JSON.stringify(events), JSON.stringify(host.list(BOT))])
      expect(text).not.toContain(secret);
    expect(snap).toContain("••••");
  });

  it("refuses http pages, other origins and fields that are not passwords", async () => {
    const { run } = setup({ secrets: vault });
    await run("browser_open", { url: "http://plain.test/" }, "network");
    await run("browser_snapshot", {}, "read");
    await expect(run("browser_fill_secret", { ref: "@1", secretId: "login_1" })).rejects.toThrow(/HTTPS/);
    const other = setup({ secrets: vault });
    await other.run("browser_open", { url: "https://form.test/" }, "network");
    await other.run("browser_snapshot", {}, "read");
    await expect(other.run("browser_fill_secret", { ref: "@2", secretId: "login_1" })).rejects.toThrow(
      /密碼欄位/,
    );
    const login = setup({ secrets: vault });
    await login.run("browser_open", { url: "https://login.test/" }, "network");
    await login.run("browser_snapshot", {}, "read");
    await expect(login.run("browser_fill_secret", { ref: "@1", secretId: "login_1" })).rejects.toThrow(
      /密碼欄位/,
    );
  });
});
