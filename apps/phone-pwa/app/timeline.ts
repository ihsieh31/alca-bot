// Turns protocol events (and stored messages) into chat items. Pure data;
// the views render it. Shared by the main chat and each worker's stream.
import { approvalView, findHost, plainLine } from "./approval-view.ts";
import { parseAppAction } from "./connect-view.ts";
import { t } from "./i18n/index.ts";

export interface Ev {
  type: string;
  runId: string;
  seq: number;
  threadId: string;
  ts: string;
  /** Who acted: `bot_…` for a teammate's message (P7). */
  actor?: { kind: string; id: string };
  data: Record<string, unknown>;
}

export interface StoredMessage {
  id: string;
  runId: string | null;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  botId?: string | null;
}

export type Item =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string; streaming: boolean; botId?: string; edited?: boolean }
  | {
      kind: "report";
      id: string;
      title: string;
      text: string;
      status: string;
      workerId?: string;
      /** A bot-to-bot request or its report (P7). */
      peerId?: string;
    }
  | {
      kind: "tool";
      id: string;
      tool: string;
      label: string;
      state: "running" | "ok" | "fail";
      args?: unknown;
    }
  /** §3.5: what was decided on an approval, one line (已付款 NT$1,280 / 你拒絕了付款). */
  | { kind: "receipt"; id: string; text: string; decision: "approved" | "denied" | "expired"; at: string };

export interface ApprovalCard {
  kind: "approval";
  id: string;
  runId: string;
  callId?: string;
  actionClass: string;
  summary: string;
  detail: string;
  /** The call's arguments, when this phone saw the call start (connector cards read them). */
  args?: Record<string, unknown>;
  botId?: string;
  workerId?: string;
  expiresAt?: string;
  /** P14: the person's standing instructions the worker was given for this kind of action. */
  applied?: string[];
}

export interface QuestionCard {
  kind: "question";
  id: string;
  runId: string;
  prompt: string;
  choices: string[];
}

export type Card = ApprovalCard | QuestionCard;

const botOfEvent = (e: Ev) => (e.actor?.id?.startsWith("bot_") ? e.actor.id : undefined);
const withBot = (botId: string | null | undefined) => (botId ? { botId } : {});

const attr = (head: string, name: string) => new RegExp(`${name}="([^"]*)"`).exec(head)?.[1];
const REPORT_WORD: Record<string, string> = {
  succeeded: t("common.done"),
  failed: t("common.notFinished"),
  stopped: t("common.stopped"),
  needs_review: t("common.needsYourConfirmation"),
};

const TOOL_LABEL: Record<string, string> = {
  browser_open: t("phone.timeline.openAPage"),
  browser_navigate: t("phone.timeline.goToAddress"),
  browser_snapshot: t("phone.timeline.readThePage"),
  browser_click: t("phone.timeline.click"),
  browser_type: t("phone.timeline.typeText"),
  browser_read: t("phone.timeline.readThePage2"),
  worker_start: t("phone.timeline.dispatchAWorker"),
  worker_status: t("phone.timeline.checkWorkers"),
  worker_stop: t("phone.timeline.stopAWorker"),
  recall: t("phone.timeline.recall"),
  hands_run: t("phone.timeline.runOnAHandsDevice"),
  hands_read_file: t("phone.timeline.readARemoteFile"),
  hands_write_file: t("phone.timeline.writeARemoteFile"),
};

// What one of our ids stands for, in words: `spl_…` is a result a worker kept aside.
const ID_NOUN: Record<string, string> = {
  spl: t("phone.timeline.result"),
  wkr: t("phone.timeline.worker"),
  thr: t("phone.timeline.chat"),
  rtn: t("phone.timeline.routine"),
  drf: t("phone.timeline.draft"),
  mem: t("phone.timeline.memory"),
  skl: t("phone.timeline.skill"),
  spc: t("phone.timeline.browsingSpace"),
  tab: t("phone.timeline.tab"),
  bot: t("phone.timeline.bot"),
  acc: t("phone.timeline.account"),
};
const OUR_ID = /^([a-z]{3})_[0-9A-Z]{26}$/;

/** Numbers our ids in the order a conversation first shows them: 「第 2 份結果」, never `spl_01M6…`. */
export class IdNames {
  private named = new Map<string, string>();
  private counts = new Map<string, number>();
  name(id: string): string {
    const known = this.named.get(id);
    if (known) return known;
    const noun = ID_NOUN[OUR_ID.exec(id)?.[1] ?? ""] ?? t("phone.timeline.item");
    const n = (this.counts.get(noun) ?? 0) + 1;
    this.counts.set(noun, n);
    const name = t("phone.timeline.text", { n, noun });
    this.named.set(id, name);
    return name;
  }
}

/** One line for a tool row: the command, path, URL… Our ids read as words; anything else unknown is left out. */
export function argSummary(args: unknown, names: IdNames = new IdNames()): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  for (const k of ["command", "path", "url", "title", "task", "ref", "query", "text", "id", "workerId"]) {
    const v = a[k];
    if (typeof v !== "string" || !v) continue;
    // A browser step's element ref (@8, from the page snapshot) means nothing on its own.
    const ref = k === "ref" ? /^@(\d+)$/.exec(v) : null;
    const shown = ref
      ? t("phone.timeline.elementOnScreen", { p0: ref[1] })
      : OUR_ID.test(v)
        ? names.name(v)
        : v;
    // A paged read (recall with an offset) says where it picks up, so two rows never look identical.
    return typeof a.offset === "number" && a.offset > 0
      ? t("phone.timeline.fromCharacter", { shown, offset: a.offset })
      : shown;
  }
  // Parameters we have no words for stay out of the row (no raw JSON on the phone).
  return "";
}

/**
 * §3.4: a tool row in plain words — 「打開頁面「shop.example.com」」, never the tool id. An
 * address reads as its site; an unknown tool says 「使用工具」.
 */
export function toolLabel(tool: string, args: unknown, names: IdNames = new IdNames()): string {
  const verb = TOOL_LABEL[tool] ?? t("phone.timeline.useATool");
  const raw = argSummary(args, names);
  const site = /^(?:https?|wss?):\/\//i.test(raw) ? findHost(raw) : undefined;
  const what = site ?? plainLine(raw);
  if (!what) return verb;
  return t("phone.timeline.toolOn", { verb, what: what.length > 40 ? `${what.slice(0, 40)}…` : what });
}

/** A router note (worker report / trigger) → one compact row. */
export function reportOf(id: string, text: string): Item {
  const head = text.split("\n")[0] ?? "";
  const inner = text.replace(/^<alca:[a-z-]+[^>]*>\n?/, "").replace(/\n?<\/alca:[a-z-]+>[\s\S]*$/, "");
  const lines = inner
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("相鄰：") && !l.startsWith("全文："));
  const body = lines
    .map((l) =>
      l
        .replace(/^停止原因：watchdog\.[a-z_]+: /, "看門狗停下：")
        .replace(/^停止原因：user$/, "你停下了它。")
        .replace(/^結果摘要（全文 \d+ 字，未放進這裡）：/, ""),
    )
    .join(" ");
  if (head.startsWith("<alca:worker")) {
    // ok="false" on a finished turn: a step failed, so it is not "done" (C2).
    const raw = attr(head, "status") ?? "succeeded";
    const status = raw === "succeeded" && attr(head, "ok") === "false" ? "failed" : raw;
    const wid = attr(head, "id");
    return {
      kind: "report",
      id,
      status,
      // A title that starts with an @name reads as the task, not the address.
      title: t("phone.timeline.worker2", {
        p0: (attr(head, "title") ?? t("common.task")).replace(/^[@＠]\S+\s*/, ""),
        p1: REPORT_WORD[status] ?? status,
      }),
      text: body.length > 140 ? `${body.slice(0, 140)}…` : body,
      ...(wid ? { workerId: wid } : {}),
    };
  }
  if (head.startsWith("<alca:peer-report") || head.startsWith("<alca:peer ")) {
    const report = head.startsWith("<alca:peer-report");
    const status = attr(head, "status") ?? (report ? "done" : "running");
    const who = (report ? attr(head, "bot") : attr(head, "from")) ?? t("common.teammate");
    const rid = attr(head, "id");
    const said = lines.filter((l) => !l.startsWith("原因：")).join(" ");
    return {
      kind: "report",
      id,
      status: status === "done" ? "succeeded" : status === "running" ? "peer" : "failed",
      title: report
        ? t("common.teammate2", {
            who,
            p1: status === "done" ? t("common.replied") : t("common.notFinished"),
          })
        : t("phone.timeline.handedOffBy", {
            who,
            p1: attr(head, "kind") === "ask" ? t("common.question") : t("common.task"),
          }),
      text: said.length > 140 ? `${said.slice(0, 140)}…` : said,
      ...(rid ? { peerId: rid } : {}),
    };
  }
  if (head.startsWith("<alca:trigger"))
    return {
      kind: "report",
      id,
      status: "trigger",
      title: t("common.trigger", { head: attr(head, "name") ?? "" }),
      text: body.slice(0, 140),
    };
  return { kind: "report", id, status: "note", title: t("phone.timeline.system"), text: text.slice(0, 140) };
}

export class Timeline {
  items: Item[] = [];
  cards: Card[] = [];
  busyRunId: string | null = null;
  private index = new Map<string, Item>();
  private seen = new Set<string>();
  private calls = new Map<string, { tool: string; args: unknown }>();
  private names = new IdNames();

  reset(): void {
    this.items = [];
    this.cards = [];
    this.busyRunId = null;
    this.index.clear();
    this.seen.clear();
    this.calls.clear();
  }

  load(messages: StoredMessage[], events: Ev[] = [], extraCards: Ev[] = []): void {
    this.reset();
    for (const m of messages) {
      if (m.role === "user") this.push({ kind: "user", id: m.id, text: m.content });
      else if (m.role === "assistant")
        this.push({ kind: "assistant", id: m.id, text: m.content, streaming: false, ...withBot(m.botId) });
      else if (m.role === "system") this.push(reportOf(m.id, m.content));
    }
    for (const e of [...events, ...extraCards]) this.apply(e);
  }

  /** Apply one event; returns false for duplicates (replays after a reconnect). */
  /** P14 回覆檢查 rewrote a reply: replace its text and mark it 已修改. */
  revise(messageId: string, text: string): boolean {
    const it = this.index.get(messageId);
    if (it?.kind !== "assistant") return false;
    it.text = text;
    it.streaming = false;
    it.edited = true;
    return true;
  }

  apply(e: Ev): boolean {
    const key = `${e.runId}:${e.seq}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    const d = e.data;
    switch (e.type) {
      case "run.started":
        this.busyRunId = e.runId;
        break;
      case "run.finished":
        if (this.busyRunId === e.runId) this.busyRunId = null;
        for (const it of this.items) if (it.kind === "assistant" && it.streaming) it.streaming = false;
        this.cards = this.cards.filter((c) => c.runId !== e.runId);
        break;
      case "message.delta": {
        const id = String(d.messageId);
        const it = this.index.get(id);
        if (it && it.kind === "assistant") it.text += String(d.delta ?? "");
        else
          this.push({
            kind: "assistant",
            id,
            text: String(d.delta ?? ""),
            streaming: true,
            ...withBot(botOfEvent(e)),
          });
        break;
      }
      case "message.completed": {
        const id = String(d.messageId);
        const text = String(d.text ?? "");
        const it = this.index.get(id);
        if (d.role === "user") {
          if (!it) this.push({ kind: "user", id, text });
        } else if (d.role === "system") {
          if (!it) this.push(reportOf(id, text));
        } else if (it && it.kind === "assistant") {
          it.text = text;
          it.streaming = false;
        } else this.push({ kind: "assistant", id, text, streaming: false, ...withBot(botOfEvent(e)) });
        break;
      }
      case "tool.requested": {
        const callId = String(d.callId);
        const tool = String(d.tool);
        this.calls.set(callId, { tool, args: d.args });
        if (tool === "ask_user") break;
        this.push({
          kind: "tool",
          id: `tool:${callId}`,
          tool,
          label: toolLabel(tool, d.args, this.names),
          state: "running",
          ...(d.args !== undefined ? { args: d.args } : {}),
        });
        break;
      }
      case "tool.completed": {
        const it = this.index.get(`tool:${String(d.callId)}`);
        if (it && it.kind === "tool") it.state = d.ok ? "ok" : "fail";
        break;
      }
      case "approval.requested": {
        const id = String(d.approvalId);
        if (this.cards.some((c) => c.id === id)) break;
        const call = typeof d.callId === "string" ? this.calls.get(d.callId) : undefined;
        this.cards.push({
          kind: "approval",
          id,
          runId: e.runId,
          ...(typeof d.callId === "string" ? { callId: d.callId } : {}),
          actionClass: String(d.actionClass),
          summary: String(d.summary ?? ""),
          detail: call ? argSummary(call.args, this.names) : "",
          ...(call?.args && typeof call.args === "object"
            ? { args: call.args as Record<string, unknown> }
            : {}),
          ...(typeof d.botId === "string" ? { botId: d.botId } : {}),
          ...(typeof d.workerId === "string" ? { workerId: d.workerId } : {}),
          ...(typeof d.expiresAt === "string" ? { expiresAt: d.expiresAt } : {}),
          ...(Array.isArray(d.applied) && d.applied.length ? { applied: d.applied.map(String) } : {}),
        });
        break;
      }
      case "approval.resolved": {
        const id = String(d.approvalId);
        const card = this.cards.find((c) => c.id === id);
        this.cards = this.cards.filter((c) => c.id !== id);
        const decision = d.decision === "approved" || d.decision === "denied" ? d.decision : "expired";
        if (card?.kind === "approval") {
          const v = approvalView(card, parseAppAction(card.summary, card.args));
          this.push({ kind: "receipt", id: `receipt:${id}`, text: v.receipt[decision], decision, at: e.ts });
        }
        break;
      }
      case "question.asked":
        if (!this.cards.some((c) => c.id === String(d.questionId)))
          this.cards.push({
            kind: "question",
            id: String(d.questionId),
            runId: e.runId,
            prompt: String(d.prompt ?? ""),
            choices: Array.isArray(d.choices) ? d.choices.map(String) : [],
          });
        break;
      case "question.answered":
        this.cards = this.cards.filter((c) => c.id !== String(d.questionId));
        break;
      default:
        break;
    }
    return true;
  }

  private push(it: Item) {
    if (this.index.has(it.id)) return;
    this.index.set(it.id, it);
    this.items.push(it);
  }
}
