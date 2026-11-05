// 設定 (素 Plain §3.7): a settings window — a category list on the left (一般, 通知,
// 模型, 裝置與連線, 瀏覽器, Telegram, 資料, 關於), one pane on the right. config.json fields are
// saved at once through PATCH /api/settings; the other areas use their own
// APIs (settings-model / -connection / -system.ts). Payment / send / delete /
// publish always asking is stated, never offered as a switch. Fields read
// only at start are marked.
import type { Api } from "./api.ts";
import { h } from "./dom.ts";
import { applyLocalePref, t } from "./i18n/index.ts";
import { type IconName, icon } from "./icons.ts";
import { connectionSection } from "./settings-connection.ts";
import { modelSection } from "./settings-model.ts";
import { searchSection } from "./settings-search.ts";
import { aboutSection, backupSection, browserSection, telegramSection } from "./settings-system.ts";

export interface SettingsData {
  simple: { level: string; learning: boolean; pushPreview: "none" | "notify_only" };
  advanced: {
    defaultScopes: string[];
    allowPairing: boolean;
    rendezvousUrl: string | null;
    logLevel: string;
    browserAutoDownload: boolean;
    browserAutoDownloadLocked: boolean;
    locale?: string;
  };
  pendingRestart: string[];
}

/** Other dialogs and views the sections link into (set by app.ts once they exist). */
export interface SettingsHooks {
  onLevel: (level: string) => void;
  openProviders?: () => void;
  openConnection?: () => void;
  openPairing?: () => void;
  openTelegram?: () => void;
}

type Cat = "general" | "notifications" | "model" | "devices" | "browser" | "telegram" | "data" | "about";
const CATS: Array<[Cat, string, IconName]> = [
  ["general", t("common.general"), "gear"],
  ["notifications", t("common.notifications"), "bell"],
  ["model", t("desktop.settingsView.catModels"), "cpu"],
  ["devices", t("desktop.settingsView.catDevices"), "phone"],
  ["browser", t("common.browser"), "globe"],
  ["telegram", "Telegram", "send"],
  ["data", t("common.data"), "archive"],
  ["about", t("common.about"), "info"],
];
/** Old area names (#open=settings:<area>, other dialogs) → the category that holds them. */
const AREA_CAT: Record<string, Cat> = {
  model: "model",
  search: "model",
  connection: "devices",
  devices: "devices",
  browser: "browser",
  telegram: "telegram",
  backups: "data",
  data: "data",
  about: "about",
  notifications: "notifications",
};

const SCOPES: Array<[string, string]> = [
  ["chat", t("common.chat2")],
  ["approve", t("desktop.settingsView.approveCards")],
  ["view_screen", t("desktop.settingsView.viewTheBrowser")],
];
const LOGS: Array<[string, string]> = [
  ["error", t("desktop.settingsView.errorsOnly")],
  ["warn", t("desktop.settingsView.errorsAndWarnings")],
  ["info", t("desktop.settingsView.normalDefault")],
  ["debug", t("desktop.settingsView.verboseForDebugging")],
];
const RESTART = t("desktop.settingsView.takesEffectAfterRestartingAlca");

function choice(
  name: string,
  value: string,
  options: Array<[string, string, string?]>,
  onPick: (v: string) => void,
): HTMLElement {
  return h(
    "div",
    { class: "st-choice st-radios", role: "radiogroup", "aria-label": name },
    ...options.map(([v, label, help]) => {
      const input = h("input", {
        type: "radio",
        name,
        value: v,
        ...(v === value ? { checked: true } : {}),
        onchange: () => onPick(v),
      });
      return h(
        "label",
        { class: "st-option st-radio" },
        input,
        h("span", { class: "st-option-text" }, h("b", {}, label), help ? h("small", {}, help) : null),
      );
    }),
  );
}

export function setupSettingsDialog(
  api: Api,
  o: SettingsHooks,
): { open(area?: string): Promise<void>; hooks: SettingsHooks } {
  let cat: Cat = "general";
  const status = h(
    "p",
    { class: "lc-msg st-status", role: "status" },
    t("desktop.settingsView.changesAreSavedToConfig"),
  );
  const navBtns = new Map<Cat, HTMLElement>();
  const nav = h(
    "nav",
    { class: "st-cats", "aria-label": t("common.settings") },
    ...CATS.map(([id, label, ico]) => {
      const b = h(
        "button",
        {
          class: "st-cat",
          type: "button",
          "data-cat": id,
          onclick: () => {
            cat = id;
            if (last) paint(last);
          },
        },
        icon(ico),
        h("span", {}, label),
      );
      navBtns.set(id, b);
      return b;
    }),
  );
  const body = h("div", { class: "st-body st-pane-body" });
  const paneTitle = h("h2", { class: "st-pane-title", id: "st-title" });
  const dialog = h(
    "dialog",
    { class: "lk-dialog st-dialog st-window", "aria-labelledby": "st-title" },
    h("aside", { class: "st-side" }, h("p", { class: "st-side-title" }, t("common.settings")), nav, status),
    h(
      "div",
      { class: "st-pane" },
      h(
        "header",
        { class: "st-pane-head" },
        paneTitle,
        h(
          "button",
          {
            class: "tool-btn st-close",
            type: "button",
            "aria-label": t("common.close"),
            title: t("common.close"),
            onclick: () => dialog.close(),
          },
          icon("cross"),
        ),
      ),
      body,
    ),
  );
  document.body.append(dialog);
  let last: SettingsData | undefined;
  /** Made once per open (keeps its picker state across saves of the other fields). */
  let model: HTMLElement | null = null;
  let search: HTMLElement | null = null;
  // Each opened dialog closes this one first (one modal at a time).
  const via = (fn: (() => void) | undefined) =>
    fn
      ? () => {
          dialog.close();
          fn();
        }
      : undefined;

  const paint = (d: SettingsData, msg?: { text: string; tone: "ok" | "bad" }) => {
    last = d;
    const save = async (patch: Record<string, unknown>) => {
      try {
        const next = await api.call<SettingsData>("PATCH", "/api/settings", patch);
        // R9.3: a new interface language reloads the window (nothing redraws in place).
        if ("locale" in patch && applyLocalePref(next.advanced.locale)) return;
        o.onLevel(next.simple.level);
        paint(next, { text: t("common.saved"), tone: "ok" });
      } catch (e) {
        paint(d, {
          text: t("desktop.settingsView.notSaved", { message: String((e as Error)?.message ?? e) }),
          tone: "bad",
        });
      }
    };
    const restartNote = (field: string) =>
      d.pendingRestart.includes(field)
        ? h(
            "span",
            { class: "st-restart", "data-tone": "warn" },
            t("desktop.settingsView.saved", { RESTART }),
          )
        : h("span", { class: "st-restart" }, RESTART);

    const relay = h("input", {
      class: "field",
      type: "url",
      inputmode: "url",
      spellcheck: "false",
      placeholder: t("desktop.settingsView.httpsRelayExampleOrgBlank"),
      value: d.advanced.rendezvousUrl ?? "",
      "aria-label": t("desktop.settingsView.selfHostedRendezvousServer"),
    });
    const relayErr = h("p", { class: "lc-msg", "data-tone": "bad", role: "alert", hidden: true });
    relay.addEventListener("input", () => {
      relayErr.hidden = true;
    });
    const log = h("select", {
      class: "popup",
      "aria-label": t("desktop.settingsView.logLevel"),
    });
    for (const [v, label] of LOGS) {
      const opt = h("option", { value: v }, label);
      if (v === d.advanced.logLevel) opt.selected = true;
      log.append(opt);
    }
    log.addEventListener("change", () => void save({ logLevel: log.value }));

    const scopesField = h(
      "div",
      { class: "lc-field" },
      h("span", { class: "lc-label" }, t("desktop.settingsView.defaultPermissionsForNewlyPaired")),
      // §2.9: each permission is a switch row, not a row of checkboxes.
      h(
        "div",
        { class: "st-checks" },
        ...SCOPES.map(([v, label]) =>
          h(
            "label",
            { class: "st-check st-line" },
            h("input", {
              type: "checkbox",
              role: "switch",
              "data-scope": v,
              ...(d.advanced.defaultScopes.includes(v) ? { checked: true } : {}),
              onchange: (ev: Event) => {
                const on = (ev.target as HTMLInputElement).checked;
                const set = new Set(d.advanced.defaultScopes);
                if (on) set.add(v);
                else set.delete(v);
                void save({ defaultScopes: [...set] });
              },
            }),
            h("span", {}, label),
          ),
        ),
      ),
      h("span", { class: "lc-help" }, t("desktop.settingsView.remoteControlOfThisComputer")),
      restartNote("devices.defaultScopes"),
    );
    const pairingField = h(
      "label",
      { class: "st-check st-line" },
      h("input", {
        type: "checkbox",
        "data-field": "allowPairing",
        ...(d.advanced.allowPairing ? { checked: true } : {}),
        onchange: (ev: Event) => void save({ allowPairing: (ev.target as HTMLInputElement).checked }),
      }),
      h(
        "span",
        {},
        h("b", {}, t("desktop.settingsView.allowPairingNewDevices")),
        " ",
        restartNote("devices.allowPairing"),
      ),
    );
    const relayField = h(
      "div",
      { class: "lc-field" },
      h("span", { class: "lc-label" }, t("desktop.settingsView.rendezvousServerAtStartupConfig")),
      h(
        "div",
        { class: "st-row" },
        relay,
        h(
          "button",
          {
            class: "btn btn-quiet lc-btn",
            type: "button",
            "data-act": "save-relay",
            onclick: () => {
              // B5: say it next to the field, before asking the core (which refuses it too).
              const v = relay.value.trim();
              if (v && !/^https:\/\//i.test(v)) {
                relayErr.textContent = t("desktop.settingsView.notSavedASelfHosted");
                relayErr.hidden = false;
                relay.focus();
                return;
              }
              void save({ rendezvousUrl: v || null });
            },
          },
          t("common.save"),
        ),
      ),
      h("span", { class: "lc-help" }, t("desktop.settingsView.httpsOnlyBlankUsesThe")),
      relayErr,
      restartNote("advanced.rendezvousUrl"),
    );
    model ??= modelSection(api, { openProviders: via(o.openProviders) });
    search ??= searchSection(api);
    const content = (c: Cat): Array<HTMLElement | null> => {
      switch (c) {
        case "general":
          return [
            h(
              "section",
              { class: "st-section" },
              h("h3", { class: "st-h" }, t("desktop.settingsView.teamPermissions")),
              choice(
                t("desktop.settingsView.teamPermissions"),
                d.simple.level,
                [
                  [
                    "confirm_each_step",
                    t("common.askEveryStep"),
                    t("desktop.settingsView.askBeforeEveryActionOther"),
                  ],
                  [
                    "autonomous",
                    t("common.autonomous"),
                    t("desktop.settingsView.doOrdinaryActionsDirectlyOnly"),
                  ],
                ],
                (v) => void save({ level: v }),
              ),
              h(
                "p",
                { class: "st-fixed" },
                icon("lock"),
                h("span", {}, t("desktop.settingsView.riskyActionsAlcaRecognizesPayments")),
              ),
              h("p", { class: "lc-help" }, t("desktop.settingsView.eachBotInTheTeam")),
            ),
            h(
              "section",
              { class: "st-section" },
              h("h3", { class: "st-h" }, t("desktop.settingsView.learning")),
              h(
                "label",
                { class: "st-check st-line" },
                h("input", {
                  type: "checkbox",
                  role: "switch",
                  ...(d.simple.learning ? { checked: true } : {}),
                  onchange: (ev: Event) => void save({ learning: (ev.target as HTMLInputElement).checked }),
                }),
                h(
                  "span",
                  {},
                  h("b", {}, t("desktop.settingsView.learnFromChats")),
                  h("small", {}, t("desktop.settingsView.rememberPreferencesYouMentionAnd")),
                ),
              ),
            ),
            h(
              "section",
              { class: "st-section", id: "st-locale" },
              h("h3", { class: "st-h" }, t("desktop.locale.title")),
              choice(
                t("desktop.locale.title"),
                d.advanced.locale ?? "auto",
                [
                  ["auto", t("desktop.locale.auto")],
                  ["zh-Hant-TW", "繁體中文"], // i18n-ignore: a language's own name, the same in every interface
                  ["en", "English"],
                ],
                (v) => void save({ locale: v }),
              ),
              h("p", { class: "lc-help" }, t("desktop.locale.help")),
            ),
          ];
        case "notifications":
          return [
            h(
              "section",
              { class: "st-section" },
              h("h3", { class: "st-h" }, t("desktop.settingsView.phoneNotifications")),
              choice(
                t("desktop.settingsView.phoneNotifications"),
                d.simple.pushPreview,
                [
                  [
                    "notify_only",
                    t("desktop.settingsView.notifyWhenSomethingNeedsYour"),
                    t("desktop.settingsView.notificationsHaveNoContentThey"),
                  ],
                  [
                    "none",
                    t("desktop.settingsView.noNotifications"),
                    t("desktop.settingsView.youllStillSeeItWhen"),
                  ],
                ],
                (v) => void save({ pushPreview: v }),
              ),
            ),
          ];
        case "model":
          return [model, search];
        case "devices":
          return [
            connectionSection(
              api,
              { openConnection: via(o.openConnection), openPairing: via(o.openPairing) },
              [
                pairingField,
                scopesField,
                // §4.2: the relay address is machine-room detail, one disclosure away.
                h(
                  "details",
                  { class: "st-adv", ...(d.advanced.rendezvousUrl ? { open: true } : {}) },
                  h("summary", {}, t("common.advanced")),
                  relayField,
                ),
              ],
            ),
          ];
        case "browser":
          return [
            browserSection(api, {
              on: d.advanced.browserAutoDownload,
              locked: d.advanced.browserAutoDownloadLocked,
              save: (on) => void save({ browserAutoDownload: on }),
            }),
          ];
        case "telegram":
          return [telegramSection(api, via(o.openTelegram))];
        case "data":
          return [backupSection(api)];
        case "about":
          return [
            aboutSection(
              api,
              h(
                "label",
                { class: "lc-field" },
                h("span", { class: "lc-label" }, t("desktop.settingsView.logLevel")),
                log,
              ),
            ),
          ];
      }
    };

    const title = CATS.find(([id]) => id === cat)?.[1] ?? "";
    paneTitle.textContent = title;
    for (const [id, b] of navBtns) b.setAttribute("aria-current", id === cat ? "page" : "false");
    const keep = body.dataset.cat === cat ? body.scrollTop : 0;
    const kids = content(cat).filter((x): x is HTMLElement => !!x);
    body.replaceChildren(...kids);
    // A pane with one section of the same name: the pane title is its heading.
    for (const k of kids) {
      const hd = k.querySelector(":scope > .st-h");
      if (hd && hd.textContent === title) (hd as HTMLElement).hidden = true;
    }
    body.dataset.cat = cat;
    body.scrollTop = keep;
    status.textContent = msg ? msg.text : t("desktop.settingsView.changesAreSavedToConfig");
    if (msg) status.dataset.tone = msg.tone;
    else delete status.dataset.tone;
  };

  const open = async (area?: string) => {
    if (!dialog.open) dialog.showModal();
    model = null;
    search = null;
    cat = (area && AREA_CAT[area]) || (area ? cat : "general");
    body.replaceChildren(h("p", { class: "lk-note" }, t("common.loading")));
    try {
      paint(await api.call<SettingsData>("GET", "/api/settings"));
      if (area) document.getElementById(`st-${area}`)?.scrollIntoView({ block: "start" });
    } catch (e) {
      body.replaceChildren(h("p", { class: "lk-note" }, String((e as Error)?.message ?? e)));
    }
  };
  return { open, hooks: o };
}
