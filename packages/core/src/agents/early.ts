import type { Settings } from "@alca/config";
import type { AgentsEventData } from "@alca/protocol";
import type { EarlyWorkRecord, WorkerRecord } from "@alca/store";
import { defuseAlcaTags } from "@alca/tools";
import type { AlcaCore } from "../agent.ts";
import type { TriggerEventInput } from "./triggers.ts";
import type { WorkerSupervisor } from "./workers.ts";

/**
 * 提前做 (plan v4 §4, P13): a bot prepares ahead, in the background, from
 * signals such as a meeting invite or a mail — checks conflicts, gathers
 * what is needed, drafts the reply — and hands the person drafts to approve.
 *
 * - Off by default, per bot (`bots.early_work`); quiet hours (`HH:MM-HH:MM`
 *   in the core's zone) hold items until they end; at most
 *   `engineering.earlyWork.maxPerDay` start per bot in 24 hours (the rest are
 *   skipped, never queued forever) and `maxConcurrent` run at once.
 * - Each item is a speculative worker at the bot's own approval level. Nobody
 *   is there to answer a card, so a call that would need one is denied (the
 *   gateway's `noAsk`): under 逐步確認 it can only read, under 自主 it can also
 *   change things in its folder, and an always-confirm class (pay, send,
 *   delete, publish) is never done in the background.
 * - When it finishes, what it saved with `draft_save` — or else its result as
 *   a note — is a draft (`draft.ready`). The router is not woken. Using a
 *   draft is a new request in the conversation, and sending still asks.
 */

export const EARLY_NO_ASK = "提前做在背景進行，沒有人可以批准；需要使用者決定或對外的事，請寫進草稿。";

export type EarlyPolicy = Settings["engineering"]["earlyWork"];

export interface EarlyDeskOptions {
  core: AlcaCore;
  workers: () => WorkerSupervisor;
  policy: () => EarlyPolicy;
  emit: (d: AgentsEventData<"draft.ready">) => void;
  /** Zone of the quiet hours (default the core's, Asia/Taipei). */
  timeZone?: string;
  now?: () => Date;
}

const DAY_MS = 24 * 3600 * 1000;

/** Minutes since local midnight in a zone. */
function localMinutes(d: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return n("hour") * 60 + n("minute");
}

/** Parse `HH:MM-HH:MM` (may wrap past midnight); undefined = not a valid window. */
export function parseQuietHours(s: string | null | undefined): { from: number; to: number } | undefined {
  const m = /^([0-2]\d):([0-5]\d)-([0-2]\d):([0-5]\d)$/.exec(s ?? "");
  if (!m) return undefined;
  const from = Number(m[1]) * 60 + Number(m[2]);
  const to = Number(m[3]) * 60 + Number(m[4]);
  if (from >= 24 * 60 || to >= 24 * 60 || from === to) return undefined;
  return { from, to };
}

/** When the quiet window `now` is in ends; undefined = not quiet now. */
export function quietUntil(window: string | null | undefined, now: Date, timeZone: string): Date | undefined {
  const w = parseQuietHours(window);
  if (!w) return undefined;
  const cur = localMinutes(now, timeZone);
  const inside = w.from < w.to ? cur >= w.from && cur < w.to : cur >= w.from || cur < w.to;
  if (!inside) return undefined;
  const left = (w.to - cur + 24 * 60) % (24 * 60);
  const end = new Date(now.getTime() + left * 60_000);
  end.setSeconds(0, 0);
  return end;
}

export class EarlyDesk {
  private readonly o: EarlyDeskOptions;
  private readonly now: () => Date;

  constructor(o: EarlyDeskOptions) {
    this.o = o;
    this.now = o.now ?? (() => new Date());
  }

  private get store() {
    return this.o.core.store;
  }

  private get zone(): string {
    return this.o.timeZone ?? "Asia/Taipei";
  }

  /** Queue something to prepare ahead (same bot + ref twice = the first one). Starts it when it may. */
  offer(i: {
    botId: string;
    threadId: string;
    source: EarlyWorkRecord["source"];
    refId?: string;
    title: string;
    goal: string;
  }): EarlyWorkRecord {
    const { item } = this.store.early.offer({ ...i, now: this.now() });
    this.tick();
    return this.store.early.get(item.id) as EarlyWorkRecord;
  }

  /** A trigger event the bot should prepare for instead of waking its router. */
  fromTrigger(
    t: { botId: string; threadId: string; name: string; source: string },
    eventId: string,
    ev: TriggerEventInput,
  ) {
    const text = defuseAlcaTags(ev.text.slice(0, 4000));
    return this.offer({
      botId: t.botId,
      threadId: t.threadId,
      source: "trigger",
      refId: eventId,
      title: (ev.text.split("\n")[0] ?? t.name).slice(0, 80) || t.name,
      goal: [
        "有一個新的事件。請先在背景替使用者準備好：查相關資料、檢查行程有沒有衝突、需要回覆就用 draft_save 擬好草稿。",
        "不要寄出、發布、付款或刪除任何東西；需要使用者決定的事寫進結果。",
        `<alca:event source="${t.source}"${ev.from ? ` from="${defuseAlcaTags(ev.from).replaceAll('"', "'")}"` : ""} trust="untrusted">`,
        text,
        "</alca:event>",
      ].join("\n"),
    });
  }

  /** The reason an early-work worker's cards are denials; undefined = not early work. */
  background(workerId: string): string | undefined {
    try {
      return this.store.early.byWorker(workerId) ? EARLY_NO_ASK : undefined;
    } catch {
      return undefined;
    }
  }

  /** Start what may start now: the bot's switch, quiet hours, the daily cap, capacity. */
  tick(): void {
    const now = this.now();
    const p = this.o.policy();
    for (const item of this.store.early.queued()) {
      const bot = this.store.bots.get(item.botId);
      if (!bot || bot.archivedAt) {
        this.store.early.finish(item.id, "skipped", { detail: "這個 bot 已經封存", now });
        continue;
      }
      if (bot.earlyWork !== "on") {
        this.store.early.finish(item.id, "skipped", { detail: "這個 bot 沒有開啟提前做", now });
        continue;
      }
      if (item.notBefore && new Date(item.notBefore) > now) continue;
      const until = quietUntil(bot.quietHours, now, this.zone);
      if (until) {
        this.store.early.defer(item.id, until, `安靜時段，${bot.quietHours?.slice(6)} 之後開始`, now);
        continue;
      }
      if (this.store.early.startedSince(item.botId, new Date(now.getTime() - DAY_MS)) >= p.maxPerDay) {
        this.store.early.finish(item.id, "skipped", {
          detail: `今天的提前做已達上限（${p.maxPerDay}）`,
          now,
        });
        continue;
      }
      if (this.store.early.running(item.botId).length >= p.maxConcurrent) continue;
      let w: WorkerRecord;
      try {
        w = this.o.workers().start({
          botId: item.botId,
          threadId: item.threadId,
          title: `提前準備：${item.title}`.slice(0, 80),
          goal: item.goal,
          initiator: { kind: "agent", id: item.botId },
          speculative: true,
          // Plan §5: 提前做 is a general-harness worker; nobody can approve (the gateway's noAsk).
          grants: { harness: "general" },
        });
      } catch (err) {
        this.store.early.finish(item.id, "failed", {
          detail: String((err as Error)?.message ?? err).slice(0, 300),
          now,
        });
        continue;
      }
      if (!this.store.early.started(item.id, w.id, now)) void this.o.workers().stop(w.id, "early.duplicate");
    }
  }

  /** A worker finished: if it was early work, turn it into drafts (and keep the router out of it). */
  workerFinished(w: WorkerRecord): boolean {
    const item = this.store.early.byWorker(w.id);
    if (!item) return false;
    const now = this.now();
    if (w.status !== "succeeded") {
      this.store.early.finish(item.id, "failed", { detail: w.stopReason ?? w.status, now });
      this.tick();
      return true;
    }
    let drafts = this.store.routines.drafts({ workerId: w.id, status: "ready" });
    if (!drafts.length) {
      const full = w.result?.spillId ? this.store.workers.spill(w.result.spillId)?.body : undefined;
      const body = (full ?? w.result?.summary ?? "").trim();
      drafts = body
        ? [
            this.store.routines.addDraft({
              botId: w.botId,
              threadId: w.threadId,
              workerId: w.id,
              kind: "note",
              title: item.title,
              body,
            }),
          ]
        : [];
    }
    this.store.early.finish(item.id, drafts.length ? "ready" : "failed", {
      draftIds: drafts.map((d) => d.id),
      detail: drafts.length ? "" : "沒有準備出東西",
      now,
    });
    for (const d of drafts)
      this.o.emit({ draftId: d.id, botId: d.botId, threadId: d.threadId, title: d.title, kind: d.kind });
    this.tick();
    return true;
  }
}
