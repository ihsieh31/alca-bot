import type { Store, WorkerRecord } from "@alca/store";
import { defuseAlcaTags } from "@alca/tools";
import { page } from "./spill.ts";

/**
 * The recall chain (plan v4): every object the router deals with has an id —
 * workers `wkr_`, spilled results `spl_`, triggers `trg_`, trigger events
 * `tev_`, streams `str_`, threads `thr_`. What goes into the router's context
 * is a summary plus the ids of the neighbouring objects; `recall` opens one
 * object and again lists its neighbours, so the model can walk the graph a
 * hop at a time instead of carrying everything in its context.
 *
 * Only objects of the calling bot are visible.
 */

const PAGE = 1500;
const clip = (s: string, n: number) => ([...s].length > n ? `${[...s].slice(0, n).join("")}…` : s);

const STATUS: Record<string, string> = {
  queued: "排隊中",
  running: "進行中",
  waiting: "等使用者批准",
  succeeded: "完成",
  failed: "失敗",
  stopped: "已停止",
  needs_review: "需要人確認",
};

export function workerLine(w: WorkerRecord): string {
  return `${w.id}「${w.title}」${STATUS[w.status] ?? w.status}${w.stopReason ? `（${w.stopReason}）` : ""}`;
}

export function recallObject(store: Store, botId: string, id: string, offset = 0): string {
  const deny = `找不到 ${id}（或不屬於這個 bot）。`;
  const prefix = id.split("_")[0];
  switch (prefix) {
    case "wkr": {
      const w = store.workers.get(id);
      if (!w || w.botId !== botId) return deny;
      const streams = store.triggers.subscriptionsOf(w.id);
      const spills = store.workers.spillsOf(w.id);
      return [
        `<alca:recalled id="${w.id}" kind="worker">`,
        workerLine(w),
        `交辦內容：${clip(w.goal, 600)}`,
        `步數 ${w.steps}${w.speculative ? "，提前準備的工作" : ""}`,
        w.result
          ? w.result.mode === "inline"
            ? `結果：\n${w.result.summary}`
            : `結果摘要（全文 ${w.result.chars} 字）：${w.result.summary}`
          : "還沒有結果。",
        `相鄰：對話 ${w.threadId}${w.parentRunId ? `、派工回合 ${w.parentRunId}` : ""}${
          spills.length ? `、全文 ${spills.join("、")}` : ""
        }${streams.length ? `、訂閱的串 ${streams.join("、")}` : ""}`,
        "</alca:recalled>",
      ].join("\n");
    }
    case "spl": {
      const s = store.workers.spill(id);
      if (!s || s.botId !== botId) return deny;
      const p = page(s.body, offset, PAGE);
      return [
        `<alca:recalled id="${s.id}" kind="spill" owner="${s.ownerId}" offset="${Math.max(0, offset)}" total="${p.total}">`,
        defuseAlcaTags(p.body),
        "</alca:recalled>",
        p.next !== undefined
          ? `還有 ${p.total - p.next} 字：recall {"id":"${s.id}","offset":${p.next}}`
          : "（到底了）",
        `相鄰：${s.ownerId}`,
      ].join("\n");
    }
    case "trg": {
      const t = store.triggers.get(id);
      if (!t || t.botId !== botId) return deny;
      const recent = store.triggers.events({ triggerId: t.id }, 5);
      return [
        `<alca:recalled id="${t.id}" kind="trigger">`,
        `${t.name}（${t.source}，${t.enabled ? "啟用" : "停用"}）`,
        `程式規則：${JSON.stringify(t.rule)}`,
        `語意規則：${t.semantic ?? "（預設）"}`,
        `最近的事件：${recent.map((e) => `${e.id}→${e.outcome}`).join("、") || "無"}`,
        `相鄰：對話 ${t.threadId}`,
        "</alca:recalled>",
      ].join("\n");
    }
    case "tev": {
      const e = store.triggers.event(id);
      const t = e ? store.triggers.get(e.triggerId) : undefined;
      if (!e || !t || t.botId !== botId) return deny;
      const text = typeof e.payload.text === "string" ? e.payload.text : JSON.stringify(e.payload);
      const p = page(text, offset, PAGE);
      return [
        `<alca:recalled id="${e.id}" kind="trigger_event" trust="untrusted">`,
        defuseAlcaTags(p.body),
        "</alca:recalled>",
        `程式規則：${e.ruleVerdict}${e.judged ? `；模型判斷：${e.judged}` : ""}；結果：${e.outcome}`,
        p.next !== undefined ? `還有 ${p.total - p.next} 字：recall {"id":"${e.id}","offset":${p.next}}` : "",
        `相鄰：觸發器 ${t.id}${e.streamId ? `、串 ${e.streamId}` : ""}`,
      ]
        .filter(Boolean)
        .join("\n");
    }
    case "str": {
      const s = store.triggers.stream(id);
      if (!s || s.botId !== botId) return deny;
      const subs = store.triggers.subscribers(s.id).map((w) => store.workers.get(w));
      const recent = store.triggers.events({ streamId: s.id }, 5);
      return [
        `<alca:recalled id="${s.id}" kind="stream">`,
        `${s.title}（${s.key}）`,
        `訂閱的工人：${
          subs
            .filter((w): w is WorkerRecord => !!w)
            .map(workerLine)
            .join("、") || "無"
        }`,
        `最近的事件：${recent.map((e) => e.id).join("、") || "無"}`,
        "</alca:recalled>",
      ].join("\n");
    }
    case "thr": {
      const t = store.threads.get(id);
      if (!t || (t.botId && t.botId !== botId)) return deny;
      const ws = store.workers.byThread(id).slice(-10);
      return [
        `<alca:recalled id="${t.id}" kind="thread">`,
        `對話「${t.title ?? "新對話"}」`,
        `工人：${ws.map(workerLine).join("、") || "無"}`,
        "</alca:recalled>",
      ].join("\n");
    }
    default:
      return `不認得這種編號：${id}。可以回想 wkr_、spl_、trg_、tev_、str_、thr_ 開頭的編號。`;
  }
}
