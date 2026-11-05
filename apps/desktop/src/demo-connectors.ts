import type { MockComposio } from "@alca/connectors/testing";
import { type ScriptContext, type ScriptStep, streamText } from "@alca/engines";

/**
 * Offline demo for connected apps and routines (P6), on the local Composio
 * stand-in: a mailbox with a few letters, a reply that stops at the send
 * card, a routine whose AI run prepares a draft ahead (提前做).
 */

const say = (text: string, delay = 12): ScriptStep[] => streamText(text, 2, delay);
const call = (id: string, name: string, input: Record<string, unknown>): ScriptStep[] => [
  { type: "tool.call", id, name, input },
  { type: "done", stop: "tool_use" },
];

export const DEMO_MAIL = [
  {
    messageId: "18f2a1c0b7e4d901",
    threadId: "18f2a1c0b7e4d901",
    subject: "下週三的報價可以先給我嗎？",
    sender: "王小明 <wang.xiaoming@example.com>",
    preview: "您好，想確認下週三前能不能先收到報價單，我們要在週四內部開會討論。",
    messageTimestamp: "2026-11-03T07:42:00Z",
  },
  {
    messageId: "18f2a0d3c9b1e772",
    threadId: "18f2a0d3c9b1e772",
    subject: "週五的會可以改到下午嗎",
    sender: "林佳穎 <jiaying.lin@example.com>",
    preview: "週五早上臨時有事，會議可以改到下午兩點嗎？",
    messageTimestamp: "2026-11-03T05:10:00Z",
  },
  {
    messageId: "18f29f11aa03c5d0",
    threadId: "18f29f11aa03c5d0",
    subject: "【電子報】本週新品與優惠",
    sender: "山嵐選物 <news@shanlan.example>",
    preview: "本週精選：藍牙耳機八折、行動電源買一送一。",
    messageTimestamp: "2026-11-03T01:00:00Z",
  },
];

export function seedDemoInbox(mock: MockComposio): void {
  mock.inbox.splice(0, mock.inbox.length, ...DEMO_MAIL.map((m) => ({ ...m })));
}

export const DEMO_REPLY_REQUEST = "幫我回王小明的信，跟他說報價週三中午前寄給他";
export const DEMO_MAIL_REQUEST = "幫我看看工作信箱有沒有要回的信";

/** Router side: requests about connected apps. Undefined = not ours. */
export function connectorRouter(text: string): ScriptStep[] | undefined {
  const draft = /(drf_[0-9A-Z]{26})/.exec(text)?.[1];
  if (draft)
    return [
      ...say("好，我開一個任務用那份草稿寄出；寄出前會先請你確認。"),
      ...call("rt-draft", "worker_start", {
        title: "寄出草稿",
        goal: text.replace(/\n/g, " ").slice(0, 600),
      }),
    ];
  const reply = (t: string) => /幫我回|回覆|回信給|寄信|寄給/.test(t) && !/要回的|盯/.test(t);
  if (reply(text))
    return [
      ...say("好，我開一個任務用你的工作 Gmail 擬好回信；寄出前一定會先問你。"),
      ...call("rt-reply", "worker_start", { title: "回覆王小明", goal: text.trim() }),
    ];
  if (/(工作|個人)?信箱.*(要回|未讀|新信)|看.*(信件|郵件)|Gmail/.test(text) && !/盯|一直/.test(text))
    return [
      ...say("我開一個任務看一下你的工作信箱。"),
      ...call("rt-mail", "worker_start", { title: "看工作信箱", goal: text.trim() }),
    ];
  return undefined;
}

/** Router side: a routine's structured report. */
export function routineReport(msg: string): ScriptStep[] {
  const name = /name="([^"]+)"/.exec(msg)?.[1] ?? "例行工作";
  const summary = /摘要：(.+)/.exec(msg)?.[1];
  const drafts = (msg.match(/草稿 drf_[0-9A-Z]+/g) ?? []).length;
  return say(
    `「${name}」有新的事：${summary ?? "有值得看的項目"}。${drafts ? `我先擬好了 ${drafts} 份回覆草稿（還沒寄出），在「例行工作」裡可以看。` : ""}`,
  );
}

/**
 * A routine's AI run is a general-harness worker; design §0.2.4: its answer is report_result's
 * structured `data`, checked against the routine's schema.
 */
const routineDone = (data: { quiet: boolean; summary?: string }): ScriptStep[] =>
  call("wk-report", "report_result", { status: "done", summary: data.summary ?? "沒有要處理的", data });

/**
 * A host tool (a connected app, a note tool) from a general-harness worker: when it is not offered
 * directly (it sits in the lazy catalog), load its schema with tool_describe
 * first, then run it through tool_call under the same call id.
 */
const viaCatalog = new Map<string, { name: string; input: Record<string, unknown> }>();
const described = new Set<string>();
export function appCall(
  req: ScriptContext["req"],
  id: string,
  name: string,
  input: Record<string, unknown>,
): ScriptStep[] {
  const tools = req.tools?.map((t) => t.name) ?? [];
  if (!tools.length || tools.includes(name) || !tools.includes("tool_call")) return call(id, name, input);
  // The catalog keeps a loaded schema for the rest of the run: describe once, then call directly.
  if (described.has(`${req.runId}:${name}`)) return call(id, "tool_call", { name, arguments: input });
  described.add(`${req.runId}:${name}`);
  viaCatalog.set(`${req.sessionKey ?? req.threadId}:${id}`, { name, input });
  return call(`${id}~schema`, "tool_describe", { name });
}

/** The tool_call that follows a tool_describe from appCall (undefined = not one). */
export function catalogFollowUp(req: ScriptContext["req"]): ScriptStep[] | undefined {
  const r = req.toolResults?.[0];
  if (!r?.id.endsWith("~schema")) return undefined;
  const id = r.id.slice(0, -"~schema".length);
  const key = `${req.sessionKey ?? req.threadId}:${id}`;
  const p = viaCatalog.get(key);
  viaCatalog.delete(key);
  return p ? call(id, "tool_call", { name: p.name, arguments: p.input }) : undefined;
}

/** Worker side. Undefined = not ours (the general demo worker handles it). */
export function connectorWorker(
  { req, pass }: Pick<ScriptContext, "req" | "pass">,
  goal: string,
): ScriptStep[] | undefined {
  const msg = req.userMessage;
  const r = req.toolResults?.[0];
  const next = catalogFollowUp(req);
  if (next) return next;
  if (pass === 0 && msg.includes("<alca:records")) {
    const items = [...msg.matchAll(/- id: ([^｜\n]+)｜(?:來自 ([^｜\n]+)｜)?([^｜\n]+)/g)].map((m) => ({
      id: (m[1] ?? "").trim(),
      from: (m[2] ?? "").trim(),
      title: (m[3] ?? "").trim(),
    }));
    const important = items.filter((i) => !/電子報|優惠|news@/.test(`${i.title} ${i.from}`));
    if (!important.length) return routineDone({ quiet: true });
    pending.set(req.sessionKey ?? req.threadId, important);
    const first = important[0];
    if (msg.includes('speculative="true"') && first)
      return call("wk-draft", "draft_save", {
        title: `回覆：${first.title}`.slice(0, 100),
        kind: "reply",
        app: "gmail",
        to: /<([^>]+)>/.exec(first.from)?.[1] ?? first.from,
        subject: `Re: ${first.title}`,
        body: "王先生您好：\n\n報價單我會在週三中午前寄給您，方便您週四開會討論。\n\n謝謝！",
      });
    return routineDone(routineData(important));
  }
  if (r?.id === "wk-draft") {
    const items = pending.get(req.sessionKey ?? req.threadId) ?? [];
    pending.delete(req.sessionKey ?? req.threadId);
    return routineDone(routineData(items, true));
  }
  if (r?.id === "wk-report") return say("好", 4);
  if (/drf_[0-9A-Z]{26}/.test(goal)) {
    if (pass === 0)
      return appCall(req, "wk-send", "app_mail_send", {
        account: "工作",
        to: "wang.xiaoming@example.com",
        subject: "Re: 下週三的報價可以先給我嗎？",
        body: "王先生您好：\n\n報價單我會在週三中午前寄給您，方便您週四開會討論。\n\n謝謝！",
      });
    if (r?.id === "wk-send")
      return say(
        r.ok && !r.output.startsWith("沒有執行") ? "草稿已經寄出了。" : `沒有寄出：${r.output.slice(0, 120)}`,
        6,
      );
  }
  if (/幫我回|回覆|回信給|寄信|寄給/.test(goal) && !/要回的/.test(goal)) {
    if (pass === 0)
      return appCall(req, "wk-find", "app_mail_search", {
        account: "工作",
        query: "from:wang.xiaoming@example.com",
        max: 3,
      });
    if (r?.id === "wk-find")
      return [
        ...say("找到王小明的來信（詢問下週三前的報價），回信寫好了，準備寄出。", 6),
        ...appCall(req, "wk-send", "app_mail_send", {
          account: "工作",
          to: "wang.xiaoming@example.com",
          subject: "Re: 下週三的報價可以先給我嗎？",
          body: "王先生您好：\n\n報價單我會在週三中午前寄給您，方便您週四開會討論。\n\n謝謝！",
        }),
      ];
    if (r?.id === "wk-send")
      return say(
        r.ok && !r.output.startsWith("沒有執行")
          ? "回信已寄給王小明。"
          : `沒有寄出：${r.output.slice(0, 120)}`,
        6,
      );
  }
  if (/信箱|信件|郵件|Gmail/.test(goal) && !/盯|一直/.test(goal)) {
    if (pass === 0)
      return appCall(req, "wk-inbox", "app_mail_search", {
        account: "工作",
        query: "is:unread in:inbox",
        max: 10,
      });
    if (r?.id === "wk-inbox") {
      if (!r.ok || r.output.startsWith("沒有執行")) return say(`讀不到信箱：${r.output.slice(0, 160)}`, 6);
      const subjects = [...r.output.matchAll(/"subject":"([^"]+)"/g)].map((m) => m[1]);
      return say(
        `工作信箱有 ${subjects.length} 封未讀：${subjects.join("、")}。要回的是王小明（報價）和林佳穎（改會議時間）；電子報不用理。`,
        6,
      );
    }
  }
  return undefined;
}

/** A routine run's records, kept between its passes (the draft step comes first). */
const pending = new Map<string, Array<{ id: string; title: string; from: string }>>();

function routineData(items: Array<{ id: string; title: string; from?: string }>, drafted = false) {
  const who = (f?: string) => (f ? f.replace(/\s*<[^>]+>/, "") : "");
  return {
    quiet: false,
    items: items.map((i, n) => ({
      id: i.id,
      note: `${i.from ? `${who(i.from)}：` : ""}${i.title}${drafted && n === 0 ? "（回覆草稿已擬好）" : ""}`.slice(
        0,
        120,
      ),
    })),
    summary: `${items.length} ${items.some((i) => i.from) ? "封要回" : "件要看"}：${items.map((i) => who(i.from) || i.title).join("、")}`,
  };
}
