import { siteOf } from "./activity.ts";
import type { AlcaEvent, Api, Bot, BrowserEvent, BrowserInstall, Frame, Space } from "./api.ts";
import { canImport, importButton } from "./browser-import.ts";
import {
  approvalCard,
  type BrowserPanelHooks,
  hostOf,
  I,
  icon,
  KEYS,
  type Pending,
} from "./browser-parts.ts";
import { h, MOD } from "./dom.ts";
import { t as tx } from "./i18n/index.ts";
import { remoteShortcut } from "./remote-keys.ts";

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

export type { BrowserPanelHooks } from "./browser-parts.ts";

// Browser panel: the Space a bot is working in, live. Space switcher, tabs,
// address, the screencast frame, 接手／交還, and approval cards for sensitive
// browser steps. Everything is built as DOM nodes (no innerHTML).

export class BrowserPanel {
  private readonly root: HTMLElement;
  private readonly api: Api;
  private readonly hooks: BrowserPanelHooks;
  private readonly spaces = new Map<string, Space>();
  private bots = new Map<string, Bot>();
  private current: string | null = null;
  private thread: string | null = null;
  private open = false;
  private menuOpen = false;
  private stopStream: (() => void) | undefined;
  private watching: string | null | undefined;
  private readonly img = h("img", { alt: tx("desktop.browser.liveViewOfTheSpace"), draggable: "false" });
  private frameSeen = false;
  private ratio = "16 / 10";
  private readonly callTools = new Map<string, string>();
  private readonly pending = new Map<string, Pending>();
  /** First-run Chromium: is one there, and how the download is going. */
  private chromium = true;
  private install: BrowserInstall | undefined;
  /** Chrome cookie import is offered (macOS). */
  private cookieImport = false;

  constructor(root: HTMLElement, api: Api, hooks: BrowserPanelHooks) {
    this.root = root;
    this.api = api;
    this.hooks = hooks;
    document.addEventListener("click", (e) => {
      if (this.menuOpen && !(e.target as HTMLElement).closest?.(".space-switch")) {
        this.menuOpen = false;
        this.render();
      }
    });
  }

  get isOpen(): boolean {
    return this.open;
  }

  async start(): Promise<boolean> {
    const st = await this.api.browserStatus().catch(() => undefined);
    if (!st?.enabled) return false;
    this.bots = new Map(st.bots.map((b) => [b.id, b]));
    this.chromium = st.chromium !== false;
    this.install = st.install;
    this.cookieImport = st.cookieImport === true;
    // No browser yet: open the panel so the download (or its button) is seen.
    if (!this.chromium) this.open = true;
    for (const s of await this.api.spaces()) this.spaces.set(s.spaceId, s);
    this.pickForThread();
    this.connect();
    this.render();
    return true;
  }

  toggle(force?: boolean): void {
    this.open = force ?? !this.open;
    this.render();
  }

  setThread(threadId: string | null): void {
    this.thread = threadId;
    this.pickForThread();
    this.render();
  }

  private pickForThread(): void {
    const mine = [...this.spaces.values()].find((s) => s.threadId && s.threadId === this.thread);
    const next =
      mine?.spaceId ??
      (this.current && this.spaces.has(this.current) ? this.current : null) ??
      [...this.spaces.keys()].at(-1) ??
      null;
    this.select(next);
  }

  private select(id: string | null): void {
    this.current = id;
    if (this.watching !== id) {
      this.frameSeen = false;
      this.img.removeAttribute("src");
      this.connect();
    }
  }

  private connect(): void {
    this.stopStream?.();
    this.watching = this.current;
    this.stopStream = this.api.browserStream(
      this.current,
      (e) => this.onBrowserEvent(e),
      (f) => this.onFrame(f),
    );
  }

  private onFrame(f: Frame): void {
    if (f.spaceId !== this.current) return;
    this.img.src = `data:${f.mime};base64,${f.data}`;
    const ratio = `${f.width} / ${f.height}`;
    if (ratio !== this.ratio) {
      this.ratio = ratio;
      this.root.querySelector<HTMLElement>(".bp-frame")?.style.setProperty("--frame-ratio", ratio);
    }
    if (!this.frameSeen) {
      this.frameSeen = true;
      this.render();
    }
  }

  private onBrowserEvent(e: BrowserEvent): void {
    if (e.type === "browser.install") {
      this.install = e.data as unknown as BrowserInstall;
      if (this.install.phase === "ready") this.chromium = true;
      this.render();
      return;
    }
    const space = e.data.space;
    if ((e.type === "space.updated" || e.type === "space.snapshot") && space) {
      const isNew = !this.spaces.has(space.spaceId);
      this.spaces.set(space.spaceId, space);
      if (isNew && space.threadId && space.threadId === this.thread) {
        this.select(space.spaceId);
        // A worker's Space opens quietly; the panel comes up when it needs you (a card, a takeover).
        if (!space.workerId) this.open = true;
      } else if (!this.current) this.select(space.spaceId);
    } else if (e.type === "space.closed" && typeof e.data.spaceId === "string") {
      this.spaces.delete(e.data.spaceId);
      if (this.current === e.data.spaceId) this.pickForThread();
    } else if (e.type === "space.control" && e.data.controller === "user" && e.data.spaceId) {
      // A captcha or the agent asking for help: bring the panel up.
      this.select(String(e.data.spaceId));
      this.open = true;
    }
    this.render();
  }

  /** Main protocol events, to mirror browser approval cards over the frame. */
  onAlcaEvent(e: AlcaEvent): void {
    const d = e.data;
    if (e.type === "tool.requested") this.callTools.set(String(d.callId), String(d.tool));
    else if (e.type === "approval.requested") {
      const tool = this.callTools.get(String(d.callId ?? "")) ?? "";
      // A worker's browser step: its tool calls stay in the worker's stream, but its Space is known.
      const workerSpace =
        typeof d.workerId === "string" && [...this.spaces.values()].some((s) => s.workerId === d.workerId);
      // A network-layer card (a page's own request) carries no call id, only its summary.
      const netCard = !d.callId && String(d.summary ?? "").startsWith("網路層");
      if (!tool.startsWith("browser_") && !workerSpace && !netCard) return;
      this.pending.set(String(d.approvalId), {
        approvalId: String(d.approvalId),
        actionClass: String(d.actionClass),
        summary: String(d.summary),
        threadId: e.threadId,
        ...(typeof d.workerId === "string" ? { workerId: d.workerId } : {}),
      });
      if (e.threadId === this.thread) this.open = true;
      this.render();
    } else if (e.type === "approval.resolved" || e.type === "run.finished") {
      if (e.type === "approval.resolved") this.pending.delete(String(d.approvalId));
      else for (const [k, p] of this.pending) if (p.threadId === e.threadId) this.pending.delete(k);
      this.render();
    }
  }

  private space(): Space | undefined {
    return this.current ? this.spaces.get(this.current) : undefined;
  }

  private async control(s: Space): Promise<void> {
    try {
      const next =
        s.controller === "agent" ? await this.api.takeOver(s.spaceId) : await this.api.handBack(s.spaceId);
      this.spaces.set(next.spaceId, next);
      this.render();
      if (next.controller === "user") (this.root.querySelector(".bp-frame") as HTMLElement | null)?.focus();
    } catch (err) {
      this.hooks.error(err);
    }
  }

  private send(s: Space, input: Parameters<Api["input"]>[1]): void {
    if (s.controller !== "user") return;
    void this.api.input(s.spaceId, input).catch((err) => this.hooks.error(err));
  }

  // ── render ───────────────────────────────────────────────
  render(): void {
    const s = this.space();
    const attention =
      [...this.spaces.values()].some((x) => x.controller === "user" || x.status === "queued") ||
      this.pending.size > 0;
    this.hooks.changed(this.open, this.spaces.size, attention);
    this.root.hidden = !this.open;
    if (!this.open) return;
    const strip = this.installStrip();
    if (!s) {
      this.root.replaceChildren(this.head(undefined), ...(strip ? [strip] : []), this.empty());
      return;
    }
    // Keep what the person is doing across re-renders (typing a URL, driving the frame).
    const active = document.activeElement as HTMLElement | null;
    const addr = active?.closest?.(".bp-address") ? (active as HTMLInputElement).value : undefined;
    const onFrame = !!active?.closest?.(".bp-frame");
    this.root.replaceChildren(
      this.head(s),
      ...(strip ? [strip] : []),
      this.bar(s),
      this.stage(s),
      this.foot(s),
    );
    if (addr !== undefined) {
      const input = this.root.querySelector<HTMLInputElement>(".bp-address input");
      if (input) {
        input.value = addr;
        input.focus();
      }
    } else if (onFrame) this.root.querySelector<HTMLElement>(".bp-frame")?.focus();
  }

  private head(s: Space | undefined): HTMLElement {
    const close = h("button", {
      class: "bp-icon",
      type: "button",
      title: tx("desktop.browser.hideBrowserB", { MOD }),
      "aria-label": tx("desktop.browser.hideBrowser"),
      onclick: () => this.toggle(false),
    });
    close.append(icon(I.close));
    if (!s)
      return h(
        "header",
        { class: "bp-head" },
        h("span", { class: "space-btn" }, tx("common.browser")),
        h("span", { class: "bp-spacer" }),
        close,
      );
    const btn = h(
      "button",
      {
        class: "space-btn",
        type: "button",
        "aria-haspopup": "listbox",
        "aria-expanded": this.menuOpen ? "true" : "false",
        onclick: () => {
          this.menuOpen = !this.menuOpen;
          this.render();
        },
      },
      h("span", { class: "space-glyph" }, s.title.slice(0, 1)),
      h("span", { class: "space-name" }, s.title),
    );
    btn.append(icon(I.chevron));
    const switcher = h("div", { class: "space-switch" }, btn, this.menuOpen ? this.menu() : null);
    const profile = h("span", {
      class: "bp-badge",
      title:
        s.profile === "shared"
          ? tx("desktop.browser.sharesSignInsWithYour")
          : tx("desktop.browser.separateCookiesNoSharedSign"),
    });
    profile.append(
      icon(s.profile === "shared" ? I.globe : I.shield),
      s.profile === "shared"
        ? tx("desktop.browser.sharedSignIns")
        : s.persistent
          ? tx("desktop.browser.isolatedKeepsSignIns")
          : tx("desktop.browser.isolated"),
    );
    const asking = [...this.pending.values()].some((p) => p.threadId === s.threadId);
    const state =
      s.controller === "user"
        ? "user"
        : asking || s.status === "queued"
          ? "queued"
          : s.status === "working"
            ? "working"
            : "idle";
    const label =
      s.controller === "user"
        ? tx("common.youreInControl")
        : asking
          ? tx("common.waitingForYourApproval")
          : {
              user: tx("common.youreInControl"),
              working: tx("common.alcaIsWorking"),
              queued: tx("desktop.browser.alcaIsQueuedForYou"),
              idle: tx("desktop.browser.alcaStandingBy"),
            }[state];
    const chip = h(
      "span",
      { class: "control-chip", "data-state": state },
      h("i", { "aria-hidden": "true" }),
      label,
    );
    const take = h(
      "button",
      {
        class: `btn ${s.controller === "agent" ? "btn-quiet" : "btn-primary"} takeover-btn`,
        type: "button",
        onclick: () => void this.control(s),
      },
      s.controller === "agent" ? tx("common.takeOver") : tx("common.handBackToAlca"),
    );
    if (s.controller === "agent") take.prepend(icon(I.hand));
    return h(
      "header",
      { class: "bp-head" },
      switcher,
      profile,
      h("span", { class: "bp-spacer" }),
      chip,
      take,
      close,
    );
  }

  private menu(): HTMLElement {
    const items = [...this.spaces.values()].map((x) => {
      const bot = this.bots.get(x.botId)?.name ?? "bot";
      const where = x.tabs.find((t) => t.tabId === x.activeTabId) ?? x.tabs[0];
      return h(
        "button",
        {
          class: "space-opt",
          type: "button",
          role: "option",
          "aria-current": x.spaceId === this.current ? "true" : "false",
          onclick: () => {
            this.menuOpen = false;
            this.select(x.spaceId);
            this.render();
          },
        },
        h("span", { class: "space-glyph" }, x.title.slice(0, 1)),
        h(
          "span",
          {},
          h("b", {}, x.title),
          h(
            "small",
            {},
            `${bot}${tx("common.joinComma")}${where ? hostOf(where.url).host : tx("desktop.browser.blank")}`,
          ),
        ),
        x.controller === "user"
          ? h("span", { class: "bp-badge" }, tx("common.youreInControl"))
          : h("span", { class: "bp-badge" }, tx("desktop.browser.tabs", { tabsCount: x.tabs.length })),
      );
    });
    return h(
      "div",
      { class: "space-menu", role: "listbox" },
      h("div", { class: "space-menu-label" }, "SPACES"),
      ...items,
    );
  }

  private bar(s: Space): HTMLElement {
    const tabs = s.tabs.map((t) =>
      h(
        "button",
        {
          class: "bp-tab",
          type: "button",
          role: "tab",
          "aria-selected": t.tabId === s.activeTabId ? "true" : "false",
          "data-loading": t.loading ? "" : undefined,
          title: t.url,
          onclick: () => {
            if (s.controller === "user" && t.tabId !== s.activeTabId)
              void this.api.tab(s.spaceId, "switch", t.tabId).catch((err) => this.hooks.error(err));
          },
        },
        h(
          "i",
          { class: "fav" },
          t.loading ? "" : (t.title || hostOf(t.url).host.replace(/^www\./, "")).slice(0, 1).toUpperCase(),
        ),
        h("span", {}, t.title || tx("desktop.browser.newTab")),
      ),
    );
    const tab = s.tabs.find((t) => t.tabId === s.activeTabId) ?? s.tabs[0];
    const url = tab?.url ?? "";
    // Alca's page reads as a site name; the full address shows when the field has focus.
    const shown = s.controller === "user" ? url : siteOf(url) || url;
    const input = h("input", {
      type: "text",
      value: shown,
      "aria-label": tx("common.address"),
      spellcheck: "false",
      readonly: s.controller !== "user",
      title:
        s.controller === "user"
          ? tx("desktop.browser.typeAnAddressAndPress")
          : tx("desktop.browser.takeOverToTypeAn"),
    });
    input.addEventListener("focus", () => {
      input.value = url;
      input.select();
    });
    input.addEventListener("blur", () => {
      if (s.controller !== "user") input.value = shown;
    });
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && s.controller === "user" && input.value.trim()) {
        ev.preventDefault();
        void this.api.navigate(s.spaceId, input.value.trim()).catch((err) => this.hooks.error(err));
      }
    });
    const addr = h("label", { class: "bp-address" });
    addr.append(icon(url.startsWith("https:") ? I.lock : I.globe), input);
    return h("div", { class: "bp-bar" }, h("div", { class: "bp-tabs", role: "tablist" }, ...tabs), addr);
  }

  private stage(s: Space): HTMLElement {
    const frame = h("div", {
      class: "bp-frame",
      "data-controller": s.controller,
      tabindex: s.controller === "user" ? "0" : "-1",
      "aria-label":
        s.controller === "user"
          ? tx("desktop.browser.youreUsingThisPageClick")
          : tx("desktop.browser.alcasBrowserView"),
    });
    frame.style.setProperty("--frame-ratio", this.ratio);
    frame.append(this.img);
    if (!this.frameSeen)
      frame.append(h("div", { class: "bp-blank" }, tx("desktop.browser.connectingToTheView")));
    const caption =
      s.controller === "user"
        ? s.handoffReason && s.handoffReason !== "使用者接手"
          ? tx("desktop.browser.yourTurn", { handoffReason: s.handoffReason })
          : tx("desktop.browser.youreInControlClickThe")
        : s.status === "working" && s.lastAction
          ? s.lastAction.label
          : undefined;
    if (caption)
      frame.append(
        h("div", { class: "bp-caption" }, h("i", { "aria-hidden": "true" }), h("span", {}, caption)),
      );
    const at = (ev: MouseEvent) => {
      const r = this.img.getBoundingClientRect();
      return { x: (ev.clientX - r.left) / r.width, y: (ev.clientY - r.top) / r.height };
    };
    frame.addEventListener("click", (ev) => this.send(s, { type: "click", ...at(ev) }));
    let wheelAt = 0;
    frame.addEventListener(
      "wheel",
      (ev) => {
        if (s.controller !== "user") return;
        ev.preventDefault();
        if (Date.now() - wheelAt < 60) return;
        wheelAt = Date.now();
        this.send(s, { type: "wheel", ...at(ev), dy: Math.round(ev.deltaY) });
      },
      { passive: false },
    );
    frame.addEventListener("keydown", (ev) => {
      if (s.controller !== "user" || ev.isComposing) return;
      // ⌘A / Ctrl+A and the other editing shortcuts go to the page (C3); ⌘V stays the paste event below.
      const cut = remoteShortcut(ev, isMac);
      if (cut) {
        ev.preventDefault();
        this.send(s, { type: "shortcut", action: cut });
        return;
      }
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      if (KEYS.has(ev.key)) this.send(s, { type: "key", key: ev.key });
      else if (ev.key.length === 1) this.send(s, { type: "text", text: ev.key });
      else return;
      ev.preventDefault();
    });
    frame.addEventListener("paste", (ev) => {
      const text = ev.clipboardData?.getData("text") ?? "";
      if (text) this.send(s, { type: "text", text });
    });
    const stage = h("div", { class: "bp-stage" }, frame);
    const p = [...this.pending.values()].find((x) => x.threadId === s.threadId);
    if (p) stage.append(this.approval(p));
    return stage;
  }

  private approval(p: Pending): HTMLElement {
    return approvalCard(p);
  }

  private foot(s: Space): HTMLElement {
    const bot = this.bots.get(s.botId)?.name ?? "bot";
    const last = s.lastAction;
    return h(
      "footer",
      { class: "bp-foot" },
      h("span", {}, tx("desktop.browser.operating", { bot })),
      last ? h("i", { class: "sep", "aria-hidden": "true" }) : null,
      last
        ? h(
            "span",
            { class: "bp-last", "data-ok": last.ok ? "true" : "false" },
            tx("desktop.browser.text", {
              p0: last.ok ? tx("desktop.browser.lastStep") : tx("desktop.browser.failed"),
              label: last.label,
            }),
          )
        : null,
      this.cookieImport && canImport(s) ? importButton(this.api, s, (e) => this.hooks.error(e)) : null,
    );
  }

  /** First-run download of Chrome for Testing: progress, or the button that starts it. */
  private installStrip(): HTMLElement | null {
    const st = this.install;
    const busy = st && ["checking", "downloading", "verifying", "extracting"].includes(st.phase);
    if (this.chromium && !busy && st?.phase !== "failed") return null;
    const mb = (n: number | undefined) => (n === undefined ? "?" : (n / 1024 / 1024).toFixed(1));
    const ver = st?.version ? ` ${st.version}` : "";
    let line = tx("desktop.browser.thisComputerDoesntHaveA");
    let bar: HTMLElement | null = null;
    let action: HTMLElement | null = null;
    const start = (label: string) =>
      h(
        "button",
        {
          class: "btn btn-quiet",
          type: "button",
          onclick: () =>
            void this.api
              .installBrowser()
              .then((x) => {
                this.install = x;
                this.render();
              })
              .catch((err) => this.hooks.error(err)),
        },
        label,
      );
    if (st?.phase === "checking") line = tx("desktop.browser.checkingTheLatestChromeFor");
    else if (st?.phase === "downloading") {
      line = tx("desktop.browser.downloadingTheBrowserChromeFor", {
        ver,
        received: mb(st.received),
        total: mb(st.total),
      });
      bar = h("progress", {
        max: String(st.total ?? 1),
        ...(st.total ? { value: String(st.received ?? 0) } : {}),
        "aria-label": tx("desktop.browser.downloadProgress"),
      });
    } else if (st?.phase === "verifying") line = tx("desktop.browser.downloadFinishedCheckingTheFiles");
    else if (st?.phase === "extracting") {
      line = tx("desktop.browser.unpacking", {
        entries: st.entries ?? 0,
        entriesTotal: st.entriesTotal ?? "?",
      });
      bar = h("progress", {
        max: String(st.entriesTotal ?? 1),
        value: String(st.entries ?? 0),
        "aria-label": tx("desktop.browser.unpackProgress"),
      });
    } else if (st?.phase === "failed") {
      line = tx("desktop.browser.browserDownloadFailed", {
        error: st.error ?? tx("desktop.browser.unknownError"),
      });
      action = start(tx("common.retry"));
    } else if (!st?.auto) action = start(tx("common.downloadTheBrowserAbout200"));
    return h(
      "div",
      { class: "bp-install", role: "status", "data-tone": st?.phase === "failed" ? "danger" : "calm" },
      h("p", {}, line),
      ...(bar ? [bar] : []),
      ...(action ? [action] : []),
      h("p", { class: "bp-install-note" }, tx("desktop.browser.itLivesOnlyInAlcas")),
    );
  }

  private empty(): HTMLElement {
    return h(
      "div",
      { class: "bp-empty" },
      h("h3", {}, tx("desktop.browser.noBrowserSpacesYet")),
      h("p", {}, tx("desktop.browser.whenYouAskAlcaTo")),
      h(
        "button",
        {
          class: "btn btn-quiet",
          type: "button",
          onclick: () =>
            void this.api
              .openSpace({
                title: tx("desktop.browser.myBrowsing"),
                ...(this.thread ? { threadId: this.thread } : {}),
              })
              .then((sp) => {
                this.spaces.set(sp.spaceId, sp);
                this.select(sp.spaceId);
                this.render();
              })
              .catch((err) => this.hooks.error(err)),
        },
        tx("desktop.browser.openASpace"),
      ),
    );
  }
}
