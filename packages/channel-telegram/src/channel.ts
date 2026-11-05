// Telegram as a reply channel (P13). The person makes a bot with BotFather,
// gives Alca its token once (kept in the local encrypted vault), and lists the
// private chat ids that may talk to it. The core long-polls getUpdates — no
// webhook, no inbound port — and routes each allowed chat to one thread of
// the chosen Alca bot; the bot's replies go back to that chat.
//
// What Telegram can NOT do: approve. Approval cards (and every always-confirm
// action: payment, send, delete, publish) are answered only on the computer
// or a paired device over Alca Link. Telegram gets a notice that a card is
// waiting — the class only, no details — and a "允許" typed in Telegram is just
// a chat message. Telegram is not end-to-end encrypted for bots: what the bot
// says passes through Telegram's servers, so the notice carries no summary.
import type { AlcaCore } from "@alca/core";
import { ThreadBusyError } from "@alca/core";
import type { SecretStore } from "@alca/os";
import type { AlcaEvent } from "@alca/protocol";
import { TelegramApi, TelegramError, type TgMessage, type TgUpdate } from "./api.ts";
import { loadState, saveState, settingsProblem, type TelegramSettings, type TelegramState } from "./state.ts";

/** What the channel needs from the core (an adapter over AlcaCore below; a fake in tests). */
export interface ChannelHost {
  defaultBotId(): string;
  botExists(botId: string): boolean;
  hasThread(threadId: string): boolean;
  createThread(title: string, botId: string): string;
  isBusy(threadId: string): boolean;
  /** Throws ThreadBusyError when a run is open. */
  send(threadId: string, text: string, chatId: number): void;
  subscribe(threadId: string, fn: (e: AlcaEvent) => void): () => void;
}

export function coreHost(core: AlcaCore): ChannelHost {
  return {
    defaultBotId: () => core.defaultBotId,
    botExists: (id) => !!core.store.bots.get(id),
    hasThread: (id) => !!core.store.threads.get(id),
    createThread: (title, botId) => core.createThread(title, botId).id,
    isBusy: (id) => core.isBusy(id),
    send: (threadId, text, chatId) => {
      core.send(threadId, text, { initiator: { kind: "user", id: `telegram:${chatId}` } });
    },
    subscribe: (id, fn) => core.bus.subscribe(id, fn),
  };
}

/** The vault, as far as Telegram needs it: the one SecretStore interface from @alca/os. */
export type { SecretStore };

export const TOKEN_SECRET = "telegram.botToken";

const CLASS_WORD: Record<string, string> = {
  payment: "付款",
  send: "寄送",
  delete: "刪除",
  publish: "發布",
  write: "寫入",
  execute: "執行",
  network: "連網",
  read: "讀取",
};

export const HELP_TEXT =
  "已連到 Alca。直接傳訊息就好。\n/new 開新對話\n需要你確認的動作（付款、寄送、刪除、發布…）只能在電腦或已配對的手機上按允許，Telegram 不能核准。";

export interface TelegramStatus extends TelegramSettings {
  tokenSet: boolean;
  /** @username of the bot, once the token was checked. */
  botUsername: string | null;
  running: boolean;
  lastError: string | null;
  lastPollAt: string | null;
  unknown: TelegramState["unknown"];
  chats: number;
}

export interface TelegramServiceOptions {
  /** Path of telegram.json (0600). */
  statePath: string;
  secrets: SecretStore;
  host: ChannelHost;
  apiBase?: string;
  fetch?: typeof fetch;
  /** Long-poll hold time; 25 s by default (tests use 1). */
  pollTimeoutSec?: number;
  now?: () => Date;
}

const nameOf = (m: TgMessage) =>
  m.chat.first_name ?? m.chat.username ?? m.from?.first_name ?? String(m.chat.id);

export class TelegramService {
  private readonly o: TelegramServiceOptions;
  private state: TelegramState;
  private api: TelegramApi | undefined;
  private botUsername: string | null = null;
  private loop: Promise<void> | undefined;
  private abort: AbortController | undefined;
  private lastError: string | null = null;
  private lastPollAt: string | null = null;
  private readonly queues = new Map<number, string[]>();
  private readonly unsubs = new Map<string, () => void>();
  private pumpTimer: NodeJS.Timeout | undefined;

  constructor(o: TelegramServiceOptions) {
    this.o = o;
    this.state = loadState(o.statePath);
  }

  private now(): Date {
    return this.o.now?.() ?? new Date();
  }

  private persist(): void {
    saveState(this.o.statePath, this.state);
  }

  async status(): Promise<TelegramStatus> {
    return {
      enabled: this.state.enabled,
      botId: this.state.botId,
      allowChatIds: [...this.state.allowChatIds],
      tokenSet: !!(await this.o.secrets.get(TOKEN_SECRET)),
      botUsername: this.botUsername,
      running: !!this.loop,
      lastError: this.lastError,
      lastPollAt: this.lastPollAt,
      unknown: [...this.state.unknown],
      chats: Object.keys(this.state.chats).length,
    };
  }

  /** Check the token with getMe, then keep it in the vault. A bad token is never stored. */
  async setToken(token: string): Promise<{ username: string | null }> {
    const api = new TelegramApi(token.trim(), this.apiOpts());
    const me = await api.getMe(AbortSignal.timeout(15_000));
    if (!me.is_bot) throw new TelegramError("這個權杖不是 bot 的");
    await this.o.secrets.set(TOKEN_SECRET, token.trim());
    this.botUsername = me.username ?? null;
    await this.restart();
    return { username: this.botUsername };
  }

  async clearToken(): Promise<void> {
    await this.stop();
    await this.o.secrets.delete(TOKEN_SECRET);
    this.botUsername = null;
    this.lastError = null;
  }

  async update(change: Partial<TelegramSettings>): Promise<void> {
    const problem = settingsProblem(change as Record<string, unknown>);
    if (problem) throw new TelegramError(problem);
    if (change.botId && !this.o.host.botExists(change.botId)) throw new TelegramError("沒有這個 bot");
    this.state = {
      ...this.state,
      ...(change.enabled !== undefined ? { enabled: change.enabled } : {}),
      ...(change.botId !== undefined ? { botId: change.botId } : {}),
      ...(change.allowChatIds ? { allowChatIds: [...new Set(change.allowChatIds)] } : {}),
    };
    // A chat that is allowed now is no longer "unknown".
    this.state.unknown = this.state.unknown.filter((u) => !this.state.allowChatIds.includes(u.chatId));
    this.persist();
    await this.restart();
  }

  private apiOpts() {
    return {
      ...(this.o.apiBase ? { base: this.o.apiBase } : {}),
      ...(this.o.fetch ? { fetch: this.o.fetch } : {}),
    };
  }

  /** Start polling when it is on, has a token and somebody is allowed. */
  async start(): Promise<void> {
    if (this.loop || !this.state.enabled || this.state.allowChatIds.length === 0) return;
    const token = await this.o.secrets.get(TOKEN_SECRET);
    if (!token) return;
    try {
      this.api = new TelegramApi(token, this.apiOpts());
    } catch (e) {
      this.lastError = (e as Error).message;
      return;
    }
    for (const [chat, link] of Object.entries(this.state.chats)) this.watch(Number(chat), link.threadId);
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.loop = this.poll(signal).finally(() => {
      this.loop = undefined;
    });
    this.pumpTimer = setInterval(() => this.pumpAll(), 500);
    this.pumpTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.abort?.abort();
    await this.loop?.catch(() => undefined);
    this.loop = undefined;
    clearInterval(this.pumpTimer);
    this.pumpTimer = undefined;
    for (const u of this.unsubs.values()) u();
    this.unsubs.clear();
    this.api = undefined;
  }

  private async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  close(): Promise<void> {
    return this.stop();
  }

  private async poll(signal: AbortSignal): Promise<void> {
    let delay = 1000;
    while (!signal.aborted && this.api) {
      try {
        const updates = await this.api.getUpdates(this.state.offset, this.o.pollTimeoutSec ?? 25, signal);
        this.lastPollAt = this.now().toISOString();
        this.lastError = null;
        delay = 1000;
        for (const u of updates) {
          // The offset moves before handling: one update is never handled twice, even after a crash.
          this.state.offset = Math.max(this.state.offset, u.update_id + 1);
          this.persist();
          await this.handle(u).catch((e: unknown) => {
            this.lastError = e instanceof Error ? e.message : String(e);
          });
        }
      } catch (e) {
        if (signal.aborted) return;
        this.lastError = e instanceof Error ? e.message : String(e);
        if (e instanceof TelegramError && e.fatal) {
          this.lastError = "Telegram 不接受這個權杖（可能被撤銷了）；請重新設定";
          return;
        }
        await sleep(delay, signal);
        delay = Math.min(delay * 2, 60_000);
      }
    }
  }

  private async handle(u: TgUpdate): Promise<void> {
    const m = u.message;
    if (!m || typeof m.text !== "string") return;
    // Private chats only: in a group anyone in it could talk to the person's agent.
    if (m.chat.type !== "private") return;
    if (!this.state.allowChatIds.includes(m.chat.id)) {
      this.remember(m);
      return; // no answer: a stranger learns nothing, not even that this is an Alca bot
    }
    const text = m.text.trim();
    if (!text) return;
    if (text === "/start" || text === "/help") return this.reply(m.chat.id, HELP_TEXT);
    if (text === "/new") {
      this.thread(m, true);
      return this.reply(m.chat.id, "好，開了一個新對話。");
    }
    const threadId = this.thread(m, false);
    const q = this.queues.get(m.chat.id) ?? [];
    q.push(text);
    this.queues.set(m.chat.id, q);
    this.pump(m.chat.id, threadId);
  }

  private remember(m: TgMessage): void {
    const rest = this.state.unknown.filter((x) => x.chatId !== m.chat.id);
    this.state.unknown = [
      { chatId: m.chat.id, name: nameOf(m).slice(0, 64), at: this.now().toISOString() },
      ...rest,
    ].slice(0, 5);
    this.persist();
  }

  /** The chat's thread for the chosen bot (a new one after /new, a bot change, or a deleted thread). */
  private thread(m: TgMessage, fresh: boolean): string {
    const botId =
      this.state.botId && this.o.host.botExists(this.state.botId)
        ? this.state.botId
        : this.o.host.defaultBotId();
    const key = String(m.chat.id);
    const cur = this.state.chats[key];
    if (!fresh && cur && cur.botId === botId && this.o.host.hasThread(cur.threadId)) return cur.threadId;
    if (cur) this.unwatch(cur.threadId);
    const threadId = this.o.host.createThread(`Telegram · ${nameOf(m).slice(0, 32)}`, botId);
    this.state.chats[key] = { threadId, botId };
    this.persist();
    this.watch(m.chat.id, threadId);
    return threadId;
  }

  private watch(chatId: number, threadId: string): void {
    if (this.unsubs.has(threadId) || !this.o.host.hasThread(threadId)) return;
    const unsub = this.o.host.subscribe(threadId, (e) => this.onEvent(chatId, threadId, e));
    this.unsubs.set(threadId, unsub);
  }

  private unwatch(threadId: string): void {
    this.unsubs.get(threadId)?.();
    this.unsubs.delete(threadId);
  }

  private onEvent(chatId: number, threadId: string, e: AlcaEvent): void {
    if (e.type === "message.completed" && e.data.role === "assistant" && e.data.text.trim())
      void this.reply(chatId, e.data.text);
    else if (e.type === "approval.requested")
      void this.reply(
        chatId,
        `有一個「${CLASS_WORD[e.data.actionClass] ?? e.data.actionClass}」動作在等你確認。請在電腦或已配對的手機上看內容並按允許或拒絕；Telegram 不能核准。`,
      );
    else if (e.type === "question.asked")
      void this.reply(chatId, "Alca 有個問題要問你，請在電腦或已配對的手機上回答。");
    else if (e.type === "run.finished") this.pump(chatId, threadId);
  }

  private pumpAll(): void {
    for (const chat of this.queues.keys()) {
      const link = this.state.chats[String(chat)];
      if (link) this.pump(chat, link.threadId);
    }
  }

  /** Hand the next queued message to the core when the thread is free (a run takes one at a time). */
  private pump(chatId: number, threadId: string): void {
    const q = this.queues.get(chatId);
    if (!q?.length || this.o.host.isBusy(threadId)) return;
    const text = q[0] as string;
    try {
      this.o.host.send(threadId, text, chatId);
      q.shift();
      if (!q.length) this.queues.delete(chatId);
    } catch (e) {
      if (e instanceof ThreadBusyError) return; // try again on run.finished / the next tick
      q.shift();
      this.lastError = e instanceof Error ? e.message : String(e);
    }
  }

  private async reply(chatId: number, text: string): Promise<void> {
    try {
      await this.api?.sendMessage(chatId, text);
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}
