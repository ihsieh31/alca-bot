// Connected apps + routines on the phone (P6): the shapes the core sends over
// Link, and the pure helpers the screens use (testable without a DOM). The
// Composio key never reaches the phone: the status says only whether it is set.
import { t } from "./i18n/index.ts";

export type Access = "read" | "act" | null;

export interface AccountView {
  id: string;
  /** Next round R8: MCP accounts are set up on the computer; the phone may only tighten. */
  provider?: "composio" | "mcp";
  toolkit: string;
  app: string;
  mark: string;
  label: string;
  status: "pending" | "active" | "failed" | "expired" | "removed";
  identity: string;
  bots: Array<{ botId: string; name: string; access: Access }>;
  triggers: Array<{ id: string; slug: string; name: string; status: string }>;
  createdAt: string;
}

export interface ConnectStatus {
  keySet: boolean;
  apps: Array<{ toolkit: string; name: string; mark: string; blurb: string }>;
  groups: Array<{ toolkit: string; app: string; mark: string; accounts: AccountView[] }>;
  bots: Array<{ id: string; name: string }>;
  usageToday: Record<string, number>;
  quota: Record<string, number>;
  routinesOn: boolean;
  error?: string;
}

export interface RoutineRun {
  id: string;
  outcome: "quiet" | "new" | "read_failed" | "capped" | "ai_done" | "ai_invalid" | "ai_failed";
  items: number;
  detail: string;
  at: string;
}

export interface RoutineView {
  id: string;
  threadId: string;
  threadTitle: string;
  name: string;
  kind: "interval" | "cron" | "once" | "trigger";
  schedule: string;
  check: string;
  instructions: string;
  speculative: boolean;
  enabled: boolean;
  state: "ok" | "error" | "working" | "off";
  lastError: string | null;
  lastCheckedAt: string | null;
  nextAt: string | null;
  backoffUntil: string | null;
  runs: RoutineRun[];
}

export interface DraftView {
  id: string;
  threadId: string;
  title: string;
  kind: "reply" | "message" | "note";
  body: string;
  target: { to?: string; subject?: string; app?: string };
  createdAt: string;
}

export interface RoutineList {
  routines: RoutineView[];
  drafts: DraftView[];
  /** Apps a routine can check (P13: the phone's 新增例行工作). */
  apps?: Array<{ toolkit: string; name: string }>;
}

export const ACCESS: Array<[Exclude<Access, null> | "none", string]> = [
  ["none", t("common.cantUse")],
  ["read", t("common.readOnly")],
  ["act", t("common.canAct")],
];

export const ACCOUNT_STATUS: Record<string, { label: string; tone?: string }> = {
  active: { label: t("common.connected"), tone: "ok" },
  pending: { label: t("common.waitingForAuthorization"), tone: "attention" },
  failed: { label: t("common.connectionFailed"), tone: "danger" },
  expired: { label: t("common.authorizationExpired"), tone: "danger" },
};

export const ROUTINE_STATE: Record<RoutineView["state"], { label: string; tone?: string }> = {
  ok: { label: t("common.normal"), tone: "ok" },
  error: { label: t("common.readFailed"), tone: "danger" },
  working: { label: t("common.aiWorking"), tone: "attention" },
  off: { label: t("common.disabled") },
};

export const RUN_WORD: Record<RoutineRun["outcome"], string> = {
  quiet: t("common.nothingNew"),
  new: t("phone.connectView.foundSomethingNew"),
  read_failed: t("common.readFailed"),
  capped: t("common.todaysAiRunsAreUsed"),
  ai_done: t("common.aiFinishedReading"),
  ai_invalid: t("phone.connectView.aiReplyBadlyFormatted"),
  ai_failed: t("common.aiDidntFinish"),
};

export const QUOTA_WORD: Record<string, string> = {
  send: t("common.send"),
  publish: t("common.publish2"),
  delete: t("common.delete"),
  payment: t("common.pay"),
};

/** "馬上" / "12 分鐘後" / "3 小時後" / "11/4 09:00"; a read failure's backoff wins when later. */
export function nextLook(nextAt: string | null, backoffUntil: string | null, now = Date.now()): string {
  if (!nextAt) return "";
  const at = backoffUntil && Date.parse(backoffUntil) > Date.parse(nextAt) ? backoffUntil : nextAt;
  const ms = Date.parse(at) - now;
  if (ms <= 60_000) return t("common.rightAway");
  const min = Math.round(ms / 60_000);
  if (min < 60) return t("common.inMin", { min });
  const hr = Math.round(min / 60);
  if (hr < 24) return t("common.inHr", { hr });
  const d = new Date(at);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** What a connector card is about, read back from its summary (and the call's arguments when the phone saw them). */
export interface AppAction {
  account: string;
  app: string;
  verb: string;
  tool: string;
  to?: string;
  subject?: string;
  body?: string;
  channel?: string;
  /** The body shown is the card's short preview, not the whole text. */
  clipped: boolean;
}

// i18n-ignore: matched against the summary text the core writes (protocol, not UI words).
const VERBS = "寄送|發布|刪除|付款|寫入";
const SUMMARY = new RegExp(`^用「([^」]+)」(.+?)(${VERBS})：([A-Z0-9_]+)(?:（([\\s\\S]*)）)?$`);

export function parseAppAction(summary: string, args?: Record<string, unknown>): AppAction | undefined {
  const m = SUMMARY.exec(summary.trim());
  if (!m) return undefined;
  const fields: Record<string, string> = {};
  for (const part of (m[5] ?? "").split("｜")) {
    const i = part.indexOf("：");
    if (i > 0) fields[part.slice(0, i)] = part.slice(i + 1);
  }
  const inner = (args?.arguments as Record<string, unknown> | undefined) ?? args ?? {};
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = inner[k];
      if (typeof v === "string" && v.trim()) return { v, full: true };
    }
    for (const k of keys) if (fields[k]) return { v: fields[k] as string, full: false };
    return undefined;
  };
  const to = pick("recipient_email", "to");
  const subject = pick("subject", "title");
  const body = pick("body", "text");
  const channel = pick("channel");
  return {
    account: m[1] ?? "",
    app: (m[2] ?? "").trim(),
    verb: m[3] ?? "",
    tool: m[4] ?? "",
    ...(to ? { to: to.v } : {}),
    ...(subject ? { subject: subject.v } : {}),
    ...(body ? { body: body.v } : {}),
    ...(channel ? { channel: channel.v } : {}),
    clipped: !!body && !body.full && body.v.length >= 80,
  };
}

// ── 網站登入 (design §0.2.7) ──
// The phone lists the website logins the computer keeps and may remove one
// (`connectors.logins` / `connectors.logins.remove`, approve). It never adds
// one: a password never travels the relay, and none is ever in this list.

/** One kept website login as the computer lists it (never a password). */
export interface PhoneSiteLogin {
  id: string;
  origin: string;
  username?: string;
  label?: string;
  bots: Array<{ id: string; name: string }>;
}

/** Only the fields the phone shows, whatever else the answer carried. */
export function phoneLogins(raw: unknown): PhoneSiteLogin[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((x): PhoneSiteLogin[] => {
    const o = x as Record<string, unknown> | null;
    if (!o || typeof o.id !== "string" || typeof o.origin !== "string") return [];
    const bots = Array.isArray(o.bots)
      ? (o.bots as Array<Record<string, unknown>>).flatMap((b) =>
          b && typeof b.id === "string"
            ? [{ id: b.id, name: typeof b.name === "string" ? b.name : b.id }]
            : [],
        )
      : [];
    return [
      {
        id: o.id,
        origin: o.origin,
        ...(typeof o.username === "string" && o.username ? { username: o.username } : {}),
        ...(typeof o.label === "string" && o.label ? { label: o.label } : {}),
        bots,
      },
    ];
  });
}

/** The row's words: the site, the account and who may use it (same words as the computer). */
export function phoneLoginLine(l: PhoneSiteLogin): { title: string; account: string; who: string } {
  let host = l.origin;
  try {
    host = new URL(l.origin).host;
  } catch {
    host = l.origin;
  }
  return {
    title: l.label ? t("common.text4", { label: l.label, host }) : host,
    account: l.username ? t("common.username", { username: l.username }) : t("common.noUsername"),
    who: l.bots.length
      ? t("common.only", { p0: l.bots.map((b) => b.name).join(t("common.text")) })
      : t("common.allBotsCanUseIt"),
  };
}

export const PHONE_LOGINS_NOTE = t("phone.connectView.passwordsAreStoredOnlyOn");
