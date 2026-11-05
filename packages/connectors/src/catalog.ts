import type { TriggerSource } from "@alca/store";

/**
 * The apps the 連接 page offers first (any Composio toolkit slug also works).
 * Trigger and tool slugs are the ones in Composio's public toolkit pages.
 */
export interface AppInfo {
  toolkit: string;
  name: string;
  /** One or two characters for the monogram tile. */
  mark: string;
  /** What this app is for, in one short line. */
  blurb: string;
  /** Inbound events this app can send (Composio trigger slugs). */
  triggers: ReadonlyArray<{ slug: string; name: string }>;
  /** Which P3 trigger source its events are. */
  source: TriggerSource;
  /** A read tool a routine can poll (checks before the model). */
  poll?: {
    tool: string;
    arguments: Record<string, unknown>;
    itemsPath: string;
    idField: string;
    titleField: string;
    fromField?: string;
    textField?: string;
  };
}

export const APPS: readonly AppInfo[] = Object.freeze([
  {
    toolkit: "gmail",
    name: "Gmail",
    mark: "M",
    blurb: "讀信、擬稿、寄信（寄出一定先問你）",
    triggers: [{ slug: "GMAIL_NEW_GMAIL_MESSAGE", name: "收到新信" }],
    source: "email",
    poll: {
      tool: "GMAIL_FETCH_EMAILS",
      arguments: { query: "is:unread in:inbox", max_results: 20 },
      itemsPath: "messages",
      idField: "messageId",
      titleField: "subject",
      fromField: "sender",
      textField: "preview",
    },
  },
  {
    toolkit: "googlecalendar",
    name: "Google 日曆",
    mark: "日",
    blurb: "看行程、找空檔；建立邀請會先問你",
    triggers: [
      { slug: "GOOGLECALENDAR_GOOGLE_CALENDAR_EVENT_CREATED_TRIGGER", name: "新行程" },
      { slug: "GOOGLECALENDAR_EVENT_STARTING_SOON_TRIGGER", name: "行程快開始" },
    ],
    source: "webhook",
    poll: {
      tool: "GOOGLECALENDAR_EVENTS_LIST",
      arguments: { calendarId: "primary", maxResults: 20 },
      itemsPath: "items",
      idField: "id",
      titleField: "summary",
    },
  },
  {
    toolkit: "github",
    name: "GitHub",
    mark: "GH",
    blurb: "讀 issue 與 PR；留言、開 issue 會先問你",
    triggers: [{ slug: "GITHUB_COMMIT_EVENT", name: "新的 commit" }],
    source: "github",
  },
  {
    toolkit: "slack",
    name: "Slack",
    mark: "S",
    blurb: "讀頻道與私訊；發訊息會先問你",
    triggers: [
      { slug: "SLACK_DIRECT_MESSAGE_RECEIVED", name: "收到私訊" },
      { slug: "SLACK_CHANNEL_MESSAGE_RECEIVED", name: "頻道新訊息" },
    ],
    source: "im",
  },
  {
    toolkit: "line",
    name: "LINE",
    mark: "L",
    blurb: "官方帳號收訊息、回覆（回覆會先問你）",
    triggers: [{ slug: "LINE_MESSAGE_RECEIVED", name: "收到訊息" }],
    source: "im",
  },
  {
    toolkit: "telegram",
    name: "Telegram",
    mark: "T",
    blurb: "Bot 發訊息（Composio 目前沒有 Telegram 觸發器）",
    triggers: [],
    source: "im",
  },
]);

/**
 * Next round R8: `mcp-<id>` is one of the person's MCP servers (not a
 * Composio app). Gmail / Google Calendar only come through Composio (the
 * person chose not to connect Google directly, 2026-11-05).
 */
export function appInfo(toolkit: string): AppInfo {
  if (toolkit.startsWith("mcp-"))
    return {
      toolkit,
      name: `MCP：${toolkit.slice(4)}`,
      mark: "M",
      blurb: "",
      triggers: [],
      source: "webhook",
    };
  return (
    APPS.find((a) => a.toolkit === toolkit) ?? {
      toolkit,
      name: toolkit,
      mark: toolkit.slice(0, 1).toUpperCase(),
      blurb: "",
      triggers: [],
      source: "webhook",
    }
  );
}

/** How far ahead a calendar poll looks (gap analysis 2026-11 P1). */
export const CALENDAR_POLL_DAYS = 14;

/**
 * Gmail search for 主動留意 (gap P7): unread inbox mail without the bulk
 * tabs. `category:updates` is kept on purpose: bills, statements and
 * shipping notices land there, and they are money / errand cards; bulk mail
 * in it is filtered in code (labels, sender, promotion words) instead.
 * Routines keep the plain default they were set up with.
 */
export const PROACTIVE_MAIL_QUERY =
  "is:unread in:inbox -category:promotions -category:social -category:forums";

/**
 * The arguments a poll of this app's read tool sends at `now`.
 *
 * Google Calendar (`GOOGLECALENDAR_EVENTS_LIST` → Calendar API `events.list`):
 * without `timeMin` / `orderBy` the API returns events "in an unspecified,
 * stable order" from the start of the calendar, so a 20-item page was almost
 * always past events (gap P1). The window is `timeMin = now` (a lower bound
 * on an event's END, so one in progress is still listed), `timeMax = now +
 * 14 days` (upper bound on its start), `singleEvents: true` (recurring
 * series expanded; required by `orderBy: "startTime"`), soonest first.
 * Values the caller set (a routine's own arguments) win; a `syncToken` call
 * gets no window (the API refuses `timeMin` / `orderBy` with it).
 * Source: https://developers.google.com/workspace/calendar/api/v3/reference/events/list
 *
 * `purpose: "proactive"` also narrows the default Gmail query
 * (PROACTIVE_MAIL_QUERY).
 */
export function pollArguments(
  toolkit: string,
  now: Date,
  given?: Record<string, unknown>,
  purpose: "routine" | "proactive" = "routine",
): Record<string, unknown> {
  const app = appInfo(toolkit);
  const args = { ...(given ?? app.poll?.arguments ?? {}) };
  if (toolkit === "googlecalendar" && args.syncToken === undefined) {
    const until = new Date(now.getTime() + CALENDAR_POLL_DAYS * 86400_000);
    return {
      timeMin: now.toISOString(),
      timeMax: until.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
      ...args,
    };
  }
  if (toolkit === "gmail" && purpose === "proactive" && !given)
    return { ...args, query: PROACTIVE_MAIL_QUERY };
  return args;
}

export const TOOLKIT_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
