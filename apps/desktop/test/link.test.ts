import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostTool } from "@alca/core";
import { ScriptedEngine, type ScriptStep, streamText } from "@alca/engines";
import { pairHands, runHands } from "@alca/hands";
import { generateIdentity, LinkClient, type LinkCredentials, pairDevice } from "@alca/link";
import type { AlcaEvent } from "@alca/protocol";
import { startRendezvous } from "@alca/rendezvous";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openVault } from "../src/data-dir.ts";
import { type DesktopApp, startDesktop } from "../src/index.ts";

/**
 * End to end over a real rendezvous: desktop core (Link outbound, no inbound
 * port) ⇄ relay ⇄ a headless phone client (the same LinkClient the PWA uses)
 * and a hands daemon on "another machine".
 */

vi.setConfig({ testTimeout: 30_000 });

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const until = async (f: () => boolean, ms = 8000, what = "condition") => {
  const t = Date.now();
  while (!f()) {
    if (Date.now() - t > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
};

let paid = 0;
const payTool: HostTool = {
  spec: { name: "pay_invoice", description: "付一張帳單", inputSchema: { type: "object", properties: {} } },
  actionClass: "payment",
  run: async () => {
    paid++;
    return "已付 NT$1,280";
  },
};

function engine() {
  return new ScriptedEngine(({ pass, req }): ScriptStep[] => {
    const msg = req.userMessage;
    if (pass === 0 && msg.includes("付款")) {
      return [
        ...streamText("好，我準備付款。", 3),
        { type: "tool.call", id: "p1", name: "pay_invoice", input: {} },
        { type: "done", stop: "tool_use" },
      ];
    }
    if (pass === 0 && msg.includes("手腳")) {
      return [
        { type: "tool.call", id: "h1", name: "hands_run", input: { command: "echo 來自手腳 && pwd" } },
        { type: "done", stop: "tool_use" },
      ];
    }
    if (pass === 1) return streamText(`結果：${req.toolResults?.[0]?.output ?? ""}`, 4);
    return streamText("哈囉，這是從桌機串流到手機的回覆。", 3);
  });
}

async function boot() {
  const relay = await startRendezvous({ port: 0, tap: (_d, p) => seen.push(p) });
  const seen: unknown[] = [];
  const dir = mkdtempSync(join(tmpdir(), "alca-link-e2e-"));
  const app: DesktopApp = await startDesktop({
    engine: "demo",
    dataDir: dir,
    port: 0,
    agents: "direct",
    browser: "off",
    engineOverride: engine(),
    tools: [payTool],
    rendezvous: relay.url,
  });
  cleanups.push(
    () => rmSync(dir, { recursive: true, force: true }),
    () => relay.close(),
    () => app.close(),
  );
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${app.server.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${app.token}`, ...app.uiHeaders, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  return { app, relay, api, dir, seen };
}

type Boot = Awaited<ReturnType<typeof boot>>;

async function phone(b: Boot, scopes?: string[]) {
  const p = await b.api("POST", "/api/link/pairings", scopes ? { scopes } : {});
  expect(p.status).toBe(201);
  expect(String(p.body.qrSvg)).toMatch(/^<svg/);
  expect(String(p.body.url)).toContain(`#pair=${String(p.body.code)}`);
  const identity = await generateIdentity();
  const creds: LinkCredentials = await pairDevice({
    relayUrl: b.relay.url,
    code: String(p.body.display),
    identity,
    device: { name: "測試 iPhone", kind: "phone", platform: "headless" },
    expectFingerprint: String(p.body.coreFingerprint),
  });
  const client = new LinkClient({
    credentials: creds,
    identity,
    pingSec: 0,
    backoff: { first: 50, max: 300 },
  });
  const events: AlcaEvent[] = [];
  client.onEvent((ch, e) => {
    if (ch === "alca") events.push(e as AlcaEvent);
  });
  client.start();
  cleanups.push(() => client.stop());
  await until(() => client.status === "online", 8000, "phone online");
  return { client, creds, events };
}

const text = (events: AlcaEvent[], runId: string) =>
  events
    .filter((e) => e.runId === runId && e.type === "message.delta")
    .map((e) => (e.data as { delta: string }).delta)
    .join("");

describe("Alca Link end to end (desktop core + rendezvous + headless phone + hands)", () => {
  it("a phone paired before the keys moved into the vault still connects after the move (§6.9)", async () => {
    const b = await boot();
    const { client } = await phone(b);
    const close = b.app.close;
    let closed = false;
    b.app.close = async () => {
      if (closed) return;
      closed = true;
      await close();
    };
    const v = openVault(b.dir, "file");
    const id = (await v.get("core.linkIdentity")) as string;
    const vapid = (await v.get("core.vapidKey")) as string;
    await b.app.close();
    await until(() => client.status !== "online", 8000, "phone offline");
    // Make the folder what a pre-D1 version leaves: the keys in secrets.json, none in the vault.
    const file = join(b.dir, "secrets.json");
    const token = (JSON.parse(readFileSync(file, "utf8")) as Record<string, string>)[
      "core.localToken"
    ] as string;
    writeFileSync(
      file,
      JSON.stringify({ "core.localToken": token, "link.identityKey": id, "push.vapidKey": vapid }),
    );
    rmSync(`${file}.bak`);
    await openVault(b.dir, "file").deleteMany(["core.linkIdentity", "core.vapidKey"]);
    const again = await startDesktop({
      engine: "demo",
      dataDir: b.dir,
      port: 0,
      agents: "direct",
      browser: "off",
      engineOverride: engine(),
      tools: [payTool],
      rendezvous: b.relay.url,
    });
    cleanups.unshift(() => again.close());
    expect(
      (JSON.parse(readFileSync(file, "utf8")) as Record<string, string>)["link.identityKey"],
    ).toBeUndefined();
    expect(await openVault(b.dir, "file").get("core.linkIdentity")).toBe(id);
    // The phone pinned the old identity; it reconnects to the moved one with the same credentials.
    await until(() => client.status === "online", 8000, "phone back online");
    const t = await client.request<{ id: string }>("threads.create", { title: "搬家後" });
    expect(t.id).toBeTruthy();
  });

  it("pairs a phone, streams a reply, and approves a payment card from the phone", async () => {
    const b = await boot();
    expect(b.app.link?.host.status).toBe("online");
    // The identity key is a real P-256 key pair, kept in the vault (Phase D1), not in secrets.json.
    const secrets = JSON.parse(readFileSync(join(b.dir, "secrets.json"), "utf8")) as Record<string, string>;
    expect(secrets["link.identityKey"]).toBeUndefined();
    const identity = (await openVault(b.dir, "file").get("core.linkIdentity")) as string;
    expect(JSON.parse(identity).privateJwk.crv).toBe("P-256");

    const { client, events } = await phone(b);
    const t = await client.request<{ id: string }>("threads.create", { title: "手機" });
    await client.request("watch.thread", { threadId: t.id });

    const r1 = await client.request<{ runId: string }>("threads.send", { threadId: t.id, text: "你好" });
    await until(() => events.some((e) => e.runId === r1.runId && e.type === "run.finished"), 8000, "reply");
    expect(text(events, r1.runId)).toBe("哈囉，這是從桌機串流到手機的回覆。");
    expect(events.filter((e) => e.runId === r1.runId && e.type === "message.delta").length).toBeGreaterThan(
      3,
    );

    const r2 = await client.request<{ runId: string }>("threads.send", { threadId: t.id, text: "幫我付款" });
    await until(
      () => events.some((e) => e.runId === r2.runId && e.type === "approval.requested"),
      8000,
      "card",
    );
    const card = events.find((e) => e.runId === r2.runId && e.type === "approval.requested");
    expect(card?.data).toMatchObject({ actionClass: "payment" });
    expect(paid).toBe(0);
    const res = await client.request("approvals.answer", {
      approvalId: (card?.data as { approvalId: string } | undefined)?.approvalId,
      decision: "approved",
    });
    expect(res).toEqual({ resolved: true });
    await until(() => events.some((e) => e.runId === r2.runId && e.type === "run.finished"), 8000, "finish");
    expect(paid).toBe(1);
    const resolved = events.find((e) => e.runId === r2.runId && e.type === "approval.resolved");
    expect((resolved?.data as { by: { id: string } } | undefined)?.by.id).toMatch(/^device:dev_/);
    expect(text(events, r2.runId)).toContain("已付 NT$1,280");

    // The relay never saw any of it in the clear.
    const dump = JSON.stringify(b.seen);
    for (const s of ["你好", "付款", "NT$1,280", "approval", "測試 iPhone", "threads.send"])
      expect(dump).not.toContain(s);
  });

  it("refuses ops outside a device's scopes; revoke cuts the phone off", async () => {
    const b = await boot();
    const { client, creds } = await phone(b, ["chat"]);
    await expect(
      client.request("approvals.answer", { approvalId: "apr_x", decision: "approved" }),
    ).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(client.request("browser.spaces")).rejects.toMatchObject({ code: "forbidden" });
    // P13 A6: chat archives a conversation; deleting one for good needs approve.
    const t = await client.request<{ id: string }>("threads.create", {});
    await expect(client.request("threads.delete", { threadId: t.id })).rejects.toMatchObject({
      code: "forbidden",
    });
    await client.request("threads.archive", { threadId: t.id });
    expect(
      (await client.request<Array<{ id: string }>>("threads.list", { limit: 10 })).map((x) => x.id),
    ).not.toContain(t.id);
    expect(
      (await client.request<Array<{ id: string }>>("threads.list", { archived: true })).map((x) => x.id),
    ).toEqual([t.id]);
    await expect(client.request("http.get", { path: "/api/session" })).rejects.toMatchObject({
      code: "unknown_op",
    });
    // A chat-only phone cannot cut another device off (only itself).
    const other = await phone(b, ["chat", "approve"]);
    await expect(client.request("devices.revoke", { deviceId: other.creds.deviceId })).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(await b.api("POST", `/api/link/devices/${other.creds.deviceId}/revoke`)).toMatchObject({
      body: { revoked: true },
    });
    const list = await b.api("GET", "/api/link");
    expect((list.body.devices as unknown[]).length).toBe(1);
    expect(await b.api("POST", `/api/link/devices/${creds.deviceId}/revoke`)).toMatchObject({
      body: { revoked: true },
    });
    await until(() => client.status === "revoked", 8000, "revoked");
    expect(((await b.api("GET", "/api/link")).body.devices as unknown[]).length).toBe(0);
  });

  it("taking chat away on the desktop stops a watch that is already streaming (P13 A4)", async () => {
    const b = await boot();
    const { client, creds, events } = await phone(b, ["chat"]);
    const t = await client.request<{ id: string }>("threads.create", {});
    await client.request("watch.thread", { threadId: t.id });
    const first = await client.request<{ runId: string }>("threads.send", { threadId: t.id, text: "哈囉" });
    await until(() => text(events, first.runId).length > 0 && !b.app.core.isBusy(t.id), 8000, "first reply");
    expect(
      (await b.api("POST", `/api/link/devices/${creds.deviceId}/scopes`, { scopes: ["approve"] })).status,
    ).toBe(200);
    const r = await b.api("POST", `/api/threads/${t.id}/messages`, { text: "再一次" });
    expect(r.status).toBe(202);
    await until(() => !b.app.core.isBusy(t.id), 8000, "second turn");
    await new Promise((x) => setTimeout(x, 200));
    expect(events.filter((e) => e.runId === r.body.runId)).toEqual([]);
    await expect(client.request("threads.list")).rejects.toMatchObject({ code: "forbidden" });
  });

  it("a streaming watch does not read the device row per event; a device write is seen at once (PERF-2026-11)", async () => {
    const b = await boot();
    const { client, creds, events } = await phone(b, ["chat"]);
    const t = await client.request<{ id: string }>("threads.create", {});
    await client.request("watch.thread", { threadId: t.id });
    const get = vi.spyOn(b.app.core.store.devices, "get");
    const r = await client.request<{ runId: string }>("threads.send", { threadId: t.id, text: "哈囉" });
    await until(() => events.some((e) => e.runId === r.runId && e.type === "run.finished"), 8000, "reply");
    const sent = events.filter((e) => e.runId === r.runId).length;
    expect(sent).toBeGreaterThan(8);
    expect(get.mock.calls.filter((c) => c[0] === creds.deviceId).length).toBeLessThanOrEqual(1);
    get.mockRestore();
    // The cache follows DeviceRepo.revision: a revoke written on the desktop applies to the next request.
    b.app.core.store.devices.revoke(creds.deviceId);
    await expect(client.request("threads.list")).rejects.toMatchObject({ code: "revoked" });
  });

  it("a scope change on the desktop reaches the connected phone at once (BUG-14)", async () => {
    const b = await boot();
    const { client, creds } = await phone(b, ["chat", "approve"]);
    const pushed: unknown[] = [];
    const saved: string[][] = [];
    client.onEvent((ch, e) => {
      if (ch === "link" && (e as { type?: string }).type === "scopes") pushed.push(e);
    });
    client.onCredentials((c) => saved.push(c.scopes));
    expect(
      (await b.api("POST", `/api/link/devices/${creds.deviceId}/scopes`, { scopes: ["chat"] })).status,
    ).toBe(200);
    await until(() => pushed.length > 0, 8000, "scopes event");
    expect(pushed).toEqual([{ type: "scopes", scopes: ["chat"] }]);
    // The client keeps the new list (persisted by the phone through onCredentials) and in `ready`.
    expect(client.credentials.scopes).toEqual(["chat"]);
    expect(client.ready?.scopes).toEqual(["chat"]);
    expect(saved.at(-1)).toEqual(["chat"]);
    // And the core enforces it for the very next request, as before.
    const t = await client.request<{ id: string }>("threads.create", {});
    await expect(client.request("threads.delete", { threadId: t.id })).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("the phone lists and exports memory with chat; forgetting, editing and skill decisions need approve", async () => {
    const b = await boot();
    const { client } = await phone(b, ["chat"]);
    const t = await client.request<{ id: string }>("threads.create", {});
    await client.request("threads.send", { threadId: t.id, text: "記住我喜歡靠窗的座位" });
    await until(() => !b.app.core.isBusy(t.id), 8000, "turn");
    const list = await client.request<{ items: Array<{ id: string; body: string; origin: string }> }>(
      "memory.list",
      {},
    );
    expect(list.items.map((i) => [i.body, i.origin])).toEqual([["喜歡靠窗的座位", "user"]]);
    const exp = await client.request<{ format: string }>("memory.export", {});
    expect(exp.format).toBe("alca.memory.export.v1");
    const s = b.app.core.store.skills.propose({
      botId: b.app.core.defaultBotId,
      name: "示範",
      description: "",
      triggers: [],
      steps: [{ text: "一步" }],
      actionClasses: ["read"],
    });
    await expect(client.request("skills.approve", { skillId: s.id })).rejects.toMatchObject({
      code: "forbidden",
    });
    // Review 2026-11-04b L7: rewriting or forgetting a memory needs approve, like threads.delete.
    await expect(client.request("memory.forget", { memoryId: list.items[0]?.id })).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      client.request("memory.update", { memoryId: list.items[0]?.id, body: "改掉" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(client.request("memory.get", { memoryId: "mem_nope" })).rejects.toMatchObject({
      code: "not_found",
    });
    const approver = await phone(b, ["chat", "approve"]);
    expect(await approver.client.request("memory.forget", { memoryId: list.items[0]?.id })).toEqual({
      forgotten: 1,
    });
    expect((await client.request<{ items: unknown[] }>("memory.list", {})).items).toEqual([]);
    const ok = await approver.client.request<{ skill: { status: string } }>("skills.approve", {
      skillId: s.id,
    });
    expect(ok.skill.status).toBe("active");
  });

  it("the phone's 記憶與技能 flows: learning events, thread proposals, edit / confirm, reject a version", async () => {
    const b = await boot();
    const { client } = await phone(b, ["chat", "approve"]);
    const learning: Array<{ type: string }> = [];
    client.onEvent((ch, e) => {
      if (ch === "learning") learning.push(e as { type: string });
    });
    const t = await client.request<{ id: string }>("threads.create", {});
    await client.request("watch.thread", { threadId: t.id });
    await client.request("threads.send", { threadId: t.id, text: "記住我喜歡靠窗的座位" });
    await until(() => learning.some((e) => e.type === "memory.changed"), 8000, "memory.changed over Link");
    const [m] = (await client.request<{ items: Array<{ id: string; versions: number }> }>("memory.list", {}))
      .items;
    const edited = await client.request<{
      memory: { id: string; body: string; edited: boolean; versions: number };
    }>("memory.update", { memoryId: m?.id, body: "喜歡靠窗、靠走道都可以" });
    expect(edited.memory).toMatchObject({ body: "喜歡靠窗、靠走道都可以", versions: 2 });
    expect(edited.memory.id).not.toBe(m?.id);
    // A proposal learned in this thread, with a payment step: the phone reads it from threads.get and
    // from skills.list (status proposed), and the payment step is in alwaysConfirm.
    const s = b.app.core.store.skills.propose({
      botId: b.app.core.defaultBotId,
      name: "結帳",
      description: "",
      triggers: ["結帳"],
      steps: [
        { text: "打開購物車", actionClass: "network" },
        { text: "按下付款", actionClass: "payment" },
      ],
      actionClasses: ["network", "payment"],
      sourceThreadId: t.id,
    });
    const got = await client.request<{
      skillProposals: Array<{ id: string; pending: { alwaysConfirm: string[] } }>;
    }>("threads.get", { threadId: t.id });
    expect(got.skillProposals.map((p) => p.id)).toEqual([s.id]);
    expect(got.skillProposals[0]?.pending.alwaysConfirm).toEqual(["payment"]);
    const proposed = await client.request<{ items: Array<{ id: string; source: { threadId: string } }> }>(
      "skills.list",
      { status: "proposed" },
    );
    expect(proposed.items.find((x) => x.id === s.id)?.source.threadId).toBe(t.id);
    const rejected = await client.request<{ skill: { status: string; pending: unknown } }>("skills.reject", {
      skillId: s.id,
      version: 1,
    });
    expect(rejected.skill).toMatchObject({ status: "rejected", pending: null });
    expect(
      (await client.request<{ skillProposals: unknown[] }>("threads.get", { threadId: t.id })).skillProposals,
    ).toEqual([]);
  });

  it("a hands daemon runs a gated command only after the phone approves it", async () => {
    const b = await boot();
    const { client, events } = await phone(b);
    const handsDir = mkdtempSync(join(tmpdir(), "alca-hands-"));
    cleanups.push(() => rmSync(handsDir, { recursive: true, force: true }));
    const p = await b.api("POST", "/api/link/pairings");
    await pairHands({
      statePath: join(handsDir, "device.json"),
      relayUrl: b.relay.url,
      code: String(p.body.code),
      name: "工作站",
      fingerprint: String(p.body.coreFingerprint),
    });
    const state = JSON.parse(readFileSync(join(handsDir, "device.json"), "utf8")) as {
      credentials: { scopes: string[] };
    };
    expect(state.credentials.scopes).toEqual(["hands"]);
    const daemon = await runHands({
      statePath: join(handsDir, "device.json"),
      workdir: join(handsDir, "work"),
    });
    cleanups.push(() => daemon.stop());
    await until(() => b.app.link?.hands.list()[0]?.online === true, 8000, "hands online");
    await until(() => b.app.link?.hands.list()[0]?.workdir !== undefined, 8000, "hands info");

    const t = await client.request<{ id: string }>("threads.create", {});
    await client.request("watch.thread", { threadId: t.id });
    const r = await client.request<{ runId: string }>("threads.send", {
      threadId: t.id,
      text: "用手腳跑一下",
    });
    await until(
      () => events.some((e) => e.runId === r.runId && e.type === "approval.requested"),
      8000,
      "card",
    );
    const card = events.find((e) => e.runId === r.runId && e.type === "approval.requested");
    expect(card?.data).toMatchObject({ actionClass: "execute" });
    expect(String((card?.data as { summary: string } | undefined)?.summary)).toContain(
      "在「工作站」執行：echo 來自手腳",
    );
    await client.request("approvals.answer", {
      approvalId: (card?.data as { approvalId: string } | undefined)?.approvalId,
      decision: "approved",
    });
    await until(() => events.some((e) => e.runId === r.runId && e.type === "run.finished"), 10_000, "finish");
    const done = events.find((e) => e.runId === r.runId && e.type === "tool.completed");
    expect(done?.data).toMatchObject({ ok: true });
    expect(text(events, r.runId)).toContain("來自手腳");
    expect(text(events, r.runId)).toContain(daemon.executor.root);
    // The audit log has the call, written before it ran.
    const audit = b.app.core.store.db
      .prepare("SELECT action FROM audit_log WHERE action LIKE 'hands_run%'")
      .all();
    expect(audit.length).toBeGreaterThan(0);
  });

  it("a denied hands command never reaches the device", async () => {
    const b = await boot();
    const { client, events } = await phone(b);
    const handsDir = mkdtempSync(join(tmpdir(), "alca-hands-"));
    cleanups.push(() => rmSync(handsDir, { recursive: true, force: true }));
    const p = await b.api("POST", "/api/link/pairings");
    await pairHands({
      statePath: join(handsDir, "d.json"),
      relayUrl: b.relay.url,
      code: String(p.body.code),
      name: "h",
    });
    const daemon = await runHands({ statePath: join(handsDir, "d.json"), workdir: join(handsDir, "w") });
    cleanups.push(() => daemon.stop());
    let calls = 0;
    const orig = daemon.executor.handle;
    daemon.executor.handle = async (op, a) => {
      if (op === "shell") calls++;
      return orig(op, a);
    };
    await until(() => b.app.link?.hands.list()[0]?.online === true);
    const t = await client.request<{ id: string }>("threads.create", {});
    await client.request("watch.thread", { threadId: t.id });
    const r = await client.request<{ runId: string }>("threads.send", { threadId: t.id, text: "手腳" });
    await until(() => events.some((e) => e.runId === r.runId && e.type === "approval.requested"));
    const card = events.find((e) => e.runId === r.runId && e.type === "approval.requested");
    await client.request("approvals.answer", {
      approvalId: (card?.data as { approvalId: string } | undefined)?.approvalId,
      decision: "denied",
    });
    await until(() => events.some((e) => e.runId === r.runId && e.type === "run.finished"));
    expect(calls).toBe(0);
  });
});
