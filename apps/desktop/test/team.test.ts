// Desktop × team end to end (P7) with the offline demo engines: add a second
// bot, @mention routes a message to it, a delegation waits for the team's
// approval rule (and runs straight through under 自動), a delete from the
// teammate's worker still asks the person in the person's own conversation,
// archive, and a bot on an OpenAI-compatible model service (local mock).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type MockLlm, startMockLlm } from "@alca/engines/testing";
import type { AgentsEvent, AlcaEvent } from "@alca/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DesktopApp, startDesktop } from "../src/index.ts";

// biome-ignore lint/suspicious/noExplicitAny: test JSON
type Json = any;

describe("desktop × team (demo engines)", () => {
  let app: DesktopApp;
  let dir: string;
  let llm: MockLlm;
  const cards: Array<Extract<AlcaEvent, { type: "approval.requested" }>> = [];
  const agentEvents: AgentsEvent[] = [];
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
    (
      (await api("GET", `/api/threads/${t}`)).body.messages as Array<{
        role: string;
        content: string;
        botId: string;
      }>
    ).filter((m) => m.role === "assistant");
  const idle = (t: string) =>
    until(async () => !app.core.isBusy(t) && !(await api("GET", `/api/threads/${t}`)).body.thread.busy);

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "alca-desk-team-"));
    llm = await startMockLlm(() => ({ text: "我是在 OpenAI 相容服務上的翻譯。" }));
    app = await startDesktop({ engine: "demo", dataDir: dir, port: 0, browser: "off" });
    app.core.bus.subscribe("*", (e) => {
      if (e.type === "approval.requested") cards.push(e);
    });
    app.agents?.subscribe((e) => agentEvents.push(e));
  }, 30_000);
  afterAll(async () => {
    await app?.close();
    await llm?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  let res: Json;
  it("first run is a team of one; adding a bot needs only a name", async () => {
    const t = (await api("GET", "/api/team")).body;
    expect(t.bots).toHaveLength(1);
    expect(t.bots[0]).toMatchObject({
      isDefault: true,
      avatar: "A",
      memoryMode: "team",
      browserProfile: "shared",
    });
    expect(t.rules).toEqual({ peerApproval: "ask_delegate", maxDepth: 2, maxOpen: 4 });
    expect((await api("GET", "/api/session")).body.team).toBe(true);
    const c = await api("POST", "/api/bots", { name: "研究員", role: "查資料、比價" });
    expect(c.status).toBe(201);
    res = c.body;
    expect(res).toMatchObject({ name: "研究員", avatar: "研", approvalLevel: null });
    expect(res.color).not.toBe(t.bots[0].color);
    expect((await api("POST", "/api/bots", { name: "研究員" })).status).toBe(400);
    expect((await api("POST", "/api/bots", {})).status).toBe(400);
    expect(agentEvents.some((e) => e.type === "team.changed" && e.data.op === "created")).toBe(true);
  });

  it("@mention routes the message to that bot, in the same thread", async () => {
    const t = (await api("POST", "/api/threads", {})).body.id as string;
    const r = await api("POST", `/api/threads/${t}/messages`, { text: "@研究員 幫我查明天的天氣" });
    expect(r.body.botId).toBe(res.id);
    await until(async () => (await said(t)).some((m) => m.content.includes("完成了")));
    const msgs = await said(t);
    expect(msgs.every((m) => m.botId === res.id)).toBe(true);
    // The thread still belongs to the first bot; a plain message goes to it.
    expect((await api("GET", `/api/threads/${t}`)).body.thread.botId).toBe(app.core.defaultBotId);
    await idle(t);
    await api("POST", `/api/threads/${t}/messages`, { text: "你好" });
    await until(async () => (await said(t)).at(-1)?.botId === app.core.defaultBotId);
  });

  it("a delegation waits for the person under the default rule, then the teammate's answer comes back", async () => {
    const t = (await api("POST", "/api/threads", {})).body.id as string;
    cards.length = 0;
    await api("POST", `/api/threads/${t}/messages`, { text: "請研究員查一下高鐵時刻" });
    const card = await until(() => cards.find((c) => c.threadId === t));
    expect(card.data.summary).toContain("交辦給隊友「研究員」");
    expect((await api("GET", `/api/peers?thread=${t}`)).body).toHaveLength(0);
    await api("POST", `/api/approvals/${card.data.approvalId}`, { decision: "approved" });
    const peers = await until(async () => {
      const p = (await api("GET", `/api/peers?thread=${t}`)).body as Json[];
      return p[0]?.status === "done" ? p : undefined;
    });
    expect(peers[0]).toMatchObject({ kind: "delegate", fromName: "Alca", toName: "研究員", depth: 1 });
    const detail = (await api("GET", `/api/peers/${peers[0].id}`)).body;
    expect(detail.events.map((e: Json) => e.kind)).toEqual(["requested", "approved", "started", "answered"]);
    expect(detail.messages.some((m: Json) => m.botId === res.id && m.role === "assistant")).toBe(true);
    await until(async () => (await said(t)).some((m) => m.content.includes("「研究員」回覆了")));
    // The peer conversation is not in the person's thread list.
    const list = (await api("GET", "/api/threads")).body as Json[];
    expect(list.map((x) => x.id)).not.toContain(detail.peerThreadId);
  });

  it("under 自動 a delegation goes straight through, and a delete from the teammate's worker still asks the person here", async () => {
    expect((await api("PATCH", "/api/team/rules", { peerApproval: "auto" })).body.peerApproval).toBe("auto");
    const t = (await api("POST", "/api/threads", {})).body.id as string;
    cards.length = 0;
    await api("POST", `/api/threads/${t}/messages`, { text: "請研究員刪除購物清單" });
    const card = await until(() => cards.find((c) => c.data.actionClass === "delete"));
    expect(card.data.botId).toBe(res.id);
    // The card is on the teammate's run, and the person's conversation shows it (replay included).
    const view = (await api("GET", `/api/threads/${t}`)).body;
    expect(view.workerCards.some((e: Json) => e.data.approvalId === card.data.approvalId)).toBe(true);
    expect(view.peers[0].status).toBe("running");
    await api("POST", `/api/approvals/${card.data.approvalId}`, { decision: "approved" });
    await until(async () => (await api("GET", `/api/peers?thread=${t}`)).body[0]?.status === "done");
    await until(async () => (await said(t)).some((m) => m.content.includes("「研究員」回覆了")));
    const roster = (await api("GET", "/api/team")).body.bots as Json[];
    expect(roster.find((b) => b.id === res.id).activity.peersOpen).toBe(0);
  });

  it("archive keeps the history; the first bot cannot be archived; a lead takes new threads", async () => {
    const w = (await api("POST", "/api/bots", { name: "寫手", role: "寫稿" })).body;
    expect((await api("POST", "/api/team/lead", { botId: w.id })).body.leadId).toBe(w.id);
    const t = (await api("POST", "/api/threads", {})).body;
    expect(t.botId).toBe(w.id);
    expect((await api("POST", `/api/bots/${app.core.defaultBotId}/archive`)).status).toBe(400);
    expect((await api("POST", `/api/bots/${w.id}/archive`)).status).toBe(200);
    const team = (await api("GET", "/api/team")).body;
    expect(team.bots.map((b: Json) => b.name)).toEqual(["Alca", "研究員"]);
    expect(team.archived.map((b: Json) => b.name)).toEqual(["寫手"]);
    expect(team.leadId).toBeNull();
    expect((await api("POST", `/api/bots/${w.id}/restore`)).body.name).toBe("寫手");
  });

  it("a bot on an OpenAI-compatible model service answers through it; the key stays in the vault", async () => {
    expect(
      (
        await api("POST", "/api/providers", {
          kind: "openai",
          label: "遠端",
          baseUrl: "http://example.com/v1",
          models: ["x"],
        })
      ).status,
    ).toBe(400);
    const prov = (
      await api("POST", "/api/providers", {
        kind: "openai",
        label: "本機 LM",
        baseUrl: llm.openaiBase,
        models: ["local-model"],
        key: "sk-local-secret-123456",
      })
    ).body as Json;
    expect(prov).toMatchObject({ label: "本機 LM", custom: true });
    expect((await api("GET", "/api/team")).body.engines).toContainEqual(
      expect.objectContaining({ id: prov.id, kind: "openai", model: "local-model" }),
    );
    expect(JSON.stringify((await api("GET", "/api/team")).body)).not.toContain("sk-local-secret");
    const tr = (await api("POST", "/api/bots", { name: "翻譯", engineId: prov.id })).body;
    expect(tr.engineId).toBe(prov.id);
    const t = (await api("POST", "/api/threads", { botId: tr.id })).body.id as string;
    await api("POST", `/api/threads/${t}/messages`, { text: "你是誰？" });
    await until(async () => (await said(t)).some((m) => m.content.includes("OpenAI 相容服務")));
    const sent = llm.requests.at(-1)!;
    expect(sent.headers.authorization).toBe("Bearer sk-local-secret-123456");
    expect((sent.body.tools as Json[]).map((x) => x.function.name)).toContain("peer_delegate");
    const last = app.core.store.db
      .prepare(
        "SELECT engine, bot_id FROM runs WHERE thread_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1",
      )
      .get(t) as { engine: string; bot_id: string };
    expect(last).toEqual({ engine: prov.id, bot_id: tr.id });
  });
});
