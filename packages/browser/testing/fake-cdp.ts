// An in-memory stand-in for a Chromium CDP connection, for unit tests.
// Pages are described as flat accessibility trees; clicks on links navigate,
// typed text lands in the focused node, and every command is logged.
import type { Cdp } from "../src/cdp/connection.ts";
import type { AXNode } from "../src/snapshot.ts";
import type { BrowserProcessLike } from "../src/space.ts";

export interface FakeNode {
  role: string;
  name?: string;
  /** Backend DOM node id (unique within the page). */
  id: number;
  value?: string;
  /** Clicking navigates here. */
  href?: string;
  /** What the facts probe returns for this node. */
  facts?: Record<string, unknown>;
  options?: string[];
  /** A checkbox / radio: its starting state (clicking toggles it). */
  checked?: boolean;
  /** CSS selectors this node matches (DOM.querySelectorAll). */
  css?: string[];
  children?: FakeNode[];
}

export interface FakePage {
  title: string;
  nodes: FakeNode[];
  text?: string;
}

type Json = Record<string, unknown>;
type Listener = (params: Json, sessionId: string | undefined) => void;

interface Target {
  targetId: string;
  url: string;
  title: string;
  loaderId: string;
  contextId?: string;
  values: Map<number, string>;
  checked?: Map<number, boolean>;
  focused?: number;
}

let seq = 0;
const nid = (p: string) => `${p}${(++seq).toString(16).padStart(6, "0")}`;

export class FakeCdp implements Cdp {
  readonly site: Record<string, FakePage>;
  readonly calls: Array<{ method: string; params: Json; sessionId?: string }> = [];
  readonly targets = new Map<string, Target>();
  private readonly sessions = new Map<string, string>();
  private readonly listeners = new Map<string, Set<{ fn: Listener; sessionId: string | undefined }>>();
  closed = false;
  /** Optional hook: return a value to override a command's result. */
  intercept?: (method: string, params: Json, t: Target | undefined) => unknown;

  constructor(site: Record<string, FakePage>) {
    this.site = site;
  }

  page(t: Target): FakePage {
    return this.site[t.url] ?? { title: "", nodes: [] };
  }

  private flat(nodes: FakeNode[], out: FakeNode[] = []): FakeNode[] {
    for (const n of nodes) {
      out.push(n);
      if (n.children) this.flat(n.children, out);
    }
    return out;
  }

  node(t: Target, id: number): FakeNode | undefined {
    return this.flat(this.page(t).nodes).find((n) => n.id === id);
  }

  on(method: string, fn: Listener, sessionId?: string): () => void {
    let set = this.listeners.get(method);
    if (!set) {
      set = new Set();
      this.listeners.set(method, set);
    }
    const e = { fn, sessionId };
    set.add(e);
    return () => set.delete(e);
  }

  fire(method: string, params: Json, sessionId?: string): void {
    for (const l of [...(this.listeners.get(method) ?? [])])
      if (l.sessionId === "*" || l.sessionId === sessionId) l.fn(params, sessionId);
  }

  close(): void {
    this.closed = true;
  }

  sessionOf(targetId: string): string | undefined {
    for (const [s, t] of this.sessions) if (t === targetId) return s;
    return undefined;
  }

  /** Navigate a tab as if the page did it (e.g. a person clicking). */
  navigateTarget(t: Target, url: string): void {
    t.url = url;
    t.title = this.page(t).title;
    t.loaderId = nid("L");
    t.values.clear();
    t.checked?.clear();
    const s = this.sessionOf(t.targetId);
    this.fire("Page.frameNavigated", { frame: { id: t.targetId, loaderId: t.loaderId, url } }, s);
    this.fire("Page.loadEventFired", {}, s);
  }

  private axNodes(t: Target): AXNode[] {
    const out: AXNode[] = [];
    const root: AXNode = {
      nodeId: "root",
      role: { value: "RootWebArea" },
      name: { value: t.title },
      childIds: [],
    };
    out.push(root);
    const add = (n: FakeNode, parent: AXNode) => {
      const ax: AXNode = {
        nodeId: `n${n.id}`,
        parentId: parent.nodeId,
        role: { value: n.role },
        name: { value: n.name ?? "" },
        backendDOMNodeId: n.id,
        childIds: [],
        ...((t.values.get(n.id) ?? n.value) ? { value: { value: t.values.get(n.id) ?? n.value } } : {}),
        ...(n.href ? { properties: [{ name: "url", value: { value: n.href } }] } : {}),
      };
      parent.childIds?.push(ax.nodeId);
      out.push(ax);
      for (const c of n.children ?? []) add(c, ax);
    };
    for (const n of this.page(t).nodes) add(n, root);
    return out;
  }

  // biome-ignore lint/suspicious/noExplicitAny: mirrors the untyped CDP result shape
  async send(method: string, params: Json = {}, sessionId?: string): Promise<any> {
    this.calls.push({ method, params, ...(sessionId ? { sessionId } : {}) });
    if (this.closed) throw new Error("closed");
    const tid = sessionId ? this.sessions.get(sessionId) : undefined;
    const t = tid ? this.targets.get(tid) : undefined;
    const over = this.intercept?.(method, params, t);
    if (over !== undefined) return over;
    switch (method) {
      case "Browser.getVersion":
        return { product: "FakeChromium/1" };
      case "Target.createTarget": {
        const targetId = nid("T");
        const tg: Target = { targetId, url: "about:blank", title: "", loaderId: nid("L"), values: new Map() };
        if (typeof params.browserContextId === "string") tg.contextId = params.browserContextId;
        this.targets.set(targetId, tg);
        this.fire("Target.targetCreated", { targetInfo: { targetId, type: "page", url: tg.url } });
        return { targetId };
      }
      case "Target.attachToTarget": {
        const s = nid("S");
        this.sessions.set(s, String(params.targetId));
        return { sessionId: s };
      }
      case "Target.getTargetInfo": {
        const tg = this.targets.get(String(params.targetId));
        return {
          targetInfo: { targetId: tg?.targetId, title: tg?.title ?? "", url: tg?.url ?? "", type: "page" },
        };
      }
      case "Target.getTargets":
        return {
          targetInfos: [...this.targets.values()].map((x) => ({ targetId: x.targetId, type: "page" })),
        };
      case "Target.closeTarget": {
        this.targets.delete(String(params.targetId));
        this.fire("Target.targetDestroyed", { targetId: params.targetId });
        return { success: true };
      }
      case "Target.createBrowserContext":
        return { browserContextId: nid("C") };
      case "Page.getFrameTree":
        return { frameTree: { frame: { id: t?.targetId, loaderId: t?.loaderId, url: t?.url } } };
      case "Accessibility.getFullAXTree":
        return { nodes: t ? this.axNodes(t) : [] };
      case "Page.navigate": {
        if (!t) return {};
        if (!this.site[String(params.url)] && String(params.url) !== "about:blank")
          return { errorText: "net::ERR_NAME_NOT_RESOLVED" };
        const url = String(params.url);
        setTimeout(() => this.navigateTarget(t, url), 1);
        return { frameId: t.targetId, loaderId: "pending" };
      }
      case "DOM.getContentQuads": {
        const id = Number(params.backendNodeId);
        if (!t || !this.node(t, id)) return { quads: [] };
        const y = id * 10;
        return { quads: [[0, y, 100, y, 100, y + 10, 0, y + 10]] };
      }
      case "Input.dispatchMouseEvent": {
        if (params.type === "mouseReleased" && t) {
          const n = this.node(t, Math.floor(Number(params.y) / 10));
          if (n && n.checked !== undefined) {
            t.checked ??= new Map();
            t.checked.set(n.id, !(t.checked.get(n.id) ?? n.checked));
          }
          if (n?.href) setTimeout(() => this.navigateTarget(t, n.href as string), 1);
        }
        return {};
      }
      case "DOM.focus":
        if (t) t.focused = Number(params.backendNodeId);
        return {};
      case "Input.insertText":
        if (t?.focused !== undefined)
          t.values.set(t.focused, (t.values.get(t.focused) ?? "") + String(params.text));
        return {};
      case "DOM.resolveNode":
        return t && this.node(t, Number(params.backendNodeId))
          ? { object: { objectId: `obj:${params.backendNodeId}` } }
          : { object: {} };
      case "Runtime.callFunctionOn": {
        const id = Number(String(params.objectId).split(":")[1]);
        const n = t ? this.node(t, id) : undefined;
        const fn = String(params.functionDeclaration);
        if (fn.includes("el.form")) return { result: { value: n?.facts ?? { tag: "button" } } };
        if (fn.includes("aria-checked")) {
          if (n?.checked === undefined) return { result: { value: null } };
          return { result: { value: t?.checked?.get(id) ?? n.checked } };
        }
        if (fn.includes("HTMLSelectElement")) {
          const want = (params.arguments as Array<{ value: string }>)[0]?.value ?? "";
          if (!n?.options) return { result: { value: { error: "not a select" } } };
          if (!n.options.includes(want))
            return { result: { value: { error: "no such option", options: n.options } } };
          t?.values.set(id, want);
          return { result: { value: { label: want } } };
        }
        if (fn.includes("this.click()")) {
          if (n?.href && t) setTimeout(() => this.navigateTarget(t, n.href as string), 1);
          return { result: {} };
        }
        if (fn.includes("innerText")) return { result: { value: n?.name ?? "" } };
        if (fn.includes('this.value = ""')) {
          t?.values.delete(id);
          return { result: {} };
        }
        return { result: {} };
      }
      case "Runtime.evaluate": {
        const text = t
          ? (this.page(t).text ??
            this.flat(this.page(t).nodes)
              .map((n) => n.name ?? "")
              .join("\n"))
          : "";
        const expr = String(params.expression);
        const m = /includes\((".*")\)/.exec(expr);
        return { result: { value: m ? text.includes(JSON.parse(m[1] as string)) : text } };
      }
      case "DOM.getDocument":
        return { root: { nodeId: 0 } };
      case "DOM.querySelectorAll": {
        if (!t) return { nodeIds: [] };
        const sel = String(params.selector);
        if (sel.startsWith("!!")) throw new Error("DOM Error while querying");
        return {
          nodeIds: this.flat(this.page(t).nodes)
            .filter((n) => n.css?.includes(sel))
            .map((n) => n.id),
        };
      }
      case "DOM.describeNode":
        return { node: { backendNodeId: Number(params.nodeId) } };
      case "Page.getLayoutMetrics":
        return { cssVisualViewport: { clientWidth: 1280, clientHeight: 800 } };
      case "Page.captureScreenshot":
        return { data: "iVBORw0KGgo=" };
      case "Page.startScreencast":
        setTimeout(
          () =>
            this.fire(
              "Page.screencastFrame",
              { data: "/9j/AA==", sessionId: 1, metadata: { deviceWidth: 1280, deviceHeight: 800 } },
              sessionId,
            ),
          1,
        );
        return {};
      default:
        return {};
    }
  }
}

export function fakeBrowser(site: Record<string, FakePage>): { cdp: FakeCdp; proc: BrowserProcessLike } {
  const cdp = new FakeCdp(site);
  return { cdp, proc: { cdp, close: async () => cdp.close() } };
}
