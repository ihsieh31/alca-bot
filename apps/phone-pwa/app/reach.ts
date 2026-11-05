// A tapped notification → its card (P8; BUG-7 / BUG-8). The app is usually
// coming back from the background then, and Link is still reconnecting: the
// old code asked `cards.locate` at once, the request failed, the failure was
// swallowed, and nothing happened (and "這件事已經處理好了" never showed).
// Now: say right away that it is connecting, wait for the connection (up to
// CONNECT_TIMEOUT_MS), then locate; can't-reach-the-computer, this-card-is-gone
// and already-handled each get their own words.
//
// The service worker also leaves the tapped target in a small cache
// (PENDING_CACHE) because its postMessage to a page that iOS had frozen can
// be lost; the page reads it when it starts and when it becomes visible.
import { t } from "./i18n/index.ts";

export type ReachFrom = "push" | "app";
export type ReachResult =
  | "test"
  | "handoff"
  | "first"
  | "unreachable"
  | "error"
  | "not_found"
  | "handled"
  | "on_screen"
  | "banner"
  | "opened"
  | "offer"
  | "card_missing";

export interface ReachDeps {
  online(): boolean;
  /** Resolves true once connected (at once if already), false on timeout or revoke. */
  waitOnline(ms: number): Promise<boolean>;
  locate(kind: string, id: string): Promise<{ threadId: string | null; status: string }>;
  threadId(): string | null;
  openThread(id: string): Promise<void>;
  /** Raise the card's sheet if the card is known yet; false = not (yet). */
  openCard(id: string): boolean;
  openFirst(): void;
  /** An offer (Alca noticed something) is not a card: show it where it is answered (對話 › 待處理). */
  openOffer(id: string): void;
  openBrowser(): void;
  toast(msg: string): void;
  banner(msg: string, onTap: () => void): void;
  sleep?(ms: number): Promise<void>;
}

export const CONNECT_TIMEOUT_MS = 15_000;
/** How long to wait for the card to arrive over the thread watch after opening its thread. */
export const CARD_WAIT_MS = 6000;

const nap = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function reach(d: ReachDeps, kind: string, id: string, from: ReachFrom): Promise<ReachResult> {
  const sleep = d.sleep ?? nap;
  if (kind === "test") {
    d.toast(t("phone.main.notificationsAreWorking"));
    return "test";
  }
  if (kind === "handoff") {
    d.openBrowser();
    return "handoff";
  }
  if (!id) {
    d.openFirst();
    return "first";
  }
  if (!d.online()) {
    // Immediate feedback: the tap did something.
    if (from === "push") d.toast(t("phone.main.connectingWillOpenCard"));
    if (!(await d.waitOnline(CONNECT_TIMEOUT_MS))) {
      if (from === "push") d.toast(t("phone.main.cantReachComputer"));
      return "unreachable";
    }
  }
  let loc: { threadId: string | null; status: string } | undefined;
  let failure: unknown;
  for (let attempt = 0; attempt < 2 && !loc; attempt++) {
    try {
      loc = await d.locate(kind, id);
    } catch (e) {
      failure = e;
      // A socket that looked open after the background may just have been replaced: wait and ask once more.
      if (attempt === 0 && !(await d.waitOnline(CONNECT_TIMEOUT_MS))) break;
    }
  }
  if (!loc) {
    if (from !== "push") return d.online() ? "error" : "unreachable";
    if (!d.online()) {
      d.toast(t("phone.main.cantReachComputer"));
      return "unreachable";
    }
    d.toast(t("phone.main.couldntOpenCard", { message: (failure as Error | undefined)?.message ?? "" }));
    return "error";
  }
  if (kind === "offer") {
    // Offers live in the thread list's 待處理 section, not in a thread's cards (and may have no
    // thread yet): never poll for a card that cannot come, never raise an unrelated approval.
    if (loc.status === "unknown") {
      d.toast(t("phone.main.thisCardCantBeFound"));
      return "not_found";
    }
    if (loc.status !== "pending") {
      d.toast(t("phone.main.thisHasAlreadyBeenTaken"));
      return "handled";
    }
    if (from === "app") return "on_screen";
    d.openOffer(id);
    return "offer";
  }
  if (!loc.threadId) {
    d.toast(t("phone.main.thisCardCantBeFound"));
    return "not_found";
  }
  if (loc.status !== "pending") {
    d.toast(t("phone.main.thisHasAlreadyBeenTaken"));
    return "handled";
  }
  if (from === "app" && loc.threadId === d.threadId()) return "on_screen";
  if (from === "app") {
    d.banner(t("phone.main.anotherChatIsWaitingFor"), () => void reach(d, kind, id, "push"));
    return "banner";
  }
  if (loc.threadId !== d.threadId()) await d.openThread(loc.threadId);
  for (let waited = 0; waited <= CARD_WAIT_MS; waited += 75) {
    if (d.openCard(id)) return "opened";
    await sleep(75);
  }
  d.openFirst();
  return "card_missing";
}

/** `waitOnline` over a Link client (status + onStatus). */
export function waitForOnline(
  c: { status: string; onStatus(h: (s: string) => void): () => void },
  ms: number,
): Promise<boolean> {
  if (c.status === "online") return Promise.resolve(true);
  if (c.status === "revoked") return Promise.resolve(false);
  return new Promise((resolve) => {
    let off = () => {};
    const timer = setTimeout(() => {
      off();
      resolve(false);
    }, ms);
    off = c.onStatus((s) => {
      if (s !== "online" && s !== "revoked") return;
      clearTimeout(timer);
      off();
      resolve(s === "online");
    });
  });
}

/** The same tap can arrive up to three ways (postMessage, the pending cache, `#open=`): act once. */
export function once(windowMs = 10_000, now: () => number = Date.now): (key: string) => boolean {
  const seen = new Map<string, number>();
  return (key) => {
    const t0 = now();
    for (const [k, at] of seen) if (t0 - at > windowMs) seen.delete(k);
    if (seen.has(key)) return false;
    seen.set(key, t0);
    return true;
  };
}

// Shared with sw.ts (a classic worker cannot import; test/sw.test.ts checks they match).
export const PENDING_CACHE = "alca-pending";
export const PENDING_KEY = "./__alca-open";
/** A pending tap older than this is stale (the person moved on). */
export const PENDING_MAX_AGE_MS = 5 * 60_000;
const KINDS = new Set(["approval", "question", "handoff", "test", "offer"]);

interface CacheLike {
  match(k: string): Promise<{ json(): Promise<unknown> } | undefined>;
  delete(k: string): Promise<boolean>;
}

/** Read (and remove) what the service worker left for the page: [kind, id] or undefined. */
export async function takePendingOpen(
  storage: { open(name: string): Promise<CacheLike> } | undefined,
  now = Date.now(),
): Promise<[string, string] | undefined> {
  if (!storage) return undefined;
  try {
    const c = await storage.open(PENDING_CACHE);
    const r = await c.match(PENDING_KEY);
    if (!r) return undefined;
    await c.delete(PENDING_KEY);
    const p = (await r.json()) as { t?: unknown; id?: unknown; at?: unknown };
    if (typeof p.t !== "string" || !KINDS.has(p.t)) return undefined;
    if (typeof p.at !== "number" || now - p.at > PENDING_MAX_AGE_MS || p.at > now + 60_000) return undefined;
    const id = typeof p.id === "string" && /^[A-Za-z0-9_-]{0,64}$/.test(p.id) ? p.id : "";
    return [p.t, id];
  } catch {
    return undefined;
  }
}

/** Drop what the service worker left (the tap already arrived another way). */
export async function dropPendingOpen(
  storage: { open(name: string): Promise<CacheLike> } | undefined,
): Promise<void> {
  if (!storage) return;
  try {
    await (await storage.open(PENDING_CACHE)).delete(PENDING_KEY);
  } catch {
    // nothing left behind to replay is the goal; a failed delete only means once() decides
  }
}

interface ListenerTarget {
  addEventListener(type: string, h: (e: Event) => void, o?: { signal?: AbortSignal }): void;
}

/**
 * The ways a notification tap reaches the page: the pending cache (at start and whenever the
 * page becomes visible) and the service worker's message. Every listener is tied to `signal`,
 * aborted when the session ends (revoke, 忘記這台電腦), so a later session never also runs
 * reach() on a dead client. A tap that arrives as a message also removes the pending note
 * (the worker writes it before posting), so a later resume cannot replay it.
 */
export function wireOpens(o: {
  doc: ListenerTarget & { visibilityState: string };
  sw: ListenerTarget | undefined;
  storage: { open(name: string): Promise<CacheLike> } | undefined;
  signal: AbortSignal;
  go(kind: string, id: string): void;
}): void {
  const { signal } = o;
  const pending = () =>
    void takePendingOpen(o.storage).then((p) => {
      if (p && !signal.aborted) o.go(p[0], p[1]);
    });
  pending();
  o.doc.addEventListener("visibilitychange", () => o.doc.visibilityState === "visible" && pending(), {
    signal,
  });
  o.sw?.addEventListener(
    "message",
    (e) => {
      const m = (e as MessageEvent).data as { type?: string; t?: string; id?: string } | null;
      if (m?.type !== "alca-open" || !m.t || signal.aborted) return;
      void dropPendingOpen(o.storage);
      o.go(m.t, m.id ?? "");
    },
    { signal },
  );
}
