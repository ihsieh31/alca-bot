// Alca phone app: boot, pairing or the live session, sheets.

import { googleScreen } from "./account.ts";
import { activityScreen } from "./activity-view.ts";
import { openBrowser } from "./browser.ts";
import { CardPresenter } from "./cards.ts";
import { ChatView } from "./chat.ts";
import { maybeComputerSignIn } from "./computer-view.ts";
import { siteConfig } from "./config.ts";
import { openConnect } from "./connect.ts";
import { captureInstallPrompt, requestPersist } from "./device.ts";
import { openDevicesPage, settingsScreen } from "./devices.ts";
import { openDiag } from "./diag.ts";
import { h, icon } from "./dom.ts";
import { userFromRedirect } from "./google.ts";
import { applyLocalePref, LOCALE_STORAGE_KEY, locale, t as tx } from "./i18n/index.ts";
import { kv, loadSaved, type ThemePref } from "./keystore.ts";
import { openLibrary } from "./memory.ts";
import { pairingScreen, paramsFromHash } from "./pairing.ts";
import { isIos, isStandalone, maybeOfferPush, openInstallGuide, openPushPrompt, resyncPush } from "./push.ts";
import { once, type ReachDeps, type ReachFrom, reach, waitForOnline, wireOpens } from "./reach.ts";
import { Session } from "./session.ts";
import { closeAll } from "./sheet.ts";
import { openProposal } from "./skills.ts";
import { Shell, type TabId } from "./tabs.ts";
import { openPeer, openTeam, type TeamActions } from "./team.ts";
import { applyTheme } from "./theme.ts";
import { threadsScreen } from "./threads-view.ts";
import { toast, toastLayer } from "./toast.ts";
import { group, largeTitleScreen, row } from "./ui.ts";
import { watchViewport } from "./viewport.ts";
import { openWorkers } from "./workers.ts";

// R9.3: the phone's interface language (its own choice, 裝置 › 介面語言; default auto = the system's).
const localePref = (() => {
  try {
    return localStorage.getItem(`${LOCALE_STORAGE_KEY}.pref`) ?? "auto";
  } catch {
    return "auto";
  }
})();
applyLocalePref(localePref);

const root = document.getElementById("app") as HTMLElement;

// Preview hook (screenshots, desktop browsers): `?safe=47,34` stands in for a notch and a home
// indicator; `?safe=0,21,59,59` adds the left / right insets of a phone held sideways.
const safe = new URLSearchParams(location.search).get("safe");
if (safe) {
  const sides = ["top", "bottom", "left", "right"];
  for (const [i, n] of safe.split(",").slice(0, 4).entries())
    document.documentElement.style.setProperty(`--safe-${sides[i]}`, `${Number(n) || 0}px`);
}

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch(() => undefined);
  // Notifications speak the app's 介面語言, not only the system's (sw.ts keeps it). A change
  // reloads the page (applyLocalePref), so telling it at every start is enough.
  void navigator.serviceWorker.ready
    .then((r) => r.active?.postMessage({ type: "alca-locale", locale: locale() }))
    .catch(() => undefined);
}
watchViewport();
captureInstallPrompt();
toastLayer(); // the live region exists (empty) before its first message

/** `#open=approval:apv_…` (a tapped notification opened the app) → [type, id]. */
const openRef = (hash = location.hash): [string, string] | undefined => {
  const m = /(?:^#|&)open=(approval|question|handoff|offer|test)(?::([A-Za-z0-9_-]{1,64}))?/.exec(hash);
  return m ? [m[1] as string, m[2] ?? ""] : undefined;
};

const saved = await loadSaved();
let theme: ThemePref = saved.theme ?? "system";
applyTheme(theme);
matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => applyTheme(theme));

const config = await siteConfig();
const googleId = config.googleClientId;
// P12: /computer-signin (a computer signing in with Google through this site), or the way back from it.
const forComputer = await maybeComputerSignIn(root, config);
// Back from the full-page Google sign-in (fallback): the token is in the fragment.
const redirected = googleId && !forComputer ? userFromRedirect() : undefined;

/** 用 Google 登入 (P10) when the site has a client ID; pairing codes otherwise. */
function showSignIn() {
  if (!googleId) return showPairing();
  root.replaceChildren(
    googleScreen({
      config: { ...config, googleClientId: googleId },
      identity: saved.identity,
      user: redirected,
      onPairCode: () => showPairing(),
      onEnrolled: (credentials, identity) => {
        saved.credentials = credentials;
        saved.identity = identity;
        showApp();
      },
    }),
  );
}

function showPairing() {
  root.replaceChildren(
    pairingScreen({
      params: paramsFromHash(),
      identity: saved.identity,
      relayDefault: config.relayUrl,
      onGoogle: googleId ? () => showSignIn() : undefined,
      onDiag: () => openDiag(undefined),
      installHint: isIos() && !isStandalone() ? () => void openInstallGuide() : undefined,
      onPaired: (credentials, identity) => {
        saved.credentials = credentials;
        saved.identity = identity;
        showApp();
      },
    }),
  );
  root.querySelector<HTMLElement>("[data-autofocus]")?.focus({ preventScroll: true });
}

/** The live session's page listeners; aborted when it ends (revoke, 忘記這台電腦) — see wireOpens. */
let live: AbortController | undefined;
function endSession() {
  live?.abort();
  live = undefined;
}

function showApp() {
  const { credentials, identity } = saved;
  if (!credentials || !identity) return showSignIn();
  endSession();
  const ended = new AbortController();
  live = ended;
  const { signal } = ended;
  const s = new Session(credentials, identity);
  const cards = new CardPresenter(s, () => shell.chatOpen);
  const openThread = (id: string) => {
    void s.openThread(id);
    shell.openChat();
  };
  const compose = () => {
    void s.newThread();
    shell.openChat();
    chat.focusComposer();
  };
  const chat = new ChatView(s, {
    back: () => shell.closeChat(),
    openWorkers: (id) => openWorkers(s, id, () => cards.openFirst()),
    openBrowser: () => openBrowser(s, undefined, () => cards.openFirst()),
    openCards: () => cards.openFirst(),
    openProposal: (id) => proposal(id),
    openPeer: (id) => openPeer(s, id, teamActs),
  });
  const proposal = (id: string) => {
    const i = s.proposals.findIndex((p) => p.id === id);
    const p = s.proposals[i];
    if (p) openProposal(s, p, s.proposals.length - 1);
  };
  const teamActs: TeamActions = {
    talkTo: (botId) => {
      closeAll();
      void s.newThread(botId);
      shell.openChat();
      chat.focusComposer();
    },
    openThread: (id) => {
      closeAll();
      openThread(id);
    },
  };
  const devices = () => openDevicesPage(s);
  const chatsScreen = threadsScreen(s, { open: openThread, compose });
  const shell = new Shell(s, {
    chat: chat.el,
    onChat: (open) => {
      // §3.5: an approval presents itself while its conversation is open; otherwise it waits in 需要你.
      if (open) cards.sync(true);
      else void s.refreshThreads().catch(() => undefined);
    },
    screens: {
      chats: chatsScreen,
      activity: activityScreen(s, {
        openCard: (id) => {
          if (!cards.openById(id)) cards.openFirst();
        },
        openThread,
        openTask: (id) => openWorkers(s, id, () => cards.openFirst()),
        openBrowser: (id) => openBrowser(s, id, () => cards.openFirst()),
        openProposal: proposal,
        openRoutines: () => openConnect(s, "routines"),
      }),
      library: libraryScreen(s, {
        team: () => openTeam(s, teamActs),
        memory: () => openLibrary(s, "memory"),
        skills: () => openLibrary(s, "skills"),
        connect: () => openConnect(s, "apps"),
      }),
      settings: settingsScreen(s, {
        theme: () => theme,
        onDiag: () => openDiag(s),
        onTheme: (t) => {
          theme = t;
          applyTheme(t);
        },
        onForget: async () => {
          endSession();
          s.client.stop();
          // P13: the offline cache goes with it (keys first, so nothing left can be read).
          await s.offline.destroy().catch(() => undefined);
          await kv.del("credentials");
          await kv.del("lastThread");
          delete saved.credentials;
          // In the page (see revoked()): no network round trip to a host that may be gone.
          closeAll();
          for (const l of document.querySelectorAll(".sheet-layer")) l.remove();
          showSignIn();
        },
      }),
    },
  });
  s.subscribe((what) => {
    if (what === "cards" || what === "thread") cards.sync();
    if (what === "conn" && s.conn === "revoked") {
      endSession();
      void s.offline.destroy().catch(() => undefined);
      revoked();
    }
  });
  root.replaceChildren(shell.el);
  s.start();

  // P8: opened from a notification (or told by the core while in front) → the card, over Link (reach.ts).
  const deps: ReachDeps = {
    online: () => s.client.status === "online",
    waitOnline: (ms) => waitForOnline(s.client, ms),
    locate: (kind, id) =>
      s.client.request<{ threadId: string | null; status: string }>("cards.locate", { kind, id }),
    threadId: () => s.threadId,
    openThread: async (id) => {
      await s.openThread(id);
      shell.openChat();
    },
    openCard: (id) => cards.openById(id),
    openFirst: () => cards.openFirst(),
    openOffer: (id) => {
      closeAll();
      shell.select("chats");
      chatsScreen.querySelector(".offer-sec")?.dispatchEvent(new CustomEvent("reveal", { detail: id }));
    },
    openBrowser: () => void openBrowser(s, undefined, () => cards.openFirst()),
    // A reach still running when its session ended says nothing over the next one.
    toast: (msg) => void (signal.aborted || toast(msg)),
    banner: (msg, onTap) => void (signal.aborted || chat.banner(msg, onTap)),
  };
  const fresh = once();
  const go = (t: string, id: string, from: ReachFrom) => {
    // The same tap may arrive as a message, from the pending cache and in the URL.
    if (signal.aborted || (from === "push" && !fresh(`${t}:${id}`))) return;
    void reach(deps, t, id, from);
  };
  const pinged = openRef();
  if (pinged) history.replaceState(null, "", location.pathname + location.search);
  // Not after the first connection any more: reach() says it is connecting and waits itself.
  if (pinged) go(pinged[0], pinged[1], "push");
  wireOpens({
    doc: document,
    sw: navigator.serviceWorker,
    storage: typeof caches === "undefined" ? undefined : caches,
    signal,
    go: (t, id) => go(t, id, "push"),
  });
  let first = true;
  s.client.onReady(() => {
    void resyncPush(s);
    void requestPersist();
    if (first && !pinged) setTimeout(() => void maybeOfferPush(s), 1600);
    first = false;
  });
  s.client.onEvent((ch, e) => {
    const p = e as { t?: string; id?: string };
    if (ch === "notify" && typeof p.t === "string") go(p.t, p.id ?? "", "app");
  });
  // `#chat`, `#tab-activity` / `#tab-library` / `#tab-settings`, `#workers`, `#browser`, `#devices`,
  // `#memory`, `#skills`, `#connect`, `#routines`, `#team`, `#activity`, `#diag`, `#notifications`
  // open a screen directly (home-screen shortcuts, screenshots).
  const open = pinged ? "" : location.hash.replace(/^#/, "");
  const tab = /^tab-(chats|activity|library|settings)$/.exec(open)?.[1] as TabId | undefined;
  if (tab) shell.select(tab);
  if (open && !tab)
    s.client.onReady(() => {
      setTimeout(() => {
        if (open === "chat") shell.openChat();
        else if (open === "workers") openWorkers(s, undefined, () => cards.openFirst());
        else if (open === "browser") openBrowser(s, undefined, () => cards.openFirst());
        else if (open === "devices") devices();
        else if (open === "memory" || open === "skills") openLibrary(s, open);
        else if (open === "connect") openConnect(s, "apps");
        else if (open === "routines") openConnect(s, "routines");
        else if (open === "team") openTeam(s, teamActs);
        else if (open === "activity") openTeam(s, teamActs, "activity");
        else if (open === "diag") openDiag(s);
        else if (open === "notifications") void openPushPrompt(s);
      }, 120);
    });
}

/** 資料庫 tab: 團隊, 記憶, 技能, 連接 — each a pushed page. */
function libraryScreen(
  s: Session,
  o: { team(): void; memory(): void; skills(): void; connect(): void },
): HTMLElement {
  const teamSub = h("span", {}, tx("phone.library.teamSub"));
  s.subscribe((w) => {
    if (w === "team") teamSub.textContent = teamLine(s);
  });
  return largeTitleScreen({
    title: tx("phone.ui.tabLibrary"),
    className: "library-screen",
    content: group({
      rows: [
        row({
          icon: "team",
          title: tx("common.team"),
          sub: teamSub,
          chevron: true,
          onclick: o.team,
          attrs: { "data-row": "team" },
        }),
        row({
          icon: "memory",
          title: tx("common.memory"),
          sub: tx("phone.library.memorySub"),
          chevron: true,
          onclick: o.memory,
          attrs: { "data-row": "memory" },
        }),
        row({
          icon: "checkCircle",
          title: tx("phone.library.skills"),
          sub: tx("phone.library.skillsSub"),
          chevron: true,
          onclick: o.skills,
          attrs: { "data-row": "skills" },
        }),
        row({
          icon: "plug",
          title: tx("common.connections"),
          sub: tx("phone.library.connectSub"),
          chevron: true,
          onclick: o.connect,
          attrs: { "data-row": "connect" },
        }),
      ],
      footer: tx("phone.library.footer"),
    }),
  }).el;
}

/** The team row's second line: how many, and who waits for the person. */
function teamLine(s: Session): string {
  const bots = s.team?.bots ?? [];
  const waiting = bots.filter((b) => b.activity.waiting > 0).length;
  if (bots.length < 2) return tx("phone.drawer.addTeammatesAndShareThe");
  return waiting
    ? tx("phone.drawer.membersWaitingOnYou", { botsCount: bots.length, waiting })
    : tx("phone.drawer.membersWhosDoingWhat", { botsCount: bots.length });
}

function revoked() {
  root.replaceChildren(
    h(
      "section",
      { class: "screen ob pairing revoked" },
      h(
        "div",
        { class: "ob-head" },
        h("div", { class: "ob-mark", "aria-hidden": "true" }, icon("phone", 28)),
        h("h1", { class: "ob-title" }, tx("common.thisPhoneHasBeenRevoked")),
        h("p", { class: "ob-sub" }, tx("phone.main.theComputerNoLongerAccepts")),
      ),
      h(
        "div",
        { class: "ob-actions ob-bottom" },
        h(
          "button",
          {
            class: "btn big primary",
            type: "button",
            onclick: async () => {
              // In the page, not location.reload(): a reload goes to the network, and a computer
              // whose tunnel is gone answers with the host's error page (Cloudflare 1033) instead.
              await kv.del("credentials");
              await kv.del("lastThread");
              delete saved.credentials;
              history.replaceState(null, "", location.pathname + location.search);
              closeAll();
              for (const l of document.querySelectorAll(".sheet-layer")) l.remove();
              showSignIn();
            },
          },
          googleId ? tx("common.reconnect") : tx("phone.main.pairAgain"),
        ),
      ),
    ),
  );
}

if (forComputer) {
  // The computer's sign-in owns this page load.
} else if (saved.credentials && saved.identity && !paramsFromHash().code) showApp();
else if (paramsFromHash().code) showPairing();
else showSignIn();
// 診斷 works before pairing too.
if (location.hash === "#diag" && !saved.credentials && !forComputer) openDiag(undefined);
