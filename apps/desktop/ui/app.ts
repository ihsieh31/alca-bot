import { type AlcaEvent, Api, takeToken } from "./api.ts";
import type { Team } from "./api-team.ts";
import {
  applyTheme,
  CLI_SUGGESTIONS,
  DEMO_SUGGESTIONS,
  isMac,
  LEVEL_TEXT,
  mod,
  ROUTER_DEMO_SUGGESTIONS,
  type RunState,
  STATUS_TEXT,
  THEMES,
  type Theme,
} from "./app-chrome.ts";
import { installShortcuts } from "./app-keys.ts";
import { BrowserPanel } from "./browser.ts";
import { ConnectView } from "./connect.ts";
import { $ } from "./dom.ts";
import { applyI18n, applyLocalePref, t as tx } from "./i18n/index.ts";
import { Library } from "./library.ts";
import { setupLinkDialog } from "./link.ts";
import { MentionBox, mentionOf, Roster, targetChip } from "./mention.ts";
import { hashIntents } from "./modal-keys.ts";
import { OfferStrip } from "./offers.ts";
import { Panes } from "./panes.ts";
import { ProvidersView } from "./providers.ts";
import { setupSettingsDialog } from "./settings-view.ts";
import { proposalCard } from "./skill-card.ts";
import { TeamView } from "./team.ts";
import { ThreadList } from "./thread-list.ts";
import { Timeline } from "./timeline.ts";
import { UndoStrip } from "./undo-strip.ts";
import { WorkerPanel } from "./workers.ts";

async function main(): Promise<void> {
  // R9.3: the static text of index.html (data-i18n), in the language this page loaded in.
  applyI18n(document);
  if (!isMac)
    for (const k of document.querySelectorAll("kbd"))
      k.textContent = (k.textContent ?? "").replace("⌘", "Ctrl ");
  // The "⌘ means Ctrl" note only makes sense where keys show as ⌘.
  if (!isMac) document.querySelector(".sheet-note")?.setAttribute("hidden", "");
  let theme = (localStorage.getItem("alca.theme") as Theme | null) ?? "system";
  applyTheme(theme);

  // The desktop shell's alca://pair link opens this window at `#token=…&open=pair` (P8).
  // Read before takeToken() clears the fragment (mac test 2026-11-04b B0: #token=…&open=settings did nothing).
  const intents = hashIntents(location.hash);
  const wantPair = intents.pair;
  const wantProviders = intents.providers;
  const token = takeToken();
  if (!token) {
    $("lock").hidden = false;
    return;
  }
  const api = new Api(token);
  const session = await api.session().catch(() => undefined);
  if (!session) {
    sessionStorage.clear();
    $("lock").hidden = false;
    return;
  }
  // R9.3: the core's interface language (設定); another language than this page's reloads it.
  const prefs = await api
    .call<{ advanced?: { locale?: string } }>("GET", "/api/settings")
    .catch(() => undefined);
  if (prefs && applyLocalePref(prefs.advanced?.locale)) return;
  // S2.2: a window the core opened can approve; say so loudly when its one-time code was already used.
  if ((await api.claim()) === "taken") toast(new Error(tx("desktop.app.thisWindowsLaunchLinkWas")));
  const linkDialogs = setupLinkDialog(api);
  if (wantPair) $("phone-toggle").click();
  // 素 Plain: the engine is not a composer label any more; 設定 › 模型 says which one runs.
  $("engine-label").title =
    session.engine === "claude-code" ? tx("desktop.app.claudeCodeLocal") : tx("desktop.app.demoEngine");
  const sidebarPref = localStorage.getItem("alca.sidebar");
  if (sidebarPref === "hidden") $("app").dataset.sidebar = "hidden";
  const toggleSidebar = () => {
    const app = $("app");
    const hide = app.dataset.sidebar !== "hidden";
    if (hide) app.dataset.sidebar = "hidden";
    else delete app.dataset.sidebar;
    localStorage.setItem("alca.sidebar", hide ? "hidden" : "shown");
  };
  $("sidebar-toggle").addEventListener("click", toggleSidebar);
  $("level-label").textContent = LEVEL_TEXT[session.level] ?? session.level;
  // P13 B3: 設定 (also from #open=settings, for screenshots).
  const settingsDlg = setupSettingsDialog(api, {
    onLevel: (l) => {
      $("level-label").textContent = LEVEL_TEXT[l] ?? l;
    },
    openConnection: () => linkDialogs.connection.open(),
    openTelegram: () => linkDialogs.telegram.open(),
    openPairing: () => $("phone-toggle").click(),
  });
  $("settings-toggle").addEventListener("click", () => void settingsDlg.open());
  $("level-label").addEventListener("click", () => void settingsDlg.open());
  const routed = session.mode === "router";
  const suggestions =
    session.engine === "claude-code"
      ? CLI_SUGGESTIONS
      : routed && session.browser
        ? ROUTER_DEMO_SUGGESTIONS
        : session.browser
          ? [
              ...DEMO_SUGGESTIONS,
              { title: tx("desktop.app.tryTheBrowser"), text: tx("common.checkOutAtTheDemo") },
            ]
          : DEMO_SUGGESTIONS;

  const list = $("thread-list");
  const search = $("thread-search") as HTMLInputElement;
  const input = $("composer-input") as HTMLTextAreaElement;
  const sendBtn = $("send") as HTMLButtonElement;
  const interruptBtn = $("interrupt");
  const statusEl = $("run-status");
  const undo = new UndoStrip(api);
  $("composer").prepend(undo.el);

  const threadList = new ThreadList({
    api,
    el: list,
    search,
    current: () => current,
    open: (id) => void open(id),
    removed: (id) => {
      if (id !== current) return;
      const next = threadList.items[0];
      if (next) void open(next.id);
      else {
        current = null;
        $("thread-title").textContent = tx("common.newChat");
        timeline.reset();
        timeline.showEmpty(suggestions);
      }
    },
    toast,
  });
  let current: string | null = null;
  let runState: RunState = "idle";
  // Cards of workers: they do not hold the composer (the router takes new messages meanwhile).
  const workerCards = new Set<string>();
  let workers: WorkerPanel | undefined;
  let offers: OfferStrip | undefined;
  // ── 團隊 (P7) ──
  let team: TeamView | undefined;
  let teamData: Team | undefined;
  /** Who the next message goes to (null = the thread's own bot). */
  let target: string | null = null;
  /** Peer conversations → the person's conversation they work for (their cards show there). */
  const peerRoots = new Map<string, string>();
  const teamBot = (id: string) =>
    teamData?.bots.find((b) => b.id === id) ?? teamData?.archived.find((b) => b.id === id);

  const timeline = new Timeline(
    $("timeline"),
    {
      approve: (id, decision) => void api.approve(id, decision).catch(toast),
      answer: (id, answer) => void api.answer(id, answer).catch(toast),
      suggest: (text) => {
        input.value = text;
        autosize();
        void submit();
      },
      openWorker: (id) => workers?.show(id),
      workerLabel: (id) => workers?.label(id),
      botOf: (id) => {
        if (!teamData || teamData.bots.length < 2) return undefined;
        const b = teamBot(id);
        return b ? { name: b.name, avatar: b.avatar || b.name.slice(0, 1), color: b.color } : undefined;
      },
      openPeer: (id) => void team?.open("activity", id),
    },
    $("starters"),
  );

  const toggleBtn = $("browser-toggle");
  let browserWasOpen = false;
  const panel = new BrowserPanel($("browser"), api, {
    approve: (id, decision) => void api.approve(id, decision).catch(toast),
    error: (err) => toast(err),
    workerLabel: (id) => workers?.label(id),
    changed: (isOpen, count, attention) => {
      // The browser and the worker panel share the right column.
      if (isOpen && !browserWasOpen && workers?.isOpen) workers.toggle(false);
      browserWasOpen = isOpen;
      $("app").toggleAttribute("data-browser", isOpen);
      toggleBtn.setAttribute("aria-pressed", isOpen ? "true" : "false");
      const c = $("browser-count");
      c.hidden = count === 0;
      c.textContent = String(count);
      toggleBtn.toggleAttribute("data-attention", attention);
    },
  });
  toggleBtn.addEventListener("click", () => panel.toggle());

  const workersBtn = $("workers-toggle");
  if (routed) {
    workers = new WorkerPanel($("workers"), api, {
      approve: (id, decision) => void api.approve(id, decision).catch(toast),
      answer: (id, answer) => void api.answer(id, answer).catch(toast),
      error: (err) => toast(err),
      pending: () => timeline.pendingWorkers(),
      opened: () => {
        if (panel.isOpen) panel.toggle(false);
      },
      changed: (isOpen, live, attention) => {
        $("app").toggleAttribute("data-workers", isOpen);
        workersBtn.setAttribute("aria-pressed", isOpen ? "true" : "false");
        const c = $("workers-count");
        c.hidden = live === 0;
        c.textContent = String(live);
        workersBtn.toggleAttribute("data-attention", attention);
      },
    });
    // P14: 主動留意 cards above the conversation.
    offers = new OfferStrip($("offers"), api, { open: (id) => void open(id), error: (err) => toast(err) });
    void offers.refresh();
    workersBtn.hidden = false;
    workersBtn.addEventListener("click", () => workers?.toggle());
    void api
      .bots()
      .then((b) => workers?.setBots(b))
      .catch(() => undefined);
  }

  // One full-width pane at a time; the chat shows when none is open (mac test: close order).
  const panes = new Panes((on) => {
    $("main").hidden = on;
    $("app").toggleAttribute("data-library", on);
  });
  // ── 記憶與技能 (P5) ──
  const libraryBtn = $("library-toggle");
  const libraryBadge = $("library-badge");
  const library = new Library($("library"), api, {
    changed: (isOpen) => {
      panes.changed("library", isOpen);
      libraryBtn.setAttribute("aria-pressed", isOpen ? "true" : "false");
      if (isOpen) {
        if (panel.isOpen) panel.toggle(false);
        if (workers?.isOpen) workers.toggle(false);
      }
    },
    pending: (n) => {
      libraryBadge.hidden = n === 0;
      libraryBadge.textContent = String(n);
    },
    openThread: (id) => {
      library.close();
      void open(id);
    },
    error: (err) => toast(err),
  });
  const skillActs = {
    approve: (id: string, edit?: { name?: string; triggers?: string[]; steps?: string[] }) =>
      api.approveSkill(id, edit).then(() => library.refreshCounts()),
    reject: (id: string) => api.rejectSkill(id).then(() => library.refreshCounts()),
    open: (id: string) => void library.open("skills", id),
  };
  const shownProposals = new Set<string>();
  const showProposal = (s: Parameters<typeof proposalCard>[0]) => {
    const key = `${s.id}:${s.pending?.version ?? 0}`;
    if (shownProposals.has(key) || !s.pending) return;
    shownProposals.add(key);
    timeline.appendExtra(proposalCard(s, skillActs, true));
  };
  // ── 連接 + 例行工作 (P6) ──
  const connectBtn = $("connect-toggle");
  const routinesBtn = $("routines-toggle");
  const routinesBadge = $("routines-badge");
  const connect = new ConnectView($("connect"), api, {
    changed: (isOpen) => {
      panes.changed("connect", isOpen);
      markConnect();
      if (isOpen) {
        if (panel.isOpen) panel.toggle(false);
        if (workers?.isOpen) workers.toggle(false);
      }
    },
    attention: (n) => {
      routinesBadge.hidden = n === 0;
      routinesBadge.textContent = String(n);
    },
    openThread: (id) => {
      connect.close();
      void open(id);
    },
    sendIn: (id, text) => {
      connect.close();
      void open(id).then(() => api.send(id, text));
    },
    error: (err) => toast(err),
  });
  panes.add("library", library);
  panes.add("connect", connect);
  function markConnect(): void {
    const on = (t: string) => (connect?.isOpen && connect.currentTab === t ? "true" : "false");
    connectBtn.setAttribute("aria-pressed", on("apps"));
    routinesBtn.setAttribute("aria-pressed", on("routines"));
  }
  if (session.connectors) {
    connectBtn.hidden = false;
    routinesBtn.hidden = !(session.mode === "router");
    connectBtn.addEventListener("click", () => connect.toggle("apps"));
    routinesBtn.addEventListener("click", () => connect.toggle("routines"));
    $("connect").addEventListener("click", () => setTimeout(markConnect, 0));
    void connect.counts();
  }
  const teamBtn = $("team-toggle");
  const targetEl = $("target-chip");
  const mentions = new MentionBox(input, document.querySelector(".composer-box") as HTMLElement);
  const roster = new Roster(
    $("team-roster"),
    (id) => setTarget(id),
    () => void team?.open("members"),
  );
  function setTarget(id: string | null): void {
    target = id;
    const b = id ? teamBot(id) : undefined;
    targetChip(targetEl, b, () => setTarget(null));
    if (teamData) roster.render(teamData, target);
    input.placeholder = b
      ? tx("desktop.app.whatWouldYouLikeTo", { name: b.name })
      : tx("desktop.app.whatWouldYouLikeAlca");
    if (id) input.focus();
  }
  team = new TeamView(
    $("team"),
    api,
    {
      changed: (isOpen) => {
        panes.changed("team", isOpen);
        if (isOpen) {
          if (panel.isOpen) panel.toggle(false);
          if (workers?.isOpen) workers.toggle(false);
        }
        teamBtn.setAttribute("aria-pressed", isOpen ? "true" : "false");
      },
      openThread: (id) => {
        team?.close();
        void open(id);
      },
      talkTo: (botId) => {
        team?.close();
        void newThread(botId);
      },
      roster: (t) => {
        const grew = (teamData?.bots.length ?? 1) < 2 && t.bots.length > 1;
        teamData = t;
        if (target && !t.bots.some((b) => b.id === target)) target = null;
        roster.render(t, target);
        mentions.setBots(t.bots);
        const waiting = t.bots.reduce((n, b) => n + b.activity.waiting, 0);
        const badge = $("team-badge");
        badge.hidden = waiting === 0;
        badge.textContent = String(waiting);
        // Bylines appear once there is a second bot: re-render the open chat with them.
        if (grew && current) void open(current);
      },
      error: (err) => toast(err),
    },
    { open: () => void connect.open("apps") },
  );
  panes.add("team", team);
  if (session.team) {
    teamBtn.hidden = false;
    teamBtn.addEventListener("click", () => team?.toggle("members"));
    await team.refresh();
    // ── 模型與供應商 (P11) ──
    const providersBtn = $("providers-toggle");
    const providers = new ProvidersView(api, {
      changed: () => void team?.refresh(),
      error: (err) => toast(err),
    });
    providersBtn.hidden = false;
    providersBtn.addEventListener("click", () => void providers.show());
    team.useProviders(() => void providers.show({}));
    settingsDlg.hooks.openProviders = () => void providers.show();
    if (wantProviders) void providers.show();
  }
  // Opened from the address only now that every hook is set (B4's 「管理供應商」 link was missing).
  if (intents.settings !== null) void settingsDlg.open(intents.settings || undefined);
  if (session.memory) {
    libraryBtn.hidden = false;
    libraryBtn.addEventListener("click", () => library.toggle());
    void api
      .bots()
      .then((b) => library.setBots(b))
      .then(() => library.refreshCounts())
      .catch(() => undefined);
  }

  function toast(err: unknown): void {
    timeline.apply({
      id: `local-${Date.now()}`,
      ts: new Date().toISOString(),
      threadId: current ?? "",
      runId: "local",
      seq: Date.now(),
      type: "error",
      data: { code: "ui", message: String((err as Error)?.message ?? err) },
    });
  }

  function setRunState(s: RunState): void {
    runState = s;
    statusEl.dataset.state = s;
    (statusEl.querySelector("span") as HTMLElement).textContent = STATUS_TEXT[s];
    interruptBtn.hidden = s !== "running"; // §3.1: Stop shows only while a reply streams (Esc still works)
    sendBtn.disabled = s === "running" || s === "waiting";
    undo.setBusy(s === "running" || s === "waiting");
  }

  // 需要你 (§3.2): the first sidebar row, with how many conversations wait on the person.
  const needsBtn = $("needs-you");
  const markNeeds = () => {
    const waiting = threadList.items.filter((t) => t.waiting);
    needsBtn.hidden = waiting.length === 0;
    $("needs-you-count").textContent = String(waiting.length);
  };
  needsBtn.addEventListener("click", () => {
    const next =
      threadList.items.find((t) => t.waiting && t.id !== current) ?? threadList.items.find((t) => t.waiting);
    if (next) void open(next.id);
  });
  const renderThreads = () => {
    threadList.render();
    markNeeds();
  };
  const refreshThreads = () => threadList.refresh().then(markNeeds);

  async function open(id: string): Promise<void> {
    current = id;
    if (library.isOpen) library.close();
    if (connect.isOpen) connect.close();
    if (team?.isOpen) team.close();
    if (target) setTarget(null);
    renderThreads();
    const data = await api.thread(id);
    $("thread-title").textContent = data.thread.title ?? tx("common.newChat");
    panel.setThread(id);
    undo.setThread(id);
    void workers?.setThread(id, data.workers ?? []);
    timeline.reset();
    if (data.messages.length === 0 && data.activeEvents.length === 0) timeline.showEmpty(suggestions);
    timeline.loadHistory(data.messages);
    for (const e of data.activeEvents) timeline.apply(e);
    for (const e of data.workerCards ?? []) {
      if (e.type === "approval.requested") workerCards.add(String(e.data.approvalId));
      timeline.apply(e);
    }
    // B10: a card left open by a worker that has since ended cannot be answered.
    for (const w of data.workers ?? []) timeline.workerUpdated(w);
    shownProposals.clear();
    for (const s of data.skillProposals ?? []) showProposal(s);
    for (const p of data.peers ?? []) if (p.peerThreadId) peerRoots.set(p.peerThreadId, id);
    setRunState(data.thread.waiting ? "waiting" : data.thread.busy ? "running" : "idle");
    input.focus();
  }

  async function newThread(botId?: string): Promise<void> {
    const t = await api.createThread(botId);
    threadList.items.unshift({ ...t, busy: false, waiting: false });
    await open(t.id);
  }

  async function submit(): Promise<void> {
    const text = input.value.trim();
    if (!text || runState === "running" || runState === "waiting") return;
    // An @name at the start, or the roster pick, says who answers (P7).
    const to = target ?? (teamData ? (mentionOf(text, teamData.bots)?.id ?? null) : null);
    let botId: string | undefined = to ?? undefined;
    if (!current) {
      const t = await api.createThread(to ?? undefined);
      threadList.items.unshift({ ...t, busy: false, waiting: false });
      current = t.id;
      timeline.reset();
      undo.setThread(t.id);
      botId = undefined;
    }
    input.value = "";
    autosize();
    setRunState("running");
    try {
      await api.send(current, text, botId);
    } catch (err) {
      setRunState("idle");
      toast(err);
    }
  }

  function autosize(): void {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
  }

  function onEvent(e: AlcaEvent): void {
    panel.onAlcaEvent(e);
    // A teammate working for one of the person's conversations: only its cards show there.
    const root = peerRoots.get(e.threadId);
    if (root) {
      const card =
        e.type.startsWith("approval.") || e.type.startsWith("question.") || e.type === "handoff.requested";
      if (card && root === current) {
        if (e.type === "approval.requested") workerCards.add(String(e.data.approvalId));
        timeline.apply(e);
      }
      if (card) void refreshThreads();
      return;
    }
    const t = threadList.items.find((x) => x.id === e.threadId);
    if (t) {
      if (e.type === "run.started") t.busy = true;
      if (e.type === "approval.requested" || e.type === "question.asked") t.waiting = true;
      if (e.type === "approval.resolved" || e.type === "question.answered") t.waiting = false;
      if (e.type === "run.finished") {
        t.busy = false;
        t.waiting = false;
        t.updatedAt = e.ts;
      }
    }
    const fromWorker =
      (e.type === "approval.requested" && typeof e.data.workerId === "string") ||
      ((e.type === "approval.resolved" || e.type === "approval.requested") &&
        workerCards.has(String(e.data.approvalId))) ||
      e.type === "handoff.requested";
    if (e.type === "approval.requested" && typeof e.data.workerId === "string")
      workerCards.add(String(e.data.approvalId));
    if (e.threadId === current && fromWorker) {
      timeline.apply(e);
    } else if (e.threadId === current) {
      timeline.apply(e);
      if (e.type === "run.started") setRunState("running");
      if (e.type === "approval.requested" || e.type === "question.asked") setRunState("waiting");
      if (e.type === "approval.resolved" || e.type === "question.answered") {
        setRunState(timeline.pendingApproval || timeline.pendingQuestion ? "waiting" : "running");
      }
      if (e.type === "run.finished") setRunState(e.data.reason === "failed" ? "failed" : "idle");
      if (e.type === "message.completed" && e.data.role === "user")
        $("thread-title").textContent = t?.title ?? $("thread-title").textContent;
    }
    if (e.type === "run.started" || e.type === "run.finished") void refreshThreads();
    else if (e.type !== "message.delta") renderThreads();
  }

  // ── wiring ─────────────────────────────────────────────────
  $("composer").addEventListener("submit", (ev) => {
    ev.preventDefault();
    void submit();
  });
  input.addEventListener("input", autosize);
  document.querySelector(".composer-box")?.addEventListener("click", (ev) => {
    if (ev.target === ev.currentTarget) input.focus();
  });
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing && !mod(ev)) {
      ev.preventDefault();
      void submit();
    }
  });
  $("new-thread").addEventListener("click", () => void newThread());
  interruptBtn.addEventListener("click", () => current && void api.interrupt(current));
  $("theme-toggle").addEventListener("click", () => {
    theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length] as Theme;
    localStorage.setItem("alca.theme", theme);
    applyTheme(theme);
  });
  const help = $("help");
  $("help-toggle").addEventListener("click", () => (help.hidden = false));
  help.addEventListener("click", (ev) => {
    if (ev.target === help) help.hidden = true;
  });

  installShortcuts({
    help,
    panes: () => [library, connect, team],
    current: () => current,
    busy: () => runState === "running" || runState === "waiting",
    interrupt: (id) => void api.interrupt(id),
    newThread: () => void newThread(),
    togglePanel: () => {
      if (toggleBtn.hidden) return false;
      panel.toggle();
      return true;
    },
    toggleWorkers: () => {
      if (!workers) return false;
      workers.toggle();
      return true;
    },
    toggleLibrary: () => {
      if (!session.memory) return false;
      library.toggle();
      return true;
    },
    focusSearch: () => search.focus(),
    toggleSidebar,
    openSettings: () => void settingsDlg.open(),
    focusInput: () => input.focus(),
    timeline,
    decide: (id, decision) => void api.approve(id, decision).catch(toast),
    answer: (id, choice) => void api.answer(id, choice).catch(toast),
    step: (by) => {
      const all = threadList.items;
      const i = all.findIndex((t) => t.id === current);
      const next = all[Math.max(0, Math.min(all.length - 1, i + by))];
      if (next) void open(next.id);
    },
  });

  if (session.browser) toggleBtn.hidden = !(await panel.start().catch(() => false));
  await refreshThreads();
  if (threadList.items[0]) await open(threadList.items[0].id);
  else timeline.showEmpty(suggestions);
  let refreshSoon: ReturnType<typeof setTimeout> | undefined;
  api.stream(
    onEvent,
    (live) => document.documentElement.toggleAttribute("data-offline", !live),
    (e) => {
      workers?.onAgentsEvent(e);
      offers?.onAgentsEvent(e);
      if (e.type === "worker.updated" && e.data.worker?.threadId === current)
        timeline.workerUpdated(e.data.worker);
      if (e.type === "reply.revised" && e.data.threadId === current)
        timeline.revise(String(e.data.messageId), String(e.data.text));
      connect.onAgentsEvent(e.type);
      team?.onAgentsEvent(e.type);
      // Next round §3: the hourly audit check failed (once per failure); details live in 設定 → 資料.
      if (e.type === "system.alert") toast(new Error(tx("desktop.app.auditLogVerificationFailedSee")));
      if (e.type === "peer.updated") {
        const d = e.data as { peerThreadId?: string; rootThreadId?: string };
        if (d.peerThreadId && d.rootThreadId) peerRoots.set(d.peerThreadId, d.rootThreadId);
      }
      // Worker counts and "waiting" dots in the sidebar.
      clearTimeout(refreshSoon);
      refreshSoon = setTimeout(() => void refreshThreads(), 250);
    },
    (e) => {
      library.onLearning(e);
      // A skill learned from the thread on screen shows up right there as a card.
      const sk = e.data.skill;
      if (
        (e.type === "skill.proposed" || (e.type === "skill.updated" && e.data.op === "revision")) &&
        sk?.sourceThreadId === current &&
        current
      )
        void api
          .thread(current)
          .then((d) => {
            for (const s of d.skillProposals ?? []) showProposal(s);
          })
          .catch(() => undefined);
    },
  );
}

void main();
