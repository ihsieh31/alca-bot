// Desktop × connected apps + routines end to end (P6), offline: the demo
// engines and a local mock of Composio's API (no real key, no network).
// Key entry → connect an account through its Connect Link → list / find /
// use a read tool → a send stops at the approval card and only runs after
// 允許 → daily quota → a routine checks before the model (AI only when new,
// quiet otherwise) → a read failure keeps the cursor → an app trigger
// through the relay mailbox → a trigger-based routine.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AlcaEvent } from "@alca/protocol";
import { type Rendezvous, startRendezvous } from "@alca/rendezvous";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEMO_MAIL_REQUEST, DEMO_REPLY_REQUEST } from "../src/demo-connectors.ts";
import { type DesktopApp, startDesktop } from "../src/index.ts";

// biome-ignore lint/suspicious/noExplicitAny: test JSON
type Json = any;

describe("desktop × connectors + routines (mock Composio)", () => {
  let app: DesktopApp;
  let relay: Rendezvous;
  let dir: string;
  const events: AlcaEvent[] = [];
  const api = async (
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: Json }> => {
    const res = await fetch(`${app.server.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${app.token}`,
        ...app.uiHeaders,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const until = async <T>(
    fn: () => T | undefined | false | Promise<T | undefined | false>,
    ms = 15_000,
  ): Promise<T> => {
    const start = Date.now();
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() - start > ms) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  const said = async (t: string) =>
    ((await api("GET", `/api/threads/${t}`)).body.messages as Array<{ role: string; content: string }>)
      .filter((m) => m.role === "assistant")
      .map((m) => m.content);
  const settled = async (t: string) => {
    await until(() => app.agents?.workerStates(t).every((w) => !["queued", "running"].includes(w.status)));
    await until(() => !app.core.isBusy(t) && app.core.store.workers.pendingInbox().length === 0);
  };
  const sends = () => app.composioMock?.executed.filter((e) => e.slug === "GMAIL_SEND_EMAIL") ?? [];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "alca-desk-conn-"));
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        engineering: { connectors: { dailyQuota: { send: 1 } }, routines: { startDelaySec: 0 } },
      }),
    );
    relay = await startRendezvous({ port: 0 });
    app = await startDesktop({
      engine: "demo",
      dataDir: dir,
      port: 0,
      browser: "off",
      composioMock: true,
      vaultKeySource: "file",
      rendezvous: relay.url,
    });
    app.core.bus.subscribe("*", (e) => events.push(e));
  }, 30_000);
  afterAll(async () => {
    await app?.close();
    await relay?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("the key is checked, kept in the vault and never returned", async () => {
    expect((await api("GET", "/api/connectors")).body.keySet).toBe(false);
    expect((await api("PUT", "/api/connectors/key", { key: "wrong-key-123456" })).status).toBe(400);
    const ok = await api("PUT", "/api/connectors/key", { key: app.composioMock?.key });
    expect(ok.status).toBe(200);
    expect(ok.body.keySet).toBe(true);
    const all = JSON.stringify((await api("GET", "/api/connectors")).body);
    expect(all).not.toContain(app.composioMock?.key as string);
  });

  it("connect two Gmail accounts through Connect Links; grants per bot", async () => {
    for (const label of ["工作", "個人"]) {
      const r = await api("POST", "/api/connectors/accounts", { toolkit: "gmail", label });
      expect(r.status).toBe(201);
      expect(r.body.account.status).toBe("pending");
      await fetch(r.body.redirectUrl); // the person finishes the provider's page
    }
    const st = await until(async () => {
      const s = (await api("POST", "/api/connectors/refresh")).body;
      return s.groups[0]?.accounts.every((a: Json) => a.status === "active") && s;
    });
    expect(st.groups[0].toolkit).toBe("gmail");
    expect(st.groups[0].accounts.map((a: Json) => a.label).sort()).toEqual(["個人", "工作"]);
    expect(st.groups[0].accounts[0].bots[0].access).toBe("act");
  });

  it("use_tool read: the worker reads the right account; results are fenced untrusted", async () => {
    const t = (await api("POST", "/api/threads", {})).body.id as string;
    await api("POST", `/api/threads/${t}/messages`, { text: DEMO_MAIL_REQUEST });
    await until(async () => (await said(t)).some((m) => m.includes("未讀")));
    expect((await said(t)).join("\n")).toContain("下週三的報價");
    const read = app.composioMock?.executed.find((e) => e.slug === "GMAIL_FETCH_EMAILS");
    const work = app.core.store.connectors.accounts().find((a) => a.label === "工作");
    expect(read?.accountId).toBe(work?.remoteId);
    const w = app.core.store.workers.byThread(t)[0];
    // A general worker reaches the app tool through the lazy catalog: tool_describe, then tool_call.
    const evs = app.agents?.workerEvents(w?.id as string) ?? [];
    const req = evs.find((e) => e.type === "tool.requested" && e.data.tool === "tool_call");
    const callId = req?.type === "tool.requested" ? req.data.callId : "";
    const done = evs.find((e) => e.type === "tool.completed" && e.data.callId === callId);
    expect(JSON.stringify(done?.data)).toContain(
      '<alca:app toolkit=\\"gmail\\" tool=\\"GMAIL_FETCH_EMAILS\\" account=\\"工作\\" trust=\\"untrusted\\">',
    );
  });

  it("a send stops at the approval card and only runs after 允許; the quota stops the next one", async () => {
    const t = (await api("POST", "/api/threads", {})).body.id as string;
    await api("POST", `/api/threads/${t}/messages`, { text: DEMO_REPLY_REQUEST });
    const card = await until(() =>
      events.find(
        (e) =>
          e.type === "approval.requested" &&
          e.data.actionClass === "send" &&
          !JSON.stringify(e).includes("used"),
      ),
    );
    if (card.type !== "approval.requested") throw new Error("not a card");
    expect(card.data.summary).toContain("用「工作」Gmail寄送");
    await new Promise((r) => setTimeout(r, 300));
    expect(sends()).toHaveLength(0);
    await api("POST", `/api/approvals/${card.data.approvalId}`, { decision: "approved" });
    await until(() => sends().length === 1);
    expect(sends()[0]?.arguments.recipient_email).toBe("wang.xiaoming@example.com");
    await settled(t);
    // Second send today: the card still comes, but the quota (1) refuses to run it.
    await api("POST", `/api/threads/${t}/messages`, { text: DEMO_REPLY_REQUEST });
    const second = await until(() =>
      events.find(
        (e) =>
          e.type === "approval.requested" &&
          e.data.actionClass === "send" &&
          e.data.approvalId !== card.data.approvalId,
      ),
    );
    if (second.type !== "approval.requested") throw new Error("not a card");
    await api("POST", `/api/approvals/${second.data.approvalId}`, { decision: "approved" });
    await until(async () => (await said(t)).some((m) => m.includes("沒有寄出") || m.includes("額度")));
    expect(sends()).toHaveLength(1);
  });

  it("a denied send never reaches Composio", async () => {
    const before = sends().length;
    const t = (await api("POST", "/api/threads", {})).body.id as string;
    const seen = events.length;
    await api("POST", `/api/threads/${t}/messages`, { text: DEMO_REPLY_REQUEST });
    const card = await until(() => events.slice(seen).find((e) => e.type === "approval.requested"));
    if (card.type !== "approval.requested") throw new Error("not a card");
    await api("POST", `/api/approvals/${card.data.approvalId}`, { decision: "denied" });
    await settled(t);
    expect(sends()).toHaveLength(before);
  });

  it("routine: checks before the model — new mail → one AI run with a draft ahead; again → quiet; read failure keeps the cursor", async () => {
    const r = await api("POST", "/api/routines", {
      name: "工作信箱",
      kind: "cron",
      cron: "0 9 * * 1-5",
      tz: "Asia/Taipei",
      check: { kind: "app", app: "gmail", account: "工作" },
      instructions: "有需要我回的信就告訴我",
      speculative: true,
    });
    expect(r.status).toBe(201);
    expect(r.body.schedule).toBe("平日 09:00（Asia/Taipei）");
    const id = r.body.id as string;
    const t = r.body.threadId as string;
    const first = await api("POST", `/api/routines/${id}/run`);
    expect(first.body.runs[0].outcome).toBe("new");
    await until(
      async () => (await api("GET", "/api/routines")).body.routines[0].runs[0].outcome === "ai_done",
    );
    await settled(t);
    const list = (await api("GET", "/api/routines")).body;
    expect(list.drafts).toHaveLength(1);
    expect(list.drafts[0].title).toContain("回覆");
    expect((await said(t)).join("\n")).toMatch(/有新的事.*草稿/);
    expect(sends().length).toBeLessThanOrEqual(1); // a draft is not a send
    const workers = app.core.store.workers.byThread(t).length;
    const again = await api("POST", `/api/routines/${id}/run`);
    expect(again.body.runs[0].outcome).toBe("quiet");
    expect(app.core.store.workers.byThread(t)).toHaveLength(workers);
    const cursor = app.core.store.routines.get(id)?.cursor;
    if (app.composioMock) app.composioMock.failReads = "Gmail 暫時無法使用（503）";
    const broken = await api("POST", `/api/routines/${id}/run`);
    expect(broken.body.runs[0].outcome).toBe("read_failed");
    expect(broken.body.state).toBe("error");
    expect(broken.body.lastError).toContain("503");
    expect(app.core.store.routines.get(id)?.cursor).toEqual(cursor);
    if (app.composioMock) app.composioMock.failReads = null;
  });

  it("app trigger → relay mailbox → two-stage filter → trigger routine → AI run only for a new item", async () => {
    const work = app.core.store.connectors.accounts().find((a) => a.label === "工作");
    const r = await api("POST", `/api/connectors/accounts/${work?.id}/triggers`, {
      slug: "GMAIL_NEW_GMAIL_MESSAGE",
      mode: "explicit",
      routine: { name: "點名找我的信" },
    });
    expect(r.status).toBe(201);
    const mock = app.composioMock;
    const ti = mock?.triggers.at(-1);
    expect(ti?.egressUrl).toContain(relay.url);
    await mock?.emit(ti?.id as string, { subject: "電子報", sender: "news@x.example", preview: "本週優惠" });
    await mock?.emit(ti?.id as string, {
      subject: "@alca 合約幫我看",
      sender: "boss@example.com",
      preview: "@alca 請在今天看完",
      thread_id: "t77",
    });
    const pulled = await app.connectors.setup.puller()?.pull();
    expect(pulled).toMatchObject({ received: 2, fired: 2, rejected: 0 });
    const routine = app.core.store.routines.list().find((x) => x.kind === "trigger");
    expect(app.core.store.routines.itemsAfter(routine?.id as string, 0)).toHaveLength(1);
    await until(() =>
      app.core.store.routines.runs(routine?.id as string).some((x) => x.outcome === "ai_done"),
    );
  });
});
