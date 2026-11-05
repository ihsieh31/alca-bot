// The live browser frame of a Space: read-only while Alca drives; 接手 lets
// the person tap and type on it (the core injects the input), 交還 gives it back.
import { ALWAYS_CONFIRM, h, haptic, icon } from "./dom.ts";
import { t as tx } from "./i18n/index.ts";
import type { Session, SpaceState } from "./session.ts";
import { Sheet } from "./sheet.ts";

export function openBrowser(s: Session, spaceId?: string, openCards?: () => void): Sheet {
  let current = spaceId ?? pickSpace(s)?.spaceId ?? null;
  const img = h("img", { class: "bv-img", alt: tx("phone.browser.liveBrowserView"), draggable: "false" });
  const placeholder = h("p", { class: "bv-wait" }, tx("phone.browser.waitingForTheView"));
  const ripple = h("i", { class: "bv-ripple", "aria-hidden": "true" });
  // §2.3: the caption over a live page keeps a fixed dark overlay in both themes.
  const who = h("span", { class: "bv-who" });
  const overlay = h("p", { class: "bv-overlay", "aria-live": "polite" }, who);
  const frame = h("div", { class: "bv-frame" }, placeholder, img, ripple, overlay);
  const caption = h("p", { class: "bv-caption", "aria-live": "polite" });
  const scroller = h("div", { class: "bv-scroll", "data-zoom": "false" }, frame);
  const zoom = h(
    "button",
    { class: "text-btn bv-zoom", type: "button", "aria-pressed": "false" },
    tx("phone.browser.zoomIn"),
  );
  zoom.addEventListener("click", () => {
    const on = scroller.dataset.zoom !== "true";
    scroller.dataset.zoom = String(on);
    zoom.setAttribute("aria-pressed", String(on));
    zoom.textContent = on ? tx("phone.browser.overview") : tx("phone.browser.zoomIn");
    haptic("tap");
  });
  const stage = h("div", { class: "bv-stage" }, scroller, h("div", { class: "bv-tools" }, caption, zoom));
  const switcher = h("div", { class: "bv-spaces", role: "tablist", "aria-label": "Space" });
  const controls = h("div", { class: "bv-controls" });
  const info = h("div", { class: "bv-info" });
  const note = h("p", { class: "group-f bv-note" });
  const text = h("input", {
    class: "bv-input",
    type: "text",
    placeholder: tx("phone.browser.typeOnThePage"),
    enterkeyhint: "send",
    "aria-label": tx("phone.browser.textToType"),
  });
  const typing = h("div", { class: "bv-typing", hidden: true }, text);

  const space = (): SpaceState | undefined => s.spaces.find((x) => x.spaceId === current);
  const driving = () => space()?.controller === "user";

  const send = async (input: Record<string, unknown>) => {
    if (!current) return;
    try {
      await s.input(current, input);
    } catch (e) {
      caption.textContent = e instanceof Error ? e.message : tx("common.notSent");
    }
  };
  frame.addEventListener("click", (e) => {
    if (!driving() || !img.naturalWidth) return;
    // Map the tap into the image's content box (object-fit: contain), normalized 0..1.
    const r = img.getBoundingClientRect();
    const scale = Math.min(r.width / img.naturalWidth, r.height / img.naturalHeight);
    const w = img.naturalWidth * scale;
    const hh = img.naturalHeight * scale;
    const x = (e.clientX - r.left - (r.width - w) / 2) / w;
    const y = (e.clientY - r.top - (r.height - hh) / 2) / hh;
    if (x < 0 || y < 0 || x > 1 || y > 1) return;
    haptic("tap");
    ripple.style.left = `${e.clientX - frame.getBoundingClientRect().left}px`;
    ripple.style.top = `${e.clientY - frame.getBoundingClientRect().top}px`;
    ripple.dataset.on = "false";
    void ripple.offsetWidth;
    ripple.dataset.on = "true";
    void send({ type: "click", x, y });
  });
  // The native keyboard does the typing: Return sends the text (or presses Enter
  // when the field is empty), Delete on an empty field deletes on the page.
  text.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (text.value) {
        void send({ type: "text", text: text.value });
        text.value = "";
      } else void send({ type: "key", key: "Enter" });
    } else if (e.key === "Backspace" && !text.value) {
      e.preventDefault();
      void send({ type: "key", key: "Backspace" });
    }
  });

  const toolIcon = (name: string, label: string, onclick: () => void, pressed?: boolean) =>
    h(
      "button",
      {
        class: "icon-btn bv-tool",
        type: "button",
        "aria-label": label,
        title: label,
        ...(pressed !== undefined ? { "aria-pressed": String(pressed) } : {}),
        onclick,
      },
      icon(name, 24),
    );

  // §4.1 phone-browser: a bottom toolbar. Watching: 接手. Driving: 鍵盤, 捲動, 交還.
  const paintControls = () => {
    const sp = space();
    const canDrive = s.can("control_computer");
    if (!sp) {
      controls.replaceChildren();
      note.textContent = tx("phone.browser.noBrowserSpaceIsOpen");
      return;
    }
    if (sp.controller === "user") {
      note.textContent = "";
      const kb = toolIcon(
        "keyboard",
        tx("phone.browser.type"),
        () => {
          typing.hidden = !typing.hidden;
          kb.setAttribute("aria-pressed", String(!typing.hidden));
          if (!typing.hidden) text.focus();
        },
        !typing.hidden,
      );
      controls.replaceChildren(
        kb,
        toolIcon(
          "down",
          tx("phone.browser.scroll"),
          () => void send({ type: "wheel", x: 0.5, y: 0.5, dy: 480 }),
        ),
        h("span", { class: "bv-spacer" }),
        h(
          "button",
          {
            class: "btn primary bv-handback",
            type: "button",
            onclick: async () => {
              haptic("success");
              typing.hidden = true;
              await s.handBack(sp.spaceId).catch(() => undefined);
            },
          },
          tx("common.handBackToAlca"),
        ),
      );
      return;
    }
    typing.hidden = true;
    note.textContent = canDrive
      ? tx("phone.browser.afterYouTakeOverAlcas")
      : tx("phone.browser.thisPhoneCanOnlyWatch");
    controls.replaceChildren(
      h(
        "button",
        {
          class: "text-btn takeover",
          type: "button",
          disabled: !canDrive,
          onclick: async () => {
            haptic("tap");
            await s.takeOver(sp.spaceId).catch((e: unknown) => {
              caption.textContent = e instanceof Error ? e.message : tx("phone.browser.cantTakeOver");
            });
          },
        },
        icon("hand", 22),
        h("span", {}, tx("common.takeOver")),
      ),
    );
  };

  // A pending decision for this page: one compact row that opens the sheet (§3.5).
  const paintInfo = () => {
    const sp = space();
    if (!sp) return info.replaceChildren();
    const card = s.cards.find(
      (c) =>
        c.kind === "approval" &&
        (sp.workerId ? c.workerId === sp.workerId : !c.workerId && sp.threadId === s.threadId),
    );
    info.replaceChildren(
      card && card.kind === "approval"
        ? h(
            "div",
            { class: "group bv-pending" },
            h(
              "div",
              { class: "cells" },
              h(
                "button",
                { class: "row bv-wait-row", type: "button", onclick: () => openCards?.() },
                h(
                  "span",
                  { class: "row-icon bare", "data-tone": "waiting" },
                  icon(ALWAYS_CONFIRM.has(card.actionClass) ? "lock" : "hand", 20),
                ),
                h(
                  "span",
                  { class: "row-text" },
                  h("span", { class: "row-title" }, tx("common.waitingOnYou")),
                  h("span", { class: "row-sub" }, card.summary),
                ),
                h("span", { class: "row-chev", "aria-hidden": "true" }, icon("chevron", 16)),
              ),
            ),
          )
        : "",
    );
  };

  // 分頁 behind a toolbar button: a short read-only list, the open one checked.
  const showTabs = () => {
    const sp = space();
    if (!sp) return;
    const list = new Sheet(
      h(
        "div",
        { class: "bv-tabs" },
        h(
          "div",
          { class: "group" },
          h(
            "div",
            { class: "cells" },
            ...sp.tabs.map((t) =>
              h(
                "div",
                { class: "row bv-tab", "data-active": String(t.tabId === sp.activeTabId) },
                h(
                  "span",
                  { class: "row-text" },
                  h("span", { class: "row-title" }, t.title || tx("phone.browser.untitled")),
                  h("span", { class: "row-sub" }, siteName(t.url)),
                ),
                t.tabId === sp.activeTabId
                  ? h("span", { class: "row-value bv-check" }, icon("check", 18))
                  : "",
              ),
            ),
          ),
        ),
      ),
      { label: tx("phone.browser.tabsTitle"), nav: { title: tx("phone.browser.tabsTitle"), trailing: null } },
    );
    void list;
  };
  const tabsBtn = h(
    "button",
    {
      class: "icon-btn bv-tabs-btn",
      type: "button",
      "aria-label": tx("phone.browser.tabsTitle"),
      title: tx("phone.browser.tabsTitle"),
      onclick: showTabs,
    },
    icon("doc", 22),
  );

  let sheet!: Sheet;
  const paint = (what: string) => {
    const sp = space();
    if (what === "spaces" || what === "init" || what === "cards" || what === "thread") paintInfo();
    if (what === "spaces" || what === "init") {
      if (!sp && s.spaces[0]) {
        current = pickSpace(s)?.spaceId ?? null;
        void s.watchSpace(current);
      }
      const now = space();
      const tab = now?.tabs.find((t) => t.tabId === now.activeTabId) ?? now?.tabs[0];
      // Nav title: the site, never its address (§4.1).
      sheet?.setTitle(now?.title ?? (tab ? siteName(tab.url) : tx("common.browser")));
      tabsBtn.hidden = !now || now.tabs.length < 2;
      who.textContent = now
        ? now.controller === "user"
          ? tx("common.youreInControl")
          : now.status === "waiting_user"
            ? tx("common.waitingOnYou")
            : tx("phone.browser.alcaIsOperating")
        : "";
      overlay.dataset.state = now ? (now.controller === "user" ? "user" : now.status) : "";
      overlay.hidden = !now;
      frame.dataset.driving = String(now?.controller === "user");
      body.dataset.driving = frame.dataset.driving;
      caption.textContent =
        now?.handoffReason ??
        (now?.lastAction ? tx("phone.browser.justNow", { label: now.lastAction.label }) : "");
      caption.dataset.gated = String(!!now?.lastAction?.gated);
      switcher.hidden = s.spaces.length < 2;
      switcher.replaceChildren(
        ...s.spaces.map((x) =>
          h(
            "button",
            {
              class: "bv-space",
              type: "button",
              role: "tab",
              "aria-selected": String(x.spaceId === current),
              onclick: () => {
                current = x.spaceId;
                void s.watchSpace(current);
                paint("spaces");
              },
            },
            x.title,
          ),
        ),
      );
      paintControls();
    }
    if (what === "frame" || what === "init") {
      const f = s.frame;
      if (f && f.spaceId === current) {
        img.src = `data:${f.mime};base64,${f.data}`;
        frame.style.aspectRatio = `${f.width} / ${f.height}`;
        placeholder.hidden = true;
      }
    }
  };

  const body = h(
    "div",
    { class: "browser-view" },
    h("div", { class: "bv-main" }, switcher, stage, info, note),
    h("div", { class: "bv-bar" }, typing, controls),
  );
  const off = s.subscribe(paint);
  sheet = new Sheet(body, {
    label: tx("phone.browser.liveBrowserView"),
    size: "full",
    className: "browser-wrap",
    nav: {
      title: tx("common.browser"),
      leading: h(
        "button",
        { class: "text-btn strong", type: "button", onclick: () => sheet.close() },
        tx("phone.browser.close"),
      ),
      trailing: tabsBtn,
    },
    onClose: () => {
      off();
      void s.watchSpace(null).catch(() => undefined);
    },
  });
  void s.watchSpace(current).then(() => paint("init"));
  paint("init");
  return sheet;
}

/** The Space that most needs a look: waiting on the person, then the thread's, then any. */
function pickSpace(s: Session): SpaceState | undefined {
  return (
    s.spaces.find((x) => x.status === "waiting_user") ??
    s.spaces.find((x) => x.threadId === s.threadId) ??
    s.spaces[0]
  );
}

/** A page's site in plain words: its hostname, or 「本機測試網站」 for a loopback address (§5.3). */
export function siteName(u: string): string {
  try {
    const x = new URL(u);
    if (/^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(x.hostname)) return tx("phone.browser.localSite");
    return x.hostname.replace(/^www\./, "");
  } catch {
    return u;
  }
}
