import { ALWAYS_CONFIRM_ACTIONS } from "@alca/config";
import type { SkillContent, SkillRecord, SkillStep } from "@alca/store";
import { REDACTED, redact, redactValue } from "./redact.ts";
import { contentTokens } from "./tombstone.ts";

/**
 * Learning: playbooks. After a task succeeds, the steps that worked are
 * drafted into a skill (name, triggers, steps); it is saved only when the
 * person approves. A skill is advice for the next worker, never a
 * permission: every step still goes through the gateway, and payment / send
 * / delete / publish are confirmed at run time like any other call.
 */

/** One host tool call a task made, as seen in its run events. */
export interface ObservedCall {
  tool: string;
  args: Record<string, unknown>;
  actionClass: string;
  ok: boolean;
  /** The approval card's text, when the call needed one (says which button, which page). */
  summary?: string;
  /** The tool's own one-line description (e.g. 讀一則筆記), for steps without a template. */
  label?: string;
}

export interface DraftInput {
  title: string;
  goal: string;
  calls: readonly ObservedCall[];
  /** What the person asked in their own words (a worker's goal is the router's rewrite and drops 「每天 09:30」). */
  request?: string;
}

/**
 * Mac test 2026-11-04b A8: 「以後每天 09:30 用瀏覽器打開…」 lost its time — the
 * proposal came from the worker's goal. The time a person asked for, as one
 * phrase (「每天 09:30」, 「每週一 早上9點」, 「每隔 2 小時」), or undefined.
 */
const SCHEDULE =
  /(每(?:天|日|晚|早上?|個?工作日|週[一二三四五六日天]|星期[一二三四五六日天]|個?月\s*\d{1,2}\s*[號号日]|小時|隔?\s*\d+\s*(?:分鐘|小時|天)))\s*((?:早上|上午|中午|下午|晚上)?\s*\d{1,2}(?:[:：]\d{2}|\s*[點点時时](?:半|\d{1,2}\s*分?)?))?/u;

export function scheduleOf(text: string): string | undefined {
  const m = SCHEDULE.exec(text.normalize("NFKC"));
  if (!m) return undefined;
  const when = (m[1] ?? "").replace(/\s+/g, "");
  const time = (m[2] ?? "").replace(/\s+/g, "").replace("：", ":");
  return time ? `${when} ${time}` : when;
}

/** Turns a finished task into a skill draft (deterministic by default; a model can replace it). */
export interface SkillDrafter {
  draft(input: DraftInput): Promise<SkillContent | undefined>;
}

const STEP_TEXT: Record<string, (a: Record<string, unknown>, summary?: string) => string> = {
  browser_open: (a) => `開啟 ${String(a.url ?? "網頁")}`,
  browser_navigate: (a) => `前往 ${String(a.url ?? "網頁")}`,
  browser_snapshot: () => "讀取頁面內容，找到要操作的元素",
  browser_click: (a, s) => (s ? `按下：${s}` : `按下「${String(a.name ?? a.label ?? "目標按鈕")}」`),
  browser_type: (a) => `在「${String(a.name ?? a.label ?? "欄位")}」輸入內容`,
  browser_select: (a) => `選擇「${String(a.value ?? "選項")}」`,
  browser_press: (a) => `按下 ${String(a.key ?? "按鍵")}`,
  browser_scroll: () => "捲動頁面",
  browser_wait: () => "等待頁面載入",
  browser_read: () => "讀取需要的資訊",
  browser_run_script: () => "執行一段瀏覽器步驟腳本",
};

function stepText(c: ObservedCall): string {
  const f = STEP_TEXT[c.tool];
  if (f) return redact(f(c.args, c.summary)).slice(0, 200);
  const values = Object.entries(c.args)
    .filter(([, v]) => typeof v === "string" || typeof v === "number")
    .slice(0, 2);
  if (c.label) {
    const first = values[0]?.[1];
    return redact(`${c.label}${first !== undefined ? `：${String(first).slice(0, 60)}` : ""}`).slice(0, 200);
  }
  const keys = values.map(([k, v]) => `${k}=${String(v).slice(0, 40)}`);
  return redact(`${c.tool}${keys.length ? `（${keys.join("，")}）` : ""}`).slice(0, 200);
}

/** Page refs like @12 are only valid for one snapshot; a playbook keeps the intent, not the ref. */
function generalize(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === "string" && /^@\d+$/.test(v)) continue;
    out[k] = v;
  }
  return redactValue(out);
}

/**
 * Clause breaks: full-width punctuation always; ASCII , ; : only before a
 * space or the end, so `https://example.com`, `10:30` and `a,b` stay whole
 * (mac test 2026-11-04: a trigger came out as 「用瀏覽器打開 https」 and 「//example.com」).
 */
const CLAUSE_BREAK = /[，。；：\n、]+|[,;:]+(?=\s|$)/u;

/** A numbered item: `1)`, `2.`, `3、`, `（4）`. */
const LIST_ITEM = /(?:^|\s)(?:\d{1,2}[).、．]|[（(]\d{1,2}[)）])\s*/u;
/** The second half of a step (「若不存在…」, 「然後…」) is not something a person asks for. */
const FRAGMENT = /^(?:若|如果|否則|不然|然後|接著|再來?|並且?|就|才|以及|或是?|但是?|而且?)/u;

function triggersOf(title: string, goal: string): string[] {
  // A numbered procedure in the goal is how the task was done, not how it is asked for
  // (mac test 2026-11-04: 「1) 先確認檔案存在」 and 「若不存在」 came out as triggers).
  const item = LIST_ITEM.exec(goal);
  const asked = item ? goal.slice(0, item.index) : goal;
  const phrases = [title, ...asked.split(CLAUSE_BREAK)]
    .map((s) =>
      redact(s)
        .replace(/^(?:請|幫我|麻煩|我要|我想)+/u, "")
        .trim(),
    )
    .filter((s) => !FRAGMENT.test(s))
    // A URL counts as one word toward the length cap (a short phrase that names a site stays).
    .filter((s) => {
      const len = s.replace(/\bhttps?:\/\/\S+/gu, "U").length;
      return len >= 2 && len <= 24 && s.length <= 200 && !s.includes(REDACTED);
    });
  return [...new Set(phrases)].slice(0, 4);
}

/** Default drafter: the successful calls in order, consecutive repeats folded. */
export class StepsDrafter implements SkillDrafter {
  readonly minSteps: number;
  constructor(minSteps = 2) {
    this.minSteps = minSteps;
  }
  async draft(i: DraftInput): Promise<SkillContent | undefined> {
    const steps: SkillStep[] = [];
    let prev = "";
    for (const c of i.calls) {
      if (!c.ok) continue;
      const args = generalize(c.args);
      const sig = `${c.tool}:${JSON.stringify(args)}`;
      if (sig === prev) continue;
      prev = sig;
      steps.push({ text: stepText(c), tool: c.tool, args, actionClass: c.actionClass });
    }
    if (steps.length < this.minSteps) return undefined;
    const when = scheduleOf(i.request ?? "") ?? scheduleOf(i.goal);
    const triggers = triggersOf(i.title, i.goal);
    const goal = redact(i.goal).slice(0, 300);
    return {
      name: redact(i.title).slice(0, 40) || "新技能",
      // The time stays with the skill: a trigger, and how to make it run on its own (例行工作).
      description: when
        ? `${goal.slice(0, 300 - 40 - when.length)}（想定時做：${when}。要自動執行，請在「例行工作」建立）`
        : goal,
      triggers: when ? [when, ...triggers.filter((t) => t !== when)].slice(0, 4) : triggers,
      steps: steps.slice(0, 30),
      actionClasses: [...new Set(steps.map((s) => s.actionClass ?? "read"))].sort(),
    };
  }
}

/** The always-confirm classes a skill's steps touch (still confirmed at run time). */
export function confirmClasses(actionClasses: readonly string[]): string[] {
  return actionClasses.filter((c) => (ALWAYS_CONFIRM_ACTIONS as readonly string[]).includes(c));
}

/** Does a message ask for what a skill does? Code only, zero tokens. */
export function skillMatches(text: string, s: Pick<SkillContent, "name" | "triggers">): boolean {
  const msg = text.normalize("NFKC").toLowerCase();
  const toks = new Set(contentTokens(text));
  for (const t of [s.name, ...s.triggers]) {
    const n = t.normalize("NFKC").toLowerCase().trim();
    if (n.length >= 2 && msg.includes(n)) return true;
    const tt = contentTokens(t);
    if (tt.length >= 2 && tt.filter((x) => toks.has(x)).length / tt.length >= 0.6) return true;
  }
  return false;
}

/** Active skills of a bot that fit a message, best first (at most `max`). */
export function matchSkills(text: string, skills: readonly SkillRecord[], max = 3): SkillRecord[] {
  return skills
    .filter((s) => s.status === "active" && s.current && skillMatches(text, s.current))
    .sort((a, b) => b.uses - a.uses)
    .slice(0, max);
}

/** How a worker sees an approved skill (only when the router hands it over). */
export function formatSkillForWorker(s: SkillRecord): string {
  const v = s.current;
  if (!v) return "";
  const confirm = confirmClasses(v.actionClasses);
  return [
    `<alca:skill id="${s.id}" version="${v.version}" name="${v.name.replaceAll('"', "'")}">`,
    "使用者核准過的做法：照著做，畫面和步驟不一樣時以實際情況為準。",
    ...(confirm.length ? [`其中有一律要確認的動作（${confirm.join("、")}），主機仍會先問使用者。`] : []),
    ...v.steps.map((st, i) => `${i + 1}. ${st.text}`),
    "</alca:skill>",
  ].join("\n");
}

/** How the router sees a skill when it loads one. */
export function formatSkillForRouter(s: SkillRecord): string {
  const v = s.current ?? s.pending;
  if (!v) return `技能 ${s.id} 沒有內容`;
  return [
    `<alca:skill id="${s.id}" status="${s.status}" version="${v.version}" uses="${s.uses}">`,
    `名稱：${v.name}`,
    `用途：${v.description}`,
    `觸發：${v.triggers.join("、") || "（無）"}`,
    ...v.steps.map((st, i) => `${i + 1}. ${st.text}`),
    "</alca:skill>",
    s.status === "active"
      ? `要照這個做法派工時，在 worker_start 帶 skillId: "${s.id}"。`
      : "這個技能目前沒有啟用，不要使用。",
  ].join("\n");
}
