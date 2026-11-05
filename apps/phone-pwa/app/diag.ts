// 診斷 (P8): everything worth knowing when testing on a real phone — the
// Link connection, notifications, storage and versions — on one screen, with
// a copy button. Reachable from 裝置, from the pairing screen and as `#diag`.
// It shows states and short ids only: no keys, no message content.

import { checkConnection, connectionCheckText } from "./connection-check.ts";
import { browserLabel, canInstall, promptInstall, requestPersist, storageInfo, swVersion } from "./device.ts";
import { h, haptic, icon } from "./dom.ts";
import { t as tx } from "./i18n/index.ts";
import { kv, probeStorage } from "./keystore.ts";
import { isStandalone, openPushPrompt, PUSH_STATE_TEXT, type PushState, pushState } from "./push.ts";
import type { Session } from "./session.ts";
import { Sheet } from "./sheet.ts";
import { toast } from "./toast.ts";

type Tone = "ok" | "warn" | "bad" | "none";
interface Row {
  k: string;
  v: string;
  tone?: Tone;
}

/** P13: the direct path's state (only shown when the computer offers one). */
const RTC_TEXT: Record<string, string> = {
  trying: tx("phone.diag.settingUpADirectConnection"),
  up: tx("phone.diag.direct"),
  failed: tx("phone.diag.directConnectionFailedUsingThe"),
  unavailable: tx("phone.diag.thisBrowserDoesntSupportIt"),
};

const CONN: Record<string, [string, Tone]> = {
  online: [tx("phone.diag.connected"), "ok"],
  connecting: [tx("common.connecting"), "warn"],
  offline: [tx("phone.diag.offlineRetryingLater"), "bad"],
  revoked: [tx("phone.diag.revoked"), "bad"],
  idle: [tx("phone.diag.notStarted"), "none"],
};

const PUSH_TONE: Record<PushState, Tone> = {
  on: "ok",
  off: "warn",
  default: "warn",
  "needs-install": "warn",
  denied: "bad",
  unsupported: "bad",
};

const mb = (n: number | null) =>
  n === null ? "—" : n < 1e6 ? `${Math.round(n / 1e3)} KB` : `${(n / 1e6).toFixed(1)} MB`;
const clock = (t: number) =>
  t
    ? new Date(t).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "—";
const px = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "0px";

async function collect(s: Session | undefined) {
  const [push, storage, probe, sw, hasIdentity] = await Promise.all([
    pushState(),
    storageInfo(),
    probeStorage(),
    swVersion(),
    kv.get("identity").then(
      (x) => !!x,
      () => false,
    ),
  ]);
  interface CorePush {
    subscribed: boolean;
    subscriptions: Array<{ endpointHost: string; lastSentAt: string | null }>;
  }
  const core: CorePush | null =
    s?.conn === "online" ? await s.client.request<CorePush>("push.status", {}, 4000).catch(() => null) : null;
  const c = s?.client;
  interface CoreHealth {
    ok: boolean | null;
    reason: string;
    lastCheckAt: string | null;
    repairs: number;
  }
  // P9: is the computer listed on each relay this phone knows, and how did the computer's own check go?
  const [relays, health] = await Promise.all([
    c ? c.probeRelays(4000).catch(() => []) : Promise.resolve([]),
    s?.conn === "online"
      ? s.client.request<CoreHealth>("link.health", {}, 4000).catch(() => null)
      : Promise.resolve(null),
  ]);
  const relayRows: Row[] = relays.map((r, i) => ({
    k: i === 0 ? tx("common.relay") : tx("phone.diag.backupRelay"),
    v: `${new URL(r.url).host} · ${r.online === true ? tx("phone.diag.computerOnlineMs", { ms: r.ms }) : r.online === false ? tx("phone.diag.reachableComputerNotThere") : tx("phone.diag.unreachable")}`,
    tone: r.online === true ? "ok" : r.online === false ? "warn" : "bad",
  }));
  const healthRows: Row[] = health
    ? [
        {
          k: tx("phone.diag.computerSelfCheck"),
          v: `${health.ok === null ? tx("phone.diag.neverRun") : health.ok ? tx("common.normal") : tx("phone.diag.failed", { reason: health.reason })} · ${clock(Date.parse(health.lastCheckAt ?? "") || 0)}${health.repairs ? tx("phone.diag.autoRepairedTimes", { repairs: health.repairs }) : ""}`,
          tone: health.ok === false ? "warn" : health.ok ? "ok" : "none",
        },
      ]
    : [];
  const link: Row[] = s
    ? [
        { k: tx("common.status"), v: CONN[s.conn]?.[0] ?? s.conn, tone: CONN[s.conn]?.[1] ?? "none" },
        { k: tx("phone.diag.computer"), v: s.coreName },
        {
          k: tx("phone.diag.route"),
          v:
            c?.via === "rtc"
              ? tx("phone.diag.webrtcDirectEncryptionLayerUnchanged")
              : c?.via === "lan"
                ? tx("phone.diag.localNetworkDirect")
                : tx("phone.diag.relay", { host: new URL(s.credentials.relayUrl).host }),
          tone: c?.via === "rtc" || c?.via === "lan" ? "ok" : "none",
        },
        ...(c && c.rtcStats.state !== "off"
          ? [
              {
                k: "WebRTC",
                v:
                  RTC_TEXT[c.rtcStats.state] +
                  (c.rtcStats.lastError ? tx("phone.diag.text", { lastError: c.rtcStats.lastError }) : ""),
                tone: (c.rtcStats.state === "up"
                  ? "ok"
                  : c.rtcStats.state === "failed"
                    ? "warn"
                    : "none") as Tone,
              },
            ]
          : []),
        { k: tx("common.thisPhone"), v: s.credentials.deviceId.slice(0, 12) },
        {
          k: tx("phone.diag.computerKey"),
          v: s.credentials.coreFingerprint.slice(0, 16).replace(/(.{4})(?=.)/g, "$1 "),
        },
        {
          k: tx("phone.diag.roundTripLatency"),
          v: c && c.stats.lastRttMs >= 0 ? `${c.stats.lastRttMs} ms` : "—",
          tone: c && c.stats.lastRttMs > 1500 ? "warn" : "none",
        },
        {
          k: tx("phone.diag.connectedThisSession"),
          v: tx("phone.diag.timesLast", {
            connects: c?.stats.connects ?? 0,
            lastOnlineAt: clock(c?.stats.lastOnlineAt ?? 0),
          }),
        },
        ...(c?.stats.lastError
          ? [{ k: tx("phone.diag.lastError"), v: c.stats.lastError, tone: "bad" as Tone }]
          : []),
        ...relayRows,
        ...healthRows,
      ]
    : [{ k: tx("common.status"), v: tx("phone.diag.notPairedYet"), tone: "none" }];
  const notif: Row[] = [
    { k: tx("common.notifications"), v: PUSH_STATE_TEXT[push], tone: PUSH_TONE[push] },
    {
      k: tx("common.permissions"),
      v:
        "Notification" in window
          ? {
              granted: tx("phone.diag.allowed"),
              denied: tx("common.decline"),
              default: tx("phone.diag.notDecided"),
            }[Notification.permission]
          : "—",
    },
    {
      k: tx("phone.diag.homeScreenApp"),
      v: isStandalone() ? tx("phone.diag.yes") : tx("phone.diag.noBrowserTab"),
      tone: isStandalone() ? "ok" : "none",
    },
    ...(core
      ? [
          {
            k: tx("phone.diag.computerSideSubscription"),
            v: core.subscribed
              ? (core.subscriptions[0]?.endpointHost ?? tx("phone.diag.yes2"))
              : tx("common.no"),
            tone: (core.subscribed ? "ok" : "warn") as Tone,
          },
          {
            k: tx("phone.diag.lastDelivered"),
            v: clock(Date.parse(core.subscriptions[0]?.lastSentAt ?? "") || 0),
          },
        ]
      : []),
  ];
  const store: Row[] = [
    {
      k: tx("phone.diag.persistentStorage"),
      v:
        storage.persisted === null
          ? tx("phone.diag.notSupported")
          : storage.persisted
            ? tx("phone.diag.kept")
            : tx("phone.diag.mayBeCleared"),
      tone: storage.persisted ? "ok" : "warn",
    },
    { k: tx("phone.diag.usage"), v: `${mb(storage.usage)} / ${mb(storage.quota)}` },
    {
      k: "IndexedDB",
      v: probe.ok ? tx("phone.diag.okMs", { ms: probe.ms }) : tx("phone.diag.error", { error: probe.error }),
      tone: probe.ok ? "ok" : "bad",
    },
    {
      k: tx("phone.diag.identityKey"),
      v: hasIdentity ? tx("phone.diag.onThisPhoneCantBe") : tx("phone.diag.noneYet"),
      tone: hasIdentity ? "ok" : "none",
    },
  ];
  const vv = window.visualViewport;
  const versions: Row[] = [
    {
      k: tx("phone.diag.appVersion"),
      v: sw ?? tx("phone.diag.serviceWorkerNotInControl"),
      tone: sw ? "none" : "warn",
    },
    { k: tx("common.browser"), v: browserLabel() },
    {
      k: tx("phone.diag.screen"),
      v: tx("phone.diag.visibleX", {
        innerWidth,
        innerHeight,
        p2: Math.round(vv?.height ?? innerHeight),
        devicePixelRatio,
      }),
    },
    {
      k: tx("phone.diag.safeArea"),
      v: tx("phone.diag.topBottom", { p0: px("--safe-top"), p1: px("--safe-bottom") }),
    },
  ];
  return { link, notif, store, versions, push };
}

function section(title: string, rows: Row[]): HTMLElement {
  return h(
    "section",
    { class: "dg-sec" },
    h("h3", { class: "group-title" }, title),
    h(
      "dl",
      { class: "dg-list" },
      ...rows.map((r) =>
        h(
          "div",
          { class: "dg-row" },
          h("dt", {}, r.k),
          h(
            "dd",
            { "data-tone": r.tone ?? "none" },
            r.tone && r.tone !== "none" ? h("i", { class: "dg-dot" }) : "",
            r.v,
          ),
        ),
      ),
    ),
  );
}

export function openDiag(s: Session | undefined): Sheet {
  const content = h("div", { class: "dg-content" }, h("p", { class: "dg-loading" }, tx("common.loading")));
  // C5: the shared toast layer, over the sheet (a toast inside this long, scrolling
  // sheet sat at the end of its content, below the screen, so 重新連線 looked silent).
  const say = (m: string, ms = 2400) => void toast(m, ms);
  let last: Awaited<ReturnType<typeof collect>> | undefined;
  const paint = async () => {
    last = await collect(s);
    content.replaceChildren(
      section(tx("common.connection"), last.link),
      section(tx("common.notifications"), last.notif),
      section(tx("common.save"), last.store),
      section(tx("common.version"), last.versions),
    );
    install.hidden = !canInstall();
  };
  const act = (label: string, ico: string, fn: () => Promise<void> | void, hidden = false) =>
    h(
      "button",
      {
        class: "row dg-act",
        type: "button",
        hidden,
        onclick: async () => {
          haptic("tap");
          await fn();
        },
      },
      icon(ico, 20),
      h("span", { class: "row-text" }, label),
    );
  const install = act(tx("phone.diag.installToHomeScreen"), "plus", async () => {
    await promptInstall();
    void paint();
  });
  // The actions as rows in one inset-grouped cell (§3.9), not a grid of boxed buttons.
  const actions = h(
    "div",
    { class: "group dg-acts", role: "group" },
    h(
      "div",
      { class: "cells" },
      act(tx("phone.diag.sendATestNotification"), "bell", async () => {
        if (s?.conn !== "online") return say(tx("phone.diag.notConnectedToTheComputer"));
        if (last?.push !== "on") {
          await openPushPrompt(s, () => void paint());
          return;
        }
        try {
          await s.client.request("push.test");
          say(tx("phone.diag.sentItShouldAppearIn"));
        } catch (e) {
          say(tx("phone.diag.notSent", { message: (e as Error).message }));
        }
        void paint();
      }),
      act(tx("common.reconnect"), "refresh", async () => {
        if (!s) return;
        // C5: say something at once, then the outcome (round trip, or why not).
        if (s.client.status !== "online") say(tx("phone.diag.reconnecting"));
        say(connectionCheckText(await checkConnection(s.client)), 4000);
        void paint();
      }),
      act(tx("phone.diag.keepStorage"), "memory", async () => {
        const ok = await requestPersist(true);
        say(ok ? tx("phone.diag.theBrowserWillKeepAlcas") : tx("phone.diag.theBrowserSaidNoInstall"));
        void paint();
      }),
      install,
      act(tx("phone.diag.copyDiagnostics"), "export", async () => {
        if (!last) return;
        const text = [
          tx("phone.diag.alcaDiagnostics", { p0: new Date().toISOString() }),
          ...(["link", "notif", "store", "versions"] as const).flatMap((k) =>
            (last?.[k] ?? []).map((r) => `${r.k}: ${r.v}`),
          ),
        ].join("\n");
        try {
          await navigator.clipboard.writeText(text);
          say(tx("phone.diag.copied"));
        } catch {
          say(tx("phone.diag.couldntCopyTheBrowserDoesnt"));
        }
      }),
    ),
  );
  const body = h(
    "div",
    { class: "dg-sheet" },
    h(
      "div",
      { class: "sheet-title" },
      h("h2", {}, tx("common.diagnostics")),
      h("p", {}, tx("phone.diag.lookHereWhenTestingOn")),
    ),
    actions,
    content,
  );
  const off = s?.subscribe((w) => w === "conn" && void paint());
  const timer = setInterval(() => void paint(), 5000);
  // One round trip now, so 往返延遲 has a number (the keep-alive pings only every 25 s).
  void (s?.conn === "online" ? s.client.resume(3000) : Promise.resolve(false)).finally(() => void paint());
  return new Sheet(body, {
    label: tx("common.diagnostics"),
    size: "full",
    onClose: () => {
      off?.();
      clearInterval(timer);
    },
  });
}
