// Desktop × memory + learning end to end (P5) with the offline demo engines:
// the person states a preference → stored with provenance → a new thread
// uses it → "忘記" removes it and it is not re-extracted; a two-step task is
// proposed as a skill → approved → reused (and handed to the worker) in a
// later task; secrets are never stored; the management API edits, confirms,
// exports and forgets.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChromium } from "@alca/browser";
import type { LearningEvent } from "@alca/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DesktopApp, startDesktop } from "../src/index.ts";

// biome-ignore lint/suspicious/noExplicitAny: test JSON
type Json = any;

describe("desktop × memory + skills (demo engines)", () => {
  let app: DesktopApp;
  let dir: string;
  const learned: LearningEvent[] = [];
  const cards: string[] = [];
  /** The demo runs under 每步確認: the weekly report's write asks first; say yes like the person would. */
  const approveNext = async () => {
    const id = await until(() => cards.shift());
    expect((await api("POST", `/api/approvals/${id}`, { decision: "approved" })).body).toEqual({
      resolved: true,
    });
  };
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
  const thread = async () => (await api("POST", "/api/threads", {})).body.id as string;
  const send = async (t: string, text: string) => {
    const before = await said(t);
    expect((await api("POST", `/api/threads/${t}/messages`, { text })).status).toBe(202);
    await until(async () => !app.core.isBusy(t) && (await said(t)).length > before.length);
    await app.learning.settle();
    return (await said(t)).at(-1) ?? "";
  };
  const said = async (t: string) =>
    ((await api("GET", `/api/threads/${t}`)).body.messages as Array<{ role: string; content: string }>)
      .filter((m) => m.role === "assistant")
      .map((m) => m.content);

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "alca-desk-memory-"));
    app = await startDesktop({ engine: "demo", dataDir: dir, port: 0, browser: "off" });
    app.learning.subscribe((e) => learned.push(e));
    app.core.bus.subscribe("*", (e) => {
      if (e.type === "approval.requested") cards.push(e.data.approvalId);
    });
  }, 30_000);
  afterAll(async () => {
    await app?.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it("preference → stored with provenance → a new thread uses it → 忘記 removes it for good", async () => {
    const a = await thread();
    await send(a, "我喜歡喝燕麥奶拿鐵");
    const list = (await api("GET", "/api/memory")).body;
    expect(list.items).toHaveLength(1);
    const m = list.items[0];
    expect(m).toMatchObject({
      body: "喜歡喝燕麥奶拿鐵",
      kind: "preference",
      origin: "inferred",
      scope: "shared",
    });
    expect(m.source).toMatchObject({ kind: "chat", threadId: a });
    expect(m.source.messageId).toMatch(/^msg_/);
    expect(learned.some((e) => e.type === "memory.changed" && e.data.op === "added")).toBe(true);
    // The learning channel carries ids, never the text.
    expect(JSON.stringify(learned)).not.toContain("燕麥奶");

    const b = await thread();
    expect(await send(b, "幫我點一杯咖啡")).toContain("喜歡喝燕麥奶拿鐵");

    expect(await send(b, "忘記我喜歡燕麥奶拿鐵")).toContain("已經忘記");
    expect((await api("GET", "/api/memory")).body.items).toHaveLength(0);
    expect((await api("GET", "/api/memory")).body.forgotten).toBeGreaterThan(0);
    await send(a, "我喜歡喝燕麥奶拿鐵");
    expect((await api("GET", "/api/memory")).body.items).toHaveLength(0);
    expect(await send(b, "幫我點一杯咖啡")).toContain("你想喝什麼");
  }, 40_000);

  it("記住 is confirmed; secrets are refused and never written", async () => {
    const t = await thread();
    expect(await send(t, "記住我喜歡靠窗的座位")).toContain("我記住了：喜歡靠窗的座位");
    expect(await send(t, "記住我的密碼是 hunter2")).toContain("不會記下來");
    await send(t, "我的 token 是 ghp_0123456789abcdefghijABCDEFGHIJ");
    const items = (await api("GET", "/api/memory")).body.items as Array<{ body: string; origin: string }>;
    expect(items.map((i) => [i.body, i.origin])).toEqual([["喜歡靠窗的座位", "user"]]);
    const exported = JSON.stringify((await api("GET", "/api/memory/export")).body);
    expect(exported).not.toMatch(/hunter2|ghp_/);
    expect((await api("POST", "/api/memory", { body: "門禁密碼是 4821" })).status).toBe(400);
  }, 30_000);

  it("the management API edits (a new version), confirms, rescopes, exports and forgets", async () => {
    const t = await thread();
    await send(t, "我住在高雄");
    const item = (
      (await api("GET", "/api/memory?origin=inferred")).body.items as Array<{ id: string; body: string }>
    ).find((i) => i.body === "住在高雄");
    expect(item).toBeDefined();
    const edited = (await api("PATCH", `/api/memory/${item?.id}`, { body: "住在高雄市鼓山區" })).body.memory;
    expect(edited).toMatchObject({ body: "住在高雄市鼓山區", origin: "user", versions: 2 });
    const detail = (await api("GET", `/api/memory/${edited.id}`)).body;
    expect(detail.history.map((h: { body: string }) => h.body)).toEqual(["住在高雄", "住在高雄市鼓山區"]);
    expect((await api("PATCH", `/api/memory/${item?.id}`, { body: "x" })).status).toBe(409);
    expect((await api("PATCH", `/api/memory/${edited.id}`, { scope: "bot" })).body.memory.scope).toBe("bot");
    const search = (await api("GET", `/api/memory?q=${encodeURIComponent("鼓山")}`)).body.items;
    expect(search.map((i: { id: string }) => i.id)).toEqual([edited.id]);
    const exp = await fetch(`${app.server.url}/api/memory/export`, {
      headers: { authorization: `Bearer ${app.token}`, ...app.uiHeaders },
    });
    expect(exp.headers.get("content-disposition")).toMatch(/attachment; filename="alca-memory-/);
    const body = (await exp.json()) as {
      format: string;
      memories: Array<{ id: string; history: unknown[] }>;
    };
    expect(body.format).toBe("alca.memory.export.v1");
    expect(body.memories.find((x) => x.id === edited.id)?.history).toHaveLength(1);
    expect((await api("DELETE", `/api/memory/${edited.id}`)).body).toEqual({ forgotten: 2 });
    expect((await api("GET", `/api/memory/${edited.id}`)).status).toBe(404);
    expect((await api("POST", "/api/memory", { body: "下週三要繳房租", kind: "fact" })).status).toBe(201);
    // mac test 2026-11-04: the 新增記憶 box (no kind) filed 「我喜歡答案先給結論」 as a fact.
    const pref = (await api("POST", "/api/memory", { body: "我喜歡答案先給結論" })).body.memory;
    expect(pref).toMatchObject({ kind: "preference", body: "我喜歡答案先給結論", origin: "user" });
    const plain = (await api("POST", "/api/memory", { body: "下週五交報告" })).body.memory;
    expect(plain.kind).toBe("fact");
  }, 30_000);

  it("skill: a two-step task is proposed → approved → reused in a later task", async () => {
    const t = await thread();
    await send(t, "幫我整理這週的週報");
    await approveNext();
    const proposal = await until(async () => {
      await app.learning.settle();
      return (await api("GET", `/api/threads/${t}`)).body.skillProposals?.[0];
    });
    expect(proposal).toMatchObject({ status: "proposed", version: 0, pending: { name: "整理週報" } });
    expect(proposal.pending.steps.map((s: { tool: string }) => s.tool)).toEqual(["read_note", "write_note"]);
    expect(learned.some((e) => e.type === "skill.proposed")).toBe(true);

    // The person edits the trigger list while approving.
    const approved = (
      await api("POST", `/api/skills/${proposal.id}/approve`, {
        edit: { triggers: ["整理週報", "週報"], steps: ["讀本週筆記", "寫成「週報」"] },
      })
    ).body.skill;
    expect(approved).toMatchObject({ status: "active", version: 2, current: { author: "user" } });
    expect(approved.current.steps.map((s: { text: string; tool: string }) => [s.text, s.tool])).toEqual([
      ["讀本週筆記", "read_note"],
      ["寫成「週報」", "write_note"],
    ]);
    expect((await api("GET", `/api/threads/${t}`)).body.skillProposals).toEqual([]);

    const t2 = await thread();
    await send(t2, "再幫我整理一次週報");
    expect((await said(t2)).some((x) => x.includes("核准過的做法"))).toBe(true);
    await approveNext();
    const w = await until(() => app.core.store.workers.byThread(t2).find((x) => x.status === "succeeded"));
    expect(w.grants.skillId).toBe(proposal.id);
    await until(async () => (await said(t2)).some((x) => x.includes("照核准過的技能步驟")));
    expect((await api("GET", `/api/skills/${proposal.id}`)).body.skill.uses).toBe(1);

    expect((await api("POST", `/api/skills/${proposal.id}/disable`)).body.skill.status).toBe("disabled");
    expect((await api("POST", `/api/skills/${proposal.id}/enable`)).body.skill.status).toBe("active");
    expect((await api("GET", "/api/skills")).body.items).toHaveLength(1);
    expect((await api("DELETE", `/api/skills/${proposal.id}`)).body).toEqual({ deleted: true });
    expect((await api("GET", `/api/skills/${proposal.id}`)).status).toBe(404);
  }, 40_000);
});

const bin = process.env.ALCA_TEST_CHROMIUM || findChromium();

describe.skipIf(!bin)("desktop × a saved shop skill still asks before paying (real Chromium)", () => {
  it("approve the proposal from a paid checkout; the reused skill puts up the payment card again under 自主", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alca-desk-skill-pay-"));
    writeFileSync(join(dir, "config.json"), JSON.stringify({ permissions: { level: "autonomous" } }));
    const app = await startDesktop({
      engine: "demo",
      dataDir: dir,
      port: 0,
      browser: "headless",
      chromium: bin as string,
    });
    try {
      const cards: Array<{ id: string; cls: string; worker: string }> = [];
      const trail: string[] = [];
      app.core.bus.subscribe("*", (e) => {
        if (!e.type.endsWith(".delta")) trail.push(`${e.type} ${JSON.stringify(e.data).slice(0, 160)}`);
        if (e.type === "approval.requested")
          cards.push({
            id: e.data.approvalId,
            cls: e.data.actionClass,
            worker: String(e.data.workerId ?? ""),
          });
      });
      // Generous: on a loaded CI runner other real-Chromium files run beside this one.
      const wait = async <T>(fn: () => T | undefined | false, ms = 45_000): Promise<T> => {
        const t0 = Date.now();
        for (;;) {
          const v = fn();
          if (v) return v;
          if (Date.now() - t0 > ms)
            throw new Error(`timed out; last events:\n${trail.slice(-25).join("\n")}`);
          await new Promise((r) => setTimeout(r, 25));
        }
      };
      const t = app.core.createThread();
      await app.core.send(t.id, "幫我在示範商店結帳").done;
      // The first Chromium start of a run can be slow (cold machine): up to the launch's own 90 s.
      const first = await wait(() => cards.find((c) => c.cls === "payment"), 100_000);
      app.core.answerApproval(first.id, "approved");
      await wait(() => app.core.store.workers.byThread(t.id).find((w) => w.status === "succeeded"));
      await app.learning.settle();
      const [p] = app.core.store.skills.list();
      expect(p?.pending?.actionClasses).toContain("payment");
      expect(p?.pending?.steps.map((s) => s.tool)).toEqual([
        "browser_open",
        "browser_snapshot",
        "browser_click",
      ]);
      app.learning.approveSkill(p!.id);

      const t2 = app.core.createThread();
      await app.core.send(t2.id, "幫我在示範商店結帳").done;
      const w = await wait(() => app.core.store.workers.byThread(t2.id)[0]);
      expect(w.grants.skillId).toBe(p!.id);
      const second = await wait(() => cards.find((c) => c.cls === "payment" && c.worker === w.id));
      app.core.answerApproval(second.id, "denied");
      await wait(() => app.core.store.workers.get(w.id)?.finishedAt);
      const audit = app.core.store.db
        .prepare("SELECT COUNT(*) AS n FROM approvals WHERE action_class = 'payment' AND status = 'denied'")
        .get() as { n: number };
      expect(audit.n).toBe(1);
    } finally {
      await app.close();
      // Chromium's helper processes can still be flushing the profile for a moment after close.
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }, 200_000);
});
