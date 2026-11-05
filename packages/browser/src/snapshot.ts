/**
 * Semantic snapshot: the accessibility tree of every frame in a tab, folded
 * into a compact outline where each actionable element gets an `@N` ref.
 * Shadow DOM is already flattened by the accessibility tree; iframes
 * (including out-of-process ones) are stitched in at their owner element.
 *
 * A ref is honoured only against the snapshot that produced it and only while
 * its frame still shows the same document (same loader id). Anything else is
 * stale and the agent must take a new snapshot: refs cannot be forged or
 * carried across navigations.
 */

/** The subset of a CDP `Accessibility.AXNode` we read. */
export interface AXNode {
  nodeId: string;
  ignored?: boolean;
  role?: { value?: unknown };
  name?: { value?: unknown };
  value?: { value?: unknown };
  properties?: Array<{ name: string; value?: { value?: unknown } }>;
  childIds?: string[];
  parentId?: string;
  backendDOMNodeId?: number;
}

/** One frame's tree plus where it lives. */
export interface FrameTree {
  /** CDP session that owns the frame (main page session or an OOPIF session). */
  sessionId: string;
  frameId: string;
  /** Document identity; changes on every navigation of the frame. */
  loaderId: string;
  url: string;
  /** Owner `<iframe>` backend node in the parent frame (absent for the main frame). */
  ownerBackendNodeId?: number;
  parentFrameId?: string;
  nodes: AXNode[];
}

/** Host-side mapping behind an `@N` ref. */
export interface ElementHandle {
  ref: number;
  snapshotId: string;
  sessionId: string;
  frameId: string;
  loaderId: string;
  backendNodeId: number;
  role: string;
  name: string;
  /** Position among elements with the same role + name (for replayable locators). */
  nth: number;
}

export interface SnapshotResult {
  snapshotId: string;
  url: string;
  title: string;
  text: string;
  refs: Map<number, ElementHandle>;
  /** A CAPTCHA or bot check is on the page: hand the Space to a person. */
  captcha: boolean;
  truncated: boolean;
}

export const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "spinbutton",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "MenuListOption",
  "ListBoxOption",
  "tab",
  "treeitem",
  "listbox",
  "PopUpButton",
  "ToggleButton",
]);

/** Roles that carry no meaning of their own: print nothing, keep the children. */
const TRANSPARENT = new Set([
  "generic",
  "none",
  "presentation",
  "GenericContainer",
  "Section",
  "LayoutTable",
  "LayoutTableRow",
  "LayoutTableCell",
  "Div",
  "Pre",
  "paragraph",
  "LineBreak",
  "Canvas",
  "LabelText",
]);
const SKIP = new Set(["InlineTextBox", "ListMarker", "MenuListPopup"]);
const PRINT_PROPS = ["checked", "selected", "expanded", "pressed", "disabled", "required", "level"] as const;

const CAPTCHA_URL = /recaptcha|hcaptcha|turnstile|challenges\.cloudflare\.com|arkoselabs|funcaptcha|captcha/i;
const CAPTCHA_TEXT =
  /我不是機器人|驗證你是真人|請完成驗證|人機驗證|verify (that )?you are (a )?human|i'?m not a robot|are you a robot/i;

const str = (v: unknown): string =>
  typeof v === "string" ? v : v === undefined || v === null ? "" : String(v);
const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const quote = (s: string) => JSON.stringify(s);

function prop(n: AXNode, name: string): unknown {
  return n.properties?.find((p) => p.name === name)?.value?.value;
}

export interface BuildOptions {
  snapshotId: string;
  title?: string;
  /** Character budget for the outline (default 12 000). */
  maxChars?: number;
}

/** Build the outline and the ref table. Pure: tests feed it plain AX node arrays. */
export function buildSnapshot(frames: readonly FrameTree[], o: BuildOptions): SnapshotResult {
  const maxChars = o.maxChars ?? 12_000;
  const main = frames.find((f) => !f.parentFrameId) ?? frames[0];
  const refs = new Map<number, ElementHandle>();
  const lines: string[] = [];
  const seenCount = new Map<string, number>();
  let used = 0;
  let truncated = false;
  let captcha = false;
  // owner backend node (per parent frame) → child frame
  const childFrames = new Map<string, FrameTree>();
  for (const f of frames)
    if (f.parentFrameId && f.ownerBackendNodeId !== undefined)
      childFrames.set(`${f.parentFrameId}:${f.ownerBackendNodeId}`, f);
  const rendered = new Set<string>();

  const push = (depth: number, line: string): boolean => {
    if (truncated) return false;
    const full = `${"  ".repeat(depth)}- ${line}`;
    if (used + full.length + 1 > maxChars) {
      truncated = true;
      return false;
    }
    lines.push(full);
    used += full.length + 1;
    return true;
  };

  const renderFrame = (frame: FrameTree, depth: number) => {
    rendered.add(frame.frameId);
    if (CAPTCHA_URL.test(frame.url)) captcha = true;
    const byId = new Map(frame.nodes.map((n) => [n.nodeId, n]));
    const root = frame.nodes.find((n) => !n.parentId || !byId.has(n.parentId)) ?? frame.nodes[0];
    if (!root) return;

    const walk = (n: AXNode, d: number, insideControl: boolean) => {
      if (truncated) return;
      const role = str(n.role?.value);
      const kids = (n.childIds ?? []).map((id) => byId.get(id)).filter((c): c is AXNode => !!c);
      const recurse = (dd: number, inControl = insideControl) => {
        for (const c of kids) walk(c, dd, inControl);
      };
      if (SKIP.has(role)) return;
      if (n.ignored || role === "RootWebArea" || role === "WebArea") return recurse(d);

      const name = clip(str(n.name?.value), 120);
      if (CAPTCHA_TEXT.test(name)) captcha = true;

      if (role === "Iframe" || role === "IframePresentational") {
        const child =
          n.backendDOMNodeId !== undefined
            ? childFrames.get(`${frame.frameId}:${n.backendDOMNodeId}`)
            : undefined;
        if (name && CAPTCHA_URL.test(name)) captcha = true;
        push(d, `iframe${name ? ` ${quote(name)}` : ""}`);
        if (child) renderFrame(child, d + 1);
        return;
      }
      if (role === "StaticText") {
        if (!insideControl && name) push(d, `text ${quote(clip(name, 200))}`);
        return;
      }
      if (TRANSPARENT.has(role) && !INTERACTIVE_ROLES.has(role)) return recurse(d);

      const interactive = INTERACTIVE_ROLES.has(role) && n.backendDOMNodeId !== undefined;
      let line = role;
      if (name) line += ` ${quote(name)}`;
      if (interactive) {
        const ref = refs.size + 1;
        const key = `${role}\u0000${name}`;
        const nth = seenCount.get(key) ?? 0;
        seenCount.set(key, nth + 1);
        refs.set(ref, {
          ref,
          snapshotId: o.snapshotId,
          sessionId: frame.sessionId,
          frameId: frame.frameId,
          loaderId: frame.loaderId,
          backendNodeId: n.backendDOMNodeId as number,
          role,
          name,
          nth,
        });
        line += ` @${ref}`;
      }
      if (role === "combobox") {
        const opts: string[] = [];
        const collect = (x: AXNode, depth: number) => {
          if (depth > 4) return;
          for (const id of x.childIds ?? []) {
            const c = byId.get(id);
            if (!c) continue;
            const r = str(c.role?.value);
            if (r === "option" || r === "MenuListOption") opts.push(clip(str(c.name?.value), 40));
            else collect(c, depth + 1);
          }
        };
        collect(n, 0);
        if (opts.filter(Boolean).length)
          line += ` options=[${opts.slice(0, 20).join("|")}${opts.length > 20 ? "|…" : ""}]`;
      }
      const value = str(n.value?.value);
      if (value && role !== "link") line += ` value=${quote(clip(value, 80))}`;
      if (role === "link") {
        const url = str(prop(n, "url"));
        if (url && !url.startsWith("javascript:")) line += ` → ${clip(url, 80)}`;
      }
      for (const p of PRINT_PROPS) {
        const v = prop(n, p);
        if (v === true || v === "true") line += ` [${p}]`;
        else if (p === "level" && typeof v === "number") line += ` [h${v}]`;
        else if ((p === "checked" || p === "pressed") && v === "mixed") line += ` [${p}=mixed]`;
      }
      if (!push(d, line)) return;
      // Text inside a named control repeats its name; nested controls still show.
      recurse(d + 1, insideControl || (interactive && !!name) || role === "heading");
    };
    walk(root, depth, false);
  };

  if (main) renderFrame(main, 0);
  // Frames whose owner we could not place (e.g. owner hidden): append at the end.
  for (const f of frames) {
    if (rendered.has(f.frameId)) continue;
    if (CAPTCHA_URL.test(f.url)) captcha = true;
    push(0, `iframe ${quote(clip(f.url, 80))}`);
    renderFrame(f, 1);
  }
  if (truncated) lines.push(`- …（內容過長，已截斷；可用 browser_read 讀取全文）`);

  return {
    snapshotId: o.snapshotId,
    url: main?.url ?? "",
    title: o.title ?? "",
    text: lines.join("\n"),
    refs,
    captcha,
    truncated,
  };
}

/** Parse an element ref like "@12". Returns undefined for anything else. */
export function parseElementRef(text: unknown): number | undefined {
  if (typeof text === "number") return Number.isInteger(text) && text > 0 && text < 1e7 ? text : undefined;
  if (typeof text !== "string") return undefined;
  const m = /^@?([1-9]\d{0,6})$/.exec(text.trim());
  return m?.[1] === undefined ? undefined : Number(m[1]);
}

/** A ref is only honoured against the snapshot that produced it. */
export function isRefCurrent(handle: ElementHandle, currentSnapshotId: string | undefined): boolean {
  return handle.snapshotId === currentSnapshotId;
}

export class StaleRefError extends Error {
  constructor(detail: string) {
    super(`${detail}。畫面可能已經變了，請重新呼叫 browser_snapshot 取得新的 @N。`);
    this.name = "StaleRefError";
  }
}
