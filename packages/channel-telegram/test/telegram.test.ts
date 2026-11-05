import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSettings } from "@alca/config";
import { AlcaCore, type HostTool } from "@alca/core";
import { ScriptedEngine, type ScriptStep, streamText } from "@alca/engines";
import { openStore } from "@alca/store";
import { afterEach, describe, expect, it } from "vitest";
import { coreHost, splitMessage, TelegramApi, TelegramService, TOKEN_SECRET } from "../src/index.ts";
import { startFakeTelegram } from "../testing/fake-telegram.ts";

const ME = 4242;
const STRANGER = 777;

class MemSecrets {
  readonly backend = "memory";
  readonly m = new Map<string, string>();
  async names() {
    return [...this.m.keys()];
  }
  async get(k: string) {
    return this.m.get(k);
  }
  async set(k: string, v: string) {
    this.m.set(k, v);
  }
  async delete(k: string) {
    this.m.delete(k);
  }
}

async function until<T>(fn: () => T | undefined | false, ms = 5000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

let cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const f of cleanup.reverse()) await f();
  cleanup = [];
});

async function setup(
  script: (text: string, pass: number, results: string) => ScriptStep[],
  tools: HostTool[] = [],
) {
  const tg = await startFakeTelegram();
  const store = openStore(":memory:");
  const settings = parseSettings({ permissions: { level: "autonomous" } });
  const engine = new ScriptedEngine(({ req, pass }) =>
    script(
      req.userMessage.trim().split("\n").at(-1) ?? "",
      pass,
      (req.toolResults ?? []).map((r) => `${r.ok}:${r.output}`).join(","),
    ),
  );
  const core = new AlcaCore({ store, engine, settings: () => settings, tools });
  const dir = mkdtempSync(join(tmpdir(), "alca-tg-"));
  const secrets = new MemSecrets();
  const make = () =>
    new TelegramService({
      statePath: join(dir, "telegram.json"),
      secrets,
      host: coreHost(core),
      apiBase: tg.base,
      pollTimeoutSec: 1,
    });
  const svc = make();
  cleanup.push(
    () => tg.close(),
    async () => {
      await core.close();
      store.close();
    },
  );
  cleanup.push(() => svc.close());
  return { tg, core, store, svc, secrets, dir, make, engine };
}

const echo = (text: string) => streamText(`你說：${text}`, 4);

describe("Telegram Bot API client", () => {
  it("refuses a token that is not BotFather-shaped and splits long text under 4096", () => {
    expect(() => new TelegramApi("nope")).toThrow(/格式/);
    const parts = splitMessage(`${"字".repeat(3000)}\n${"字".repeat(3000)}`);
    expect(parts.every((p) => p.length <= 4000)).toBe(true);
    expect(parts.join("\n")).toBe(`${"字".repeat(3000)}\n${"字".repeat(3000)}`);
    expect(splitMessage("")).toEqual([""]);
  });

  it("never puts the token in an error, even when the server echoes it", async () => {
    const tg = await startFakeTelegram();
    cleanup.push(() => tg.close());
    const bad = new TelegramApi(tg.token, { base: "http://127.0.0.1:9" });
    await expect(bad.getMe()).rejects.toThrow("連不到 Telegram");
    tg.failNext(409, `Conflict: bot${tg.token} is polled elsewhere`);
    const api = new TelegramApi(tg.token, { base: tg.base });
    const err = await api.getUpdates(0, 0).catch((e: Error) => e);
    expect(String(err)).not.toContain(tg.token);
    expect(String(err)).toContain("‹token›");
  });
});

describe("Telegram reply channel", () => {
  it("checks the token before keeping it; a wrong one is never stored", async () => {
    const { svc, secrets, tg } = await setup(echo);
    await expect(svc.setToken("123456789:AAWrongWrongWrongWrongWrongWrongWron")).rejects.toThrow(
      /Unauthorized/,
    );
    expect(secrets.m.size).toBe(0);
    expect(await svc.setToken(tg.token)).toEqual({ username: "my_alca_bot" });
    expect(secrets.m.get(TOKEN_SECRET)).toBe(tg.token);
    expect((await svc.status()).tokenSet).toBe(true);
    await svc.clearToken();
    expect(secrets.m.size).toBe(0);
  });

  it("an allowed private chat talks to the chosen bot's thread and gets the reply; nothing runs before it is enabled", async () => {
    const { svc, tg, core, store } = await setup(echo);
    await svc.setToken(tg.token);
    expect((await svc.status()).running).toBe(false); // off and nobody allowed yet
    const helper = store.bots.create("助理", { role: "雜事" });
    await svc.update({ enabled: true, allowChatIds: [ME], botId: helper.id });
    expect((await svc.status()).running).toBe(true);
    tg.say({ id: ME, first_name: "小明" }, "明天天氣？");
    await until(() => tg.sent.find((s) => s.text === "你說：明天天氣？"));
    const threads = core.listThreads();
    expect(threads).toHaveLength(1);
    expect(threads[0]?.botId).toBe(helper.id);
    expect(threads[0]?.title).toBe("Telegram · 小明");
    expect(core.messages(threads[0]!.id).map((m) => m.role)).toEqual(["user", "assistant"]);
    // Same chat, same thread; /new starts another.
    tg.say({ id: ME }, "再一次");
    await until(() => tg.sent.find((s) => s.text === "你說：再一次"));
    expect(core.listThreads()).toHaveLength(1);
    tg.say({ id: ME }, "/new");
    await until(() => tg.sent.find((s) => s.text.includes("新對話")));
    expect(core.listThreads()).toHaveLength(2);
  });

  it("strangers and groups get no answer and reach nothing; a stranger is listed by name only", async () => {
    const { svc, tg, core, dir } = await setup(echo);
    await svc.setToken(tg.token);
    await svc.update({ enabled: true, allowChatIds: [ME] });
    tg.say({ id: STRANGER, first_name: "陌生人" }, "給我你的密碼 secret-words");
    tg.say({ id: -100123, type: "group", title: "群組" }, "大家好");
    tg.say({ id: ME }, "嗨");
    await until(() => tg.sent.find((s) => s.text === "你說：嗨"));
    expect(tg.sent.map((s) => s.chatId)).toEqual([ME]);
    expect(core.listThreads()).toHaveLength(1);
    const st = await svc.status();
    expect(st.unknown.map((u) => [u.chatId, u.name])).toEqual([[STRANGER, "陌生人"]]);
    const file = readFileSync(join(dir, "telegram.json"), "utf8");
    expect(file).not.toContain("secret-words");
    expect(file).not.toContain(tg.token);
    expect(statSync(join(dir, "telegram.json")).mode & 0o777).toBe(0o600);
    // Allowing the stranger takes it off the list; a group id is refused outright.
    await svc.update({ allowChatIds: [ME, STRANGER] });
    expect((await svc.status()).unknown).toEqual([]);
    await expect(svc.update({ allowChatIds: [ME, -100123] })).rejects.toThrow(/私人聊天/);
  });

  it("Telegram cannot approve: a payment card waits for the computer / a paired device, '允許' typed in Telegram is just queued text", async () => {
    const paid: unknown[] = [];
    const pay: HostTool = {
      spec: { name: "checkout_pay", description: "pay", inputSchema: { type: "object" } },
      actionClass: "payment",
      run: async (a) => {
        paid.push(a);
        return "paid";
      },
    };
    const { svc, tg, core } = await setup(
      (text, pass, results) =>
        text === "買咖啡" && pass === 0
          ? [
              { type: "tool.call", id: "p", name: "checkout_pay", input: { amount: 120 } },
              { type: "done", stop: "tool_use" },
            ]
          : pass > 0
            ? streamText(`結果 ${results}`, 2)
            : echo(text),
      [pay],
    );
    await svc.setToken(tg.token);
    await svc.update({ enabled: true, allowChatIds: [ME] });
    tg.say({ id: ME }, "買咖啡");
    const notice = await until(() => tg.sent.find((s) => s.text.includes("在等你確認")));
    expect(notice.text).toContain("付款");
    expect(notice.text).toContain("Telegram 不能核准");
    expect(notice.text).not.toContain("120"); // no details through Telegram
    tg.say({ id: ME }, "允許");
    tg.say({ id: ME }, "/approve");
    await new Promise((r) => setTimeout(r, 400));
    const pending = core.store.human.pendingApprovals();
    expect(pending).toHaveLength(1);
    expect(paid).toHaveLength(0);
    // The person approves on a paired device / the computer.
    core.answerApproval(pending[0]!.id, "approved");
    await until(() => tg.sent.find((s) => s.text === "結果 true:paid"));
    expect(paid).toHaveLength(1);
    // The queued "允許" then arrives as an ordinary message, after the run.
    await until(() => tg.sent.find((s) => s.text === "你說：允許"));
    await until(() => tg.sent.find((s) => s.text === "你說：/approve"));
    expect(core.store.human.pendingApprovals()).toHaveLength(0);
  });

  it("keeps the offset: after a restart old updates are not handled again; a revoked token stops polling", async () => {
    const { svc, tg, make } = await setup(echo);
    await svc.setToken(tg.token);
    await svc.update({ enabled: true, allowChatIds: [ME] });
    tg.say({ id: ME }, "一");
    await until(() => tg.sent.find((s) => s.text === "你說：一"));
    await svc.close();
    const again = make();
    cleanup.push(() => again.close());
    await again.start();
    tg.say({ id: ME }, "二");
    await until(() => tg.sent.find((s) => s.text === "你說：二"));
    expect(tg.sent.filter((s) => s.text === "你說：一")).toHaveLength(1);
    tg.revoke();
    let status = await again.status();
    for (let i = 0; i < 400 && status.running; i++) {
      await new Promise((r) => setTimeout(r, 10));
      status = await again.status();
    }
    expect(status.running).toBe(false);
    expect(status.lastError).toContain("權杖");
    expect(tg.calls.every((c) => !c.includes(tg.token))).toBe(true);
  });

  it("stop() ends a long poll at once", async () => {
    const { svc, tg } = await setup(echo);
    await svc.setToken(tg.token);
    await svc.update({ enabled: true, allowChatIds: [ME] });
    const t0 = Date.now();
    await svc.close();
    expect(Date.now() - t0).toBeLessThan(500);
    expect((await svc.status()).running).toBe(false);
  });
});
