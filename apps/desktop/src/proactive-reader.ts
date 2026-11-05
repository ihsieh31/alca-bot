import { appInfo, type ConnectorService, pick, pollArguments } from "@alca/connectors";
import { type AppItem, type AppRead, eventVersion } from "@alca/core";

/**
 * P14: 主動留意's calendar / mail reader. Every read account of the app the
 * bot may use, through the app's own poll tool, with the arguments of
 * `pollArguments(…, "proactive")` (calendar: the next 14 days, soonest
 * first; mail: unread inbox without the bulk tabs).
 *
 * `complete` says the answer is the whole window (every account answered
 * with fewer items than the page size and no next page), so an event missing
 * from it was cancelled or moved out of the window (revalidation, gap P9);
 * a full page cannot say that.
 */

const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export type ReadService = Pick<ConnectorService, "usable" | "readRaw">;

export function appReader(service: ReadService, toolkit: "googlecalendar" | "gmail") {
  return async (botId: string, now: Date): Promise<AppRead> => {
    const poll = appInfo(toolkit).poll;
    if (!poll) return { items: [], complete: true };
    const args = pollArguments(toolkit, now, undefined, "proactive");
    const page = Number(args.maxResults ?? args.max_results ?? 20) || 20;
    const out: AppItem[] = [];
    let complete = true;
    for (const acc of service.usable(botId).filter((a) => a.toolkit === toolkit)) {
      const data = await service.readRaw({ botId, slug: poll.tool, account: acc.id, arguments: args });
      const list = pick(data, poll.itemsPath ?? "items");
      if (!Array.isArray(list)) {
        complete = false;
        continue;
      }
      if (list.length >= page || str(pick(data, "nextPageToken"))) complete = false;
      for (const x of list) {
        if (!x || typeof x !== "object") continue;
        const r = x as Record<string, unknown>;
        const id = str(pick(r, poll.idField ?? "id"));
        if (!id) continue;
        const start = str(pick(r, "start.dateTime")) || str(pick(r, "start.date"));
        const end = str(pick(r, "end.dateTime")) || str(pick(r, "end.date"));
        const from = poll.fromField ? str(pick(r, poll.fromField)) : "";
        const text = poll.textField ? str(pick(r, poll.textField)) : "";
        const at = str(r.date ?? r.messageTimestamp);
        const labels = strs(r.labelIds);
        const thread = str(r.threadId);
        out.push({
          id: `${acc.id}:${id}`,
          title: str(pick(r, poll.titleField ?? "title")).slice(0, 200),
          ...(from ? { from } : {}),
          ...(text ? { text: text.slice(0, 200) } : {}),
          ...(at ? { at } : {}),
          ...(start && !Number.isNaN(Date.parse(start)) ? { startsAt: new Date(start).toISOString() } : {}),
          // Calendar: start / end / status version the evidence (a moved event is new evidence, gap P4);
          // not `updated`, which every RSVP bumps (review 2026-11-05 #8).
          ...(toolkit === "googlecalendar" && (start || end)
            ? { version: eventVersion(start, end, str(r.status)) }
            : {}),
          ...(str(r.status) ? { status: str(r.status) } : {}),
          ...(labels.length ? { labels } : {}),
          ...(thread ? { threadId: `${acc.id}:${thread}` } : {}),
        });
      }
    }
    return { items: out, complete };
  };
}
