// P13: the Session's offline side — the encrypted cache of conversations
// (read while the computer is unreachable) and the outbox of messages typed
// meanwhile (sent, once each, when the session is back).
import { memoryStore, type RecordStore, SealedStore } from "./cache-crypto.ts";
import { hasIndexedDb, idbStore } from "./cache-db.ts";
import { newClientKey, OfflineCache, Outbox, type OutboxItem } from "./offline.ts";
import type { Session, ThreadSummary } from "./session.ts";
import type { TeamView } from "./team-view.ts";
import type { StoredMessage } from "./timeline.ts";

export class OfflineState {
  cache: OfflineCache | undefined;
  outbox = new Outbox(undefined);
  /** The screen shows what was saved, not what the computer has now (and since when). */
  stale = false;
  savedAt = 0;
  /** The new conversation being typed (its queued items share it). */
  draft = newClientKey();
  readonly ready: Promise<void>;
  private store: SealedStore | undefined;
  private readonly s: Session;

  constructor(s: Session, raw?: RecordStore) {
    this.s = s;
    this.ready = this.init(raw).catch(() => undefined);
  }

  private async init(raw?: RecordStore) {
    const base = raw ?? (hasIndexedDb() ? idbStore : memoryStore());
    try {
      this.store = await SealedStore.open(base, this.s.credentials.deviceId);
    } catch {
      // No IndexedDB / WebCrypto here (private mode): keep the outbox in memory for this launch only.
      this.store = await SealedStore.open(memoryStore(), this.s.credentials.deviceId).catch(() => undefined);
    }
    this.cache = this.store ? new OfflineCache(this.store) : undefined;
    this.outbox = new Outbox(this.store);
    this.outbox.onChange(() => this.s.changed("outbox"));
    await this.outbox.load();
  }

  /** Before the first connection: what was saved last time. */
  async boot(): Promise<void> {
    const online = () => this.s.client.status === "online";
    await this.ready;
    if (online() || !this.cache) return;
    const threads = await this.cache.threads<ThreadSummary>();
    if (!threads?.length || online()) return;
    this.s.threads = threads;
    this.stale = true;
    this.s.changed("threads");
    const team = await this.cache.team<TeamView>();
    if (team && !this.s.team) {
      this.s.team = team;
      this.s.changed("team");
    }
    const last = this.s.threadId ?? threads[0]?.id;
    if (last) await this.show(last, online);
  }

  /** Show a saved conversation (offline). False when nothing is saved for it. */
  async show(threadId: string, skipIf?: () => boolean): Promise<boolean> {
    await this.ready;
    const t = await this.cache?.thread(threadId);
    // The computer answered meanwhile: its copy wins.
    if (!t || skipIf?.()) return false;
    this.s.threadId = threadId;
    this.s.timeline.load(t.messages, [], []);
    this.s.workers = [];
    this.stale = true;
    this.savedAt = t.savedAt;
    this.s.changed("thread");
    this.s.changed("stale");
    return true;
  }

  /** Fresh data from the computer: it is what the screen shows now, and what is saved for later. */
  fresh(): void {
    if (this.stale) {
      this.stale = false;
      this.s.changed("stale");
    }
  }

  saveThreads(list: ThreadSummary[]): void {
    void this.cache?.saveThreads(list).catch(() => undefined);
  }

  saveThread(id: string, title: string | null, messages: StoredMessage[]): void {
    void this.cache?.saveThread(id, title, messages).catch(() => undefined);
  }

  /** A turn finished in the open conversation: save the computer's copy as it is now. */
  async resave(threadId: string): Promise<void> {
    const c = this.s.client;
    await this.cache
      ?.refresh(
        { online: () => c.status === "online", request: (op, args) => c.request(op, args) },
        threadId,
        this.s.threads.find((x) => x.id === threadId)?.title ?? null,
      )
      .catch(() => undefined);
  }

  saveTeam(team: TeamView): void {
    void this.cache?.saveTeam(team).catch(() => undefined);
  }

  /** What is waiting to go out in the open conversation (or the new-conversation draft). */
  queued(): OutboxItem[] {
    return this.outbox.for(this.s.threadId, this.draft);
  }

  async queue(text: string): Promise<OutboxItem> {
    await this.ready;
    const item = await this.outbox.add(
      text,
      this.s.threadId,
      this.s.threadId ? null : this.s.pendingBot,
      this.draft,
    );
    void this.flush();
    return item;
  }

  flush(): Promise<void> {
    const s = this.s;
    return this.outbox.flush({
      online: () => s.client.status === "online",
      request: (op, args) => s.client.request(op, args),
      created: (item, threadId) => {
        // Still looking at the draft it came from: follow it into the new conversation.
        if (!s.threadId && item.draft === this.draft) {
          s.pendingBot = null;
          this.draft = newClientKey();
          void s.openThread(threadId).catch(() => undefined);
        }
        void s.refreshThreads().catch(() => undefined);
      },
    });
  }

  async retry(key: string): Promise<void> {
    await this.outbox.retry(key);
    void this.flush();
  }

  remove(key: string): Promise<void> {
    return this.outbox.remove(key);
  }

  /** The computer is forgotten / the phone revoked: nothing readable stays behind. */
  async destroy(): Promise<void> {
    await this.ready;
    await this.store?.destroy();
  }
}
