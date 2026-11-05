// Activity rows (素 Plain §3.4): the tools one assistant turn used, as one
// collapsed row 「做了 4 件事 · 12 秒 ›」 that opens to plain-language steps.
// No bullet dots, no tool ids: the id, arguments and result sit behind
// 技術細節 inside each step.
import { h } from "./dom.ts";
import { t as tx } from "./i18n/index.ts";
import { type IconName, icon, spinner } from "./icons.ts";

type Args = Record<string, unknown>;
const str = (a: Args, ...keys: string[]): string => {
  for (const k of keys) {
    const v = a[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
};

/** A hostname a person can read; loopback demo sites say so instead of an address. */
export function siteOf(url: string): string {
  try {
    const u = new URL(url);
    if (/^(127\.|localhost$|\[::1\]$|0\.0\.0\.0$)/.test(u.hostname)) return tx("desktop.approval.localSite");
    return u.hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

const base = (p: string) => p.split(/[\\/]/).filter(Boolean).at(-1) ?? p;
const clip = (s: string, n = 40) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Tools never shown as a step (recall / memory lookups live in 技術細節 only). */
export const HIDDEN_TOOLS = new Set([
  "memory_search",
  "recall",
  "read_spill",
  "worker_status",
  "worker_inbox",
  // The question card is the step itself.
  "ask_user",
]);

/** Tool id + arguments → an icon and 「動詞 + 對象」 in plain words. */
export function describeTool(tool: string, args: Args): { icon: IconName; text: string } {
  const url = str(args, "url");
  const title = clip(str(args, "title", "name", "key"));
  const path = str(args, "file_path", "path");
  if (tool === "browser_open" || tool === "browser_navigate") {
    const site = siteOf(url);
    return {
      icon: "globe",
      text: site ? tx("desktop.activity.open", { target: site }) : tx("desktop.activity.openPage"),
    };
  }
  if (/^browser_(snapshot|read)$/.test(tool)) return { icon: "doc", text: tx("desktop.activity.readPage") };
  if (/^browser_(click|press|select)$/.test(tool))
    return { icon: "pointer", text: tx("desktop.activity.click") };
  if (/^browser_(type|fill_secret)$/.test(tool)) return { icon: "pencil", text: tx("desktop.activity.type") };
  if (tool === "browser_scroll") return { icon: "pointer", text: tx("desktop.activity.scroll") };
  if (tool === "browser_screenshot") return { icon: "doc", text: tx("desktop.activity.screenshot") };
  if (tool.startsWith("browser_")) return { icon: "globe", text: tx("desktop.activity.browse") };
  if (tool === "web_search" || tool.endsWith("_search")) {
    const q = clip(str(args, "query", "q"));
    return {
      icon: "search",
      text: q ? tx("desktop.activity.search", { target: q }) : tx("desktop.activity.searchWeb"),
    };
  }
  if (tool === "web_fetch")
    return { icon: "globe", text: tx("desktop.activity.fetch", { target: siteOf(url) || url }) };
  if (tool === "write_note")
    return { icon: "pencil", text: tx("desktop.activity.writeNote", { target: title }) };
  if (tool === "read_note") return { icon: "doc", text: tx("desktop.activity.readNote", { target: title }) };
  if (tool === "delete_note")
    return { icon: "trash", text: tx("desktop.activity.deleteNote", { target: title }) };
  if (tool === "file_read")
    return { icon: "doc", text: tx("desktop.activity.readFile", { target: base(path) }) };
  if (tool === "file_list") return { icon: "doc", text: tx("desktop.activity.listFiles") };
  if (/^file_(write|edit|change)$/.test(tool))
    return { icon: "pencil", text: tx("desktop.activity.editFile", { target: base(path) }) };
  if (tool === "shell" || tool === "bash" || tool.startsWith("shell_"))
    return { icon: "terminal", text: tx("desktop.activity.runCommand") };
  if (tool.startsWith("worker_") || tool.startsWith("dispatch"))
    return { icon: "person", text: tx("desktop.activity.handOff") };
  if (tool.startsWith("ask_")) {
    const you = tool === "ask_user";
    return { icon: "person", text: you ? tx("desktop.activity.askYou") : tx("desktop.activity.askTeammate") };
  }
  if (tool.startsWith("memory_")) return { icon: "book", text: tx("desktop.activity.remember") };
  if (/^[A-Z][A-Z0-9]+_/.test(tool)) {
    const app = tool.split("_")[0] ?? "";
    const icn: IconName = /MAIL/.test(tool) ? "mail" : "gear";
    return {
      icon: icn,
      text: tx("desktop.activity.useTool", { target: app.charAt(0) + app.slice(1).toLowerCase() }),
    };
  }
  return { icon: "gear", text: tx("desktop.activity.useAny") };
}

export function duration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60
    ? tx("desktop.activity.seconds", { n: s })
    : tx("desktop.activity.minutes", { n: Math.round(s / 60) });
}

interface Step {
  el: HTMLElement;
  slot: HTMLElement;
  trail: HTMLElement;
  tech: HTMLElement;
  started: number;
  state: "running" | "ok" | "fail";
  verb: HTMLElement;
}

/** One turn's steps: a disclosure row with its count and total time. */
export class ActivityGroup {
  readonly el: HTMLElement;
  private readonly sumText: HTMLElement;
  private readonly sumTime: HTMLElement;
  private readonly sumIcon: HTMLElement;
  private readonly list: HTMLElement;
  private readonly steps: Step[] = [];
  private first = 0;
  private last = 0;

  constructor() {
    this.sumIcon = h("span", { class: "act-icon" });
    this.sumText = h("span", { class: "act-text" });
    this.sumTime = h("span", { class: "act-trail" });
    this.list = h("div", { class: "act-list" });
    const summary = h(
      "summary",
      { class: "act-row act-summary" },
      this.sumIcon,
      this.sumText,
      this.sumTime,
      icon("chevron", "act-chev"),
    );
    this.el = h("details", { class: "item activity" }, summary, this.list);
  }

  get size(): number {
    return this.steps.length;
  }

  /** A new step; returns its id in this group. */
  add(tool: string, args: Args, at: number): number {
    const d = describeTool(tool, args);
    const slot = h("span", { class: "act-icon" }, spinner());
    const trail = h("span", { class: "act-trail" });
    const verb = h("span", { class: "act-text" }, d.text);
    const tech = h("pre", { class: "tech-body" }, `${tool}\n${JSON.stringify(args, null, 2)}`);
    const el = h(
      "details",
      { class: "act-step", "data-state": "running", "data-icon": d.icon },
      h("summary", { class: "act-row" }, slot, verb, trail),
      tech,
    );
    this.list.append(el);
    if (!this.first) this.first = at;
    this.last = at;
    this.steps.push({ el, slot, trail, tech, started: at, state: "running", verb });
    this.refresh();
    return this.steps.length - 1;
  }

  done(i: number, ok: boolean, at: number, result: string): void {
    const s = this.steps[i];
    if (!s) return;
    s.state = ok ? "ok" : "fail";
    s.el.dataset.state = s.state;
    s.slot.replaceChildren(icon(ok ? (s.el.dataset.icon as IconName) : "alert"));
    s.trail.textContent = ok ? duration(at - s.started) : tx("desktop.activity.failed");
    if (result) s.tech.append(`\n\n${result.slice(0, 600)}`);
    this.last = Math.max(this.last, at);
    this.refresh();
  }

  private refresh(): void {
    const running = this.steps.findIndex((s) => s.state === "running");
    const failed = this.steps.some((s) => s.state === "fail");
    this.el.dataset.state = running >= 0 ? "running" : failed ? "fail" : "ok";
    this.sumIcon.replaceChildren(running >= 0 ? spinner() : icon(failed ? "alert" : "clock"));
    this.sumText.textContent =
      running >= 0
        ? tx("desktop.activity.doing", { n: running + 1 })
        : tx("desktop.activity.didN", { n: this.steps.length });
    this.sumTime.textContent = running >= 0 || !this.first ? "" : duration(this.last - this.first);
  }
}
