// P13: what the phone keeps for offline use — conversations to read, and
// messages typed while the computer was out of reach — on top of the sealed
// store (cache-crypto.ts). Pure (no DOM): the Session wires it to the Link
// client, the chat draws it.
//
// Outbox rules:
// - Each item gets a random client key when typed; the core runs a send with
//   that key at most once (link_client_ops), so a flush that is retried after
//   a lost answer, a dropped connection or a restarted core never sends twice.
// - Flushed in the order typed, one at a time, when the session is up.
// - The connection going away (closed / timeout / offline) leaves the item
//   queued; a conversation that is still answering (busy) waits and retries;
//   anything else marks the item failed with the core's words — it stays in
//   the queue until the person retries or removes it.
import type { SealedStore } from "./cache-crypto.ts";
import { t as tx } from "./i18n/index.ts";
import type { StoredMessage } from "./timeline.ts";

/** A conversation in the list, as `threads.list` returns it (the Session's ThreadSummary). */
export interface ThreadRow {
  id: string;
  title: string | null;
  updatedAt: string;
}

export interface CachedThread {
  id: string;
  title: string | null;
  messages: StoredMessage[];
  savedAt: number;
}

/** How much one conversation keeps offline, and how many conversations. */
export const CACHE_MESSAGES = 200;
export const CACHE_THREADS = 30;

export class OfflineCache {
  private readonly st: SealedStore;
  constructor(st: SealedStore) {
    this.st = st;
  }

  async saveThreads<T extends ThreadRow>(list: T[]): Promise<void> {
    await this.st.put("threads", list.slice(0, 100));
    // Keep the newest CACHE_THREADS conversations' messages; forget the rest.
    const keep = new Set(list.slice(0, CACHE_THREADS).map((t) => `thread:${t.id}`));
    for (const n of await this.st.names("thread:")) if (!keep.has(n)) await this.st.del(n);
  }

  threads<T extends ThreadRow>(): Promise<T[] | undefined> {
    return this.st.get<T[]>("threads");
  }

  async saveThread(id: string, title: string | null, messages: StoredMessage[]): Promise<void> {
    const cut = messages.filter((m) => m.role !== "tool").slice(-CACHE_MESSAGES);
    await this.st.put(`thread:${id}`, {
      id,
      title,
      messages: cut,
      savedAt: Date.now(),
    } satisfies CachedThread);
  }

  thread(id: string): Promise<CachedThread | undefined> {
    return this.st.get<CachedThread>(`thread:${id}`);
  }

  /**
   * A turn finished in the open conversation: save the computer's copy as it
   * is now (one threads.get), so offline it shows the last answer too.
   * Offline, nothing is asked and the saved copy stays.
   */
  async refresh(
    c: { online(): boolean; request<T>(op: string, args: Record<string, unknown>): Promise<T> },
    id: string,
    title: string | null,
  ): Promise<boolean> {
    if (!c.online()) return false;
    const t = await c
      .request<{ messages: StoredMessage[] }>("threads.get", { threadId: id })
      .catch(() => undefined);
    if (!t) return false;
    await this.saveThread(id, title, t.messages);
    return true;
  }

  saveTeam(team: unknown): Promise<void> {
    return this.st.put("team", team);
  }

  team<T>(): Promise<T | undefined> {
    return this.st.get<T>("team");
  }
}

export type OutboxState = "queued" | "sending" | "waiting" | "failed";

export interface OutboxItem {
  key: string;
  /** null = a new conversation, made when the item is flushed. */
  threadId: string | null;
  botId: string | null;
  /** A new conversation typed offline: every item of the same draft lands in the one thread made for it. */
  draft?: string;
  text: string;
  createdAt: number;
  state: OutboxState;
  error?: string;
  tries: number;
}

/** Errors that mean "the computer did not get it, or we do not know": try again later with the same key. */
const TRANSIENT = new Set(["closed", "timeout", "offline", "relay", "rate_limited"]);

export const newClientKey = (): string => {
  const b = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...b))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
};

export interface FlushApi {
  online(): boolean;
  request<T>(op: string, args: Record<string, unknown>): Promise<T>;
  /** A queued new conversation now exists on the computer. */
  created?(item: OutboxItem, threadId: string): void;
  /** An item reached the computer (or had already, `duplicate`). */
  sent?(item: OutboxItem, r: { runId?: string; duplicate?: boolean }): void;
}

export class Outbox {
  items: OutboxItem[] = [];
  private readonly st: SealedStore | undefined;
  private flushing: Promise<void> | undefined;
  private listeners = new Set<() => void>();
  private waitTimer: ReturnType<typeof setTimeout> | undefined;
  /** Retry delay for a conversation that is still answering. */
  busyRetryMs = 3000;

  constructor(st: SealedStore | undefined) {
    this.st = st;
  }

  async load(): Promise<void> {
    const saved = (await this.st?.get<OutboxItem[]>("outbox")) ?? [];
    // An item that was mid-send when the app closed is queued again (same key: no double send).
    this.items = saved.map((i) =>
      i.state === "sending" || i.state === "waiting" ? { ...i, state: "queued" } : i,
    );
    this.changed();
  }

  onChange(h: () => void): () => void {
    this.listeners.add(h);
    return () => this.listeners.delete(h);
  }

  private changed() {
    for (const h of this.listeners) h();
  }

  private async save() {
    await this.st?.put("outbox", this.items);
    this.changed();
  }

  async add(
    text: string,
    threadId: string | null,
    botId: string | null,
    draft?: string,
  ): Promise<OutboxItem> {
    const item: OutboxItem = {
      key: newClientKey(),
      threadId,
      botId: threadId ? null : botId,
      ...(threadId ? {} : { draft: draft ?? newClientKey() }),
      text,
      createdAt: Date.now(),
      state: "queued",
      tries: 0,
    };
    this.items.push(item);
    await this.save();
    return item;
  }

  /** What to show in a conversation (or in the new-conversation draft). */
  for(threadId: string | null, draft?: string): OutboxItem[] {
    return this.items.filter((i) => (threadId ? i.threadId === threadId : !i.threadId && i.draft === draft));
  }

  // Neither touches an item that is on its way (a sheet opened before it started sending):
  // deleting it would not stop the delivery, re-queuing it would send it twice.
  async retry(key: string): Promise<void> {
    const i = this.items.find((x) => x.key === key);
    if (!i || i.state === "sending") return;
    i.state = "queued";
    delete i.error;
    await this.save();
  }

  async remove(key: string): Promise<void> {
    if (this.items.some((x) => x.key === key && x.state === "sending")) return;
    this.items = this.items.filter((x) => x.key !== key);
    await this.save();
  }

  /** Send what is queued, in order. Concurrent calls share one pass. */
  flush(api: FlushApi): Promise<void> {
    this.flushing ??= this.pass(api).finally(() => {
      this.flushing = undefined;
    });
    return this.flushing;
  }

  private async pass(api: FlushApi): Promise<void> {
    clearTimeout(this.waitTimer);
    for (const item of [...this.items]) {
      if (!this.items.includes(item) || item.state === "failed") continue;
      if (!api.online()) return;
      item.state = "sending";
      item.tries++;
      await this.save();
      try {
        if (!item.threadId) {
          const t = await api.request<{ id: string }>("threads.create", {
            title: item.text.slice(0, 40),
            ...(item.botId ? { botId: item.botId } : {}),
            clientKey: `${item.key}-t`,
          });
          item.threadId = t.id;
          // Later items typed into the same new conversation go there too.
          for (const other of this.items)
            if (other !== item && !other.threadId && other.draft && other.draft === item.draft)
              other.threadId = t.id;
          await this.save();
          api.created?.(item, t.id);
        }
        const r = await api.request<{ runId?: string; duplicate?: boolean }>("threads.send", {
          threadId: item.threadId,
          text: item.text,
          clientKey: item.key,
        });
        this.items = this.items.filter((x) => x !== item);
        await this.save();
        api.sent?.(item, r);
      } catch (e) {
        const code = String((e as { code?: unknown })?.code ?? "");
        if (TRANSIENT.has(code)) {
          item.state = "queued";
          await this.save();
          return; // the session is gone or unsure: the next connection flushes again, same keys
        }
        if (code === "busy") {
          item.state = "waiting";
          await this.save();
          this.waitTimer = setTimeout(() => void this.flush(api), this.busyRetryMs);
          (this.waitTimer as { unref?: () => void }).unref?.();
          return; // keep the order: nothing after it goes first
        }
        item.state = "failed";
        item.error = e instanceof Error ? e.message.slice(0, 200) : tx("common.notSent");
        await this.save();
      }
    }
  }
}
