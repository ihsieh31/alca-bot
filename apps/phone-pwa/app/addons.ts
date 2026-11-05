// P14 on the phone: a bot's add-ons in its sheet — name, one line, the
// vermilion 「會自己消耗額度」 for the ones that spend on their own, today's
// usage against the cap, and the switch (needs `approve`; settings stay on
// the computer, except 回覆檢查's model, picked from the bot's configured
// models). Same list and checks as the desktop's 擴充 tab.
import { h, haptic } from "./dom.ts";
import { t } from "./i18n/index.ts";
import type { Session } from "./session.ts";

export interface PhoneAddon {
  id: string;
  name: string;
  description: string;
  costClass: "none" | "on_use" | "proactive";
  enabled: boolean;
  unmet: string[];
  settings?: Record<string, unknown>;
  /** 回覆檢查: the models it may run on; engine null = the bot's router model (the default). */
  modelChoices?: Array<{ engine: string | null; model: string | null; label: string }>;
  usage: {
    tokens: number;
    tokenCap: number | null;
    runs: number;
    runCap: number | null;
    capped: boolean;
  } | null;
}

const fmt = (n: number) => n.toLocaleString("zh-TW");

export function addonUsage(a: PhoneAddon): string {
  const u = a.usage;
  if (!u) return "";
  if (u.capped) return t("phone.addons.todaysAllowanceIsUsedUp");
  const parts: string[] = [];
  if (u.tokenCap !== null)
    parts.push(t("common.tokens", { tokens: fmt(u.tokens), tokenCap: fmt(u.tokenCap) }));
  if (u.runCap !== null) parts.push(t("common.runs", { runs: u.runs, runCap: u.runCap }));
  return parts.length ? t("common.today", { p0: parts.join(" · ") }) : "";
}

const pickKey = (c: { engine?: unknown; model?: unknown }) =>
  typeof c.engine === "string" ? `${c.engine}\u0000${typeof c.model === "string" ? c.model : ""}` : "";

/** 回覆檢查's model on the phone: one select; a change is saved at once (needs `approve`). */
function modelSelect(
  s: Session,
  botId: string,
  a: PhoneAddon,
  done: (v: PhoneAddon) => void,
): HTMLElement | null {
  const choices = a.modelChoices;
  if (!choices?.length) return null;
  const now = pickKey(a.settings ?? {});
  const sel = h(
    "select",
    { class: "ad-model", "aria-label": t("phone.addons.modelForChecks", { name: a.name }) },
    ...choices.map((c) =>
      h("option", { value: pickKey(c), ...(pickKey(c) === now ? { selected: true } : {}) }, c.label),
    ),
  ) as HTMLSelectElement;
  if (!choices.some((c) => pickKey(c) === now))
    sel.prepend(h("option", { value: now, selected: true }, t("phone.addons.noLongerAvailableUsingThe")));
  sel.disabled = !s.can("approve");
  sel.addEventListener("change", () => {
    const c = choices.find((x) => pickKey(x) === sel.value);
    if (!c) return;
    haptic("tap");
    sel.disabled = true;
    void s.client
      .request<PhoneAddon>("team.bots.addons.set", {
        botId,
        addonId: a.id,
        settings: { engine: c.engine, model: c.model },
      })
      .then(done, () => {
        sel.value = now;
        sel.disabled = false;
      });
  });
  return h(
    "label",
    { class: "ad-model-row" },
    h("span", { class: "ad-desc" }, t("common.modelForChecks")),
    sel,
  );
}

function row(s: Session, botId: string, start: PhoneAddon): HTMLElement {
  let a = start;
  const li = h("li", { class: "ad-row", "data-addon": a.id });
  const render = () => {
    const can = s.can("approve");
    const sw = h("input", {
      type: "checkbox",
      role: "switch",
      class: "ad-switch switch-input",
      switch: true,
      "aria-label": a.name,
      ...(a.enabled ? { checked: true } : {}),
      ...(!can || (!a.enabled && a.unmet.length) ? { disabled: true } : {}),
      onchange: () => {
        haptic("tap");
        sw.disabled = true;
        void s.client
          .request<PhoneAddon>("team.bots.addons.set", { botId, addonId: a.id, enabled: sw.checked })
          .then(
            (v) => {
              a = v;
              render();
            },
            () => {
              sw.checked = a.enabled;
              sw.disabled = false;
            },
          );
      },
    }) as HTMLInputElement;
    const usage = addonUsage(a);
    li.replaceChildren(
      h(
        "div",
        { class: "ad-text" },
        h("span", { class: "ad-name" }, a.name),
        a.costClass === "proactive" ? h("span", { class: "ad-cost" }, t("common.usesCreditsOnItsOwn")) : null,
        h("span", { class: "ad-desc" }, a.description),
        usage
          ? h("span", { class: "ad-usage", "data-capped": a.usage?.capped ? "true" : "false" }, usage)
          : null,
        ...a.unmet.map((u) => h("span", { class: "ad-unmet" }, t("common.cantTurnOnYet", { u }))),
        modelSelect(s, botId, a, (v) => {
          a = v;
          render();
        }),
      ),
      sw,
    );
  };
  render();
  return li;
}

/** The 擴充 list for a bot's sheet. */
export function addonList(s: Session, botId: string): HTMLElement {
  const ul = h("ul", { class: "ad-list" }, h("li", { class: "mem-empty" }, t("common.loadingAddOns")));
  void s.client.request<{ addons: PhoneAddon[] }>("team.bots.addons.list", { botId }).then(
    (r) => ul.replaceChildren(...r.addons.map((a) => row(s, botId, a))),
    () => ul.replaceChildren(h("li", { class: "mem-empty" }, t("phone.addons.addOnsNeedRouterMode"))),
  );
  return h(
    "section",
    { class: "ad-sec" },
    h("h3", { class: "group-title" }, t("common.addOns")),
    ul,
    s.can("approve") ? null : h("p", { class: "fine" }, t("phone.addons.turningAddOnsOnOr")),
  );
}

/** P14 C: a 主動留意 card waiting for an answer. */
export interface PhoneOffer {
  id: string;
  botId: string;
  threadId: string | null;
  category: string;
  text: string;
  status: string;
  dueAt: string | null;
}

/**
 * 待處理: the add-on cards (好 / 先不用 / 別再提這類) at the top of the thread
 * list until each is answered. Answering needs `approve` (好 starts work).
 */
export function pendingOffers(s: Session, onOpen: (threadId: string) => void): HTMLElement {
  const sec = h("section", { class: "ad-sec offer-sec", hidden: true });
  /** An offer a tapped notification points at: brought into view once it is painted. */
  let reveal = "";
  const paint = (offers: PhoneOffer[]) => {
    sec.hidden = offers.length === 0;
    const can = s.can("approve");
    const answer = (o: PhoneOffer, choice: "yes" | "later" | "never") => {
      haptic("tap");
      void s.client.request<PhoneOffer>("offers.answer", { offerId: o.id, choice }).then(
        (r) => {
          load();
          if (choice === "yes" && r.threadId) onOpen(r.threadId);
        },
        () => load(),
      );
    };
    sec.replaceChildren(
      h("h3", { class: "group-title" }, t("phone.addons.pending")),
      h(
        "ul",
        { class: "offer-list" },
        ...offers.map((o) =>
          h(
            "li",
            { class: "offer-card", "data-offer": o.id },
            h("span", { class: "offer-src" }, t("common.proactiveSuggestions")),
            h("p", { class: "offer-text" }, o.text),
            can
              ? h(
                  "div",
                  { class: "offer-acts" },
                  h(
                    "button",
                    { class: "btn primary", type: "button", onclick: () => answer(o, "yes") },
                    t("common.ok"),
                  ),
                  h(
                    "button",
                    { class: "btn plain", type: "button", onclick: () => answer(o, "later") },
                    t("common.notNow"),
                  ),
                  h(
                    "button",
                    { class: "btn plain", type: "button", onclick: () => answer(o, "never") },
                    t("common.dontSuggestThisKindAgain"),
                  ),
                )
              : h("p", { class: "fine" }, t("phone.addons.replyingNeedsTheApprovePermission")),
          ),
        ),
      ),
    );
  };
  const load = () =>
    void s.client.request<{ offers: PhoneOffer[] }>("offers.list", {}).then(
      (r) => {
        paint(r.offers);
        const card = reveal ? sec.querySelector<HTMLElement>(`[data-offer="${CSS.escape(reveal)}"]`) : null;
        reveal = "";
        card?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      },
      () => paint([]),
    );
  // main.ts (a tapped "Alca noticed something" notification): fetch the list fresh and show that offer.
  sec.addEventListener("reveal", (e) => {
    reveal = String((e as CustomEvent).detail ?? "");
    load();
  });
  load();
  return sec;
}
