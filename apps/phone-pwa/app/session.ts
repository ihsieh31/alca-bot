// The phone's live session with its core: one LinkClient, the app state the
// views read, and the requests they make. Every byte to and from the core
// travels in sealed Link frames; the relay sees only ciphertext.
import {
  type ClientStatus,
  type Identity,
  LinkClient,
  type LinkCredentials,
  w3cRtc,
} from "@alca/link/browser";
import { coreText } from "./i18n/index.ts";
import { kv } from "./keystore.ts";
import type { MemoryItem, MemoryList, SkillView } from "./learn-view.ts";
import { newClientKey } from "./offline.ts";
import { scopesEvent, scopesFrom } from "./scopes.ts";
import { OfflineState } from "./session-offline.ts";
import type { PeerView, TeamBot, TeamView } from "./team-view.ts";
import { type Card, type Ev, type StoredMessage, Timeline } from "./timeline.ts";
import { type WorkerHarness, working } from "./worker-view.ts";

export { working };

const THREAD_PAGE = 50;

export interface ThreadSummary {
  id: string;
  title: string | null;
  updatedAt: string;
  busy: boolean;
  waiting: boolean;
  workers: number;
  /** The bot whose conversation this is (P7). */
  botId?: string;
}

export interface WorkerState {
  workerId: string;
  botId: string;
  threadId: string;
  title: string;
  status: "queued" | "running" | "waiting" | "succeeded" | "failed" | "stopped" | "needs_review";
  steps: number;
  runId?: string;
  createdAt: string;
  finishedAt?: string;
  stopReason?: string;
  result?: { mode: string; summary: string; chars: number };
  startedAt?: string;
  /** Phase 6: the harness part (absent for a plain worker and from older cores). */
  harness?: WorkerHarness;
}

export interface SpaceState {
  spaceId: string;
  botId: string;
  title: string;
  threadId?: string;
  workerId?: string;
  controller: "agent" | "user";
  status: string;
  tabs: Array<{ tabId: string; title: string; url: string; loading: boolean }>;
  activeTabId?: string;
  lastAction?: { label: string; ok: boolean; gated?: string };
  handoffReason?: string;
}

export interface Frame {
  spaceId: string;
  data: string;
  mime: string;
  width: number;
  height: number;
}

export interface DeviceRow {
  id: string;
  name: string;
  kind: "phone" | "hands";
  platform: string;
  scopes: string[];
  createdAt: string;
  lastSeenAt: string | null;
  online: boolean;
  self: boolean;
}

export type { MemoryItem, MemoryList, SkillVersionView, SkillView } from "./learn-view.ts";

export const LIVE = new Set(["queued", "running", "waiting"]);

export class Session {
  readonly client: LinkClient;
  conn: ClientStatus = "idle";
  connWhy: string | undefined;
  threads: ThreadSummary[] = [];
  /** P13: the last page was full, so there may be older conversations. */
  threadsMore = false;
  threadId: string | null = null;
  timeline = new Timeline();
  /** Cards of the thread's workers (they live in the workers' runs). */
  workers: WorkerState[] = [];
  workerTimelines = new Map<string, Timeline>();
  watchedWorker: string | null = null;
  spaces: SpaceState[] = [];
  watchedSpace: string | null = null;
  frame: Frame | undefined;
  devices: DeviceRow[] = [];
  /** Skill proposals that came from the open thread (shown as a bottom sheet). */
  proposals: SkillView[] = [];
  scopes: string[];
  /** The team (P7): roster, rules, who leads. */
  team: TeamView | undefined;
  /** Who a new conversation goes to (picked in the team screen); null = the lead / default. */
  pendingBot: string | null = null;
  private teamTimer: ReturnType<typeof setTimeout> | undefined;
  private listeners = new Set<(what: string) => void>();
  private pending = new Set<string>();
  private flushQueued = false;

  readonly credentials: LinkCredentials;
  /** P13: the encrypted offline cache and the outbox of queued sends. */
  readonly offline: OfflineState;

  constructor(credentials: LinkCredentials, identity: Identity) {
    this.credentials = credentials;
    this.scopes = credentials.scopes;
    this.offline = new OfflineState(this);
    // An https page cannot open ws:// LAN sockets, so only the relay is used here.
    // P13: a direct WebRTC DataChannel when the computer offers one (STUN servers set there); relay otherwise.
    const rtc = w3cRtc();
    this.client = new LinkClient({
      credentials,
      identity,
      preferLan: location.protocol === "http:",
      ...(rtc ? { rtc } : {}),
    });
    // R9.3 batch 5: a core error arrives as its Chinese text; show it in this page's language.
    const request = this.client.request.bind(this.client);
    this.client.request = (async (...a: Parameters<typeof request>) => {
      try {
        return await request(...a);
      } catch (e) {
        if (e instanceof Error) e.message = coreText(e.message);
        throw e;
      }
    }) as typeof request;
    this.client.onStatus((s, why) => {
      this.conn = s;
      this.connWhy = why;
      this.changed("conn");
    });
    this.client.onEvent((ch, e) => this.onEvent(ch, e));
    // A new relay or direct address (P9): keep it, so the next launch finds the computer there.
    this.client.onCredentials((c) => void kv.set("credentials", c));
    this.client.onReady((ready) => {
      const next = scopesFrom(ready.scopes);
      if (next && next.join() !== this.scopes.join()) {
        this.scopes = next;
        this.changed("scopes");
      }
      void kv.set("credentials", this.client.credentials);
      void this.resync();
    });
  }

  get coreName(): string {
    return this.credentials.coreName;
  }

  can(scope: string): boolean {
    return this.scopes.includes(scope);
  }

  start(): void {
    this.client.start();
    // Until the computer answers, show what was saved last time.
    void this.offline.boot();
    // Back from the background (iOS freezes the page; its socket may be dead while it still looks
    // open): check with one quick ping and reconnect at once instead of waiting for the backoff.
    let hiddenAt = 0;
    const wake = () => void this.client.resume();
    document.addEventListener("visibilitychange", () => {
      const visible = document.visibilityState === "visible";
      if (!visible) hiddenAt = Date.now();
      else if (Date.now() - hiddenAt > 2000) wake();
      else this.client.nudge();
      this.presence(visible);
    });
    addEventListener("pageshow", (e) => (e as PageTransitionEvent).persisted && wake());
    document.addEventListener("resume", wake);
    addEventListener("online", wake);
    addEventListener("pagehide", () => this.presence(false));
    this.client.onReady(() => this.presence(document.visibilityState === "visible"));
  }

  /** Tell the core whether the app is in front: then a new card comes over Link, not as a push. */
  presence(visible: boolean): void {
    if (this.conn === "online" || this.client.status === "online")
      void this.client.request("push.presence", { visible }).catch(() => undefined);
  }

  /** Batched change notification (one per animation frame, so streaming stays smooth). */
  subscribe(fn: (what: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  changed(what: string): void {
    this.pending.add(what);
    if (this.flushQueued) return;
    this.flushQueued = true;
    requestAnimationFrame(() => {
      this.flushQueued = false;
      const all = [...this.pending];
      this.pending.clear();
      for (const w of all) for (const l of this.listeners) l(w);
    });
  }

  /** Every card that waits for the person: the thread's own and its workers'. */
  get cards(): Card[] {
    return this.timeline.cards;
  }

  get liveWorkers(): WorkerState[] {
    return this.workers.filter(working);
  }

  private async resync() {
    await this.refreshThreads();
    void this.loadTeam().catch(() => undefined);
    const want = this.threadId ?? (await kv.get<string>("lastThread")) ?? this.threads[0]?.id ?? null;
    if (want && this.threads.some((t) => t.id === want)) await this.openThread(want);
    else await this.openThread(null);
    // P13: what was typed while offline goes out now, in order, once each.
    void this.offline.flush();
    if (this.watchedWorker) await this.watchWorker(this.watchedWorker);
    // Always on the browser channel (Space list + state); frames only for the watched Space.
    if (this.can("view_screen")) await this.watchSpace(this.watchedSpace);
  }

  async refreshThreads(): Promise<void> {
    // Paged (P13): reload as many as were shown, at least one page.
    const limit = Math.min(Math.max(THREAD_PAGE, this.threads.length), 200);
    this.threads = await this.client.request<ThreadSummary[]>("threads.list", { limit });
    this.threadsMore = this.threads.length === limit;
    this.threads.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    this.offline.saveThreads(this.threads);
    this.changed("threads");
  }

  async loadMoreThreads(): Promise<void> {
    const last = this.threads.at(-1);
    if (!last) return this.refreshThreads();
    const page = await this.client.request<ThreadSummary[]>("threads.list", {
      limit: THREAD_PAGE,
      before: `${last.updatedAt}~${last.id}`,
    });
    const seen = new Set(this.threads.map((t) => t.id));
    this.threads.push(...page.filter((t) => !seen.has(t.id)));
    this.threadsMore = page.length === THREAD_PAGE;
    this.changed("threads");
  }

  /**
   * Archive (chat scope) or delete (approve scope) a conversation, then leave it if it was open.
   * R5.4: a delete says whether the memories learned there go too and whether the backups are scrubbed.
   */
  async removeThread(
    id: string,
    how: "archive" | "delete",
    o: { memories?: boolean; backups?: boolean } = {},
  ): Promise<void> {
    if (how === "archive") await this.client.request("threads.archive", { threadId: id });
    else
      await this.client.request("threads.delete", {
        threadId: id,
        memories: o.memories === true,
        ...(typeof o.backups === "boolean" ? { backups: o.backups } : {}),
      });
    this.threads = this.threads.filter((t) => t.id !== id);
    this.offline.saveThreads(this.threads);
    this.changed("threads");
    if (this.threadId === id) await this.openThread(this.threads[0]?.id ?? null);
  }

  async openThread(id: string | null): Promise<void> {
    if (id) this.pendingBot = null;
    this.threadId = id;
    if (id) void kv.set("lastThread", id);
    if (!id) {
      this.timeline.reset();
      this.workers = [];
      this.proposals = [];
      await this.client.request("watch.thread", { threadId: null }).catch(() => undefined);
      this.changed("thread");
      return;
    }
    // P13: offline → the saved copy (read-only until the computer is back).
    if (this.client.status !== "online") {
      if (await this.offline.show(id)) return;
    }
    const t = await this.client.request<{
      messages: StoredMessage[];
      activeEvents: Ev[];
      workers: WorkerState[];
      workerCards: Ev[];
      skillProposals?: SkillView[];
    }>("threads.get", { threadId: id });
    this.timeline.load(t.messages, t.activeEvents, t.workerCards);
    this.offline.fresh();
    this.offline.saveThread(id, this.threads.find((x) => x.id === id)?.title ?? null, t.messages);
    this.workers = t.workers;
    this.proposals = t.skillProposals ?? [];
    this.changed("skills");
    this.changed("thread");
    this.changed("workers");
    await this.client.request("watch.thread", { threadId: id });
  }

  async newThread(botId: string | null = null): Promise<void> {
    this.pendingBot = botId;
    this.offline.draft = newClientKey();
    this.threadId = null;
    this.timeline.reset();
    this.workers = [];
    this.changed("thread");
    this.changed("workers");
  }

  /**
   * P13: every message goes through the outbox — at once when online, later
   * when not — with a client key, so it reaches the computer exactly once.
   */
  async send(text: string): Promise<void> {
    await this.offline.queue(text);
  }

  interrupt(): Promise<unknown> {
    return this.threadId
      ? this.client.request("threads.interrupt", { threadId: this.threadId })
      : Promise.resolve();
  }

  approve(approvalId: string, decision: "approved" | "denied"): Promise<unknown> {
    return this.client.request("approvals.answer", { approvalId, decision });
  }

  answer(questionId: string, answer: string): Promise<unknown> {
    return this.client.request("questions.answer", { questionId, answer });
  }

  async watchWorker(workerId: string | null): Promise<void> {
    this.watchedWorker = workerId;
    if (workerId && !this.workerTimelines.has(workerId)) this.workerTimelines.set(workerId, new Timeline());
    await this.client.request("watch.worker", { workerId });
  }

  stopWorker(workerId: string): Promise<unknown> {
    return this.client.request("workers.stop", { workerId });
  }

  /** Phase 6: answer a worker's NEEDS_INPUT as the person (needs the `approve` scope). */
  answerWorker(workerId: string, answers: string[]): Promise<unknown> {
    return this.client.request("workers.answer", { workerId, answers });
  }

  /** Design §0.2.5: 續做 a task whose step budget ran out (needs the `approve` scope). */
  continueWorker(workerId: string): Promise<unknown> {
    return this.client.request("workers.continue", { workerId });
  }

  async loadSpaces(): Promise<void> {
    if (!this.can("view_screen")) return;
    this.spaces = await this.client.request<SpaceState[]>("browser.spaces").catch(() => []);
    this.changed("spaces");
  }

  async watchSpace(spaceId: string | null): Promise<void> {
    this.watchedSpace = spaceId;
    if (spaceId !== this.frame?.spaceId) this.frame = undefined;
    if (this.can("view_screen")) await this.client.request("watch.browser", { spaceId });
    this.changed("frame");
  }

  takeOver(spaceId: string): Promise<unknown> {
    return this.client.request("browser.takeover", { spaceId });
  }

  handBack(spaceId: string): Promise<unknown> {
    return this.client.request("browser.handback", { spaceId });
  }

  input(spaceId: string, input: Record<string, unknown>): Promise<unknown> {
    return this.client.request("browser.input", { spaceId, input });
  }

  async loadDevices(): Promise<void> {
    this.devices = await this.client.request<DeviceRow[]>("devices.list");
    this.changed("devices");
  }

  async revoke(deviceId: string): Promise<void> {
    await this.client.request("devices.revoke", { deviceId });
    await this.loadDevices().catch(() => undefined);
  }

  // ── team (P7) ─────────────────────────────────────────────

  async loadTeam(): Promise<void> {
    this.team = await this.client.request<TeamView>("team.get");
    this.offline.saveTeam(this.team);
    this.changed("team");
  }

  botOf(botId: string | null | undefined): TeamBot | undefined {
    return botId ? this.team?.bots.find((b) => b.id === botId) : undefined;
  }

  /** The bot this conversation (or the new one) talks to. */
  get threadBot(): TeamBot | undefined {
    const t = this.threads.find((x) => x.id === this.threadId);
    return this.botOf(this.threadId ? t?.botId : this.pendingBot);
  }

  peers(q: { threadId?: string; botId?: string; limit?: number } = {}): Promise<PeerView[]> {
    return this.client.request<PeerView[]>("peers.list", q);
  }

  peer(requestId: string): Promise<PeerView> {
    return this.client.request<PeerView>("peers.get", { requestId });
  }

  stopPeer(requestId: string): Promise<unknown> {
    return this.client.request("peers.stop", { requestId });
  }

  private teamSoon() {
    clearTimeout(this.teamTimer);
    this.teamTimer = setTimeout(() => void this.loadTeam().catch(() => undefined), 250);
  }

  // ── memory + skills (P5) ──────────────────────────────────

  listMemory(q: { q?: string; kind?: string; origin?: string } = {}): Promise<MemoryList> {
    return this.client.request<MemoryList>("memory.list", q);
  }

  updateMemory(memoryId: string, body: string): Promise<{ memory: MemoryItem }> {
    return this.client.request("memory.update", { memoryId, body });
  }

  confirmMemory(memoryId: string): Promise<unknown> {
    return this.client.request("memory.confirm", { memoryId });
  }

  forgetMemory(memoryId: string): Promise<{ forgotten: number }> {
    return this.client.request("memory.forget", { memoryId });
  }

  exportMemory(): Promise<unknown> {
    return this.client.request("memory.export", {});
  }

  async listSkills(): Promise<SkillView[]> {
    const r = await this.client.request<{ items: SkillView[] }>("skills.list", {});
    return r.items;
  }

  async decideSkill(skillId: string, decision: "approve" | "reject", version?: number): Promise<void> {
    await this.client.request(decision === "approve" ? "skills.approve" : "skills.reject", {
      skillId,
      ...(version ? { version } : {}),
    });
    this.proposals = this.proposals.filter((p) => p.id !== skillId);
    this.changed("skills");
  }

  setSkillEnabled(skillId: string, enabled: boolean): Promise<unknown> {
    return this.client.request("skills.enable", { skillId, enabled });
  }

  /** Re-read the proposals of the open thread (after a learning event). */
  private async refreshProposals(): Promise<void> {
    const id = this.threadId;
    if (!id) return;
    const r = await this.client.request<{ items: SkillView[] }>("skills.list", { status: "proposed" });
    if (this.threadId !== id) return;
    this.proposals = r.items.filter((x) => x.source.threadId === id && x.pending && x.status !== "rejected");
    this.changed("skills");
  }

  private onEvent(ch: string, e: unknown) {
    const ev = e as Ev & { data: Record<string, unknown> };
    if (ch === "alca") {
      if (this.threadId && ev.threadId !== this.threadId) {
        // Another thread: only its waiting / busy flags matter here.
        void this.refreshThreads().catch(() => undefined);
        return;
      }
      if (!this.threadId) return;
      if (this.timeline.apply(ev)) {
        this.changed(ev.type.startsWith("approval") || ev.type.startsWith("question") ? "cards" : "thread");
        if (ev.type === "run.finished") {
          void this.offline.flush();
          // P13: the saved copy follows the conversation, so offline it shows the last answer too.
          void this.offline.resave(this.threadId);
        }
        if (ev.type === "run.started" || ev.type === "run.finished") {
          this.changed("busy");
          void this.refreshThreads().catch(() => undefined);
        }
      }
      return;
    }
    if (ch === "agents") {
      const a = e as { type: string; data: { worker?: WorkerState } };
      if (a.type === "team.changed" || a.type === "peer.updated") {
        this.teamSoon();
        this.changed("peers");
        return;
      }
      if (a.type === "routine.checked" || a.type === "draft.ready" || a.type === "connector.changed") {
        this.changed("connectors");
        return;
      }
      if (a.type === "reply.revised") {
        const d = a.data as unknown as { threadId?: string; messageId?: string; text?: string };
        if (
          d.threadId === this.threadId &&
          d.messageId &&
          d.text &&
          this.timeline.revise(d.messageId, d.text)
        )
          this.changed("thread");
        return;
      }
      if (a.type === "worker.updated" && a.data.worker) {
        const w = a.data.worker;
        if (this.threadId && w.threadId !== this.threadId) return;
        const i = this.workers.findIndex((x) => x.workerId === w.workerId);
        if (i >= 0) this.workers[i] = w;
        else this.workers.push(w);
        this.changed("workers");
      }
      return;
    }
    if (ch === "worker") {
      const { workerId, e: inner } = e as { workerId: string; e: Ev };
      const tl = this.workerTimelines.get(workerId) ?? new Timeline();
      this.workerTimelines.set(workerId, tl);
      if (tl.apply(inner)) this.changed("worker");
      return;
    }
    if (ch === "browser") {
      const b = e as { type: string; data: { space?: SpaceState; spaceId?: string } };
      if ((b.type === "space.snapshot" || b.type === "space.updated") && b.data.space) {
        const s = b.data.space;
        const i = this.spaces.findIndex((x) => x.spaceId === s.spaceId);
        if (i >= 0) this.spaces[i] = s;
        else this.spaces.push(s);
      } else if (b.type === "space.closed") {
        this.spaces = this.spaces.filter((x) => x.spaceId !== b.data.spaceId);
      }
      this.changed("spaces");
      return;
    }
    if (ch === "frame") {
      const f = e as Frame;
      if (f.spaceId === this.watchedSpace) {
        this.frame = f;
        this.changed("frame");
      }
      return;
    }
    if (ch === "learning") {
      const l = e as { type: string };
      if (l.type === "memory.changed") this.changed("memory");
      else {
        this.changed("skill-list");
        void this.refreshProposals().catch(() => undefined);
      }
      return;
    }
    if (ch === "link") {
      // BUG-14: the computer changed this phone's scopes while it was connected.
      const next = scopesEvent(ch, e);
      if (next) {
        this.scopes = next;
        this.changed("scopes");
        return;
      }
      void this.loadDevices().catch(() => undefined);
    }
  }
}
