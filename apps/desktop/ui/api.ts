// Thin client for the loopback API. The token comes from the URL fragment
// once, then lives in sessionStorage; it is sent as a bearer header.

import { coreText, t } from "./i18n/index.ts";
import type { RestoreResult, Snapshot } from "./snapshot-view.ts";
import type { WorkerHarness } from "./worker-view.ts";

/** The core's error answer: the text, and (R9.3 batch 5) its key and params. */
type ErrorAnswer = { error?: string; code?: string; params?: Record<string, string> };

export interface Thread {
  id: string;
  title: string | null;
  /** The bot the thread belongs to (P7). */
  botId?: string | null;
  createdAt: string;
  updatedAt: string;
  busy: boolean;
  waiting: boolean;
  /** Unfinished workers of the thread (router mode). */
  workers?: number;
}

export type WorkerStatus =
  | "queued"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "stopped"
  | "needs_review";

/** A worker as the agents channel describes it (never its text). */
export interface Worker {
  workerId: string;
  botId: string;
  threadId: string;
  title: string;
  status: WorkerStatus;
  speculative: boolean;
  runId?: string;
  parentRunId?: string;
  steps: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  lastActivityAt?: string;
  stopReason?: string;
  result?: { mode: "inline" | "spill"; summary: string; chars: number; spillId?: string };
  subscriptions: string[];
  /** Phase 6: the harness part (absent for a plain worker and from older cores). */
  harness?: WorkerHarness;
}

/** Agents channel event (worker.updated / trigger.fired / watchdog.flagged). */
export interface AgentsEvent {
  type: string;
  data: Record<string, unknown> & { worker?: Worker };
}

/** One remembered item (P5), as the memory API shows it. */
export interface MemoryItem {
  id: string;
  botId: string;
  botName: string;
  scope: "shared" | "bot";
  kind: "fact" | "preference" | "person" | "project";
  body: string;
  quote: string | null;
  origin: "user" | "inferred";
  confidence: number;
  status: "active" | "superseded";
  source: {
    kind: string;
    threadId: string | null;
    threadTitle: string | null;
    messageId: string | null;
    workerId: string | null;
    workerTitle: string | null;
  };
  edited: boolean;
  versions: number;
  uses: number;
  lastUsedAt: string | null;
  confirmedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryList {
  botId: string;
  items: MemoryItem[];
  counts: Record<string, number>;
  forgotten: number;
}

export interface SkillVersionView {
  version: number;
  name: string;
  description: string;
  triggers: string[];
  steps: Array<{ text: string; tool?: string; actionClass?: string }>;
  actionClasses: string[];
  alwaysConfirm: string[];
  state: "proposed" | "approved" | "rejected";
  author: "agent" | "user";
  note: string | null;
  createdAt: string;
}

/** A skill (playbook): saved only after the person approves it. */
export interface Skill {
  id: string;
  botId: string;
  botName: string;
  status: "proposed" | "active" | "disabled" | "rejected";
  version: number;
  current: SkillVersionView | null;
  pending: SkillVersionView | null;
  history: Array<{ version: number; state: string; author: string; createdAt: string; note: string | null }>;
  uses: number;
  lastUsedAt: string | null;
  source: { threadId: string | null; threadTitle: string | null; workerId: string | null };
  createdAt: string;
  updatedAt: string;
}

/** Learning channel event (memory.changed / skill.proposed / skill.updated): ids and names, never memory text. */
export interface LearningEvent {
  type: string;
  data: Record<string, unknown> & { skill?: { skillId: string; sourceThreadId?: string; botId: string } };
}

export interface Message {
  id: string;
  threadId: string;
  runId: string | null;
  /** Which bot spoke (P7). */
  botId?: string | null;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  createdAt: string;
}

/** Alca Event Protocol event, as much of it as the UI reads. */
export interface AlcaEvent {
  id: string;
  ts: string;
  threadId: string;
  runId: string;
  seq: number;
  type: string;
  data: Record<string, unknown>;
  /** Who emitted it (a bot, a worker, the person, the system). */
  actor?: { kind: string; id: string };
}

export interface BrowserTab {
  tabId: string;
  title: string;
  url: string;
  loading: boolean;
}

export interface Space {
  spaceId: string;
  botId: string;
  title: string;
  threadId?: string;
  workerId?: string;
  profile: "shared" | "isolated";
  persistent: boolean;
  controller: "agent" | "user";
  status: "idle" | "working" | "queued" | "waiting_user";
  tabs: BrowserTab[];
  activeTabId?: string;
  lastAction?: { kind: string; label: string; ok: boolean; at: string };
  handoffReason?: string;
}

export interface Bot {
  id: string;
  name: string;
  isDefault: boolean;
}

/** Browser channel event (space.updated / space.closed / space.control / space.action / space.snapshot). */
/** First-run Chromium download progress (`browser.install`). */
export interface BrowserInstall {
  phase: "idle" | "checking" | "downloading" | "verifying" | "extracting" | "ready" | "failed";
  version?: string;
  platform?: string;
  received?: number;
  total?: number;
  entries?: number;
  entriesTotal?: number;
  error?: string;
  /** The app downloads by itself (no button needed). */
  auto?: boolean;
}

export interface BrowserEvent {
  type: string;
  data: Record<string, unknown> & { space?: Space; spaceId?: string };
}

export interface Frame {
  spaceId: string;
  tabId: string;
  mime: string;
  data: string;
  width: number;
  height: number;
}

export type UserInput =
  | { type: "click"; x: number; y: number }
  | { type: "wheel"; x: number; y: number; dy: number }
  | { type: "text"; text: string }
  | { type: "key"; key: string }
  | { type: "shortcut"; action: "selectAll" | "copy" | "cut" | "undo" | "redo" };

const KEY = "alca.token";

/**
 * Review 2026-11-04b S2.2: approving needs the core's in-memory approve key.
 * A window the core opened carries a one-time launch code (`ui=`) in its
 * fragment; it is traded once for the key, which stays in this page's memory
 * only (not sessionStorage: that is on disk for session restore).
 */
let launchCode: string | null = null;

/** Requests the core refuses without the approve key (apps/desktop/src/ui-session.ts). */
const NEEDS_KEY: ReadonlyArray<[string, RegExp]> = [
  ["POST", /^\/api\/approvals\/[^/]+$/],
  ["POST", /^\/api\/link\/pairings$/],
  ["POST", /^\/api\/link\/enrollments\/[^/]+$/],
  ["POST", /^\/api\/link\/devices\/[^/]+\/scopes$/],
  ["POST", /^\/api\/workers\/[^/]+\/answer$/],
  // Design §0.2.5: 續做 spends another step budget; the person's own act.
  ["POST", /^\/api\/workers\/[^/]+\/continue$/],
  // Design §0.2.7: keeping or removing a website password is the person's own act.
  ["POST", /^\/api\/connectors\/logins$/],
  ["DELETE", /^\/api\/connectors\/logins\/[^/]+$/],
  ["POST", /^\/api\/import$/],
  ["POST", /^\/api\/settings\/encryption\/drop-plaintext-backups$/],
  // Next round R8: adding or changing an MCP server (a program that runs / an endpoint it calls) widens what Alca does.
  ["PUT", /^\/api\/connectors\/mcp\/[^/]+$/],
];

export const NO_KEY_MESSAGE = t("desktop.api.forSafetyThisWindowCant");

export function takeToken(): string | null {
  const u = /(?:^|[#&])ui=([0-9a-f]{32,})/.exec(location.hash);
  if (u?.[1]) launchCode = u[1];
  const m = /(?:^|[#&])token=([0-9a-f]{32,})/.exec(location.hash);
  if (m?.[1]) {
    sessionStorage.setItem(KEY, m[1]);
    history.replaceState(null, "", location.pathname);
  }
  return sessionStorage.getItem(KEY);
}

export class Api {
  private readonly token: string;
  private approveKey: string | null = null;
  constructor(token: string) {
    this.token = token;
  }

  /** Trade this window's launch code for the approve key: ok, none (no code), or taken (used / expired). */
  async claim(): Promise<"ok" | "none" | "taken"> {
    const code = launchCode;
    launchCode = null;
    if (!code) return "none";
    try {
      this.approveKey = (
        await this.call<{ approveKey: string }>("POST", "/api/ui/session", { code })
      ).approveKey;
      return "ok";
    } catch {
      return "taken";
    }
  }

  get canApprove(): boolean {
    return this.approveKey !== null;
  }

  /** Ask the core to open a window that can approve (this one cannot). */
  openApprovingWindow(open?: string) {
    return this.call<{ opened: boolean }>("POST", "/api/ui/open", open ? { open } : {});
  }

  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.approveKey && NEEDS_KEY.some(([m, re]) => m === method && re.test(path))) {
      await this.openApprovingWindow(/\/api\/link\//.test(path) ? "pair" : undefined).catch(() => undefined);
      throw new Error(NO_KEY_MESSAGE);
    }
    const res = await fetch(path, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(this.approveKey ? { "x-alca-approve": this.approveKey } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = (await res.json().catch(() => ({}))) as T & ErrorAnswer;
    if (!res.ok) throw new Error(data.error ? coreText(data) : `HTTP ${res.status}`);
    return data;
  }

  /** A POST whose answer is a file (R5.6 匯出): the bytes and the name the core gave it. */
  async download(path: string, body: unknown): Promise<{ blob: Blob; name: string }> {
    const res = await fetch(path, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as ErrorAnswer;
      throw new Error(data.error ? coreText(data) : `HTTP ${res.status}`);
    }
    const name =
      /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "alca.alca-export";
    return { blob: await res.blob(), name };
  }

  session() {
    return this.call<{
      engine: string;
      level: string;
      capabilities: Record<string, unknown>;
      browser?: boolean;
      bot?: Bot;
      mode?: "router" | "direct";
      memory?: boolean;
      connectors?: boolean;
      team?: boolean;
    }>("GET", "/api/session");
  }
  threads() {
    return this.call<Thread[]>("GET", "/api/threads");
  }
  createThread(botId?: string) {
    return this.call<Thread & { botId?: string | null }>("POST", "/api/threads", botId ? { botId } : {});
  }
  thread(id: string) {
    return this.call<{
      thread: Thread;
      messages: Message[];
      activeRunId: string | null;
      activeEvents: AlcaEvent[];
      workers?: Worker[];
      workerCards?: AlcaEvent[];
      skillProposals?: Skill[];
      peers?: Array<{
        id: string;
        peerThreadId: string | null;
        status: string;
        toBotId: string;
        fromBotId: string;
        kind: string;
        text: string;
      }>;
    }>("GET", `/api/threads/${id}`);
  }

  memory(q: { bot?: string; q?: string; kind?: string; origin?: string } = {}) {
    const p = new URLSearchParams(Object.entries(q).filter(([, v]) => !!v) as Array<[string, string]>);
    const qs = p.toString();
    return this.call<MemoryList>("GET", `/api/memory${qs ? `?${qs}` : ""}`);
  }
  addMemory(body: { body: string; kind?: string; botId?: string }) {
    return this.call<{ status: string; memory: MemoryItem | null }>("POST", "/api/memory", body);
  }
  editMemory(id: string, body: { body?: string; kind?: string; scope?: string }) {
    return this.call<{ memory: MemoryItem }>("PATCH", `/api/memory/${id}`, body);
  }
  confirmMemory(id: string) {
    return this.call<{ memory: MemoryItem | null }>("POST", `/api/memory/${id}/confirm`, {});
  }
  forgetMemory(id: string) {
    return this.call<{ forgotten: number }>("DELETE", `/api/memory/${id}`);
  }
  clearForgotten() {
    return this.call<{ cleared: number }>("POST", "/api/memory/forgotten/clear", {});
  }
  /** The export as a file the browser saves (fetched with the token, never put in a URL). */
  async exportMemory(bot?: string): Promise<Blob> {
    const res = await fetch(`/api/memory/export${bot ? `?bot=${encodeURIComponent(bot)}` : ""}`, {
      headers: { authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.blob();
  }
  skills(bot?: string) {
    return this.call<{ botId: string; items: Skill[] }>(
      "GET",
      `/api/skills${bot ? `?bot=${encodeURIComponent(bot)}` : ""}`,
    );
  }
  approveSkill(id: string, edit?: { name?: string; triggers?: string[]; steps?: string[] }) {
    return this.call<{ skill: Skill }>("POST", `/api/skills/${id}/approve`, edit ? { edit } : {});
  }
  rejectSkill(id: string) {
    return this.call<{ skill: Skill }>("POST", `/api/skills/${id}/reject`, {});
  }
  editSkill(id: string, body: { name?: string; triggers?: string[]; steps?: string[] }) {
    return this.call<{ skill: Skill }>("PATCH", `/api/skills/${id}`, body);
  }
  setSkillEnabled(id: string, enabled: boolean) {
    return this.call<{ skill: Skill }>("POST", `/api/skills/${id}/${enabled ? "enable" : "disable"}`, {});
  }
  deleteSkill(id: string) {
    return this.call<{ deleted: boolean }>("DELETE", `/api/skills/${id}`);
  }
  bots() {
    return this.call<Bot[]>("GET", "/api/bots");
  }
  workers(threadId: string) {
    return this.call<Worker[]>("GET", `/api/threads/${threadId}/workers`);
  }
  stopWorker(id: string) {
    return this.call<{ stopped: boolean; worker: Worker }>("POST", `/api/workers/${id}/stop`, {});
  }
  /** Phase 6: answer a worker's NEEDS_INPUT as the person (needs the approve key). */
  answerWorker(id: string, answers: string[]) {
    return this.call<{ worker: Worker }>("POST", `/api/workers/${id}/answer`, { answers });
  }
  /** Design §0.2.5: 續做 a task whose step budget ran out (needs the approve key). */
  continueWorker(id: string) {
    return this.call<{ worker: Worker }>("POST", `/api/workers/${id}/continue`, {});
  }
  snapshots(dispatchId: string) {
    return this.call<Snapshot[]>("GET", `/api/snapshots?dispatch=${encodeURIComponent(dispatchId)}`);
  }
  restoreSnapshot(repo: string, ref: string) {
    return this.call<RestoreResult>("POST", "/api/snapshots/restore", { repo, ref });
  }
  purgeSnapshots(filter: { dispatchId?: string; repo?: string; ref?: string }) {
    return this.call<{ purged: number }>("POST", "/api/snapshots/purge", filter);
  }

  /** One worker's own run events (replayed, then live). The router never sees this stream. */
  workerStream(id: string, onEvent: (e: AlcaEvent) => void): () => void {
    return this.sse(
      `/api/workers/${encodeURIComponent(id)}/events`,
      (_event, data) => onEvent(JSON.parse(data) as AlcaEvent),
      () => undefined,
    );
  }
  /** `botId`: answer as that bot (P7); an @name at the start of the text does the same on the server. */
  send(threadId: string, text: string, botId?: string) {
    return this.call<{ runId: string; botId?: string }>("POST", `/api/threads/${threadId}/messages`, {
      text,
      ...(botId ? { botId } : {}),
    });
  }
  interrupt(threadId: string) {
    return this.call<{ interrupted: boolean }>("POST", `/api/threads/${threadId}/interrupt`, {});
  }
  approve(id: string, decision: "approved" | "denied") {
    return this.call<{ resolved: boolean }>("POST", `/api/approvals/${id}`, { decision });
  }
  answer(id: string, answer: string) {
    return this.call<{ resolved: boolean }>("POST", `/api/questions/${id}`, { answer });
  }

  browserStatus() {
    return this.call<{
      enabled: boolean;
      bots: Bot[];
      chromium?: boolean;
      install?: BrowserInstall;
      cookieImport?: boolean;
    }>("GET", "/api/browser/status");
  }
  /** Start (or join) the first-run Chrome for Testing download. */
  installBrowser() {
    return this.call<BrowserInstall>("POST", "/api/browser/install", {});
  }
  spaces() {
    return this.call<Space[]>("GET", "/api/browser/spaces");
  }
  takeOver(spaceId: string) {
    return this.call<Space>("POST", `/api/browser/spaces/${spaceId}/takeover`, {});
  }
  handBack(spaceId: string) {
    return this.call<Space>("POST", `/api/browser/spaces/${spaceId}/handback`, {});
  }
  input(spaceId: string, input: UserInput) {
    return this.call<{ ok: boolean }>("POST", `/api/browser/spaces/${spaceId}/input`, input);
  }
  navigate(spaceId: string, url: string) {
    return this.call<Space>("POST", `/api/browser/spaces/${spaceId}/navigate`, { url });
  }
  tab(spaceId: string, action: "switch" | "new" | "close", tabId?: string) {
    return this.call<Space>("POST", `/api/browser/spaces/${spaceId}/tabs`, {
      action,
      ...(tabId ? { tabId } : {}),
    });
  }
  openSpace(body: { title: string; threadId?: string; url?: string }) {
    return this.call<Space>("POST", "/api/browser/spaces", body);
  }

  /** The browser channel; frames come only for the watched Space. */
  browserStream(
    watch: string | null,
    onEvent: (e: BrowserEvent) => void,
    onFrame: (f: Frame) => void,
  ): () => void {
    return this.sse(
      `/api/browser/events${watch ? `?watch=${encodeURIComponent(watch)}` : ""}`,
      (event, data) => {
        if (event === "frame") onFrame(JSON.parse(data) as Frame);
        else onEvent(JSON.parse(data) as BrowserEvent);
      },
      () => undefined,
    );
  }

  /** SSE over fetch (EventSource cannot send headers). Reconnects with backoff. */
  stream(
    onEvent: (e: AlcaEvent) => void,
    onState: (live: boolean) => void,
    onAgents?: (e: AgentsEvent) => void,
    onLearning?: (e: LearningEvent) => void,
  ): () => void {
    return this.sse(
      "/api/events",
      (event, data) => {
        if (event === "agents") onAgents?.(JSON.parse(data) as AgentsEvent);
        else if (event === "learning") onLearning?.(JSON.parse(data) as LearningEvent);
        else onEvent(JSON.parse(data) as AlcaEvent);
      },
      onState,
    );
  }

  private sse(
    path: string,
    onMessage: (event: string, data: string) => void,
    onState: (live: boolean) => void,
  ): () => void {
    let stopped = false;
    let ctrl: AbortController | undefined;
    const loop = async (delay: number): Promise<void> => {
      if (stopped) return;
      ctrl = new AbortController();
      try {
        const res = await fetch(path, {
          headers: { authorization: `Bearer ${this.token}` },
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        onState(true);
        delay = 500;
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          let cut = buf.indexOf("\n\n");
          while (cut >= 0) {
            const frame = buf.slice(0, cut);
            buf = buf.slice(cut + 2);
            const lines = frame.split("\n");
            const event = lines.find((l) => l.startsWith("event: "))?.slice(7) ?? "message";
            const data = lines
              .filter((l) => l.startsWith("data: "))
              .map((l) => l.slice(6))
              .join("\n");
            if (data) onMessage(event, data);
            cut = buf.indexOf("\n\n");
          }
        }
      } catch {
        // fall through to reconnect
      }
      onState(false);
      if (!stopped) setTimeout(() => void loop(Math.min(delay * 2, 8000)), delay);
    };
    void loop(500);
    return () => {
      stopped = true;
      ctrl?.abort();
    };
  }
}
