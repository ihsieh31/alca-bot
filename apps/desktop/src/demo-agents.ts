import type { HostTool } from "@alca/core";
import { type ScriptContext, type ScriptStep, streamText } from "@alca/engines";
import {
  appCall,
  catalogFollowUp,
  connectorRouter,
  connectorWorker,
  routineReport,
} from "./demo-connectors.ts";
import { DemoEngine } from "./demo-engine.ts";
import { teamFirst, teamReport, teamRequest } from "./demo-team.ts";

/**
 * Offline demo for the router / worker split (P3): three scripted engines —
 * the router (talks and dispatches), the workers (do the work with the host
 * tools), and the trigger judge. No model, no login; it exercises parallel
 * workers, a payment card in a worker's browser Space, a spilled result the
 * router recalls, and a looping worker the watchdog stops.
 */

const say = (text: string, delay = 14): ScriptStep[] => streamText(text, 2, delay);
const call = (id: string, name: string, input: Record<string, unknown>): ScriptStep[] => [
  { type: "tool.call", id, name, input },
  { type: "done", stop: "tool_use" },
];
const lastLine = (s: string) => s.trim().split("\n").at(-1)?.trim() ?? "";

/**
 * A slow mailbox poll that never gets anywhere: the same call returns the same
 * result every time, so it is a loop by the one set of stop rules (plan §2.4:
 * call signature + result hash). An unattended worker's LoopGuard or the
 * watchdog stops it, whichever sees it first.
 */
export function demoInboxTool(delayMs = 350): HostTool {
  return {
    spec: {
      name: "check_inbox",
      description: "看信箱有沒有新回信",
      inputSchema: { type: "object", properties: {} },
    },
    actionClass: "read",
    run: async (_a, signal) => {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, delayMs);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(t);
            resolve();
          },
          { once: true },
        );
      });
      return "還沒有新回信";
    },
  };
}

const REPORT = [
  "三家店的藍牙耳機比價整理如下。",
  ...["山嵐選物", "北岸電器", "南門數位"].map(
    (shop, i) =>
      `${shop}：售價 NT$${[3280, 2990, 3150][i]}，${["含運、七天鑑賞", "滿千免運、保固一年", "門市取貨、保固兩年"][i]}。` +
      "評價摘錄：".concat("音質清楚、通話收音穩定、配戴舒適，續航大約七小時。".repeat(14)),
  ),
  "規格對照：".concat("藍牙 5.3、主動降噪、IPX4、USB-C 快充、支援多點連線。".repeat(16)),
  "退換貨條款：".concat("未拆封七天內可退，拆封後僅限瑕疵換貨，運費由店家負擔。".repeat(10)),
  "結論：北岸電器最便宜（NT$2,990）且保固一年；要長保固就選南門數位。",
].join("\n\n");

/** Shared by the router and the UI copy: what a request that starts two workers looks like. */
export const DEMO_PARALLEL_REQUEST = "同時幫我做兩件事：在示範商店結帳，再整理一份藍牙耳機的比價報告";
export const DEMO_LOOP_REQUEST = "幫我一直盯著信箱，有回信就告訴我";

/** What the router's user message carries besides the text: memory notes, recalled items, skill hints. */
interface RouterInputs {
  notes: string[];
  recalled: Array<{ id: string; body: string }>;
  skillId?: string;
}

function routerInputs(msg: string, volatile: string): RouterInputs {
  const block = (tag: string) =>
    (new RegExp(`<alca:${tag}>\\n([\\s\\S]*?)\\n</alca:${tag}>`).exec(msg)?.[1] ?? "")
      .split("\n")
      .map((l) => l.replace(/^- /, "").trim())
      .filter(Boolean);
  const recalled = block("recalled").map((l) => ({
    id: /(mem_[0-9A-Z]{26})/.exec(l)?.[1] ?? "",
    body: l.replace(/（[^（]*・mem_[0-9A-Z]{26}）$/, ""),
  }));
  const skillId = /(skl_[0-9A-Z]{26})/.exec(volatile)?.[1];
  return { notes: block("memory-update"), recalled, ...(skillId ? { skillId } : {}) };
}

/** Reply to 記住／忘記 the way a router model would: short, saying what happened. */
function memoryReply(notes: string[]): ScriptStep[] {
  const parts = notes.map((n) => {
    if (n.startsWith("沒有記下")) return "這看起來是密碼、金鑰或卡號，我不會記下來。";
    if (n.startsWith("已忘記")) return "好，已經忘記了（連舊版本一起刪除），之後也不會再記住。";
    if (n.startsWith("沒有找到")) return "我本來就沒有記得這件事；之後也不會記下來。";
    const body = /：(.+)（mem_/.exec(n)?.[1] ?? n;
    return n.startsWith("本來就記得") ? `我本來就記得：${body}。` : `好，我記住了：${body}。`;
  });
  return say(parts.join("\n"));
}

function routerFirst(text: string, shop: boolean, inp: RouterInputs): ScriptStep[] {
  if (inp.notes.length && /記住|忘記|忘掉|remember|forget/i.test(text)) return memoryReply(inp.notes);
  const memoryIds = inp.recalled.map((r) => r.id).filter(Boolean);
  const grants = {
    ...(memoryIds.length ? { memoryIds } : {}),
    ...(inp.skillId ? { skillId: inp.skillId } : {}),
  };
  if (/咖啡|飲料|喝什麼|點一杯|推薦.*喝/.test(text)) {
    const drink = inp.recalled.find((r) => /喝|咖啡|拿鐵|茶|奶/.test(r.body));
    return say(
      drink
        ? `記得你${drink.body.replace(/^喜歡/, "喜歡")}，我就照這個幫你準備。要換別的也可以跟我說。`
        : "你想喝什麼？告訴我你的喜好，我可以記下來，下次就不用再問。",
    );
  }
  if (/同時|兩件|分頭/.test(text))
    return [
      ...say("好，我開兩個任務同時進行：一個去示範商店結帳，一個整理比價報告。"),
      {
        type: "tool.call",
        id: "rt-shop",
        name: "worker_start",
        input: { title: "示範商店結帳", goal: shop ? "在示範商店結帳" : "整理購物清單" },
      },
      {
        type: "tool.call",
        id: "rt-report",
        name: "worker_start",
        input: { title: "藍牙耳機比價", goal: "整理三家店的藍牙耳機比價報告" },
      },
      { type: "done", stop: "tool_use" },
    ];
  const app = connectorRouter(text);
  if (app) return app;
  if (/^我(?:現在|平常|最)?(?:喜歡|愛|習慣|不喜歡|討厭|住|對|的|改)/.test(text))
    return say("了解，我會記得這件事（先標成推測；你可以在「記憶」裡確認、修改或刪掉）。");
  if (/盯|一直|信箱/.test(text))
    return [
      ...say("好，我開一個任務盯著信箱。"),
      ...call("rt-watch", "worker_start", { title: "盯信箱", goal: "一直檢查信箱有沒有新回信" }),
    ];
  if (/問|哪個時間|排幾點/.test(text))
    return call("rt-ask", "ask_user", {
      prompt: "下午的會議想排在什麼時候？",
      choices: ["14:00", "15:30", "16:00"],
    });
  if (/結帳|商店|瀏覽器|網頁|刪除|寫|筆記|記下|整理|查|比價|週報/.test(text)) {
    const title = /週報/.test(text)
      ? "整理週報"
      : /結帳/.test(text) && shop
        ? "示範商店結帳"
        : text.trim().slice(0, 14);
    return [
      ...say(
        inp.skillId ? "收到，這件事有你核准過的做法，我照那些步驟開一個任務。" : "收到，我開一個任務去做。",
      ),
      ...call("rt-one", "worker_start", { title, goal: text.trim(), ...grants }),
    ];
  }
  if (/^\s*(你好|您好|嗨|哈囉|hi|hello|hey)/i.test(text))
    return say(
      `你好！我可以幫你寫筆記、整理信箱，或在瀏覽器裡把事情辦完。直接告訴我想做什麼就好。\n\n想看看幾件事一起做？試試「${DEMO_PARALLEL_REQUEST}」。`,
    );
  return say(
    `收到：「${text.trim().slice(0, 60)}」。\n\n這是示範模式，我還沒接上真的模型。試試「${DEMO_PARALLEL_REQUEST}」，看兩個任務同時進行；或「${DEMO_LOOP_REQUEST}」，看 Alca 怎麼停下原地打轉的任務。`,
  );
}

const STATUS_WORD: Record<string, string> = {
  succeeded: "完成了",
  failed: "沒有完成",
  stopped: "被停下了",
  needs_review: "需要你確認",
};

function routerReport(msg: string): ScriptStep[] {
  const title = /title="([^"]+)"/.exec(msg)?.[1] ?? "工作";
  const raw = /status="([a-z_]+)"/.exec(msg)?.[1] ?? "succeeded";
  // ok="false": the turn ended but a step failed (C2) — say so, never "done".
  const status = raw === "succeeded" && / ok="false"/.test(msg) ? "failed" : raw;
  const spill = /全文：(spl_[0-9A-Z]+)/.exec(msg)?.[1];
  if (spill && status === "succeeded") return call("rt-recall", "recall", { id: spill });
  const body = msg.split("\n").slice(1, -3).join("\n").trim();
  if (status === "stopped" && /watchdog/.test(msg)) {
    const detail = /停止原因：watchdog\.[a-z_]+: (.+)/.exec(msg)?.[1];
    return say(
      `「${title}」被看門狗停下了：它一直重複同一個動作卻沒有進展${detail ? `（${detail}）` : ""}。需要的話我可以換個方式再派一次。`,
    );
  }
  // A harness worker's report: say its own words, not the closing caution.
  const words = /工人原話（[^）]*）：(.+)/.exec(body)?.[1];
  return say(`「${title}」${STATUS_WORD[status] ?? status}。${words ?? body.split("\n").at(-1) ?? ""}`);
}

export function demoRouterEngine(opts: { shop?: boolean } = {}): DemoEngine {
  return new DemoEngine(
    ({ req, pass }: ScriptContext) => {
      const msg = req.userMessage;
      if (pass === 0) {
        if (msg.includes("<alca:routine")) return routineReport(msg);
        if (msg.includes("<alca:peer-report")) return teamReport(msg) ?? say("隊友回覆了。");
        if (msg.includes("<alca:peer "))
          return teamRequest(msg, req.system.volatile) ?? say("收到隊友的請求。");
        if (msg.includes("<alca:worker")) return routerReport(msg);
        if (msg.includes("<alca:trigger"))
          return say(`有新的觸發事件：${lastLine(msg.split("</alca:trigger>")[0] ?? "")}`);
        const team = teamFirst(lastLine(msg), req.system.volatile);
        if (team) return team;
        return routerFirst(lastLine(msg), !!opts.shop, routerInputs(msg, req.system.volatile));
      }
      const r = req.toolResults?.[0];
      if (r?.id.startsWith("rt-recall")) {
        const conclusion = /結論：[^\n<]+/.exec(r.output)?.[0];
        const next = /recall (\{"id":"spl_[0-9A-Z]+","offset":\d+\})/.exec(r.output)?.[1];
        // Follow the chain one page at a time until the part we need shows up.
        if (!conclusion && next)
          return call(`rt-recall-${pass}`, "recall", JSON.parse(next) as Record<string, unknown>);
        const total = /total="(\d+)"/.exec(r.output)?.[1];
        return say(`比價報告整理好了（全文 ${total ?? "很多"} 字，我只取回需要的部分）。${conclusion ?? ""}`);
      }
      if (r?.id === "rt-ask") return say(r.ok ? `好，會議排在 ${r.output}。` : "這題先跳過。");
      if (r?.id === "rt-peer")
        return say(r.ok ? "已經交出去了；隊友回覆後我整理給你。" : `沒有交出去：${r.output}`);
      if (r && !r.ok) return say(`沒有派出去：${r.output}`);
      return say("已經派出去了；你可以繼續跟我說別的事，好了我會回報。");
    },
    { id: "demo-router" },
  );
}

/**
 * A harness worker ends by calling report_result: its closing words go in the
 * summary (a failure is reported as partial). Plain workers just talk.
 */
export function withReport(req: ScriptContext["req"], steps: ScriptStep[]): ScriptStep[] {
  if (!req.tools?.some((t) => t.name === "report_result")) return steps;
  if (req.toolResults?.[0]?.id === "wk-report") return steps;
  if (steps.some((s) => s.type === "tool.call")) return steps;
  const summary = steps
    .map((s) => (s.type === "text.delta" ? s.text : ""))
    .join("")
    .trim();
  if (!summary) return steps;
  const failed = /^(沒有|讀不到|瀏覽器開不起來|頁面上沒找到)/.test(summary);
  return [...steps, ...call("wk-report", "report_result", { status: failed ? "partial" : "done", summary })];
}

/** Worker: the goal is the last line of its first message; later passes are keyed by its session (the worker id). */
export function demoWorkerEngine(opts: { shopUrl?: string } = {}): DemoEngine {
  const goals = new Map<string, string>();
  const skilled = new Set<string>();
  const step = (ctx: ScriptContext): ScriptStep[] => withReport(ctx.req, workerStep(ctx));
  const workerStep = ({ req, pass }: ScriptContext): ScriptStep[] => {
    const key = req.sessionKey ?? req.threadId;
    if (req.toolResults?.[0]?.id === "wk-report") return say("好", 4);
    const viaCatalog = catalogFollowUp(req);
    if (viaCatalog) return viaCatalog;
    if (req.userMessage.includes("<alca:stream-events>"))
      return say("收到串的新事件，已經依原本的工作處理。");
    // The task message sets the goal once; a later note (a reminder, a check) never replaces it.
    if (pass === 0 && req.userMessage && !goals.has(key)) goals.set(key, lastLine(req.userMessage));
    if (pass === 0 && req.userMessage.includes("<alca:skill ")) skilled.add(key);
    const goal = goals.get(key) ?? "";
    const app = connectorWorker({ req, pass }, goal);
    if (app) return app;
    const r = req.toolResults?.[0];
    if (opts.shopUrl && /結帳|商店|瀏覽器/.test(goal)) {
      if (pass === 0) return call("wk-open", "browser_open", { url: opts.shopUrl, title: "山嵐選物結帳" });
      if (r?.id === "wk-open")
        return r.ok ? appCall(req, "wk-snap", "browser_snapshot", {}) : say(`瀏覽器開不起來：${r.output}`);
      if (r?.id === "wk-snap") {
        const ref = /button "確認付款[^"]*" (@\d+)/.exec(r.output)?.[1];
        if (!r.ok || !ref) return say("頁面上沒找到付款按鈕。");
        return [
          ...say("購物車兩件、總計 NT$1,280，準備按下付款。", 8),
          ...appCall(req, "wk-pay", "browser_click", { ref }),
        ];
      }
      if (r?.id === "wk-pay")
        return say(r.ok ? "已按下付款（示範商店，沒有真的扣款），訂單完成。" : `沒有付款：${r.output}`, 8);
    }
    if (/週報/.test(goal)) {
      if (pass === 0) return appCall(req, "wk-read", "read_note", { title: "本週筆記" });
      if (r?.id === "wk-read")
        return appCall(req, "wk-weekly", "write_note", { title: "週報", body: "本週完成：記憶與技能。" });
      if (r?.id === "wk-weekly")
        return say(
          `${skilled.has(key) ? "照核准過的技能步驟，" : ""}週報整理好了：先讀本週筆記，再寫成「週報」。`,
          8,
        );
    }
    if (/比價|報告/.test(goal)) return say(REPORT, 0);
    if (/信箱|盯/.test(goal)) return appCall(req, `wk-poll-${pass}`, "check_inbox", {});
    if (/刪除/.test(goal))
      return pass === 0
        ? appCall(req, "wk-del", "delete_note", { title: "購物清單" })
        : say(r?.ok ? `已刪除「購物清單」。` : `沒有刪除：${r?.output ?? ""}`, 8);
    if (/寫|筆記|記下/.test(goal))
      return pass === 0
        ? appCall(req, "wk-write", "write_note", { title: "待辦", body: goal })
        : say(r?.ok ? `已記下：${goal}` : `沒有寫入：${r?.output ?? ""}`, 8);
    return say(`做完了：${goal}`, 8);
  };
  return new DemoEngine(step, { id: "demo-worker" });
}

/** Stage 2 of the trigger filter, offline: wake on anything that sounds like a request or is urgent. */
export function demoJudgeEngine(): DemoEngine {
  return new DemoEngine(
    ({ req }: ScriptContext) => {
      const ev = /<alca:event[^>]*>\n([\s\S]*?)\n<\/alca:event>/.exec(req.userMessage)?.[1] ?? "";
      return /急|請|幫|麻煩|今天/.test(ev)
        ? streamText("WAKE\n看起來需要處理。")
        : streamText("SKIP\n只是通知，不用叫醒 Alca。");
    },
    { id: "demo-judge" },
  );
}
