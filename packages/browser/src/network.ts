import { isAlwaysConfirm } from "@alca/config";
import type { ActionClass } from "@alca/policy";
import type { CdpSession } from "./cdp/connection.ts";
import { type Classification, DEFAULT_SENSITIVE_RULES, type SensitiveRule } from "./sensitive.ts";

/**
 * Sensitive-action gate, network layer. Every request a Space's tabs (and
 * their out-of-process frames) make is paused by the CDP Fetch domain at the
 * request stage and classified here. Reads pass straight through. A request
 * that pays, sends, deletes or publishes (by method, URL, form fields or a
 * GraphQL mutation name) continues only when the agent step that caused it
 * was approved for that class, or a person approves it now through the same
 * always-confirm gate; otherwise it is failed as blocked. A person driving
 * the Space is never gated, and tabs that are not a Space's are never
 * intercepted. Like the action layer this only ever escalates: it catches
 * known shapes, it is not a guarantee (see docs/SECURITY.md).
 *
 * R3 channels. Page and frame requests bypass service workers, so a worker
 * cannot send for the page out of sight; a Space's service and shared workers
 * are attached by the host and gated like a tab. WebRTC is refused in agent
 * tabs by a script (the launch switch only keeps UDP from leaving unproxied).
 * WebSockets cannot be held by CDP: they are watched, classified and, when a
 * frame looks like an always-confirm action the step was not granted, the tab
 * is sent to about:blank after the fact. That first frame has already left;
 * the note, the card and the audit row say so. A popup's very first request
 * is still outside.
 */

export interface RequestFacts {
  method: string;
  url: string;
  /** CDP resource type: Document, XHR, Fetch, Ping, Other, … */
  resourceType?: string;
  postData?: string;
  contentType?: string;
  /** The page the request came from (rules match its host too). */
  pageUrl?: string;
}

type Sensitive = "payment" | "send" | "delete" | "publish";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const SEG = String.raw`(?:\/|\?|#|\.|$|-|_)`;
const PATH_PATTERNS: ReadonlyArray<[Sensitive, RegExp]> = [
  [
    "payment",
    new RegExp(
      String.raw`\/(checkout|payments?|pay|purchase|billing|charge|donate|subscribe|place-?order|orders?\/(place|confirm|submit|complete|create))${SEG}`,
      "i",
    ),
  ],
  ["delete", new RegExp(String.raw`\/(delete|destroy|remove|trash|erase|purge)${SEG}`, "i")],
  [
    "send",
    new RegExp(
      String.raw`\/(send|sendmail|send-?message|messages?|mail\/send|compose|reply|forward|comments?|chat\.postmessage)${SEG}`,
      "i",
    ),
  ],
  [
    "publish",
    new RegExp(
      String.raw`\/(publish|posts?|tweets?|statuses|share|deploy|releases?|create-?tweet)${SEG}`,
      "i",
    ),
  ],
];
const QUERY_ACTION: ReadonlyArray<[Sensitive, RegExp]> = [
  ["payment", /[?&](action|op|do)=(pay|checkout|purchase|place_?order)\b/i],
  ["delete", /[?&](action|op|do)=(delete|remove|destroy|trash)\b/i],
  ["send", /[?&](action|op|do)=(send|reply|forward|post_?message)\b/i],
  ["publish", /[?&](action|op|do)=(publish|post|share|tweet)\b/i],
];
const MUTATION_NAME: ReadonlyArray<[Sensitive, RegExp]> = [
  ["payment", /^(checkout|pay|purchase|placeorder|submitorder|completeorder|createorder|subscribe|donate)/i],
  ["delete", /^(delete|remove|destroy|trash|purge)/i],
  ["send", /^(send|reply|forward|createcomment|addcomment|postmessage|createmessage)/i],
  ["publish", /^(publish|createpost|createtweet|createstatus|share|post|deploy|release)/i],
];
const PASSWORD_FIELD = /^(pass(word)?|passwd|pwd|pin|current-?password|new-?password|密碼)$/i;
const CARD_FIELD = /cc-?(number|csc|exp)|card.?num|cardnumber|\bcvv\b|\bcvc\b|security.?code|卡號|安全碼/i;
const PRIORITY: readonly Sensitive[] = ["payment", "delete", "send", "publish"];

function parseUrl(url: string | undefined): URL | undefined {
  try {
    return url ? new URL(url) : undefined;
  } catch {
    return undefined;
  }
}
const domainMatches = (h: string, d: string) => h === d || h.endsWith(`.${d}`);

/** Field names a request body carries: urlencoded, multipart or JSON (two levels deep). */
export function bodyFieldNames(postData: string | undefined, contentType = ""): string[] {
  if (!postData) return [];
  const ct = contentType.toLowerCase();
  const out: string[] = [];
  const text = postData.slice(0, 64 * 1024);
  if (ct.includes("json") || /^\s*[[{]/.test(text)) {
    try {
      const walk = (v: unknown, depth: number) => {
        if (!v || typeof v !== "object" || depth > 2) return;
        for (const [k, inner] of Object.entries(v as Record<string, unknown>)) {
          out.push(k);
          walk(inner, depth + 1);
        }
      };
      walk(JSON.parse(text), 0);
      return out;
    } catch {
      // not JSON after all
    }
  }
  if (ct.includes("multipart/")) {
    for (const m of text.matchAll(/content-disposition:\s*form-data;\s*name="([^"]{1,200})"/gi))
      out.push(m[1] as string);
    return out;
  }
  for (const pair of text.split("&")) {
    const k = pair.split("=")[0] ?? "";
    try {
      out.push(decodeURIComponent(k.replaceAll("+", " ")));
    } catch {
      out.push(k);
    }
  }
  return out;
}

/** GraphQL operation names in a body (`operationName`, or `mutation Name`). */
function mutationNames(postData: string | undefined): string[] {
  if (!postData) return [];
  const text = postData.slice(0, 64 * 1024);
  const out: string[] = [];
  for (const m of text.matchAll(/"operationName"\s*:\s*"([A-Za-z_][\w]{0,80})"/g)) out.push(m[1] as string);
  for (const m of text.matchAll(/\bmutation\s+([A-Za-z_][\w]{0,80})/g)) out.push(m[1] as string);
  // An anonymous mutation still names its first field: `mutation { deleteThing(...) }`.
  for (const m of text.matchAll(/\bmutation\b[^{]{0,200}\{\s*([A-Za-z_][\w]{0,80})/g))
    out.push(m[1] as string);
  return out;
}

/** Classify one request. Non-mutating requests are reads, whatever their URL says. */
export function classifyRequest(
  r: RequestFacts,
  rules: readonly SensitiveRule[] = DEFAULT_SENSITIVE_RULES,
): Classification {
  const method = r.method.toUpperCase();
  if (!MUTATING.has(method)) return { actionClass: "read", reasons: [] };
  const u = parseUrl(r.url);
  const found: Array<{ c: Sensitive; why: string }> = [];
  if (method === "DELETE") found.push({ c: "delete", why: "DELETE 請求" });
  const path = u ? `${u.pathname}${u.search}` : r.url;
  // Beacons (sendBeacon / <a ping>) carry telemetry with chatty URLs; only their contents count.
  if (r.resourceType !== "Ping") {
    for (const [c, re] of PATH_PATTERNS)
      if (re.test(u?.pathname ?? r.url)) found.push({ c, why: `網址 ${u?.pathname ?? ""}` });
    for (const [c, re] of QUERY_ACTION) if (re.test(path)) found.push({ c, why: "網址參數" });
  }
  const fields = bodyFieldNames(r.postData, r.contentType);
  if (fields.some((f) => CARD_FIELD.test(f))) found.push({ c: "payment", why: "送出付款卡資料" });
  if (fields.some((f) => PASSWORD_FIELD.test(f))) found.push({ c: "send", why: "送出密碼" });
  for (const n of mutationNames(r.postData))
    for (const [c, re] of MUTATION_NAME) if (re.test(n)) found.push({ c, why: `GraphQL ${n}` });
  found.push(...ruleHits(rules, u, r.pageUrl));
  return pick(found);
}

/** What the gate asks a person to approve. */
export interface NetworkConfirmRequest {
  spaceId: string;
  botId: string;
  threadId?: string;
  workerId?: string;
  actionClass: ActionClass;
  method: string;
  url: string;
  reasons: string[];
  /** One line for the approval card. */
  summary: string;
}

/** Ask a person (the always-confirm gate). Resolve true only for an explicit yes. */
export type NetworkConfirm = (req: NetworkConfirmRequest, signal: AbortSignal) => Promise<boolean>;

/** What the gate needs to know about a Space (the host's SpaceInternal satisfies it). */
export interface GatedSpace {
  spaceId: string;
  botId: string;
  threadId?: string;
  workerId?: string;
  controller: "agent" | "user";
  closed: boolean;
}

/** R3: the channels the request gate cannot hold. */
export type ChannelKind = "websocket" | "webrtc" | "worker-fetch";
export interface ChannelFacts {
  kind: ChannelKind;
  url: string;
  pageUrl?: string;
  /** websocket: a text frame the page sent (first 64 KB); worker-fetch: the request body. */
  frame?: string;
  /** worker-fetch only. */
  method?: string;
}

/**
 * Classify a channel with the request gate's own rules and shapes. A worker's
 * fetch is a request. A WebSocket or WebRTC channel is a write, unless a
 * domain rule names its host (or the page's), or a frame carries a password
 * or card field or a GraphQL mutation name that classifyRequest would flag.
 */
export function classifyChannel(
  c: ChannelFacts,
  rules: readonly SensitiveRule[] = DEFAULT_SENSITIVE_RULES,
): Classification {
  if (c.kind === "worker-fetch")
    return classifyRequest(
      {
        method: c.method ?? "GET",
        url: c.url,
        ...(c.frame !== undefined ? { postData: c.frame } : {}),
        ...(c.pageUrl ? { pageUrl: c.pageUrl } : {}),
      },
      rules,
    );
  const found: Array<{ c: Sensitive; why: string }> = [];
  const frame = c.frame?.slice(0, 64 * 1024);
  if (frame) {
    const fields = /^\s*[[{]/.test(frame) ? bodyFieldNames(frame, "application/json") : [];
    if (fields.some((f) => CARD_FIELD.test(f))) found.push({ c: "payment", why: "送出付款卡資料" });
    if (fields.some((f) => PASSWORD_FIELD.test(f))) found.push({ c: "send", why: "送出密碼" });
    for (const n of mutationNames(frame))
      for (const [k, re] of MUTATION_NAME) if (re.test(n)) found.push({ c: k, why: `GraphQL ${n}` });
  }
  found.push(...ruleHits(rules, parseUrl(c.url), c.pageUrl));
  return pick(found);
}

function ruleHits(
  rules: readonly SensitiveRule[],
  u: URL | undefined,
  pageUrl: string | undefined,
): Array<{ c: Sensitive; why: string }> {
  const out: Array<{ c: Sensitive; why: string }> = [];
  const host = u?.hostname.toLowerCase() ?? "";
  const pageHost = parseUrl(pageUrl)?.hostname.toLowerCase() ?? "";
  for (const rule of rules) {
    // Rules keyed on a button label belong to the action layer.
    if (rule.name || !rule.domain) continue;
    if (!domainMatches(host, rule.domain) && !domainMatches(pageHost, rule.domain)) continue;
    if (rule.path && !rule.path.test(u?.pathname ?? "")) continue;
    out.push({ c: rule.actionClass as Sensitive, why: `規則 ${rule.id}` });
  }
  return out;
}

function pick(found: ReadonlyArray<{ c: Sensitive; why: string }>): Classification {
  for (const c of PRIORITY) {
    const hits = found.filter((f) => f.c === c);
    if (hits.length) return { actionClass: c, reasons: [...new Set(hits.map((h) => h.why))] };
  }
  return { actionClass: "write", reasons: [] };
}

export interface NetworkNote {
  actionClass: ActionClass;
  method: string;
  url: string;
  /** observed: seen and let be; stopped: a channel the gate could not hold was shut after the fact. */
  outcome: "approved" | "blocked" | "step" | "observed" | "stopped";
  /** Set for a channel note (WebSocket, WebRTC). */
  kind?: ChannelKind;
}

/** A channel the gate shut (a WebSocket's tab) or refused (WebRTC): for a card and an audit row. */
export interface ChannelEvent {
  spaceId: string;
  botId: string;
  threadId?: string;
  workerId?: string;
  kind: ChannelKind;
  outcome: "stopped" | "blocked";
  actionClass: ActionClass;
  url: string;
  reasons: string[];
}

interface SpaceGate {
  /** Classes cleared for the running agent step (or a moment after it), and until when. */
  grants: Map<ActionClass, number>;
  inStep: boolean;
  /** Open confirmations, one per class: requests of that class wait on the same card. */
  asking: Map<ActionClass, Promise<boolean>>;
  notes: NetworkNote[];
  abort: AbortController;
  /** Open WebSockets by session and request id, with what their URL alone classifies as. */
  sockets: Map<string, { url: string; c: Classification; stopped?: boolean }>;
  /** Hosts whose WebSocket was shut, how often, and for what. */
  strikes: Map<string, { n: number; actionClass: ActionClass }>;
  /** Pages whose WebRTC refusal is already noted. */
  rtc: Set<string>;
}

/** After this many stops on one host, the Space shuts that host's WebSockets as they open. */
export const WEBSOCKET_STRIKES = 2;
/** Runtime binding the WebRTC refusal reports through. */
export const RTC_BINDING = "__alcaRtc";
/**
 * Agent tabs: RTCPeerConnection and friends refuse. This script is the lock (the launch switch does not
 * stop a loopback data channel in CI Chromium); defence in depth, not a guarantee.
 */
export const RTC_BLOCK = `(() => {
  const report = globalThis[${JSON.stringify("__alcaRtc")}];
  const deny = function () {
    try { if (typeof report === "function") report(String(location.href)); } catch {}
    throw new DOMException("WebRTC is turned off in Alca agent tabs", "NotAllowedError");
  };
  for (const k of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel"]) {
    try { Object.defineProperty(globalThis, k, { value: deny, configurable: false, writable: false }); } catch {}
  }
})();`;
const SENSITIVE_LABEL: Partial<Record<ActionClass, string>> = {
  payment: "付款",
  send: "寄送",
  delete: "刪除",
  publish: "發布",
};
const rank = (c: ActionClass) => {
  const i = PRIORITY.indexOf(c as Sensitive);
  return i < 0 ? PRIORITY.length : i;
};
const hostOf = (url: string) => parseUrl(url)?.hostname.toLowerCase() ?? "";

const INTERCEPT_TYPES = ["Document", "XHR", "Fetch", "Ping", "Other", "EventSource"];

function summaryOf(method: string, url: string, reasons: string[]): string {
  const u = parseUrl(url);
  const where = u ? `${u.host}${u.pathname}`.slice(0, 160) : url.slice(0, 160);
  return `網路層：網頁要送出 ${method} ${where}${reasons.length ? `（${reasons.join("、")}）` : ""}`;
}

/** Per-Space network interception. One instance per browser host. */
export class NetworkGate {
  private readonly spaces = new WeakMap<GatedSpace, SpaceGate>();
  private readonly o: {
    rules: () => readonly SensitiveRule[];
    confirm?: NetworkConfirm;
    now: () => number;
    graceMs: number;
    notify?: (e: ChannelEvent) => void;
  };

  constructor(o: {
    rules: () => readonly SensitiveRule[];
    confirm?: NetworkConfirm;
    now?: () => number;
    graceMs?: number;
    /** A channel was shut or refused (the host's card and audit row). */
    notify?: (e: ChannelEvent) => void;
  }) {
    this.o = {
      rules: o.rules,
      ...(o.confirm ? { confirm: o.confirm } : {}),
      now: o.now ?? Date.now,
      graceMs: o.graceMs ?? 3000,
      ...(o.notify ? { notify: o.notify } : {}),
    };
  }

  private state(s: GatedSpace): SpaceGate {
    let g = this.spaces.get(s);
    if (!g) {
      g = {
        grants: new Map(),
        inStep: false,
        asking: new Map(),
        notes: [],
        abort: new AbortController(),
        sockets: new Map(),
        strikes: new Map(),
        rtc: new Set(),
      };
      this.spaces.set(s, g);
    }
    return g;
  }

  /**
   * Start intercepting one session: a tab (`page`), one of its out-of-process
   * frames (`iframe`), or a worker (`worker`, `service_worker`,
   * `shared_worker`). Pages and frames also bypass service workers, watch
   * their WebSockets and refuse WebRTC; `tab` is the tab session a stopped
   * frame's tab is navigated through (default: this session). A failure here
   * throws, and the caller does not let that target run.
   */
  async attach(s: GatedSpace, session: CdpSession, kind = "page", tab?: CdpSession): Promise<() => void> {
    const offs = [session.on("Fetch.requestPaused", (e) => void this.onPaused(s, session, e))];
    const off = () => {
      for (const f of offs.splice(0)) f();
    };
    try {
      await session.send("Fetch.enable", {
        patterns: INTERCEPT_TYPES.map((resourceType) => ({
          urlPattern: "*",
          resourceType,
          requestStage: "Request",
        })),
      });
      if (kind !== "page" && kind !== "iframe") return off;
      const stopVia = tab ?? session;
      const key = (id: unknown) => `${session.sessionId}:${String(id)}`;
      offs.push(
        session.on("Network.webSocketCreated", (e) =>
          this.onSocket(s, stopVia, key(e.requestId), String(e.url)),
        ),
        session.on("Network.webSocketFrameSent", (e) =>
          this.onFrame(s, stopVia, key(e.requestId), e.response as { opcode?: number; payloadData?: string }),
        ),
        session.on("Network.webSocketClosed", (e) => this.spaces.get(s)?.sockets.delete(key(e.requestId))),
        session.on("Runtime.bindingCalled", (e) => {
          if (e.name === RTC_BINDING) this.onRtc(s, String(e.payload ?? ""));
        }),
      );
      // Network events are wanted for the WebSockets only: keep its buffers small.
      await session.send("Network.enable", {
        maxTotalBufferSize: 256 * 1024,
        maxResourceBufferSize: 64 * 1024,
      });
      await session.send("Network.setBypassServiceWorker", { bypass: true });
      await session.send("Runtime.addBinding", { name: RTC_BINDING }).catch(() => undefined);
      await session
        .send("Page.addScriptToEvaluateOnNewDocument", { source: RTC_BLOCK, runImmediately: true })
        .catch(() => undefined);
      return off;
    } catch (err) {
      off();
      throw err;
    }
  }

  private onSocket(s: GatedSpace, tab: CdpSession, key: string, url: string): void {
    if (s.closed) return;
    const g = this.state(s);
    const c = classifyChannel({ kind: "websocket", url }, this.o.rules());
    g.sockets.set(key, { url, c });
    if (s.controller === "user") return;
    const strike = g.strikes.get(hostOf(url));
    if (strike && strike.n >= WEBSOCKET_STRIKES) {
      this.stop(s, g, tab, key, strike.actionClass, [`這個網域的 WebSocket 已被停止 ${strike.n} 次`]);
      return;
    }
    if (g.notes.length < 200)
      g.notes.push({
        actionClass: c.actionClass,
        method: "WebSocket",
        url,
        outcome: "observed",
        kind: "websocket",
      });
  }

  private onFrame(
    s: GatedSpace,
    tab: CdpSession,
    key: string,
    frame: { opcode?: number; payloadData?: string } | undefined,
  ): void {
    if (s.closed || s.controller === "user") return;
    // Text frames only: a binary frame is base64 that no rule reads.
    if (frame?.opcode !== 1 || typeof frame.payloadData !== "string") return;
    const g = this.state(s);
    const sock = g.sockets.get(key);
    if (sock?.stopped) return;
    const url = sock?.url ?? "";
    const fc = classifyChannel({ kind: "websocket", url, frame: frame.payloadData }, this.o.rules());
    const c = sock && rank(sock.c.actionClass) < rank(fc.actionClass) ? sock.c : fc;
    if (!isAlwaysConfirm(c.actionClass)) return;
    if (this.granted(g, c.actionClass)) {
      g.notes.push({
        actionClass: c.actionClass,
        method: "WebSocket",
        url,
        outcome: "step",
        kind: "websocket",
      });
      return;
    }
    this.stop(s, g, tab, key, c.actionClass, c.reasons);
  }

  /** The frame is gone already: shut every socket on the tab and say what may have happened. */
  private stop(
    s: GatedSpace,
    g: SpaceGate,
    tab: CdpSession,
    key: string,
    actionClass: ActionClass,
    reasons: string[],
  ): void {
    const sock = g.sockets.get(key);
    const url = sock?.url ?? "";
    if (sock) sock.stopped = true;
    void tab.send("Page.navigate", { url: "about:blank" }).catch(() => undefined);
    const host = hostOf(url);
    const prev = g.strikes.get(host);
    g.strikes.set(host, {
      n: (prev?.n ?? 0) + 1,
      actionClass: prev && rank(prev.actionClass) < rank(actionClass) ? prev.actionClass : actionClass,
    });
    g.notes.push({ actionClass, method: "WebSocket", url, outcome: "stopped", kind: "websocket" });
    this.tell(s, { kind: "websocket", outcome: "stopped", actionClass, url, reasons });
  }

  private onRtc(s: GatedSpace, pageUrl: string): void {
    if (s.closed) return;
    const g = this.state(s);
    const page = pageUrl.slice(0, 2000);
    if (g.rtc.has(page)) return;
    g.rtc.add(page);
    g.notes.push({ actionClass: "write", method: "WebRTC", url: page, outcome: "blocked", kind: "webrtc" });
    this.tell(s, {
      kind: "webrtc",
      outcome: "blocked",
      actionClass: "write",
      url: page,
      reasons: ["代理人分頁不允許 WebRTC"],
    });
  }

  private tell(s: GatedSpace, e: Omit<ChannelEvent, "spaceId" | "botId" | "threadId" | "workerId">): void {
    try {
      this.o.notify?.({
        spaceId: s.spaceId,
        botId: s.botId,
        ...(s.threadId ? { threadId: s.threadId } : {}),
        ...(s.workerId ? { workerId: s.workerId } : {}),
        ...e,
      });
    } catch {
      // a card or audit failure must not keep the tab open
    }
  }

  /** An agent step authorized for `actionClass` begins. */
  beginStep(s: GatedSpace, actionClass: ActionClass): void {
    const g = this.state(s);
    g.grants = new Map([[actionClass, Number.POSITIVE_INFINITY]]);
    g.inStep = true;
    // A tab stopped between steps (its WebSocket frame arrived late) is still news for the next one.
    g.notes = g.notes.filter((n) => n.outcome === "stopped");
  }

  /**
   * The step's own work is done: wait for any card it raised, keep its grant a
   * moment longer (a click's request can leave after the click returns), and
   * hand back what the network layer did during the step.
   */
  async endStep(s: GatedSpace, signal?: AbortSignal): Promise<NetworkNote[]> {
    const g = this.state(s);
    while (g.asking.size && !signal?.aborted) {
      const aborted = new Promise<void>((r) => signal?.addEventListener("abort", () => r(), { once: true }));
      await Promise.race([Promise.allSettled([...g.asking.values()]), aborted]);
    }
    const until = this.o.now() + this.o.graceMs;
    for (const c of g.grants.keys()) g.grants.set(c, until);
    g.inStep = false;
    const notes = g.notes;
    g.notes = [];
    return notes;
  }

  /** The Space closed: give up on open cards and fail what still waits. */
  forget(s: GatedSpace): void {
    const g = this.spaces.get(s);
    if (!g) return;
    g.abort.abort(new Error("Space closed"));
    this.spaces.delete(s);
  }

  private granted(g: SpaceGate, c: ActionClass): boolean {
    return (g.grants.get(c) ?? Number.NEGATIVE_INFINITY) >= this.o.now();
  }

  private async onPaused(
    s: GatedSpace,
    session: CdpSession,
    e: {
      requestId: string;
      resourceType?: string;
      request: { method: string; url: string; postData?: string; headers?: Record<string, string> };
    },
  ): Promise<void> {
    const pass = () =>
      session.send("Fetch.continueRequest", { requestId: e.requestId }).catch(() => undefined);
    const block = () =>
      session
        .send("Fetch.failRequest", { requestId: e.requestId, errorReason: "BlockedByClient" })
        .catch(() => undefined);
    try {
      if (s.closed) return void (await block());
      // A person at the wheel browses freely.
      if (s.controller === "user") return void (await pass());
      const headers = e.request.headers ?? {};
      const ct = Object.entries(headers).find(([k]) => k.toLowerCase() === "content-type")?.[1];
      const c = classifyRequest(
        {
          method: e.request.method,
          url: e.request.url,
          ...(e.resourceType ? { resourceType: e.resourceType } : {}),
          ...(e.request.postData !== undefined ? { postData: e.request.postData } : {}),
          ...(ct ? { contentType: ct } : {}),
        },
        this.o.rules(),
      );
      if (!isAlwaysConfirm(c.actionClass)) return void (await pass());
      const g = this.state(s);
      const note = (outcome: NetworkNote["outcome"]) =>
        g.notes.push({ actionClass: c.actionClass, method: e.request.method, url: e.request.url, outcome });
      if (this.granted(g, c.actionClass)) {
        note("step");
        return void (await pass());
      }
      const ok = await this.ask(s, g, c.actionClass, e.request.method, e.request.url, c.reasons);
      note(ok ? "approved" : "blocked");
      if (ok) await pass();
      else await block();
    } catch {
      await block();
    }
  }

  private ask(
    s: GatedSpace,
    g: SpaceGate,
    actionClass: ActionClass,
    method: string,
    url: string,
    reasons: string[],
  ): Promise<boolean> {
    const open = g.asking.get(actionClass);
    if (open) return open;
    const confirm = this.o.confirm;
    if (!confirm) return Promise.resolve(false);
    const p = confirm(
      {
        spaceId: s.spaceId,
        botId: s.botId,
        ...(s.threadId ? { threadId: s.threadId } : {}),
        ...(s.workerId ? { workerId: s.workerId } : {}),
        actionClass,
        method,
        url,
        reasons,
        summary: summaryOf(method, url, reasons),
      },
      g.abort.signal,
    )
      .then((yes) => {
        // One yes covers the rest of this step's requests of that class.
        if (yes)
          g.grants.set(actionClass, g.inStep ? Number.POSITIVE_INFINITY : this.o.now() + this.o.graceMs);
        return yes === true;
      })
      .catch(() => false)
      .finally(() => g.asking.delete(actionClass));
    g.asking.set(actionClass, p);
    return p;
  }
}

/** One line for the model about what the network layer did during a step. */
export function describeNotes(notes: readonly NetworkNote[]): string {
  if (!notes.length) return "";
  const parts = notes.map((n) => {
    const u = parseUrl(n.url);
    const where = (u ? `${u.host}${u.pathname}` : n.url).slice(0, 120);
    if (n.outcome === "stopped")
      return `網頁經 WebSocket（${where}）送出疑似「${SENSITIVE_LABEL[n.actionClass] ?? n.actionClass}」的資料，已停止這個分頁（導到 about:blank）；這個動作可能已經生效，請照實告訴使用者，不要說已攔下`;
    if (n.kind === "webrtc") return `網頁要建立 WebRTC 連線（${where}），代理人分頁不允許，已拒絕`;
    const what = n.outcome === "blocked" ? "已攔下（使用者未批准，沒有送出）" : "已放行（使用者批准）";
    return `${n.method} ${where} ${what}`;
  });
  const shown = parts.filter((_, i) => notes[i]?.outcome !== "step" && notes[i]?.outcome !== "observed");
  return shown.length ? `\n網路層閘門：${[...new Set(shown)].slice(0, 5).join("；")}` : "";
}
