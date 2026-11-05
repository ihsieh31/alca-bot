import type { MemoryApplies, MemoryKind } from "@alca/store";
import { actionRule, parseDue } from "./applies.ts";
import { isMoved, lifeBody, lifeSubject, parseLifeEvent } from "./life.ts";

/**
 * Write path, engine-agnostic. Two parts:
 * - `parseCommands`: what the person asks for outright — 記住… (remember,
 *   confirmed by them) and 忘記… (forget). Handled before the turn so the
 *   reply can say what happened and a forgotten item is not recalled.
 * - `ruleExtract`: first-person statements that are worth keeping
 *   (preferences, people, facts, projects), always marked `inferred` with a
 *   confidence below 1. A model-backed extractor can be plugged in instead
 *   (`Extractor`); the rules need no model and run under `ScriptedEngine`.
 */

export interface Candidate {
  kind: MemoryKind;
  /** Normalized topic key; a later candidate with the same key supersedes the older item. */
  subject: string;
  /** What to remember, about the person, in short neutral words. */
  body: string;
  /** The person's own words it came from. */
  quote: string;
  confidence: number;
  /** "不對／其實／現在改…": the person is correcting an earlier item. */
  correction?: boolean;
  /** P14: action kinds this must be followed for (「寫信不要提到…」 → send_message). */
  appliesTo?: MemoryApplies[];
  /** P14: a deadline the person mentioned (ISO). */
  dueAt?: string;
}

export type MemoryCommand =
  | { kind: "remember"; text: string; quote: string }
  | { kind: "forget"; text: string; quote: string };

export interface ExtractInput {
  userText: string;
  assistantTexts?: readonly string[];
  botId: string;
  threadId: string;
}

/** Pluggable extractor (rules by default; a model-backed one may replace or add to them). */
export interface Extractor {
  readonly id: string;
  extract(input: ExtractInput): Promise<Candidate[]>;
}

const SENTENCE = /[。！？!?\n；;，,]+/u;
const LEAD = /^(?:嗯+|欸|對了|另外|還有|然後|而且|順便說|順帶一提|by the way|btw)[，,\s]*/iu;
const CORRECTION = /^(?:不對|不是啦|更正|修正|其實|現在|我現在|以後|從現在起|改成)[，,\s]*/u;
const TAIL = /(?:了|啦|喔|哦|耶|呢|唷|嘛|的說|而已|哈哈+|～+|~+)+$/u;
const CUT = /[，,、]|但是|但|可是|不過|所以|因為|因此|and |but /u;

function clean(s: string): string {
  let out = s.trim();
  const cut = CUT.exec(out);
  if (cut && cut.index > 0) out = out.slice(0, cut.index);
  return out
    .replace(TAIL, "")
    .replace(/[「」"'“”]/g, "")
    .trim();
}

const isQuestion = (s: string) =>
  /[?？]$|嗎$|是不是|要不要|能不能|可不可以|有沒有|怎麼|為什麼|\bwhat\b|\bhow\b|\bwhy\b/iu.test(s);
const isHypothetical = (s: string) => /如果|假如|要是|假設|\bif\b/iu.test(s);

/** People the person may name: relationship words. */
const RELATION =
  /^(?:媽媽|媽|爸爸|爸|老婆|老公|太太|先生|妻子|丈夫|女友|男友|女朋友|男朋友|另一半|哥哥|姊姊|姐姐|弟弟|妹妹|老闆|主管|上司|同事|朋友|好朋友|室友|小孩|孩子|兒子|女兒|阿公|阿嬤|爺爺|奶奶|外公|外婆|老師|醫生|貓|狗|寵物)$/u;

type Rule = (s: string) => Omit<Candidate, "quote"> | undefined;

const VERBS = "喝|吃|用|穿|聽|看|玩|去|搭|坐|買|讀|住";

const RULES: Rule[] = [
  // P14: a standing instruction about a kind of action (寫信／發文／買／訂…).
  (s) => {
    const r = actionRule(s);
    return r
      ? { kind: "preference", subject: r.subject, body: r.body, confidence: 0.75, appliesTo: r.appliesTo }
      : undefined;
  },
  (s) => {
    const m = new RegExp(`^我?(?:現在)?改(${VERBS})(.{1,40})$`, "u").exec(s);
    if (!m) return;
    const obj = clean(m[2] ?? "");
    return obj
      ? {
          kind: "preference",
          subject: `pref:${m[1]}`,
          body: `現在${m[1]}${obj}`,
          confidence: 0.75,
          correction: true,
        }
      : undefined;
  },
  (s) => {
    const m = /^我(?:真的|其實|一直|超|很|最)?(?:不喜歡|討厭|不吃|不喝|不要|受不了|不太喜歡)(.{1,40})$/u.exec(
      s,
    );
    if (!m) return;
    const obj = clean(m[1] ?? "");
    const verb = /不吃|不喝/.exec(s)?.[0] ?? "不喜歡";
    return obj
      ? { kind: "preference", subject: `dislike:${obj}`, body: `${verb}${obj}`, confidence: 0.7 }
      : undefined;
  },
  (s) => {
    const m = new RegExp(
      `^我(?:現在|平常|平時|通常|比較|最|都|一直|真的)?(?:很|超|蠻|滿|最)?(喜歡|愛|偏好|習慣)(${VERBS})?(.{1,40})$`,
      "u",
    ).exec(s);
    if (!m) return;
    const verb = m[2] ?? "";
    const obj = clean(m[3] ?? "");
    if (!obj || /^(?:你|妳|這樣|那樣|這個|那個)$/u.test(obj)) return;
    return {
      kind: "preference",
      subject: verb ? `pref:${verb}` : `pref:${obj}`,
      body: `${m[1] === "習慣" ? "習慣" : "喜歡"}${verb}${obj}`,
      confidence: 0.7,
    };
  },
  // How the person wants answers (「我希望回答先給結論」, 記住「回答時先給結論」): a preference.
  (s) => {
    const m =
      /^我(?:比較|都|一直)?希望(?:你)?(?:的)?((?:回答|回覆|答案|回應|說明|解釋).{1,40})$/u.exec(s) ??
      /^我(?:以後|之後)?(?:請)?(?:你)?(?:的)?((?:回答|回覆|答案|回應)(?:時|的時候)?[都請要]?.{1,40})$/u.exec(
        s,
      );
    const what = clean(m?.[1] ?? "");
    return what
      ? { kind: "preference", subject: "answer-style", body: `希望${what}`, confidence: 0.7 }
      : undefined;
  },
  (s) => {
    const m = /^我對(.{1,20})過敏$/u.exec(s);
    const what = clean(m?.[1] ?? "");
    return what
      ? { kind: "fact", subject: `allergy:${what}`, body: `對${what}過敏`, confidence: 0.8 }
      : undefined;
  },
  (s) => {
    const m = /^我(?:現在)?住(?:在)?(.{2,30})$/u.exec(s);
    const where = clean(m?.[1] ?? "");
    return where ? { kind: "fact", subject: "home", body: `住在${where}`, confidence: 0.7 } : undefined;
  },
  (s) => {
    const m = /^我(?:現在)?在(.{2,30})(工作|上班|上學|讀書|念書|唸書)$/u.exec(s);
    if (!m) return;
    const where = clean(m[1] ?? "");
    return where ? { kind: "fact", subject: "work", body: `在${where}${m[2]}`, confidence: 0.7 } : undefined;
  },
  (s) => {
    const m = /^(?:以後)?(?:請)?(?:叫我|稱呼我)(.{1,12})$/u.exec(s);
    const name = clean(m?.[1] ?? "");
    return name
      ? { kind: "preference", subject: "call-me", body: `希望被稱呼為「${name}」`, confidence: 0.8 }
      : undefined;
  },
  (s) => {
    const m = /^我的(.{1,10}?)(?:是|叫)(.{1,40})$/u.exec(s);
    if (!m) return;
    const key = clean(m[1] ?? "");
    const value = clean(m[2] ?? "");
    if (!key || !value) return;
    if (RELATION.test(key))
      return { kind: "person", subject: `person:${key}`, body: `${key}：${value}`, confidence: 0.7 };
    return { kind: "fact", subject: `my:${key}`, body: `${key}是${value}`, confidence: 0.65 };
  },
  (s) => {
    const m = /^我(?:們)?(?:正在|最近在|在)(做|寫|開發|準備|規劃|弄)(.{2,40})$/u.exec(s);
    if (!m) return;
    const what = clean(m[2] ?? "");
    if (!what || /^(?:什麼|啥|飯|菜)/u.test(what)) return;
    return { kind: "project", subject: `project:${what}`, body: `正在${m[1]}${what}`, confidence: 0.55 };
  },
  (s) => {
    const m = /^i (?:really )?(?:like|love|prefer)\s+(.{2,60})$/iu.exec(s);
    const obj = clean(m?.[1] ?? "");
    return obj
      ? { kind: "preference", subject: `pref:${obj.toLowerCase()}`, body: `likes ${obj}`, confidence: 0.7 }
      : undefined;
  },
  (s) => {
    const m = /^i(?:'m| am) allergic to\s+(.{2,40})$/iu.exec(s);
    const what = clean(m?.[1] ?? "");
    return what
      ? {
          kind: "fact",
          subject: `allergy:${what.toLowerCase()}`,
          body: `allergic to ${what}`,
          confidence: 0.8,
        }
      : undefined;
  },
  (s) => {
    const m = /^i live in\s+(.{2,40})$/iu.exec(s);
    const where = clean(m?.[1] ?? "");
    return where ? { kind: "fact", subject: "home", body: `lives in ${where}`, confidence: 0.7 } : undefined;
  },
  (s) => {
    const m = /^(?:please )?call me\s+(.{1,20})$/iu.exec(s);
    const name = clean(m?.[1] ?? "");
    return name
      ? { kind: "preference", subject: "call-me", body: `wants to be called "${name}"`, confidence: 0.8 }
      : undefined;
  },
];

function sentences(text: string): string[] {
  // Code and quoted blocks are not about the person.
  const plain = text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`]*`/g, " ");
  return plain
    .split(SENTENCE)
    .map((s) => s.trim().replace(LEAD, "").trim())
    .filter((s) => s.length >= 2 && s.length <= 160);
}

/** Inferred candidates from the person's own words. Never from the assistant's text. */
export function ruleExtract(
  text: string,
  opts: { implicitSelf?: boolean; now?: Date; timeZone?: string } = {},
): Candidate[] {
  const out: Candidate[] = [];
  let carried = false;
  for (const raw of sentences(text)) {
    // "不對，我…": the correction word is its own clause; it applies to the next one.
    if (/^(?:不對|不是|不是啦|更正|修正|錯了)$/u.test(raw)) {
      carried = true;
      continue;
    }
    if (isQuestion(raw) || isHypothetical(raw)) continue;
    const correction = carried || CORRECTION.test(raw);
    carried = false;
    const s = raw.replace(CORRECTION, "").trim();
    // Care moments: a dated life event (exam, trip, interview …) is its own timeline item,
    // with the day resolved now in the person's zone (「後天」 on Mar 10 → 2027-03-12).
    const life = parseLifeEvent(s, opts.now ?? new Date(), opts.timeZone ?? "Asia/Taipei");
    if (life) {
      out.push({
        kind: "fact",
        subject: lifeSubject(life),
        body: lifeBody(life),
        quote: raw,
        confidence: 0.7,
        dueAt: life.at,
        ...(correction || isMoved(s) ? { correction: true } : {}),
      });
      continue;
    }
    let found = false;
    for (const rule of RULES) {
      // Inferred memory needs the person to talk about themselves; a 記住… text may leave the 我 out.
      const self =
        opts.implicitSelf && !/^(?:我|i |please |call |以後|請|叫我|稱呼我|改)/iu.test(s) ? `我${s}` : s;
      const c = rule(self);
      if (c) {
        out.push({ ...c, quote: raw, ...(correction || c.correction ? { correction: true } : {}) });
        found = true;
        break;
      }
    }
    // P14: 「11 月 20 日要交報告」「下週三考試」 — a deadline becomes a project memory with due_at.
    const due = found ? undefined : parseDue(s, opts.now ?? new Date(), opts.timeZone ?? "Asia/Taipei");
    if (due && s.length <= 80)
      out.push({
        kind: "project",
        subject: `due:${s.slice(0, 40)}`,
        body: s.replace(/^我/u, ""),
        quote: raw,
        confidence: 0.6,
        dueAt: due.toISOString(),
      });
  }
  return out;
}

const REMEMBER = /(?:^|[，,。\s])(?:請|幫我|麻煩你?|你要|以後要)?記住(?:一下)?(?:這件事)?[:：，,\s]*(.+)$/u;
const REMEMBER_EN = /^(?:please\s+)?remember(?:\s+that)?[:,\s]+(.+)$/iu;
const FORGET =
  /^(?:請|幫我|麻煩你?)?(?:忘記|忘掉|刪掉|刪除|清掉|不要再記得?|別再記得?)(?:關於|有關)?(?:我)?[:：，,\s]*(.+?)(?:這件事|的事|這個記憶|的記憶|這筆記憶)?$/u;
const FORGET_EN = /^(?:please\s+)?forget(?:\s+(?:that|about))?[:,\s]+(.+)$/iu;

/** Explicit memory commands in a message (at most one of each kind per sentence). */
export function parseCommands(text: string): MemoryCommand[] {
  const out: MemoryCommand[] = [];
  for (const s of text.split(/[。！!\n；;]+/u).map((x) => x.trim().replace(LEAD, "").trim())) {
    if (!s) continue;
    const f = FORGET.exec(s) ?? FORGET_EN.exec(s);
    // "忘記帶傘了怎麼辦" is a question about the person's day, not a command;
    // "刪除購物清單" is a task, unless it says it is about memory.
    const task = /^(?:請|幫我|麻煩你?)?(?:刪掉|刪除|清掉)/u.test(s) && !/記憶|記住|記得/u.test(s);
    if (f?.[1] && !isQuestion(s) && !task) {
      const body = clean(f[1]).replace(/^我/u, "") || f[1].trim();
      out.push({ kind: "forget", text: body.replace(/(?:這個|的)?記憶$/u, "").trim() || body, quote: s });
      continue;
    }
    const r = REMEMBER.exec(s) ?? REMEMBER_EN.exec(s);
    if (r?.[1] && !isQuestion(s))
      out.push({ kind: "remember", text: r[1].trim().replace(TAIL, ""), quote: s });
  }
  return out;
}

/** Turn a "記住…" text into a memory: the rules pick the kind and subject when they can. */
export function candidateFromRemember(
  cmd: { text: string; quote: string },
  opts: { now?: Date; timeZone?: string } = {},
): Candidate {
  // The person's own wording is kept (minus a leading 我); the rules only pick the kind and subject.
  const body =
    cmd.text
      .replace(/^我的/u, "")
      .replace(/^我/u, "")
      .replace(/[。！!]+$/u, "")
      .trim() || cmd.text.trim();
  const ruled = ruleExtract(cmd.text, {
    implicitSelf: true,
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.timeZone ? { timeZone: opts.timeZone } : {}),
  })[0];
  // Care moments: a remembered life event keeps its timeline subject, absolute day and zone.
  if (ruled?.subject.startsWith("life:")) return { ...ruled, quote: cmd.quote, confidence: 1 };
  // P14: a remembered deadline stays the fact it was, and carries its due date.
  if (ruled?.subject.startsWith("due:"))
    return {
      kind: "fact",
      subject: "",
      body: body.slice(0, 400),
      quote: cmd.quote,
      confidence: 1,
      ...(ruled.dueAt ? { dueAt: ruled.dueAt } : {}),
    };
  if (ruled) return { ...ruled, body: body.slice(0, 400), quote: cmd.quote, confidence: 1 };
  return { kind: "fact", subject: "", body: body.slice(0, 400), quote: cmd.quote, confidence: 1 };
}

/** Default extractor: the rules above. */
export class RuleExtractor implements Extractor {
  readonly id = "rules";
  private readonly now: () => Date;
  private readonly timeZone: string;
  constructor(o: { now?: () => Date; timeZone?: string } = {}) {
    this.now = o.now ?? (() => new Date());
    this.timeZone = o.timeZone ?? "Asia/Taipei";
  }
  async extract(input: ExtractInput): Promise<Candidate[]> {
    const spans = parseCommands(input.userText).map((c) => c.quote);
    // Sentences that were commands were handled before the turn.
    let text = input.userText;
    for (const q of spans) text = text.replace(q, " ");
    return ruleExtract(text, { now: this.now(), timeZone: this.timeZone });
  }
}
