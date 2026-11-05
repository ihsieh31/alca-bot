// Gap analysis 2026-11 P1: 主動留意's calendar read asks Google for the
// upcoming window (timeMin / timeMax / singleEvents / orderBy), and says
// whether the answer was the whole window. A fake read service stands in
// for Composio (the arguments are what the Calendar API's events.list takes).
import { CALENDAR_POLL_DAYS, PROACTIVE_MAIL_QUERY, pollArguments } from "@alca/connectors";
import { eventVersion } from "@alca/core";
import { describe, expect, it } from "vitest";
import { appReader, type ReadService } from "../src/proactive-reader.ts";

const NOW = new Date("2026-11-05T02:00:00.000Z");

function fakeService(pages: Record<string, unknown>) {
  const calls: Array<{ slug: string; account: unknown; arguments: Record<string, unknown> }> = [];
  const service = {
    usable: () => [
      { id: "acc_cal", toolkit: "googlecalendar" },
      { id: "acc_mail", toolkit: "gmail" },
    ],
    readRaw: async (i: { slug: string; account?: unknown; arguments: Record<string, unknown> }) => {
      calls.push({ slug: i.slug, account: i.account, arguments: i.arguments });
      return pages[i.slug];
    },
  } as unknown as ReadService;
  return { service, calls };
}

describe("proactive calendar / mail reader", () => {
  it("asks events.list for the next 14 days, soonest first, recurring events expanded", async () => {
    const { service, calls } = fakeService({
      GOOGLECALENDAR_EVENTS_LIST: {
        items: [
          {
            id: "ev1",
            summary: "牙醫",
            start: { dateTime: "2026-11-06T10:00:00+08:00" },
            updated: "2026-11-01T00:00:00.000Z",
            status: "confirmed",
          },
        ],
      },
    });
    const r = await appReader(service, "googlecalendar")("bot_1", NOW);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.slug).toBe("GOOGLECALENDAR_EVENTS_LIST");
    expect(calls[0]?.arguments).toEqual({
      calendarId: "primary",
      maxResults: 20,
      timeMin: "2026-11-05T02:00:00.000Z",
      timeMax: new Date(NOW.getTime() + CALENDAR_POLL_DAYS * 86400_000).toISOString(),
      singleEvents: true,
      orderBy: "startTime",
    });
    expect(r.complete).toBe(true);
    expect(r.items).toEqual([
      {
        id: "acc_cal:ev1",
        title: "牙醫",
        startsAt: "2026-11-06T02:00:00.000Z",
        version: eventVersion("2026-11-06T10:00:00+08:00", "", "confirmed"),
        status: "confirmed",
      },
    ]);
  });

  it("review #8: the version follows start / end / status, not `updated` (an RSVP is not new evidence)", async () => {
    const ev = (o: Record<string, unknown>) => ({
      id: "ev1",
      summary: "牙醫",
      start: { dateTime: "2026-11-06T02:00:00Z" },
      end: { dateTime: "2026-11-06T03:00:00Z" },
      status: "confirmed",
      updated: "2026-11-01T00:00:00Z",
      ...o,
    });
    const read = async (o: Record<string, unknown>) =>
      (
        await appReader(
          fakeService({ GOOGLECALENDAR_EVENTS_LIST: { items: [ev(o)] } }).service,
          "googlecalendar",
        )("b", NOW)
      ).items[0]?.version;
    const base = await read({});
    expect(base).toMatch(/^v[0-9a-f]{12}$/);
    expect(await read({ updated: "2026-11-02T09:30:00Z" })).toBe(base); // someone answered the invite
    expect(await read({ description: "改了說明", updated: "2026-11-03T09:30:00Z" })).toBe(base);
    expect(await read({ start: { dateTime: "2026-11-06T05:00:00Z" } })).not.toBe(base); // moved
    expect(await read({ end: { dateTime: "2026-11-06T04:00:00Z" } })).not.toBe(base);
    expect(await read({ status: "tentative" })).not.toBe(base);
  });

  it("a full page or a next page token is not the whole window", async () => {
    const items = Array.from({ length: 20 }, (_, i) => ({ id: `e${i}`, summary: "x" }));
    const full = await appReader(
      fakeService({ GOOGLECALENDAR_EVENTS_LIST: { items } }).service,
      "googlecalendar",
    )("b", NOW);
    expect(full.complete).toBe(false);
    const paged = await appReader(
      fakeService({ GOOGLECALENDAR_EVENTS_LIST: { items: [], nextPageToken: "p2" } }).service,
      "googlecalendar",
    )("b", NOW);
    expect(paged.complete).toBe(false);
  });

  it("mail: unread inbox without promotions / social / forums; labels and thread kept", async () => {
    const { service, calls } = fakeService({
      GMAIL_FETCH_EMAILS: {
        messages: [
          {
            messageId: "m1",
            subject: "帳單",
            sender: "billing@x.example",
            labelIds: ["CATEGORY_UPDATES"],
            threadId: "t1",
          },
        ],
      },
    });
    const r = await appReader(service, "gmail")("bot_1", NOW);
    expect(calls[0]?.arguments).toEqual({ query: PROACTIVE_MAIL_QUERY, max_results: 20 });
    expect(PROACTIVE_MAIL_QUERY).toBe(
      "is:unread in:inbox -category:promotions -category:social -category:forums",
    );
    expect(r.items[0]).toMatchObject({
      id: "acc_mail:m1",
      labels: ["CATEGORY_UPDATES"],
      threadId: "acc_mail:t1",
    });
    // A routine keeps the plain default query.
    expect(pollArguments("gmail", NOW)).toEqual({ query: "is:unread in:inbox", max_results: 20 });
  });

  it("pollArguments: a routine's own arguments win; a syncToken call gets no window; other apps unchanged", () => {
    const mine = pollArguments("googlecalendar", NOW, {
      calendarId: "work",
      timeMax: "2026-11-06T00:00:00Z",
    });
    expect(mine).toMatchObject({ calendarId: "work", timeMax: "2026-11-06T00:00:00Z", orderBy: "startTime" });
    expect(pollArguments("googlecalendar", NOW, { syncToken: "abc" })).toEqual({ syncToken: "abc" });
    expect(pollArguments("github", NOW, { q: "x" })).toEqual({ q: "x" });
  });
});
