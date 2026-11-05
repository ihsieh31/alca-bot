import type { AgentsEventData } from "@alca/protocol";
import type { Store } from "@alca/store";
import { defuseAlcaTags } from "@alca/tools";
import type { AddonCompletion } from "../extract-engine.ts";
import type { Learning, TurnInfo, TurnObserver } from "../learning.ts";
import type { TurnState } from "../turn.ts";
import { REPLY_CHECK_ID, type ReplyCheckSettings } from "./manifest.ts";
import type { AddonService } from "./service.ts";

/**
 * P14 §D, the 回覆檢查 add-on (costClass on_use). After a router reply, one
 * tool-less completion on the bot's engine checks it against the
 * conversation rules: more than one question, asking what memory already
 * has, offering what the bot cannot do, naming where a memory came from,
 * repeating an offer this conversation declined, breaking a must-follow
 * instruction. On issues the reply is rewritten once (another tool-less
 * turn); a rewrite that still fails, an error or a timeout leaves the
 * original as it was. A rewrite replaces the stored message and goes out as
 * `reply.revised`, so surfaces swap the text and mark it 已修改.
 */

export interface ReplyVerdict {
  ok: boolean;
  issues: string[];
}

const SOURCE_TALK =
  /我在你的(?:信|郵件|email|行事曆|日曆|訊息|對話紀錄)裡(?:看到|發現|讀到)|I saw (?:it )?in your (?:email|inbox|calendar|messages)/iu;

/** Cheap checks that need no model (they join the model's issues). */
export function ruleIssues(reply: string): string[] {
  const out: string[] = [];
  const questions = (reply.match(/[?？]/gu) ?? []).length;
  if (questions > 1) out.push("一則訊息裡問了不只一個問題");
  if (SOURCE_TALK.test(reply)) out.push("說出了記憶的來源（「我在你的信裡看到」）");
  return out;
}

export function checkPrompt(i: {
  userText: string;
  reply: string;
  mustFollow: readonly string[];
  memories: readonly string[];
  declined: readonly string[];
  tools: readonly string[];
}): string {
  return [
    "你是回覆檢查員。檢查 <reply> 這則助理回覆有沒有違反下面的規則，只輸出 JSON，不要其他文字：",
    '{"ok":true} 或 {"ok":false,"issues":["問題（15 字內）"]}',
    "規則：",
    "1. 一則最多一個問題。",
    "2. 不要問 <memory> 裡已經有答案的事。",
    "3. 提議的事必須是這個 bot 現在做得到的（它的工具：<tools>）。",
    "4. 不說記憶的來源（例如「我在你的信裡看到」），除非使用者問「你怎麼知道」。",
    "5. 不重提 <declined> 裡這個對話被拒絕過的提議。",
    "6. 一定要遵守 <must-follow> 裡使用者的固定指示。",
    "<user>",
    defuseAlcaTags(i.userText.slice(0, 1500)),
    "</user>",
    "<reply>",
    defuseAlcaTags(i.reply.slice(0, 4000)),
    "</reply>",
    "<memory>",
    ...i.memories.map((m) => `- ${defuseAlcaTags(m).slice(0, 120)}`),
    "</memory>",
    "<declined>",
    ...i.declined.map((m) => `- ${defuseAlcaTags(m).slice(0, 120)}`),
    "</declined>",
    "<must-follow>",
    ...i.mustFollow.map((m) => defuseAlcaTags(m)),
    "</must-follow>",
    `<tools>${i.tools.slice(0, 40).join(", ")}</tools>`,
  ].join("\n");
}

export function parseReplyVerdict(answer: string): ReplyVerdict | undefined {
  const start = answer.indexOf("{");
  const end = answer.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const v = JSON.parse(answer.slice(start, end + 1)) as { ok?: unknown; issues?: unknown };
    if (v.ok === true) return { ok: true, issues: [] };
    if (v.ok === false && Array.isArray(v.issues))
      return {
        ok: false,
        issues: v.issues
          .filter((x): x is string => typeof x === "string" && !!x.trim())
          .map((x) => x.slice(0, 80))
          .slice(0, 6),
      };
  } catch {
    return undefined;
  }
  return undefined;
}

export function rewritePrompt(
  userText: string,
  reply: string,
  issues: readonly string[],
  mustFollow: readonly string[],
): string {
  return [
    "把下面 <reply> 這則助理回覆改寫一次，修正 <issues> 列出的問題；意思、事實和語氣保持不變，只輸出改寫後的回覆本身。",
    "改寫規則：最多一個問題；不說記憶來源；不提做不到或被拒絕過的事；遵守 <must-follow>。",
    "<user>",
    defuseAlcaTags(userText.slice(0, 1500)),
    "</user>",
    "<reply>",
    defuseAlcaTags(reply.slice(0, 4000)),
    "</reply>",
    "<issues>",
    ...issues.map((x) => `- ${defuseAlcaTags(x)}`),
    "</issues>",
    "<must-follow>",
    ...mustFollow.map((m) => defuseAlcaTags(m)),
    "</must-follow>",
  ].join("\n");
}

export interface ReplyCheckOptions {
  store: Store;
  addons: AddonService;
  complete: AddonCompletion;
  learning: () => Learning | undefined;
  /** Declined offers of the conversation (from the offer ledger). */
  declined?: (threadId: string) => string[];
  /** Tool names the bot's workers can use (what it can offer to do). */
  tools?: () => readonly string[];
  publish?: (d: AgentsEventData<"reply.revised">) => void;
  /** Log a check that kept the original (error, timeout, a rewrite that still fails). */
  log?: (botId: string, note: string) => void;
}

export class ReplyCheck implements TurnObserver {
  private readonly o: ReplyCheckOptions;
  private readonly pending = new Set<Promise<unknown>>();

  constructor(o: ReplyCheckOptions) {
    this.o = o;
  }

  /** Tests and shutdown wait for checks still running. */
  async settle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  after(info: TurnInfo, state: TurnState): void {
    if (info.role === "worker" || info.messageRole !== "user") return;
    if (state.finish?.reason !== "completed") return;
    const reply = state.assistantTexts.join("\n").trim();
    if (!reply) return;
    if (!this.o.addons.allowance(info.botId, REPLY_CHECK_ID).ok) return;
    const p = this.check(info, reply).catch((e) => this.o.log?.(info.botId, `回覆檢查失敗：${String(e)}`));
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
  }

  private spend(botId: string, a: { inputTokens: number; outputTokens: number }): void {
    this.o.addons.charge(botId, REPLY_CHECK_ID, {
      runs: 1,
      inputTokens: a.inputTokens,
      outputTokens: a.outputTokens,
    });
  }

  /** The check for one reply. Returns the verdict and the rewritten text, if any (tests). */
  async check(info: TurnInfo, reply: string): Promise<{ verdict: ReplyVerdict; revised?: string }> {
    const s = this.o.addons.settingsOf<ReplyCheckSettings>(info.botId, REPLY_CHECK_ID);
    const learning = this.o.learning();
    let mustFollow: string[] = [];
    let memories: string[] = [];
    try {
      mustFollow = learning?.mustFollow(info) ?? [];
      memories =
        learning && learning.memoryMode(info.botId) !== "off"
          ? this.o.store.memory
              .search(info.text, { visibleTo: info.botId, any: true, limit: 5 })
              .map((h) => h.body)
          : [];
    } catch {
      // the check runs with what it has
    }
    const prompt = checkPrompt({
      userText: info.text,
      reply,
      mustFollow,
      memories,
      declined: this.o.declined?.(info.threadId) ?? [],
      tools: this.o.tools?.() ?? [],
    });
    let verdict: ReplyVerdict | undefined;
    try {
      const a = await this.o.complete({
        botId: info.botId,
        prompt,
        signal: AbortSignal.timeout(s.timeoutSec * 1000),
        purpose: "reply-check",
      });
      this.spend(info.botId, a);
      verdict = parseReplyVerdict(a.text);
    } catch {
      this.o.log?.(info.botId, "回覆檢查逾時或失敗，照原文送出");
      return { verdict: { ok: true, issues: [] } };
    }
    const issues = [...new Set([...ruleIssues(reply), ...(verdict?.ok === false ? verdict.issues : [])])];
    if (!issues.length) return { verdict: { ok: true, issues: [] } };
    if (!this.o.addons.allowance(info.botId, REPLY_CHECK_ID).ok) return { verdict: { ok: false, issues } };
    let revised: string;
    try {
      const a = await this.o.complete({
        botId: info.botId,
        prompt: rewritePrompt(info.text, reply, issues, mustFollow),
        signal: AbortSignal.timeout(Math.max(s.timeoutSec, 10) * 1000),
        purpose: "reply-rewrite",
      });
      this.spend(info.botId, a);
      revised = a.text.trim();
    } catch {
      this.o.log?.(info.botId, "回覆重寫失敗，照原文送出");
      return { verdict: { ok: false, issues } };
    }
    // Only once: a rewrite that still breaks a plain rule is not used.
    if (!revised || ruleIssues(revised).length) {
      this.o.log?.(info.botId, "重寫後仍有問題，照原文送出");
      return { verdict: { ok: false, issues } };
    }
    const msg = this.o.store.threads
      .messages(info.threadId)
      .filter((m) => m.runId === info.runId && m.role === "assistant")
      .at(-1);
    if (!msg) return { verdict: { ok: false, issues } };
    this.o.store.threads.reviseMessage(msg.id, revised);
    this.o.publish?.({
      botId: info.botId,
      threadId: info.threadId,
      messageId: msg.id,
      text: revised,
      issues: issues.slice(0, 6),
    });
    return { verdict: { ok: false, issues }, revised };
  }
}
