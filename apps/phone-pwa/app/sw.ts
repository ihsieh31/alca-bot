// Service worker: the app shell works offline (and opens instantly); the
// live data never touches the cache — it only travels over the Link socket.
// The build replaces the two constants below.
//
// Push (P8): a push carries `{v, t, id}` only — a type and an opaque id. The
// notification shows a fixed local sentence for the type; tapping it opens
// (or focuses) the app at `#open=<type>:<id>`, and the app fetches the card
// over Link. Nothing about the card is ever in the notification.
const VERSION = "__VERSION__";
const ASSETS: string[] = JSON.parse("__ASSETS__") as string[];
// R9: a classic service worker cannot import the string table, so the build fills in the
// words for the keys below (both languages). It follows the app's own 介面語言 choice, which the
// page posts here (alca-locale) and this keeps in a small cache; the system language until then.
const WORDS = JSON.parse("__WORDS__") as Record<string, Record<string, string>>;
const CACHE = `alca-shell-${VERSION}`;

interface SwEvent extends Event {
  waitUntil(p: Promise<unknown>): void;
}
interface FetchEv extends SwEvent {
  request: Request;
  respondWith(r: Promise<Response> | Response): void;
}
interface PushEv extends SwEvent {
  data: { json(): unknown } | null;
}
interface ClickEv extends SwEvent {
  notification: { data: unknown; close(): void; tag: string };
  action: string;
}
interface MessageEv extends SwEvent {
  data: unknown;
  ports: MessagePort[];
}
interface WinClient {
  url: string;
  focused: boolean;
  focus(): Promise<WinClient>;
  navigate(url: string): Promise<WinClient | null>;
  postMessage(m: unknown): void;
}
const sw = self as unknown as {
  addEventListener(t: "install" | "activate", h: (e: SwEvent) => void): void;
  addEventListener(t: "fetch", h: (e: FetchEv) => void): void;
  addEventListener(t: "push", h: (e: PushEv) => void): void;
  addEventListener(t: "notificationclick", h: (e: ClickEv) => void): void;
  addEventListener(t: "message", h: (e: MessageEv) => void): void;
  skipWaiting(): Promise<void>;
  registration: {
    scope: string;
    showNotification(title: string, o: Record<string, unknown>): Promise<void>;
    getNotifications(o?: { tag?: string }): Promise<Array<{ close(): void }>>;
  };
  clients: {
    claim(): Promise<void>;
    matchAll(o: { type: "window"; includeUncontrolled: boolean }): Promise<WinClient[]>;
    openWindow(url: string): Promise<WinClient | null>;
  };
};

type Lang = "zh-Hant-TW" | "en";
const SYSTEM_LANG: Lang = /^zh\b/i.test(
  (self as unknown as { navigator?: { language?: string } }).navigator?.language ?? "zh",
)
  ? "zh-Hant-TW"
  : "en";
let LANG: Lang = SYSTEM_LANG;
const tx = (key: string): string => WORDS[LANG]?.[key] ?? WORDS["zh-Hant-TW"]?.[key] ?? key;

// The app's language choice (same names as app/main.ts; test/sw.test.ts checks).
const PREFS_CACHE = "alca-prefs";
const LOCALE_KEY = "./__alca-locale";
const isLang = (v: unknown): v is Lang => v === "zh-Hant-TW" || v === "en";
function chosenLang(): Promise<Lang> {
  return caches
    .open(PREFS_CACHE)
    .then((c) => c.match(LOCALE_KEY))
    .then((r) => (r ? r.text() : ""))
    .then((v) => (isLang(v) ? v : SYSTEM_LANG))
    .catch(() => SYSTEM_LANG);
}

/** The only words a notification can have: fixed per type, chosen here (in LANG), never sent. */
const NOTICE: Record<string, () => { title: string; body: string }> = {
  approval: () => ({ title: tx("common.waitingOnYou"), body: tx("common.somethingNeedsYourOkOpen") }),
  question: () => ({ title: tx("phone.sw.alcaHasAQuestion"), body: tx("phone.sw.openAlcaToAnswer") }),
  handoff: () => ({ title: tx("phone.sw.needsYouToTakeOver"), body: tx("phone.sw.theresAStepInThe") }),
  offer: () => ({ title: tx("phone.sw.alcaNoticedSomething"), body: tx("phone.sw.openAlcaToSeeWhether") }),
  test: () => ({ title: tx("phone.sw.notificationsAreOn"), body: tx("phone.sw.fromNowOnYoullBe") }),
};
const OPAQUE = /^[A-Za-z0-9_-]{1,64}$/;

sw.addEventListener("push", (e) => {
  let t = "approval";
  let id = "";
  try {
    const p = (e.data?.json() ?? {}) as { t?: unknown; id?: unknown };
    if (typeof p.t === "string" && p.t in NOTICE) t = p.t;
    if (typeof p.id === "string" && OPAQUE.test(p.id)) id = p.id;
  } catch {
    // unreadable payload: still a ping (Safari requires a visible notification for every push)
  }
  e.waitUntil(
    chosenLang().then((lang) => {
      LANG = lang;
      const n = (NOTICE[t] ?? (NOTICE.approval as () => { title: string; body: string }))();
      return sw.registration.showNotification(n.title, {
        body: n.body,
        tag: id || t,
        data: { t, id },
        icon: "./icons/icon-192.png",
        badge: "./icons/badge-96.png",
        timestamp: Date.now(),
        requireInteraction: t === "approval",
      });
    }),
  );
});

sw.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const d = (e.notification.data ?? {}) as { t?: string; id?: string };
  const t = typeof d.t === "string" && d.t in NOTICE ? d.t : "approval";
  const id = typeof d.id === "string" && OPAQUE.test(d.id) ? d.id : "";
  const target = new URL(`./#open=${t}${id ? `:${id}` : ""}`, sw.registration.scope).href;
  e.waitUntil(
    // BUG-7: a postMessage to a page iOS had frozen can be lost, and a Home Screen app may
    // open without the URL's fragment: leave the target where the page looks on start and
    // whenever it becomes visible (app/reach.ts takePendingOpen; the page acts on it once).
    rememberOpen(t, id)
      .then(() => sw.clients.matchAll({ type: "window", includeUncontrolled: true }))
      .then(async (list) => {
        const win = list.find((c) => c.url.startsWith(sw.registration.scope)) ?? list[0];
        if (win) {
          // An open app: bring it forward and tell it which card (no reload, the Link session stays).
          await win.focus().catch(() => undefined);
          win.postMessage({ type: "alca-open", t, id });
          return;
        }
        await sw.clients.openWindow(target);
      }),
  );
});

// Same names as app/reach.ts (PENDING_CACHE / PENDING_KEY; test/sw.test.ts checks).
const PENDING_CACHE = "alca-pending";
const PENDING_KEY = "./__alca-open";
function rememberOpen(t: string, id: string): Promise<void> {
  return caches
    .open(PENDING_CACHE)
    .then((c) =>
      c.put(
        PENDING_KEY,
        new Response(JSON.stringify({ t, id, at: Date.now() }), {
          headers: { "content-type": "application/json" },
        }),
      ),
    )
    .catch(() => undefined);
}

/**
 * Navigations: network first (a fresh shell when online), the cached shell when the
 * network fails — and also when the host answers with a server error. A computer's
 * tunnel that went away answers 530 (Cloudflare Error 1033): a response, not a network
 * error, so before this the error page replaced the app (re-pairing after a revoke).
 */
async function navigate(req: Request): Promise<Response> {
  const shell = () => caches.match("./index.html");
  let r: Response;
  try {
    r = await fetch(req);
  } catch {
    return (await shell()) ?? Response.error();
  }
  if (r.status >= 500) return (await shell()) ?? r;
  return r;
}

sw.addEventListener("message", (e) => {
  const m = e.data as { type?: string; locale?: unknown } | null;
  if (m?.type === "alca-version") e.ports[0]?.postMessage({ version: VERSION });
  if (m?.type === "alca-locale" && isLang(m.locale)) {
    const locale = m.locale;
    e.waitUntil(
      caches
        .open(PREFS_CACHE)
        .then((c) => c.put(LOCALE_KEY, new Response(locale, { headers: { "content-type": "text/plain" } })))
        .catch(() => undefined),
    );
  }
});

sw.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      // `reload`: past the HTTP cache. /app /styles /icons are max-age=300, so a new worker
      // installed within minutes of the last fetch would fill its cache with the old bytes.
      .then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: "reload" }))))
      .then(() => sw.skipWaiting()),
  );
});

sw.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k.startsWith("alca-shell-") && k !== CACHE).map((k) => caches.delete(k)),
        ),
      )
      .then(() => sw.clients.claim()),
  );
});

sw.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || url.pathname.startsWith("/v0/")) return;
  // Navigations: see navigate().
  if (req.mode === "navigate") {
    e.respondWith(navigate(req));
    return;
  }
  e.respondWith(caches.match(req).then((hit) => hit ?? fetch(req)));
});
