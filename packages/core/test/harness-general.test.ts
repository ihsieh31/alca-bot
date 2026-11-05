import type { ScriptContext, ScriptStep } from "@alca/engines";
import type { AlcaEvent } from "@alca/protocol";
import type { WorkerRecord } from "@alca/store";
import { afterEach, describe, expect, it } from "vitest";
import type { FetchedResponse } from "../src/harness/general/web-fetch.ts";
import type { HostTool } from "../src/turn.ts";
import { call, type Harness, lastLine, makeAgents, say, until } from "./agents-helpers.ts";

/**
 * Plan §5 acceptance on the formal path (`makeAgents`: router + workers +
 * store + gate, scripted API engine, fictional data only): a general worker
 * looks something up with web_fetch, writes a draft through the deferred
 * catalog, and the send stops at an always-confirm card even under 自主;
 * await_event parks the dispatch until the clock wakes it.
 */

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const PAGE = `<html><head><title>社區讀書會</title></head><body><h1>十一月讀書會</h1>
<p>時間：11 月 20 日晚上 7 點，地點：虛構市立圖書館 3 樓。</p></body></html>`;

const webFetch = {
  resolve: async () => ["93.184.216.34"],
  connect: async (): Promise<FetchedResponse> => ({
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    destroy: () => undefined,
    body: (async function* () {
      yield Buffer.from(PAGE);
    })(),
  }),
};

function mailTools(log: string[]): HostTool[] {
  const obj = (properties: Record<string, unknown>) => ({
    type: "object",
    properties,
    additionalProperties: false,
  });
  return [
    {
      spec: {
        name: "mail_draft",
        description: "寫一封信的草稿（不寄出）",
        inputSchema: obj({ to: { type: "string" }, body: { type: "string" } }),
      },
      actionClass: "write",
      run: async (a) => {
        log.push(`draft:${String(a.to)}`);
        return JSON.stringify({ draftId: "draft_1" });
      },
    },
    {
      spec: {
        name: "mail_send",
        description: "寄出一封草稿",
        inputSchema: obj({ draftId: { type: "string" } }),
      },
      actionClass: "send",
      run: async (a) => {
        log.push(`sent:${String(a.draftId)}`);
        return "sent";
      },
    },
    // A connected app brings many tools: enough that the catalog is deferred.
    ...[
      "calendar_list",
      "calendar_create",
      "contacts_find",
      "drive_list",
      "drive_read",
      "sheet_read",
      "task_add",
      "task_list",
    ].map(
      (name): HostTool => ({
        spec: { name, description: `虛構的連接工具 ${name}`, inputSchema: obj({}) },
        actionClass: name.endsWith("_add") || name.endsWith("_create") ? "write" : "read",
        run: async () => "ok",
      }),
    ),
    {
      spec: { name: "web_search", description: "搜尋網路", inputSchema: obj({ q: { type: "string" } }) },
      actionClass: "read",
      run: async () => "results",
    },
  ];
}

const routerFor =
  () =>
  ({ req, pass }: ScriptContext): ScriptStep[] => {
    if (req.userMessage.includes("<alca:worker")) return say("收到回報");
    return pass === 0
      ? call("s", "worker_start", {
          title: "讀書會通知",
          goal: lastLine(req.userMessage),
          harness: "general",
        })
      : say("派了");
  };

const reportTo = (threadId: string, n = 1) =>
  until(() => {
    const ms = h?.store.threads
      .messages(threadId)
      .filter((m) => m.role === "system" && m.content.includes("<alca:worker"));
    return ms && ms.length >= n ? ms[n - 1] : undefined;
  }, 25_000);

type Completed = Extract<AlcaEvent, { type: "tool.completed" }>;

function workerEvents(x: Harness): AlcaEvent[] {
  const out: AlcaEvent[] = [];
  const bus = x.core.bus;
  const publishTo = bus.publishTo.bind(bus);
  bus.publishTo = (key, e) => {
    if (key.startsWith("worker:")) out.push(e);
    publishTo(key, e);
  };
  return out;
}

describe("general inner layer on the formal path (plan §5)", () => {
  it("look up → draft → send: the send asks with an always-confirm card under 自主", async () => {
    const log: string[] = [];
    const seen: { tools?: string[] } = {};
    const worker = ({ req, pass }: ScriptContext): ScriptStep[] => {
      if (pass === 0) seen.tools = (req.tools ?? []).map((t) => t.name);
      switch (pass) {
        case 0:
          return call("f", "web_fetch", { url: "https://club.example.com/november" });
        case 1:
          return call("q", "tool_search", { query: "mail draft send" });
        case 2:
          return call("d", "tool_call", {
            name: "mail_draft",
            arguments: { to: "members@club.example.com", body: "11/20 19:00 讀書會" },
          });
        case 3:
          return call("x", "tool_call", { name: "mail_send", arguments: { draftId: "draft_1" } });
        case 4:
          return call("rep", "report_result", {
            status: "partial",
            summary: "草稿寫好了；寄出被拒絕，草稿留著。",
            changes: ["草稿 draft_1"],
            claims: [{ text: "讀書會在 11/20 19:00", evidenceRef: "https://club.example.com/november" }],
            proposal: "要我把草稿寄給讀書會成員嗎？",
          });
        default:
          return say("完成");
      }
    };
    h = makeAgents({
      router: routerFor(),
      worker,
      level: "autonomous",
      tools: mailTools(log),
      system: { webFetch },
    });
    const events = workerEvents(h);
    const t = h.core.createThread();
    await h.core.send(t.id, "查讀書會時間，寫信通知成員").done;
    const card = await until(
      () =>
        h?.events.find(
          (e): e is Extract<AlcaEvent, { type: "approval.requested" }> => e.type === "approval.requested",
        ),
      20_000,
    );
    expect(card.data.actionClass).toBe("send");
    expect(card.data.summary).toContain("mail_send");
    h.core.answerApproval(card.data.approvalId, "denied");
    const msg = await reportTo(t.id);

    // The direct set: web_fetch and the lazy trio; no web_search; the mail tools sit in the catalog.
    expect(seen.tools).toEqual(
      expect.arrayContaining(["web_fetch", "tool_search", "tool_describe", "tool_call"]),
    );
    expect(seen.tools).not.toContain("web_search");
    expect(seen.tools).not.toContain("mail_send");
    const fetched = events.find(
      (e): e is Completed => e.type === "tool.completed" && String(e.data.result ?? "").includes("web_fetch"),
    );
    expect(String(fetched?.data.result)).toContain('trust="untrusted"');
    expect(String(fetched?.data.result)).toContain("11 月 20 日晚上 7 點");
    const search = events.find(
      (e): e is Completed => e.type === "tool.completed" && String(e.data.result ?? "").includes('"tools"'),
    );
    expect(String(search?.data.result)).not.toContain("web_search");

    // Only the draft ran; the send was denied, and only it asked.
    expect(log).toEqual(["draft:members@club.example.com"]);
    expect(h.events.filter((e) => e.type === "approval.requested")).toHaveLength(1);
    const w = h.store.workers.byThread(t.id)[0] as WorkerRecord;
    const row = h.store.dispatches.get(w.grants.dispatchId ?? "");
    expect((row?.report as { report?: { proposal?: string } } | undefined)?.report?.proposal).toBe(
      "要我把草稿寄給讀書會成員嗎？",
    );
    expect(msg?.content).toContain("提案：要我把草稿寄給讀書會成員嗎？");
  }, 40_000);

  it("tool_call refuses a tool whose schema was not loaded this turn (it returns the schema instead)", async () => {
    const log: string[] = [];
    const worker = ({ pass }: ScriptContext): ScriptStep[] => {
      if (pass === 0)
        return call("x", "tool_call", { name: "mail_draft", arguments: { to: "a@b.example.com" } });
      if (pass === 1) {
        return call("rep", "report_result", {
          status: "blocked",
          summary: "先載入",
          unblock: "tool_describe",
        });
      }
      return say("完成");
    };
    h = makeAgents({
      router: routerFor(),
      worker,
      level: "autonomous",
      tools: mailTools(log),
      system: { webFetch },
    });
    const events = workerEvents(h);
    const t = h.core.createThread();
    await h.core.send(t.id, "寫草稿").done;
    await reportTo(t.id);
    const r = events.find((e): e is Completed => e.type === "tool.completed");
    expect(String(r?.data.result)).toContain("schema_not_loaded");
    expect(log).toEqual([]);
  }, 30_000);

  it("await_event parks the dispatch; the clock wakes it and a continuation worker finishes on the same dispatch", async () => {
    let clock = new Date("2026-11-05T09:00:00Z").getTime();
    const goals: string[] = [];
    const worker = ({ req, pass }: ScriptContext): ScriptStep[] => {
      if (pass === 0) goals.push(req.userMessage);
      const woken = req.userMessage.includes("等待的事件到了");
      if (!woken) {
        if (pass === 0)
          return call("w", "await_event", { note: "等報名截止後再統計人數", wakeInMinutes: 30 });
        return say("（不該到這裡）");
      }
      if (pass === 0)
        return call("rep", "report_result", { status: "done", summary: "報名截止，共 12 人。", claims: [] });
      return say("完成");
    };
    h = makeAgents({
      router: routerFor(),
      worker,
      level: "autonomous",
      system: { webFetch, now: () => new Date(clock) },
    });
    const t = h.core.createThread();
    await h.core.send(t.id, "報名截止後告訴我人數").done;
    const first = await reportTo(t.id);
    expect(first?.content).toContain("等報名截止後再統計人數");
    const w1 = h.store.workers.byThread(t.id)[0] as WorkerRecord;
    const dsp = w1.grants.dispatchId ?? "";
    expect(h.store.dispatches.get(dsp)?.status).toBe("waiting_event");
    const wait = h.store.dispatches.waitOf(w1.id);
    expect(wait).toMatchObject({ kind: "event", state: "open" });
    // Not yet due: nothing wakes.
    h.agents.sweep();
    expect(h.store.workers.byThread(t.id)).toHaveLength(1);
    clock += 31 * 60_000;
    h.agents.sweep();
    await reportTo(t.id, 2);
    const all = h.store.workers.byThread(t.id);
    expect(all).toHaveLength(2);
    expect(all.every((w) => w.grants.dispatchId === dsp)).toBe(true);
    expect(goals.at(-1)).toContain("等待的事件到了");
    expect(h.store.dispatches.get(dsp)).toMatchObject({ status: "settled", outcome: "done" });
    expect(h.store.dispatches.wait(wait?.id ?? "")?.state).toBe("closed");
    // A second sweep does not wake it again.
    h.agents.sweep();
    expect(h.store.workers.byThread(t.id)).toHaveLength(2);
  }, 40_000);
});
