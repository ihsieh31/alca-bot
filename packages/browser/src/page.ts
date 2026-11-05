import { type Cdp, CdpSession } from "./cdp/connection.ts";
import type { ElementFacts } from "./sensitive.ts";
import {
  type AXNode,
  buildSnapshot,
  type ElementHandle,
  type FrameTree,
  type SnapshotResult,
  StaleRefError,
} from "./snapshot.ts";

/**
 * One tab's driver: frames, snapshots, and the primitive actions. Only the
 * host calls it; every function the page runs here is host-authored and
 * fixed (no agent-supplied JavaScript reaches the page).
 */

interface FrameInfo {
  id: string;
  parentId?: string;
  loaderId: string;
  url: string;
}

export interface Viewport {
  width: number;
  height: number;
}

export interface Frame {
  mime: "image/jpeg" | "image/png";
  data: string;
  width: number;
  height: number;
}

export type UserInput =
  | { type: "click"; x: number; y: number }
  | { type: "wheel"; x: number; y: number; dy: number }
  | { type: "text"; text: string }
  | { type: "key"; key: string }
  | { type: "shortcut"; action: ShortcutAction };

/** Editing shortcuts a person can send from the takeover view (mac test 2026-11-04b C3). */
export const SHORTCUT_ACTIONS = ["selectAll", "copy", "cut", "paste", "undo", "redo"] as const;
export type ShortcutAction = (typeof SHORTCUT_ACTIONS)[number];

const SHORTCUT_KEY: Record<ShortcutAction, { key: string; shift?: boolean }> = {
  selectAll: { key: "a" },
  copy: { key: "c" },
  cut: { key: "x" },
  paste: { key: "v" },
  undo: { key: "z" },
  redo: { key: "z", shift: true },
};

/** CDP `Input.dispatchKeyEvent` modifier bits. */
const MOD_CTRL = 2;
const MOD_META = 4;
const MOD_SHIFT = 8;

/**
 * The keyDown of an editing shortcut, as CDP takes it: the platform's command
 * modifier (Meta on macOS, Ctrl elsewhere — the Chromium runs on this
 * machine) and the editing command itself in `commands`, which Chromium
 * executes whatever its keymap; the modifiers keep the page's own key
 * handlers seeing a real ⌘A / Ctrl+A.
 */
export function shortcutKeyEvent(action: ShortcutAction, platform: string = process.platform) {
  const k = SHORTCUT_KEY[action];
  const upper = k.key.toUpperCase();
  const modifiers = (platform === "darwin" ? MOD_META : MOD_CTRL) | (k.shift ? MOD_SHIFT : 0);
  return {
    key: k.shift ? upper : k.key,
    code: `Key${upper}`,
    windowsVirtualKeyCode: upper.charCodeAt(0),
    nativeVirtualKeyCode: upper.charCodeAt(0),
    modifiers,
    commands: [action],
  };
}

export class NavigationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NavigationError";
  }
}

const KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Tab: { code: "Tab", keyCode: 9 },
  Escape: { code: "Escape", keyCode: 27 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  PageUp: { code: "PageUp", keyCode: 33 },
  PageDown: { code: "PageDown", keyCode: 34 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
  " ": { code: "Space", keyCode: 32, text: " " },
};
export const SUPPORTED_KEYS = Object.freeze(Object.keys(KEYS));

const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

/** Only web pages and about:blank. No javascript:, file:, chrome:, data: or extension pages. */
export function checkNavigableUrl(raw: string): string {
  const text = raw.trim();
  if (text === "about:blank") return text;
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`);
  } catch {
    throw new NavigationError(`不是有效的網址：${text.slice(0, 200)}`);
  }
  if (!ALLOWED_SCHEMES.has(u.protocol)) throw new NavigationError(`不允許的網址類型：${u.protocol}`);
  return u.href;
}

const FACTS_FN = `function () {
  const el = this;
  const f = el.form || (el.closest ? el.closest("form") : null);
  const fields = f ? Array.from(f.querySelectorAll("input,select,textarea")) : [];
  const card = fields.some((x) => /cc-(number|csc|exp)/i.test(x.autocomplete || "") ||
    /card.?num|cardnumber|cvv|cvc|security.?code/i.test((x.name || "") + " " + (x.id || "")));
  const sub = f ? f.querySelector("button[type=submit],button:not([type]),input[type=submit]") : null;
  const label = (n) => n ? (n.innerText || n.value || n.getAttribute("aria-label") || "").trim().slice(0, 120) : "";
  return {
    tag: (el.tagName || "").toLowerCase(),
    type: (el.getAttribute && el.getAttribute("type")) || "",
    href: el.href ? String(el.href) : "",
    autocomplete: el.autocomplete || (el.getAttribute && el.getAttribute("autocomplete")) || "",
    fieldName: ((el.name || "") + " " + (el.id || "")).trim(),
    form: f ? {
      action: f.action ? String(f.action) : "",
      method: String(f.method || "get").toLowerCase(),
      hasPassword: !!f.querySelector("input[type=password]"),
      hasCardFields: card,
      isSearch: f.getAttribute("role") === "search" || !!f.closest("[role=search]") ||
        fields.some((x) => x.type === "search"),
      submitLabel: label(sub),
    } : null,
  };
}`;

const SELECT_FN = `function (want) {
  if (!(this instanceof HTMLSelectElement)) return { error: "not a select" };
  const o = Array.from(this.options).find((o) => o.value === want || o.label === want || o.text.trim() === want);
  if (!o) return { error: "no such option", options: Array.from(this.options).map((o) => o.text.trim()).slice(0, 30) };
  this.value = o.value;
  this.dispatchEvent(new Event("input", { bubbles: true }));
  this.dispatchEvent(new Event("change", { bubbles: true }));
  return { label: o.text.trim() };
}`;

const CLEAR_FN = `function () {
  if ("value" in this) {
    this.value = "";
    this.dispatchEvent(new Event("input", { bubbles: true }));
  } else if (this.isContentEditable) this.textContent = "";
}`;

const HOVER_FN = `function () {
  for (const t of ["pointerover", "mouseover", "pointerenter", "mouseenter", "mousemove"])
    this.dispatchEvent(new MouseEvent(t, { bubbles: true }));
}`;

const CHECKED_FN = `function () {
  if (this instanceof HTMLInputElement && (this.type === "checkbox" || this.type === "radio")) return !!this.checked;
  const a = this.getAttribute && this.getAttribute("aria-checked");
  if (a === "true" || a === "mixed") return true;
  if (a === "false") return false;
  return null;
}`;

export class TabDriver {
  readonly cdp: Cdp;
  readonly targetId: string;
  readonly session: CdpSession;
  private readonly frames = new Map<string, FrameInfo>();
  private readonly oopif = new Map<string, CdpSession>();
  private readonly oopifParent = new Map<string, string>();
  private mainFrameId = "";
  private current: SnapshotResult | undefined;
  private loading = false;
  private snapCount = 0;
  private readonly off: Array<() => void> = [];
  private screencastFn: ((f: Frame) => void) | undefined;
  title = "";
  url = "about:blank";
  onChange: (() => void) | undefined;
  /**
   * Called for the tab's own session and each child session (out-of-process
   * frames, workers) before it runs; the network gate hooks in here. A
   * failure fails the tab: the gate never silently turns off.
   */
  onSession: ((session: CdpSession, kind: string) => Promise<unknown>) | undefined;

  constructor(cdp: Cdp, targetId: string, sessionId: string) {
    this.cdp = cdp;
    this.targetId = targetId;
    this.session = new CdpSession(cdp, sessionId);
  }

  get snapshotId(): string | undefined {
    return this.current?.snapshotId;
  }
  get isLoading(): boolean {
    return this.loading;
  }
  /** Drop the current snapshot: every `@N` from it becomes stale. */
  invalidate(): void {
    this.current = undefined;
  }

  async init(): Promise<void> {
    const s = this.session;
    this.off.push(
      s.on("Page.frameNavigated", (p) => this.onFrameNavigated(p.frame)),
      s.on("Page.frameDetached", (p) => this.frames.delete(String(p.frameId))),
      s.on("Page.frameStartedLoading", (p) => {
        if (p.frameId === this.mainFrameId) this.setLoading(true);
      }),
      s.on("Page.frameStoppedLoading", (p) => {
        if (p.frameId === this.mainFrameId) this.setLoading(false);
      }),
      s.on("Target.attachedToTarget", (p) => void this.onAttached(p)),
      s.on("Page.screencastFrame", (p) => {
        void s.send("Page.screencastFrameAck", { sessionId: p.sessionId }).catch(() => undefined);
        const m = p.metadata ?? {};
        this.screencastFn?.({
          mime: "image/jpeg",
          data: String(p.data),
          width: Math.round(Number(m.deviceWidth ?? 0)) || 1,
          height: Math.round(Number(m.deviceHeight ?? 0)) || 1,
        });
      }),
    );
    await this.onSession?.(s, "page");
    await s.send("Page.enable");
    await s.send("Accessibility.enable").catch(() => undefined);
    // Children start paused so the gate is on before their first request.
    await s
      .send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true })
      .catch(() => undefined);
    const tree = await s.send("Page.getFrameTree");
    this.ingestTree(tree.frameTree);
  }

  dispose(): void {
    for (const f of this.off.splice(0)) f();
  }

  private ingestTree(node: { frame: FrameInfo; childFrames?: unknown[] } | undefined): void {
    if (!node) return;
    const f = node.frame;
    this.frames.set(f.id, {
      id: f.id,
      loaderId: f.loaderId,
      url: f.url,
      ...(f.parentId ? { parentId: f.parentId } : {}),
    });
    if (!f.parentId) {
      this.mainFrameId = f.id;
      this.url = f.url;
    }
    for (const c of (node.childFrames ?? []) as Array<{ frame: FrameInfo; childFrames?: unknown[] }>)
      this.ingestTree(c);
  }

  private onFrameNavigated(f: FrameInfo): void {
    const prev = this.frames.get(f.id);
    this.frames.set(f.id, {
      id: f.id,
      loaderId: f.loaderId,
      url: f.url,
      ...(f.parentId ? { parentId: f.parentId } : {}),
    });
    if (!f.parentId) {
      this.mainFrameId = f.id;
      this.url = f.url;
      // A new document: every ref from the old one is void.
      if (!prev || prev.loaderId !== f.loaderId) this.current = undefined;
      this.onChange?.();
    }
  }

  private setLoading(v: boolean): void {
    if (this.loading === v) return;
    this.loading = v;
    this.onChange?.();
  }

  private async onAttached(p: {
    sessionId: string;
    targetInfo: { type: string; targetId: string; url?: string; parentFrameId?: string };
  }) {
    const child = new CdpSession(this.cdp, p.sessionId);
    if (p.targetInfo.type !== "iframe") {
      // Workers: gate what we can (not every worker type takes Fetch), then let them run.
      await this.onSession?.(child, p.targetInfo.type).catch(() => undefined);
      await child.send("Runtime.runIfWaitingForDebugger").catch(() => undefined);
      return;
    }
    const id = p.targetInfo.targetId;
    this.oopif.set(id, child);
    // An out-of-process frame is not in the page's frame tree; its frame id is its target id.
    this.oopifParent.set(id, p.targetInfo.parentFrameId ?? this.mainFrameId);
    this.off.push(
      child.on("Page.frameNavigated", (e) => {
        const f = e.frame as FrameInfo;
        const known = this.frames.get(f.id);
        this.frames.set(f.id, { ...f, ...(known?.parentId ? { parentId: known.parentId } : {}) });
      }),
    );
    try {
      await this.onSession?.(child, "iframe");
    } catch {
      // No gate on this frame: it never runs.
      await child.send("Target.detachFromTarget", { sessionId: p.sessionId }).catch(() => undefined);
      return;
    }
    await child.send("Page.enable").catch(() => undefined);
    await child.send("Accessibility.enable").catch(() => undefined);
    await child.send("Runtime.runIfWaitingForDebugger").catch(() => undefined);
  }

  /** Session that owns a frame: the OOPIF's own session, or the page session. */
  private sessionFor(frameId: string): CdpSession {
    return this.oopif.get(frameId) ?? this.session;
  }

  async refreshTitle(): Promise<void> {
    const info = await this.cdp
      .send("Target.getTargetInfo", { targetId: this.targetId })
      .catch(() => undefined);
    if (info?.targetInfo) {
      this.title = String(info.targetInfo.title ?? "");
      this.url = String(info.targetInfo.url ?? this.url);
    }
  }

  async snapshot(maxChars?: number): Promise<SnapshotResult> {
    const tree = await this.session.send("Page.getFrameTree");
    this.ingestTree(tree.frameTree);
    for (const [id, child] of this.oopif) {
      const t = await child.send("Page.getFrameTree").catch(() => undefined);
      const f = t?.frameTree?.frame as FrameInfo | undefined;
      if (!f) {
        this.oopif.delete(id);
        continue;
      }
      const parentId = this.oopifParent.get(id) ?? this.mainFrameId;
      this.frames.set(f.id, { id: f.id, loaderId: f.loaderId, url: f.url, parentId });
    }
    const trees: FrameTree[] = [];
    for (const f of this.frames.values()) {
      const sess = this.sessionFor(f.id);
      try {
        const ax = await sess.send(
          "Accessibility.getFullAXTree",
          sess === this.session ? { frameId: f.id } : {},
        );
        let owner: number | undefined;
        if (f.parentId) {
          const o = await this.sessionFor(f.parentId)
            .send("DOM.getFrameOwner", { frameId: f.id })
            .catch(() => undefined);
          owner = typeof o?.backendNodeId === "number" ? o.backendNodeId : undefined;
        }
        trees.push({
          sessionId: sess.sessionId,
          frameId: f.id,
          loaderId: f.loaderId,
          url: f.url,
          ...(f.parentId ? { parentFrameId: f.parentId } : {}),
          ...(owner !== undefined ? { ownerBackendNodeId: owner } : {}),
          nodes: (ax.nodes ?? []) as AXNode[],
        });
      } catch {
        // a frame that went away mid-snapshot is skipped
      }
    }
    await this.refreshTitle();
    this.snapCount += 1;
    const snap = buildSnapshot(trees, {
      snapshotId: `${this.targetId.slice(0, 8)}-${this.snapCount}`,
      title: this.title,
      ...(maxChars ? { maxChars } : {}),
    });
    this.current = snap;
    return snap;
  }

  /** Resolve `@N` against the current snapshot and the frame's current document. */
  handle(ref: number): ElementHandle {
    if (!this.current) throw new StaleRefError(`@${ref} 來自舊的畫面`);
    const h = this.current.refs.get(ref);
    if (!h) throw new StaleRefError(`目前的快照裡沒有 @${ref}`);
    const frame = this.frames.get(h.frameId);
    if (!frame || frame.loaderId !== h.loaderId) throw new StaleRefError(`@${ref} 所在的頁面已經換了`);
    return h;
  }

  /** Find a ref by role + accessible name (replayable locators). */
  find(role: string | undefined, name: string, nth = 0, exact = false): ElementHandle | undefined {
    if (!this.current) return undefined;
    const want = name.trim().toLowerCase();
    const hits = [...this.current.refs.values()].filter(
      (h) =>
        (!role || h.role === role) &&
        (exact ? h.name.toLowerCase() === want : h.name.toLowerCase().includes(want)),
    );
    return hits[nth];
  }

  private sessionOf(h: ElementHandle): CdpSession {
    return h.sessionId === this.session.sessionId ? this.session : new CdpSession(this.cdp, h.sessionId);
  }

  private async callOn(h: ElementHandle, fn: string, args: unknown[] = []): Promise<unknown> {
    const s = this.sessionOf(h);
    const r = await s.send("DOM.resolveNode", { backendNodeId: h.backendNodeId });
    const objectId = r.object?.objectId;
    if (!objectId) throw new StaleRefError(`@${h.ref} 已不在頁面上`);
    try {
      const out = await s.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: fn,
        arguments: args.map((value) => ({ value })),
        returnByValue: true,
        awaitPromise: true,
      });
      if (out.exceptionDetails) throw new Error(String(out.exceptionDetails.text ?? "page error"));
      return out.result?.value;
    } finally {
      void s.send("Runtime.releaseObject", { objectId }).catch(() => undefined);
    }
  }

  async facts(h: ElementHandle): Promise<ElementFacts> {
    const raw = ((await this.callOn(h, FACTS_FN).catch(() => ({}))) ?? {}) as Record<string, unknown>;
    const form = raw.form as ElementFacts["form"] | null | undefined;
    return {
      role: h.role,
      name: h.name,
      ...(typeof raw.tag === "string" ? { tag: raw.tag } : {}),
      ...(typeof raw.type === "string" && raw.type ? { type: raw.type } : {}),
      ...(typeof raw.href === "string" && raw.href ? { href: raw.href } : {}),
      ...(typeof raw.autocomplete === "string" && raw.autocomplete ? { autocomplete: raw.autocomplete } : {}),
      ...(typeof raw.fieldName === "string" && raw.fieldName ? { fieldName: raw.fieldName } : {}),
      ...(form ? { form } : {}),
    };
  }

  async viewport(): Promise<Viewport> {
    const m = await this.session.send("Page.getLayoutMetrics");
    const v = m.cssVisualViewport ?? m.layoutViewport ?? {};
    return { width: Math.round(v.clientWidth ?? 1280), height: Math.round(v.clientHeight ?? 800) };
  }

  /** Wait for the main frame to finish loading (if it is loading). */
  async settle(timeoutMs = 10_000, graceMs = 150): Promise<void> {
    await sleep(graceMs);
    const start = Date.now();
    while (this.loading && Date.now() - start < timeoutMs) await sleep(50);
  }

  async navigate(url: string, timeoutMs = 20_000): Promise<void> {
    const href = checkNavigableUrl(url);
    const loaded = new Promise<void>((resolve) => {
      const off = this.session.on("Page.loadEventFired", () => {
        off();
        resolve();
      });
      setTimeout(() => {
        off();
        resolve();
      }, timeoutMs).unref?.();
    });
    const r = await this.session.send("Page.navigate", { url: href });
    if (r.errorText) throw new NavigationError(`無法開啟 ${href}：${r.errorText}`);
    this.current = undefined;
    if (r.loaderId) await loaded;
    await this.refreshTitle();
  }

  async click(h: ElementHandle): Promise<void> {
    const s = this.sessionOf(h);
    await s.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: h.backendNodeId }).catch(() => undefined);
    if (h.sessionId !== this.session.sessionId || h.frameId !== this.mainFrameId) {
      // Inside a child frame: coordinates are frame-relative, so use the element's own click().
      await this.callOn(h, "function () { this.click(); }");
    } else {
      const q = await s
        .send("DOM.getContentQuads", { backendNodeId: h.backendNodeId })
        .catch(() => undefined);
      const quad: number[] | undefined = q?.quads?.[0];
      if (!quad) throw new StaleRefError(`@${h.ref} 目前看不到（可能被隱藏）`);
      const x = (quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4;
      const y = (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4;
      await this.mouseClick(x, y);
    }
    await this.settle();
  }

  async mouseClick(x: number, y: number): Promise<void> {
    const s = this.session;
    await s.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await s.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await s.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  }

  async type(
    h: ElementHandle,
    text: string,
    opts: { clear?: boolean; submit?: boolean } = {},
  ): Promise<void> {
    const s = this.sessionOf(h);
    await s.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: h.backendNodeId }).catch(() => undefined);
    await s.send("DOM.focus", { backendNodeId: h.backendNodeId });
    if (opts.clear) await this.callOn(h, CLEAR_FN);
    if (text) await s.send("Input.insertText", { text });
    if (opts.submit) await this.press("Enter", s);
    await this.settle();
  }

  async press(key: string, s: CdpSession = this.session): Promise<void> {
    const k = KEYS[key];
    if (!k) throw new Error(`不支援的按鍵：${key}（可用：${SUPPORTED_KEYS.join("、")}）`);
    const base = { key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode };
    await s.send("Input.dispatchKeyEvent", { type: "keyDown", ...base, ...(k.text ? { text: k.text } : {}) });
    await s.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  async focus(h: ElementHandle): Promise<void> {
    await this.sessionOf(h).send("DOM.focus", { backendNodeId: h.backendNodeId });
  }

  async select(h: ElementHandle, option: string): Promise<string> {
    const r = (await this.callOn(h, SELECT_FN, [option])) as {
      label?: string;
      error?: string;
      options?: string[];
    };
    if (r?.error)
      throw new Error(
        r.options ? `找不到選項「${option}」，可選：${r.options.join("、")}` : `@${h.ref} 不是下拉選單`,
      );
    await this.settle(5000, 50);
    return r?.label ?? option;
  }

  async scroll(opts: { h?: ElementHandle; dy?: number }): Promise<void> {
    if (opts.h) {
      await this.sessionOf(opts.h).send("DOM.scrollIntoViewIfNeeded", {
        backendNodeId: opts.h.backendNodeId,
      });
      return;
    }
    const vp = await this.viewport();
    await this.session.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: vp.width / 2,
      y: vp.height / 2,
      deltaX: 0,
      deltaY: opts.dy ?? Math.round(vp.height * 0.8),
    });
    await sleep(100);
  }

  /** Move the pointer over an element (menus that open on hover). Not a mutating step. */
  async hover(h: ElementHandle): Promise<void> {
    const s = this.sessionOf(h);
    await s.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: h.backendNodeId }).catch(() => undefined);
    if (h.sessionId !== this.session.sessionId || h.frameId !== this.mainFrameId) {
      await this.callOn(h, HOVER_FN);
    } else {
      const q = await s
        .send("DOM.getContentQuads", { backendNodeId: h.backendNodeId })
        .catch(() => undefined);
      const quad: number[] | undefined = q?.quads?.[0];
      if (!quad) throw new StaleRefError(`@${h.ref} 目前看不到（可能被隱藏）`);
      const x = (quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4;
      const y = (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4;
      await s.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    }
    await sleep(100);
  }

  /** Whether a checkbox / radio / switch is checked; undefined when the element is not checkable. */
  async checkedState(h: ElementHandle): Promise<boolean | undefined> {
    const v = await this.callOn(h, CHECKED_FN);
    return typeof v === "boolean" ? v : undefined;
  }

  /**
   * Plan §5: a CSS target. The selector runs in the main frame's document
   * (DOM.querySelectorAll, no page script), and only an element that is
   * also in the current snapshot can be acted on, so every step still has a
   * role and a name for the sensitive-action gate.
   */
  async findCss(selector: string, nth = 0): Promise<ElementHandle | undefined> {
    if (!this.current) await this.snapshot();
    const doc = await this.session.send("DOM.getDocument", { depth: 0 });
    const rootId = doc.root?.nodeId;
    if (rootId === undefined) return undefined;
    const r = await this.session
      .send("DOM.querySelectorAll", { nodeId: rootId, selector })
      .catch((err: unknown) => {
        throw new Error(
          `css 選擇器無效：${selector}（${String((err as Error)?.message ?? err).slice(0, 120)}）`,
        );
      });
    const ids: number[] = Array.isArray(r?.nodeIds) ? r.nodeIds : [];
    const backends: number[] = [];
    for (const nodeId of ids.slice(0, 200)) {
      const d = await this.session.send("DOM.describeNode", { nodeId }).catch(() => undefined);
      const b = d?.node?.backendNodeId;
      if (typeof b === "number") backends.push(b);
    }
    const refs = [...(this.current?.refs.values() ?? [])].filter(
      (h) => h.sessionId === this.session.sessionId && h.frameId === this.mainFrameId,
    );
    const hits = backends
      .map((b) => refs.find((h) => h.backendNodeId === b))
      .filter((h): h is ElementHandle => !!h);
    return hits[nth];
  }

  async readText(h?: ElementHandle, maxChars = 8000): Promise<string> {
    let text: string;
    if (h)
      text = String(
        (await this.callOn(h, "function () { return this.innerText || this.textContent || ''; }")) ?? "",
      );
    else {
      const r = await this.session.send("Runtime.evaluate", {
        expression: "document.body ? document.body.innerText : ''",
        returnByValue: true,
      });
      text = String(r.result?.value ?? "");
    }
    text = text.replace(/\n{3,}/g, "\n\n").trim();
    return text.length > maxChars ? `${text.slice(0, maxChars)}\n…（已截斷）` : text;
  }

  async waitForText(text: string, timeoutMs = 10_000): Promise<boolean> {
    const start = Date.now();
    const expression = `!!document.body && document.body.innerText.includes(${JSON.stringify(text)})`;
    while (Date.now() - start < timeoutMs) {
      const r = await this.session
        .send("Runtime.evaluate", { expression, returnByValue: true })
        .catch(() => undefined);
      if (r?.result?.value === true) return true;
      await sleep(100);
    }
    return false;
  }

  async screenshot(format: "png" | "jpeg" = "png"): Promise<Frame> {
    const vp = await this.viewport();
    const r = await this.session.send("Page.captureScreenshot", {
      format,
      ...(format === "jpeg" ? { quality: 70 } : {}),
    });
    return {
      mime: format === "png" ? "image/png" : "image/jpeg",
      data: String(r.data),
      width: vp.width,
      height: vp.height,
    };
  }

  async startScreencast(fn: (f: Frame) => void, size = { width: 1280, height: 800 }): Promise<void> {
    this.screencastFn = fn;
    await this.session.send("Page.startScreencast", {
      format: "jpeg",
      quality: 70,
      maxWidth: size.width,
      maxHeight: size.height,
      everyNthFrame: 1,
    });
  }

  async stopScreencast(): Promise<void> {
    this.screencastFn = undefined;
    await this.session.send("Page.stopScreencast").catch(() => undefined);
  }

  /** A person driving the Space from the desktop or phone view (normalized 0..1 coordinates). */
  async userInput(input: UserInput): Promise<void> {
    if (input.type === "text") {
      if (input.text) await this.session.send("Input.insertText", { text: input.text.slice(0, 2000) });
      return;
    }
    if (input.type === "key") return this.press(input.key);
    if (input.type === "shortcut") {
      const { commands, ...base } = shortcutKeyEvent(input.action);
      await this.session.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base, commands });
      await this.session.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
      return;
    }
    const vp = await this.viewport();
    const x = clamp01(input.x) * vp.width;
    const y = clamp01(input.y) * vp.height;
    if (input.type === "click") await this.mouseClick(x, y);
    else
      await this.session.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x,
        y,
        deltaX: 0,
        deltaY: input.dy,
      });
  }
}

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5);
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
