import type { HostTool } from "@alca/core";
import { type ScriptStep, streamText } from "@alca/engines";
import { DemoEngine } from "./demo-engine.ts";

/**
 * Offline demo: a scripted engine plus three note tools over an in-memory
 * notebook (nothing touches the disk). It exercises streaming, approval cards
 * and question cards without any model or login.
 */
export function demoTools(): HostTool[] {
  const notes = new Map<string, string>([["購物清單", "牛奶、雞蛋、烏龍茶"]]);
  const obj = { type: "object", properties: { title: { type: "string" }, body: { type: "string" } } };
  return [
    {
      spec: { name: "read_note", description: "讀一則筆記", inputSchema: obj },
      actionClass: "read",
      run: async (a) => notes.get(String(a.title)) ?? "（沒有這則筆記）",
    },
    {
      spec: { name: "write_note", description: "新增或覆寫一則筆記", inputSchema: obj },
      actionClass: "write",
      run: async (a) => {
        notes.set(String(a.title), String(a.body ?? ""));
        return `已寫入「${String(a.title)}」`;
      },
    },
    {
      spec: { name: "delete_note", description: "刪除一則筆記", inputSchema: obj },
      actionClass: "delete",
      run: async (a) => (notes.delete(String(a.title)) ? `已刪除「${String(a.title)}」` : "找不到這則筆記"),
    },
  ];
}

const say = (text: string): ScriptStep[] => streamText(text, 2, 16);

function firstPass(text: string, shopUrl?: string): ScriptStep[] {
  if (shopUrl && /結帳|網頁|瀏覽器|商店/.test(text)) {
    return [
      ...say("好，我在瀏覽器裡打開示範商店的結帳頁。"),
      {
        type: "tool.call",
        id: "demo-open",
        name: "browser_open",
        input: { url: shopUrl, title: "山嵐選物結帳" },
      },
      { type: "done", stop: "tool_use" },
    ];
  }
  if (/刪除|delete/i.test(text)) {
    return [
      ...say("好的，我先確認一下要刪除的筆記。"),
      { type: "tool.call", id: "demo-del", name: "delete_note", input: { title: "購物清單" } },
      { type: "done", stop: "tool_use" },
    ];
  }
  if (/寫|記下|筆記/.test(text)) {
    return [
      ...say("我幫你把這件事記下來。"),
      { type: "tool.call", id: "demo-write", name: "write_note", input: { title: "待辦", body: text } },
      { type: "done", stop: "tool_use" },
    ];
  }
  if (/問|選|哪/.test(text)) {
    return [
      {
        type: "tool.call",
        id: "demo-ask",
        name: "ask_user",
        input: { prompt: "下午的會議想排在什麼時候？", choices: ["14:00", "15:30", "16:00"] },
      },
      { type: "done", stop: "tool_use" },
    ];
  }
  if (/慢|長/.test(text)) {
    return say(
      "這是一段比較長的回答，用來展示串流的節奏。Alca 會一邊想一邊把字送到畫面上，你隨時可以按 Esc 中斷。".repeat(
        3,
      ),
    );
  }
  return say(
    `收到：「${text.trim().slice(0, 60)}」。\n\n這是離線示範引擎，不會呼叫任何模型。試試看：「幫我寫一則筆記」、「刪除購物清單」，或「問我會議時間」，就能看到批准卡與提問卡。`,
  );
}

/** Browser demo: open → snapshot → press the pay button (which the host gates). */
function browserPass(r: { id: string; ok: boolean; output: string }): ScriptStep[] | undefined {
  if (r.id === "demo-open")
    return r.ok
      ? [
          { type: "tool.call", id: "demo-snap", name: "browser_snapshot", input: {} },
          { type: "done", stop: "tool_use" },
        ]
      : say(`瀏覽器開不起來：${r.output}`);
  if (r.id === "demo-snap") {
    const ref = /button "確認付款[^"]*" (@\d+)/.exec(r.output)?.[1];
    if (!r.ok || !ref) return say("我沒在頁面上找到付款按鈕。");
    return [
      ...say(`購物車共兩件、總計 NT$1,280。付款按鈕是 ${ref}，按下去之前需要你確認。`),
      { type: "tool.call", id: "demo-pay", name: "browser_click", input: { ref } },
      { type: "done", stop: "tool_use" },
    ];
  }
  if (r.id === "demo-pay")
    return say(r.ok ? "已按下付款（示範商店，沒有真的扣款）。" : `沒有付款：${r.output}`);
  return undefined;
}

export function demoEngine(opts: { shopUrl?: string } = {}): DemoEngine {
  return new DemoEngine(
    ({ pass, req }) => {
      if (pass === 0) return firstPass(req.userMessage.split("\n").at(-1) ?? "", opts.shopUrl);
      const r = req.toolResults?.[0];
      if (!r) return say("完成。");
      const b = browserPass(r);
      if (b) return b;
      if (r.id === "demo-ask")
        return say(r.ok ? `好，我把會議排在 ${r.output}，並保留前後各十分鐘的緩衝。` : "這題先跳過。");
      return r.ok
        ? say(`${r.output}。還需要什麼嗎？`)
        : say(`這一步沒有執行：${r.output}。我不會再自己重試。`);
    },
    { id: "demo" },
  );
}
