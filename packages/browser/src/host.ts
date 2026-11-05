import {
  type ActorT,
  BrowserChannelEmitter,
  type BrowserEvent,
  type BrowserEventData,
  type BrowserEventType,
  newId,
  type SpaceFrameT,
  type SpaceStateT,
} from "@alca/protocol";
import { CdpSession, CLOSED_EVENT } from "./cdp/connection.ts";
import type { ImportedCookie } from "./cookies/chrome-import.ts";
import { type ChannelEvent, type NetworkConfirm, NetworkGate } from "./network.ts";
import { TabDriver, type UserInput } from "./page.ts";
import { DEFAULT_SENSITIVE_RULES, type SensitiveRule } from "./sensitive.ts";
import {
  type BrowserProcessLike,
  type ControlChange,
  ControlError,
  publicState,
  type SpaceInternal,
  SpaceNotFoundError,
  SpaceOwnershipError,
  type SpaceRecordStore,
  type TabEntry,
} from "./space.ts";

/**
 * The browser host: the only CDP client. It owns one shared Chromium (the
 * profile people also browse with) plus, on demand, isolated contexts or
 * separate isolated profiles. Every Space belongs to one bot, and only that
 * bot's commands touch it; tabs the host did not open for a Space (the
 * person's own browsing) are never touched.
 */

export interface BrowserHostOptions {
  /** Launch the shared browser (lazily, on the first Space). */
  launchShared: () => Promise<BrowserProcessLike>;
  /** Launch a separate browser with its own persisted profile for a Space. */
  launchIsolated?: (spaceId: string) => Promise<BrowserProcessLike>;
  records?: SpaceRecordStore;
  rules?: () => readonly SensitiveRule[];
  now?: () => Date;
  /** Screencast size (CSS px). */
  frameSize?: { width: number; height: number };
  /**
   * Network-layer gate: how a paused sensitive request asks a person (the
   * always-confirm gate). Without it such requests are blocked.
   */
  confirmNetwork?: NetworkConfirm;
  /** R3: a WebSocket tab the gate shut, or WebRTC it refused (the card and the audit row). */
  notifyChannel?: (e: ChannelEvent) => void;
}

export interface OpenSpaceOptions {
  botId: string;
  title: string;
  threadId?: string;
  workerId?: string;
  /** shared (default): same logins as the person's browsing. isolated: own cookie jar. */
  profile?: "shared" | "isolated";
  /** isolated only: keep the profile on disk between runs. */
  persistent?: boolean;
  url?: string;
}

const SYSTEM: ActorT = { kind: "system", id: "browser-host" };

interface WorkerAttached {
  sessionId?: string;
  targetInfo?: { targetId: string; type: string; url?: string; browserContextId?: string };
}

function originOf(url: string | undefined): string | undefined {
  try {
    const o = url ? new URL(url).origin : "null";
    return o === "null" ? undefined : o;
  } catch {
    return undefined;
  }
}

export class BrowserHost {
  readonly o: BrowserHostOptions;
  private shared: BrowserProcessLike | undefined;
  private sharedStarting: Promise<BrowserProcessLike> | undefined;
  private readonly spaces = new Map<string, SpaceInternal>();
  private readonly emitter: BrowserChannelEmitter;
  private readonly listeners = new Set<(e: BrowserEvent) => void>();
  private readonly frameListeners = new Map<string, Set<(f: SpaceFrameT) => void>>();
  private readonly controlListeners = new Set<(c: ControlChange) => void>();
  private readonly pendingUpdate = new Set<string>();
  private readonly adopted = new Set<BrowserProcessLike>();
  /** Network-layer gate over every Space tab (never over the person's own tabs). */
  readonly net: NetworkGate;

  constructor(o: BrowserHostOptions) {
    this.o = o;
    this.emitter = new BrowserChannelEmitter(o.now);
    this.net = new NetworkGate({
      rules: () => this.rules(),
      ...(o.confirmNetwork ? { confirm: o.confirmNetwork } : {}),
      ...(o.now ? { now: () => this.now().getTime() } : {}),
      notify: (e) => this.o.notifyChannel?.(e),
    });
  }

  now(): Date {
    return this.o.now?.() ?? new Date();
  }
  rules(): readonly SensitiveRule[] {
    return this.o.rules?.() ?? DEFAULT_SENSITIVE_RULES;
  }

  // ── events ───────────────────────────────────────────────
  subscribe(fn: (e: BrowserEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  onControlChange(fn: (c: ControlChange) => void): () => void {
    this.controlListeners.add(fn);
    return () => this.controlListeners.delete(fn);
  }
  emit<T extends BrowserEventType>(type: T, data: BrowserEventData<T>): void {
    const e = this.emitter.emit(type, data);
    for (const l of [...this.listeners]) {
      try {
        l(e);
      } catch {
        // a surface bug must not break the host
      }
    }
  }
  /** Coalesce state updates within a tick (title/url/loading churn). */
  changed(spaceId: string): void {
    if (this.pendingUpdate.has(spaceId)) return;
    this.pendingUpdate.add(spaceId);
    queueMicrotask(() => {
      this.pendingUpdate.delete(spaceId);
      const s = this.spaces.get(spaceId);
      if (s && !s.closed) this.emit("space.updated", { space: publicState(s) });
    });
  }

  /** Live frames of a Space's active tab. The screencast runs only while someone watches. */
  watch(spaceId: string, fn: (f: SpaceFrameT) => void): () => void {
    const s = this.get(spaceId);
    let set = this.frameListeners.get(spaceId);
    if (!set) {
      set = new Set();
      this.frameListeners.set(spaceId, set);
    }
    set.add(fn);
    if (set.size === 1) void this.startScreencast(s);
    return () => {
      set.delete(fn);
      if (set.size === 0) {
        this.frameListeners.delete(spaceId);
        const tab = this.activeTab(s);
        if (tab) void tab.driver.stopScreencast();
      }
    };
  }

  private async startScreencast(s: SpaceInternal): Promise<void> {
    const tab = this.activeTab(s);
    if (!tab || !this.frameListeners.get(s.spaceId)?.size) return;
    await tab.driver
      .startScreencast((f) => {
        const set = this.frameListeners.get(s.spaceId);
        if (!set || s.activeTabId !== tab.tabId) return;
        const frame: SpaceFrameT = {
          v: 0,
          type: "space.frame",
          spaceId: s.spaceId,
          botId: s.botId,
          tabId: tab.tabId,
          ...f,
        };
        for (const l of [...set]) l(frame);
      }, this.o.frameSize)
      .catch(() => undefined);
  }

  // ── spaces ───────────────────────────────────────────────
  get(spaceId: string): SpaceInternal {
    const s = this.spaces.get(spaceId);
    if (!s || s.closed) throw new SpaceNotFoundError(spaceId);
    return s;
  }
  /** The Space, checked to belong to `botId`. */
  owned(spaceId: string, botId: string): SpaceInternal {
    const s = this.get(spaceId);
    if (s.botId !== botId) throw new SpaceOwnershipError(spaceId);
    return s;
  }
  state(spaceId: string): SpaceStateT {
    return publicState(this.get(spaceId));
  }
  list(botId?: string): SpaceStateT[] {
    return [...this.spaces.values()]
      .filter((s) => !s.closed && (!botId || s.botId === botId))
      .map(publicState);
  }
  /** The bot's Space for a thread (one task, one Space), if open. */
  /**
   * The bot's open Space for a task: a thread turn's own Space, or (P3) a
   * worker's. Two workers of one bot on one thread never share a Space.
   */
  forThread(botId: string, threadId: string, workerId?: string): SpaceInternal | undefined {
    return [...this.spaces.values()].find(
      (s) =>
        !s.closed &&
        s.botId === botId &&
        s.threadId === threadId &&
        (s.workerId ?? undefined) === (workerId ?? undefined),
    );
  }
  activeTab(s: SpaceInternal): TabEntry | undefined {
    return s.tabs.find((t) => t.tabId === s.activeTabId) ?? s.tabs[0];
  }

  private async sharedBrowser(): Promise<BrowserProcessLike> {
    if (this.shared && !this.shared.cdp.closed) return this.shared;
    this.sharedStarting ??= this.o.launchShared().then((p) => {
      this.shared = p;
      this.sharedStarting = undefined;
      this.adopt(p);
      return p;
    });
    try {
      return await this.sharedStarting;
    } catch (err) {
      this.sharedStarting = undefined;
      throw err;
    }
  }

  /**
   * Follow target lifecycle on a browser: popups join their opener's Space,
   * gone tabs leave. R3: service and shared workers start paused; a Space's
   * are gated like its tabs before they run (or closed when that fails), and
   * everyone else's run untouched.
   */
  private adopt(p: BrowserProcessLike): void {
    if (this.adopted.has(p)) return;
    this.adopted.add(p);
    const { cdp } = p;
    void cdp.send("Target.setDiscoverTargets", { discover: true }).catch(() => undefined);
    cdp.on("Target.attachedToTarget", (e) => void this.onWorker(p, e as WorkerAttached));
    void cdp
      .send("Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
        filter: [{ type: "service_worker" }, { type: "shared_worker" }],
      })
      .catch(() => undefined);
    cdp.on("Target.targetCreated", (e) => {
      const info = e.targetInfo;
      if (info?.type !== "page" || !info.openerId) return;
      const owner = this.findTab(info.openerId);
      if (owner && !this.findTab(info.targetId)) void this.attachTab(owner.space, info.targetId, true);
    });
    cdp.on("Target.targetDestroyed", (e) => {
      const hit = this.findTab(e.targetId);
      if (hit) this.dropTab(hit.space, hit.tab);
    });
    cdp.on("Target.targetInfoChanged", (e) => {
      const hit = this.findTab(e.targetInfo?.targetId);
      if (!hit) return;
      hit.tab.driver.title = String(e.targetInfo.title ?? hit.tab.driver.title);
      hit.tab.driver.url = String(e.targetInfo.url ?? hit.tab.driver.url);
      this.changed(hit.space.spaceId);
    });
    cdp.on(CLOSED_EVENT, () => {
      for (const s of this.spaces.values()) if (s.proc === p && !s.closed) this.markClosed(s);
    });
  }

  private async onWorker(p: BrowserProcessLike, e: WorkerAttached): Promise<void> {
    const info = e.targetInfo;
    if (!e.sessionId || !info || (info.type !== "service_worker" && info.type !== "shared_worker")) return;
    const session = new CdpSession(p.cdp, e.sessionId);
    const space = this.workerSpace(p, info);
    if (!space) {
      await session.send("Runtime.runIfWaitingForDebugger").catch(() => undefined);
      await p.cdp.send("Target.detachFromTarget", { sessionId: e.sessionId }).catch(() => undefined);
      return;
    }
    try {
      await this.net.attach(space, session, info.type);
    } catch {
      // No gate on this worker: it never runs.
      await p.cdp.send("Target.closeTarget", { targetId: info.targetId }).catch(() => undefined);
      return;
    }
    await session.send("Runtime.runIfWaitingForDebugger").catch(() => undefined);
  }

  /**
   * The Space a worker belongs to: the isolated context it runs in, the
   * Space that owns the whole (persistent) browser, or, in the shared
   * profile, a Space with a tab open on the worker's origin. Sharing an
   * origin with a person's tab only ever adds a gate.
   */
  private workerSpace(p: BrowserProcessLike, info: WorkerAttached["targetInfo"]): SpaceInternal | undefined {
    const open = [...this.spaces.values()].filter((s) => !s.closed && s.proc === p);
    if (info?.browserContextId) {
      const hit = open.find((s) => s.browserContextId === info.browserContextId);
      if (hit) return hit;
    }
    const own = open.find((s) => s.ownsProcess);
    if (own) return own;
    const origin = originOf(info?.url);
    if (!origin) return undefined;
    return open.find((s) => !s.browserContextId && s.tabs.some((t) => originOf(t.driver.url) === origin));
  }

  private findTab(targetId: string | undefined): { space: SpaceInternal; tab: TabEntry } | undefined {
    if (!targetId) return undefined;
    for (const space of this.spaces.values()) {
      const tab = space.tabs.find((t) => t.targetId === targetId);
      if (tab) return { space, tab };
    }
    return undefined;
  }

  async open(o: OpenSpaceOptions): Promise<SpaceStateT> {
    const spaceId = newId("space");
    const profile = o.profile ?? "shared";
    const persistent = profile === "isolated" && !!o.persistent;
    let proc: BrowserProcessLike;
    let ownsProcess = false;
    let browserContextId: string | undefined;
    if (persistent) {
      if (!this.o.launchIsolated) throw new Error("這台主機不支援保留登入的隔離 Space");
      proc = await this.o.launchIsolated(spaceId);
      ownsProcess = true;
      this.adopt(proc);
    } else {
      proc = await this.sharedBrowser();
      if (profile === "isolated") {
        const r = await proc.cdp.send("Target.createBrowserContext", { disposeOnDetach: false });
        browserContextId = String(r.browserContextId);
      }
    }
    const s: SpaceInternal = {
      spaceId,
      botId: o.botId,
      ...(o.threadId ? { threadId: o.threadId } : {}),
      ...(o.workerId ? { workerId: o.workerId } : {}),
      title: o.title.trim().slice(0, 60) || "瀏覽器",
      profile,
      persistent,
      controller: "agent",
      status: "idle",
      proc,
      ownsProcess,
      ...(browserContextId ? { browserContextId } : {}),
      tabs: [],
      waiters: [],
      chain: Promise.resolve(),
      recording: [],
      closed: false,
    };
    this.spaces.set(spaceId, s);
    this.o.records?.openSpace(
      {
        id: spaceId,
        botId: s.botId,
        threadId: s.threadId ?? null,
        workerId: s.workerId ?? null,
        title: s.title,
        profile,
        persistent,
      },
      this.now(),
    );
    try {
      await this.newTab(s, o.url);
      if (ownsProcess) await this.closeStrayPages(s);
    } catch (err) {
      await this.close(spaceId).catch(() => undefined);
      throw err;
    }
    return publicState(s);
  }

  /** A separate isolated browser starts with its own blank page; it is not part of the Space. */
  private async closeStrayPages(s: SpaceInternal): Promise<void> {
    const r = await s.proc.cdp.send("Target.getTargets").catch(() => ({ targetInfos: [] }));
    const mine = new Set(s.tabs.map((t) => t.targetId));
    for (const t of r.targetInfos ?? [])
      if (t.type === "page" && !mine.has(t.targetId))
        await s.proc.cdp.send("Target.closeTarget", { targetId: t.targetId }).catch(() => undefined);
  }

  async newTab(s: SpaceInternal, url?: string): Promise<TabEntry> {
    const r = await s.proc.cdp.send("Target.createTarget", {
      url: "about:blank",
      newWindow: s.tabs.length === 0,
      ...(s.browserContextId ? { browserContextId: s.browserContextId } : {}),
    });
    const tab = await this.attachTab(s, String(r.targetId), true);
    if (url) await tab.driver.navigate(url);
    return tab;
  }

  private async attachTab(s: SpaceInternal, targetId: string, activate: boolean): Promise<TabEntry> {
    const a = await s.proc.cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const driver = new TabDriver(s.proc.cdp, targetId, String(a.sessionId));
    const tab: TabEntry = { tabId: newId("tab"), targetId, driver };
    driver.onChange = () => this.changed(s.spaceId);
    driver.onSession = (session, kind) => this.net.attach(s, session, kind, driver.session);
    s.tabs.push(tab);
    await driver.init();
    await driver.refreshTitle();
    if (activate) await this.activate(s, tab.tabId);
    else this.changed(s.spaceId);
    return tab;
  }

  async activate(s: SpaceInternal, tabId: string): Promise<void> {
    const tab = s.tabs.find((t) => t.tabId === tabId);
    if (!tab) throw new Error(`這個 Space 沒有分頁 ${tabId}`);
    const prev = this.activeTab(s);
    s.activeTabId = tabId;
    if (prev && prev !== tab && this.frameListeners.get(s.spaceId)?.size) await prev.driver.stopScreencast();
    await s.proc.cdp.send("Target.activateTarget", { targetId: tab.targetId }).catch(() => undefined);
    await this.startScreencast(s);
    this.changed(s.spaceId);
  }

  async closeTab(s: SpaceInternal, tabId: string): Promise<void> {
    const tab = s.tabs.find((t) => t.tabId === tabId);
    if (!tab) throw new Error(`這個 Space 沒有分頁 ${tabId}`);
    if (s.tabs.length === 1) throw new Error("Space 至少要留一個分頁；要結束請關閉 Space");
    await s.proc.cdp.send("Target.closeTarget", { targetId: tab.targetId }).catch(() => undefined);
    this.dropTab(s, tab);
  }

  private dropTab(s: SpaceInternal, tab: TabEntry): void {
    tab.driver.dispose();
    s.tabs = s.tabs.filter((t) => t !== tab);
    if (s.activeTabId === tab.tabId) {
      const next = s.tabs.at(-1);
      if (next) s.activeTabId = next.tabId;
      else delete s.activeTabId;
      void this.startScreencast(s);
    }
    this.changed(s.spaceId);
  }

  async close(spaceId: string): Promise<void> {
    const s = this.spaces.get(spaceId);
    if (!s || s.closed) return;
    this.markClosed(s);
    for (const t of s.tabs) {
      t.driver.dispose();
      await s.proc.cdp.send("Target.closeTarget", { targetId: t.targetId }).catch(() => undefined);
    }
    if (s.browserContextId)
      await s.proc.cdp
        .send("Target.disposeBrowserContext", { browserContextId: s.browserContextId })
        .catch(() => undefined);
    if (s.ownsProcess) await s.proc.close().catch(() => undefined);
  }

  private markClosed(s: SpaceInternal): void {
    if (s.closed) return;
    s.closed = true;
    this.net.forget(s);
    for (const w of s.waiters.splice(0)) w();
    this.frameListeners.delete(s.spaceId);
    this.o.records?.closeSpace(s.spaceId, this.now());
    this.emit("space.closed", { spaceId: s.spaceId, botId: s.botId });
  }

  async shutdown(): Promise<void> {
    for (const id of [...this.spaces.keys()]) await this.close(id);
    await this.shared?.close().catch(() => undefined);
    this.shared = undefined;
  }

  /**
   * Put cookies (from the opt-in Chrome import) into a Space's own browser.
   * Only a persistent isolated Space takes them: never the shared profile,
   * never a throwaway context, so an import stays inside the one Space the
   * person chose and can be removed by closing and deleting that Space.
   */
  async importCookies(spaceId: string, cookies: readonly ImportedCookie[]): Promise<number> {
    const s = this.get(spaceId);
    if (s.profile !== "isolated" || !s.persistent || !s.ownsProcess)
      throw new ControlError("只能匯入到「隔離並保留登入」的 Space，不會匯入共用的瀏覽器設定檔");
    if (!cookies.length) return 0;
    await s.proc.cdp.send("Storage.setCookies", { cookies: cookies.map((c) => ({ ...c })) });
    for (const t of s.tabs) t.driver.invalidate();
    this.changed(s.spaceId);
    return cookies.length;
  }

  // ── human takeover ───────────────────────────────────────
  /** A person takes the wheel. Agent commands for this Space queue until hand-back. */
  takeOver(spaceId: string, by: ActorT, reason = "使用者接手"): SpaceStateT {
    const s = this.get(spaceId);
    if (s.controller === "user") return publicState(s);
    s.controller = "user";
    s.handoffReason = reason;
    if (s.status === "working") s.status = "queued";
    else if (s.status === "idle") s.status = "waiting_user";
    this.controlChanged(s, by, reason);
    return publicState(s);
  }

  handBack(spaceId: string, by: ActorT, reason = "交還給 Alca"): SpaceStateT {
    const s = this.get(spaceId);
    if (s.controller === "agent") return publicState(s);
    s.controller = "agent";
    delete s.handoffReason;
    s.status = "idle";
    // Whatever the person did, refs from before are not to be trusted.
    for (const t of s.tabs) t.driver.invalidate();
    this.controlChanged(s, by, reason);
    for (const w of s.waiters.splice(0)) w();
    return publicState(s);
  }

  private controlChanged(s: SpaceInternal, by: ActorT, reason: string): void {
    this.emit("space.control", { spaceId: s.spaceId, botId: s.botId, controller: s.controller, by, reason });
    this.changed(s.spaceId);
    const change: ControlChange = { space: publicState(s), controller: s.controller, by, reason };
    for (const l of [...this.controlListeners]) {
      try {
        l(change);
      } catch {
        // ignore
      }
    }
  }

  /** Resolve once the agent may drive the Space (immediately, or after hand-back). */
  async agentTurn(s: SpaceInternal, signal: AbortSignal): Promise<void> {
    while (s.controller === "user") {
      if (s.closed) throw new SpaceNotFoundError(s.spaceId);
      if (signal.aborted) throw new ControlError("已中斷");
      if (s.status !== "queued") {
        s.status = "queued";
        this.changed(s.spaceId);
      }
      await new Promise<void>((resolve) => {
        const done = () => {
          signal.removeEventListener("abort", done);
          resolve();
        };
        s.waiters.push(done);
        signal.addEventListener("abort", done, { once: true });
      });
    }
    if (s.closed) throw new SpaceNotFoundError(s.spaceId);
  }

  /** Captchas and similar checks go to a person automatically. */
  autoHandoff(s: SpaceInternal, reason: string): void {
    if (s.controller === "agent") this.takeOver(s.spaceId, SYSTEM, reason);
  }

  // ── person driving ───────────────────────────────────────
  private personTab(spaceId: string): { s: SpaceInternal; tab: TabEntry } {
    const s = this.get(spaceId);
    if (s.controller !== "user") throw new ControlError("先按「接手」才能直接操作這個 Space");
    const tab = this.activeTab(s);
    if (!tab) throw new ControlError("這個 Space 沒有分頁");
    return { s, tab };
  }

  async userInput(spaceId: string, input: UserInput): Promise<void> {
    await this.personTab(spaceId).tab.driver.userInput(input);
  }

  async userNavigate(spaceId: string, url: string): Promise<void> {
    const { s, tab } = this.personTab(spaceId);
    await tab.driver.navigate(url);
    this.changed(s.spaceId);
  }
}
