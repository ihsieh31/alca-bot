// What an approval says (§3.5): the action as a title (verb + object, 「付款
// NT$1,280」), where it happens, the facts we actually know, the risk tier, the
// primary button's words and the one-line receipt left in the chat after the
// decision. Pure (no DOM): unit-tested in Node. Addresses, ids and tool names
// never reach the title or the subtitle — they go to 技術細節.
import type { AppAction } from "./connect-view.ts";
import { t } from "./i18n/index.ts";

export type Tier = "routine" | "confirm" | "danger";

export interface ApprovalInput {
  actionClass: string;
  summary: string;
  detail?: string;
  args?: Record<string, unknown>;
}

export interface ApprovalView {
  title: string;
  subtitle: string;
  /** The primary button repeats the title's verb (「付款 NT$1,280」「寄出」「刪除」). */
  primary: string;
  tier: Tier;
  icon: string;
  /** Rows we know: [label, value]. */
  facts: Array<[string, string]>;
  /** A content preview (the mail body), when it matters. */
  preview?: string;
  receipt: { approved: string; denied: string; expired: string };
}

const MONEY = /(?:NT\$|US\$|HK\$|NTD\s?|\$|€|£|¥)\s?\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s?(?:TWD|USD|EUR)/i;
const LOOPBACK = /^(?:localhost|127(?:\.\d+){3}|::1|0\.0\.0\.0)$/i;
const TLD = "com|net|org|io|app|dev|ai|co|me|tw|jp|hk|us|uk|edu|gov|info|xyz|shop|store|site|page";
/** A host (with an optional port and path) or a URL, anywhere in a line. */
const HOSTISH = new RegExp(
  `(?:(?:https?|wss?):\\/\\/)?(localhost|\\d{1,3}(?:\\.\\d{1,3}){3}|\\[::1\\]|(?:[a-z0-9-]+\\.)+(?:${TLD})\\b)(?::\\d{2,5})?(?:\\/[^\\s\\uFF09)\\u300D]*)?`,
  "gi",
);
const OUR_ID = /\b[a-z]{2,4}_[0-9A-Z]{8,26}\b/g;
const TOOL_ID = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b|\b[a-z]+(?:_[a-z]+)+\b/g;

/** The site as a person says it: shop.example.com, or 「本機測試網站」 for a loopback address. */
export function siteName(host: string): string {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (LOOPBACK.test(h)) return t("phone.approval.localSite");
  return h.replace(/^www\./, "");
}

/** The first host in a text (or a URL in the call's arguments). */
export function findHost(text: string, args?: Record<string, unknown>): string | undefined {
  const fromArgs = typeof args?.url === "string" ? args.url : undefined;
  for (const src of [fromArgs, text]) {
    if (!src) continue;
    HOSTISH.lastIndex = 0;
    const m = HOSTISH.exec(src);
    if (m?.[1]) return siteName(m[1]);
  }
  return undefined;
}

/** A line with every address, id and tool name replaced by words (or dropped). */
export function plainLine(text: string): string {
  return text
    .replace(HOSTISH, (_all, host: string) => siteName(host))
    .replace(OUR_ID, "")
    .replace(TOOL_ID, "")
    .replace(/[（(]\s*[)）]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

const amountOf = (s: string) => MONEY.exec(s)?.[0]?.replace(/\s+/g, "");

/** The quoted object in a summary: 刪除筆記「購物清單」 → 購物清單. */
const quoted = (s: string) => /「([^」]{1,60})」/.exec(s)?.[1];

/** The object a call names in its arguments (a note's title, a file's name), wrapped calls included. */
export function argObject(args?: Record<string, unknown>): string | undefined {
  const inner = args?.arguments;
  for (const a of [
    args,
    inner && typeof inner === "object" ? (inner as Record<string, unknown>) : undefined,
  ]) {
    if (!a) continue;
    for (const k of ["title", "name", "subject", "path", "file", "filename"]) {
      const v = a[k];
      if (typeof v !== "string" || !v.trim() || (a === args && k === "name" && /_/.test(v))) continue;
      const base = k === "path" || k === "file" ? (v.split(/[\\/]/).pop() ?? v) : v;
      return base.length > 40 ? `${base.slice(0, 40)}…` : base;
    }
  }
  return undefined;
}

interface Words {
  title: string;
  primary: string;
  icon: string;
  done: string;
  noun: string;
}

function words(
  cls: string,
  o: { amount?: string; to?: string; what?: string; where?: string; host?: string },
): Words {
  switch (cls) {
    case "payment": {
      const title = o.amount ? t("phone.approval.payAmount", { amount: o.amount }) : t("phone.approval.pay");
      return {
        title,
        primary: title,
        icon: "card",
        done: o.amount ? t("phone.approval.paidAmount", { amount: o.amount }) : t("phone.approval.paid"),
        noun: t("phone.approval.payNoun"),
      };
    }
    case "send":
      return {
        title: o.to ? t("phone.approval.sendTo", { to: o.to }) : t("phone.approval.send"),
        primary: t("phone.approval.sendVerb"),
        icon: "mail",
        done: o.to ? t("phone.approval.sentTo", { to: o.to }) : t("phone.approval.sent"),
        noun: t("phone.approval.sendNoun"),
      };
    case "delete":
      return {
        title: o.what ? t("phone.approval.deleteThing", { what: o.what }) : t("phone.approval.delete"),
        primary: t("phone.approval.deleteVerb"),
        icon: "trash",
        done: o.what ? t("phone.approval.deletedThing", { what: o.what }) : t("phone.approval.deleted"),
        noun: t("phone.approval.deleteNoun"),
      };
    case "publish":
      return {
        title: o.where ? t("phone.approval.publishTo", { where: o.where }) : t("phone.approval.publish"),
        primary: t("phone.approval.publishVerb"),
        icon: "share",
        done: t("phone.approval.published"),
        noun: t("phone.approval.publishNoun"),
      };
    case "network":
      return {
        title: o.host ? t("phone.approval.connectTo", { host: o.host }) : t("phone.approval.connect"),
        primary: t("phone.approval.connectVerb"),
        icon: "globe",
        done: t("phone.approval.connected"),
        noun: t("phone.approval.connectNoun"),
      };
    case "write":
      return {
        title: t("phone.approval.write"),
        primary: t("phone.approval.writeVerb"),
        icon: "pencil",
        done: t("phone.approval.written"),
        noun: t("phone.approval.writeNoun"),
      };
    case "execute":
      return {
        title: t("phone.approval.execute"),
        primary: t("phone.approval.executeVerb"),
        icon: "terminal",
        done: t("phone.approval.executed"),
        noun: t("phone.approval.executeNoun"),
      };
    default:
      return {
        title: t("phone.approval.read"),
        primary: t("phone.approval.readVerb"),
        icon: "doc",
        done: t("phone.approval.readDone"),
        noun: t("phone.approval.readNoun"),
      };
  }
}

export function approvalView(c: ApprovalInput, app?: AppAction): ApprovalView {
  const cls = c.actionClass;
  const text = `${c.summary} ${c.detail ?? ""}`;
  const host = findHost(text, c.args);
  const amount = cls === "payment" ? amountOf(text) : undefined;
  const facts: Array<[string, string]> = [];
  const tier: Tier =
    cls === "delete" ? "danger" : ["payment", "send", "publish"].includes(cls) ? "confirm" : "routine";
  let preview: string | undefined;
  if (app) {
    const mail = /mail/i.test(app.tool) || app.app === "Gmail";
    if (app.to) facts.push([mail ? t("phone.cards.recipient") : t("phone.cards.target"), app.to]);
    else if (app.channel) facts.push([t("phone.cards.target"), app.channel]);
    if (app.subject) facts.push([t("phone.cards.subject"), app.subject]);
    facts.push([t("common.account"), app.account ? `${app.app} ${app.account}` : app.app]);
    if (app.body) preview = app.clipped ? `${app.body}…` : app.body;
  }
  const w = words(cls, {
    ...(amount ? { amount } : {}),
    ...((app?.to ?? app?.channel) ? { to: (app?.to ?? app?.channel) as string } : {}),
    ...((app?.subject ?? quoted(c.summary) ?? argObject(c.args))
      ? { what: (app?.subject ?? quoted(c.summary) ?? argObject(c.args)) as string }
      : {}),
    ...((app?.app ?? host) ? { where: (app?.app ?? host) as string } : {}),
    ...(host ? { host } : {}),
  });
  if (amount) facts.unshift([t("phone.approval.amount"), amount]);
  if (host && !app) facts.push([t("phone.approval.site"), host]);
  // What is left once ids and tool names are gone; too little left says nothing.
  // A wrapped call (「透過 tool_call 執行 x：…」) says its part after the colon.
  const wrapped = /\btool_call\b/.test(c.summary);
  const said = wrapped
    ? /\uff1a/.test(c.summary)
      ? c.summary.replace(/^[^\uff1a]*\uff1a/, "")
      : ""
    : c.summary;
  const sub = plainLine(said);
  const meaningful = sub.replace(/[\s\p{P}]/gu, "").length >= 6 || !TOOL_ID.test(said);
  TOOL_ID.lastIndex = 0;
  // The sentence under the title never repeats a row (amount, site, recipient…):
  // a line that does says nothing the rows don't, so it goes (it stays under 技術細節).
  const repeats = (line: string) => facts.some(([, v]) => v.length >= 2 && line.includes(v));
  const line = sub && meaningful && sub !== w.title ? sub : "";
  return {
    title: w.title,
    subtitle: line && !repeats(line) ? line : "",
    primary: w.primary,
    tier,
    icon: w.icon,
    facts,
    ...(preview ? { preview } : {}),
    receipt: {
      approved: w.done,
      denied: t("phone.approval.youDeclined", { noun: w.noun }),
      expired: t("phone.approval.expired"),
    },
  };
}
