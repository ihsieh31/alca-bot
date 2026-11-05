// The confirmation card (素 Plain §3.5, desktop): what will happen as the title
// (verb + object), who asked, how risky it is (icon tint + button style), and a
// primary button that repeats the verb. 「不要」 always declines. Shortcuts are
// in the tooltips, ids and arguments behind 技術細節. Once decided, the card
// folds into a one-line receipt.
import { siteOf } from "./activity.ts";
import { h, MOD } from "./dom.ts";
import { t as tx } from "./i18n/index.ts";
import { type IconName, icon } from "./icons.ts";

/** The classes that always ask, whatever the permission level. */
export const ALWAYS = new Set(["payment", "send", "delete", "publish"]);

const KNOWN = ["payment", "send", "delete", "publish", "network", "write", "execute", "read"] as const;
type Known = (typeof KNOWN)[number];
const known = (cls: string): Known | "other" =>
  (KNOWN as readonly string[]).includes(cls) ? (cls as Known) : "other";

const ICON: Record<Known | "other", IconName> = {
  payment: "card",
  send: "send",
  delete: "trash",
  publish: "megaphone",
  network: "globe",
  write: "pencil",
  execute: "terminal",
  read: "doc",
  other: "hand",
};

const VERB = (k: Known | "other"): string =>
  ({
    payment: tx("desktop.approval.verb.payment"),
    send: tx("desktop.approval.verb.send"),
    delete: tx("desktop.approval.verb.delete"),
    publish: tx("desktop.approval.verb.publish"),
    network: tx("desktop.approval.verb.network"),
    write: tx("desktop.approval.verb.write"),
    execute: tx("desktop.approval.verb.execute"),
    read: tx("desktop.approval.verb.read"),
    other: tx("desktop.approval.verb.other"),
  })[k];
const BUTTON = (k: Known | "other"): string =>
  ({
    payment: tx("desktop.approval.button.payment"),
    send: tx("desktop.approval.button.send"),
    delete: tx("desktop.approval.button.delete"),
    publish: tx("desktop.approval.button.publish"),
    network: tx("desktop.approval.button.network"),
    write: tx("desktop.approval.button.write"),
    execute: tx("desktop.approval.button.execute"),
    read: tx("desktop.approval.button.read"),
    other: tx("desktop.approval.button.other"),
  })[k];

/** Tool ids and plumbing words: these stay in 技術細節. */
const MACHINE = /\b[a-z]+_[a-z_]+\b|\btool_call\b|\b[A-Z][A-Z0-9]+_[A-Z0-9_]+\b|wss?:\/\//;
/** A loopback demo address reads 「本機測試網站」. */
const LOOPBACK = /(https?:\/\/)?(127\.0\.0\.1|localhost)(:\d+)?(\/\S*)?/g;

/** A space between two CJK characters (left behind when an address became 「本機測試網站」). */
const CJK_GAP = /([\u3000-\u9fff\uff00-\uffef])\s+(?=[\u3000-\u9fff\uff00-\uffef])/g;

/** The host's summary in the person's words: no 「透過 tool_call 執行 x：」 lead, no loopback address. */
export function plainSummary(summary: string): string {
  const s = summary
    .replace(/^[^：:\n]*\b(tool_call|[a-z]+_[a-z_]+)\b[^：:\n]*[：:]\s*/, "")
    .replace(LOOPBACK, tx("desktop.approval.localSite"))
    .replace(CJK_GAP, "$1");
  return MACHINE.test(s) ? "" : s;
}

/** A learned step or a log line in plain words: no 「透過 tool_call 執行 x：」, no loopback address. */
export function plainStep(text: string): string {
  return text
    .replace(/[^：:\n]*\btool_call\b[^：:\n]*[：:]\s*/g, "")
    .replace(LOOPBACK, tx("desktop.approval.localSite"))
    .replace(CJK_GAP, "$1")
    .trim();
}

export type Risk = "routine" | "confirm" | "destructive";
export const riskOf = (cls: string): Risk =>
  cls === "delete" ? "destructive" : ALWAYS.has(cls) ? "confirm" : "routine";

type Args = Record<string, unknown>;
const first = (a: Args | undefined, keys: string[]): string => {
  for (const k of keys) {
    const v = a?.[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
};

const amountOf = (s: string) => /(NT\$|US\$|\$|€|£|¥)\s?[\d,]+(\.\d+)?/.exec(s)?.[0];

/** 「付款 NT$1,280」「刪除「購物清單」」「連上網路：shop.example.com」 — from what the card knows. */
export function approvalTitle(cls: string, summary: string, args?: Args): string {
  const k = known(cls);
  const verb = VERB(k);
  const amount = amountOf(summary);
  if (k === "payment" && amount) return tx("desktop.approval.titleAmount", { verb, amount });
  const url = first(args, ["url"]);
  if (k === "network" && url && siteOf(url))
    return tx("desktop.approval.titleHost", { verb, obj: siteOf(url) });
  const path = first(args, ["file_path", "path"]);
  const obj =
    first(args, ["title", "name", "subject", "to", "recipient"]) ||
    (path ? (path.split(/[\\/]/).filter(Boolean).at(-1) ?? "") : "");
  if (obj && !MACHINE.test(obj) && k !== "execute" && k !== "read")
    return tx("desktop.approval.titleObject", { verb, obj: obj.length > 40 ? `${obj.slice(0, 39)}…` : obj });
  if (k === "payment" || k === "send" || k === "publish" || k === "network") {
    const site = siteOf(url);
    if (site) return tx("desktop.approval.titleHost", { verb, obj: site });
  }
  return verb;
}

export interface ApprovalInput {
  id: string;
  cls: string;
  summary: string;
  tool?: string;
  args?: Args;
  /** 「Alca › 示範商店結帳」, or a bot name. */
  who?: string;
  /** The task's own title, when a task asked (「刪除購物清單」). */
  task?: string;
  workerId?: string;
  applied?: string[];
}

export interface ApprovalCard {
  el: HTMLElement;
  /** Where the buttons sit (replaced by the receipt once decided). */
  actions: HTMLElement;
  title: string;
  resolve(decision: string, staleWord: string, at?: string): void;
}

const fact = (label: string, value: string) =>
  h(
    "div",
    { class: "ap-fact" },
    h("span", { class: "ap-fact-label" }, label),
    h("span", { class: "ap-fact-value" }, value),
  );

export function approvalCard(
  a: ApprovalInput,
  decide: (d: "approved" | "denied") => void,
  compact = false,
): ApprovalCard {
  const k = known(a.cls);
  const risk = riskOf(a.cls);
  // A line written for machines (a tool id, 「透過 tool_call 執行 …」) never reaches the card face.
  const plain = plainSummary(a.summary);
  let title = approvalTitle(a.cls, plain, a.args);
  // Nothing more specific known, and the task's own name already says it (「刪除購物清單」): use that.
  if (title === VERB(k) && a.task?.startsWith(VERB(k))) title = a.task;
  const browserStep = a.tool?.startsWith("browser_") ?? false;
  // The host-written line (e.g. 在 shop.test 按下「確認付款」) is the subtitle when it adds something.
  const subtitle = plain && plain !== title ? plain : "";
  const site = siteOf(first(a.args, ["url"]));
  const facts = [
    a.who ? fact(tx("desktop.approval.who"), a.who) : null,
    site && !browserStep ? fact(tx("desktop.approval.site"), site) : null,
    a.applied?.length ? fact(tx("desktop.approval.rules"), a.applied.join(tx("common.text2"))) : null,
  ].filter((x) => x !== null);

  const amount = k === "payment" ? amountOf(a.summary) : undefined;
  const primaryLabel = amount ? title : BUTTON(k);
  const allow = h(
    "button",
    {
      class: risk === "destructive" ? "btn btn-danger" : "btn btn-primary",
      type: "button",
      title: tx("desktop.approval.tipApprove", { label: primaryLabel, keys: `${MOD}↩` }),
      onclick: () => decide("approved"),
    },
    primaryLabel,
  );
  const deny = h(
    "button",
    {
      class: "btn btn-quiet",
      type: "button",
      title: tx("desktop.approval.tipApprove", { label: tx("desktop.approval.dont"), keys: `${MOD}⇧⌫` }),
      onclick: () => decide("denied"),
    },
    tx("desktop.approval.dont"),
  );
  // Tap-through guard: the primary only works once the card has been on screen for a moment.
  allow.setAttribute("disabled", "");
  setTimeout(() => allow.removeAttribute("disabled"), 500);
  const actions = h("div", { class: "ap-actions" }, deny, allow);

  const techLines = [
    a.tool ? `${a.tool}\n${JSON.stringify(a.args ?? {}, null, 2)}` : a.summary,
    a.workerId ? `worker ${a.workerId}` : "",
    `${a.cls} ${a.id}`,
  ].filter(Boolean);

  const body = h(
    "div",
    { class: "ap-body" },
    h(
      "div",
      { class: "ap-head" },
      h("span", { class: "ap-icon", "data-risk": risk }, icon(ICON[k])),
      h(
        "div",
        { class: "ap-titles" },
        h("h3", { class: "ap-title" }, title),
        subtitle ? h("p", { class: "ap-sub" }, subtitle) : null,
      ),
    ),
    facts.length ? h("div", { class: "ap-facts" }, ...facts) : null,
    ALWAYS.has(a.cls)
      ? h("p", { class: "ap-lock" }, icon("lock"), tx("common.paymentsSendingDeletingAndPublishing"))
      : null,
    h(
      "div",
      { class: "ap-foot" },
      h(
        "details",
        { class: "tech" },
        h("summary", {}, tx("common.technicalDetails")),
        h("pre", { class: "tech-body" }, techLines.join("\n\n")),
      ),
      actions,
    ),
  );
  if (compact)
    body.replaceChildren(
      h(
        "div",
        { class: "receipt", "data-tone": "waiting" },
        h("span", { class: "receipt-icon" }, icon("hand")),
        h("span", { class: "receipt-text" }, tx("desktop.approval.pending", { title })),
      ),
    );
  const el = h(
    "article",
    {
      class: compact ? "item card ap-card ap-compact" : "item card ap-card",
      "data-state": "pending",
      "data-risk": risk,
      "aria-label": title,
    },
    body,
  );

  return {
    el,
    actions,
    title,
    resolve(decision, staleWord, at) {
      el.dataset.state = "done";
      const row: Record<string, [IconName, string, string]> = {
        approved: ["check", "ok", tx("desktop.approval.approved", { title })],
        denied: ["cross", "no", tx("desktop.approval.denied", { title })],
        expired: ["alert", "muted", tx("desktop.approval.expired", { title })],
        stale: ["alert", "muted", tx("desktop.approval.stale", { word: staleWord, title })],
      };
      const [ic, tone, text] = row[decision] ?? ["alert", "muted", `${decision}: ${title}`];
      const time = at ? new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
      el.replaceChildren(
        h(
          "div",
          { class: "receipt", "data-tone": tone },
          h("span", { class: "receipt-icon" }, icon(ic)),
          h("span", { class: "receipt-text resolution", "data-tone": tone }, text),
          time ? h("time", { class: "receipt-time" }, time) : null,
        ),
      );
    },
  };
}
