import { createHash } from "node:crypto";
import type { Store } from "@alca/store";
import { seenCursor, unseen } from "../routines/checks.ts";

/**
 * P14 C1: where the 主動留意 add-on looks for something new. Plain code, no
 * model: a source reads, keeps a cursor of what it already saw, and answers
 * with the new pieces of evidence (or `ok: false` when it could not read,
 * which is not "nothing new"). Mail is read as subject, sender, date and a
 * short preview only.
 */

export type ProactiveSourceId = "calendar" | "mail" | "alca" | "deadlines";

export interface Evidence {
  /**
   * Stable id, prefixed by source (`cal:…`, `mail:…`, `alca:…`, `due:…`). A
   * calendar event's id carries its version (`cal:<id>@<version>`), so a
   * moved, re-timed or cancelled event is new evidence (gap P4). The version
   * is a hash of start / end / status (`eventVersion`), not Google's
   * `updated`, which an RSVP or a description edit also bumps (review
   * 2026-11-05 #8).
   */
  id: string;
  source: ProactiveSourceId;
  title: string;
  from?: string;
  /** A short preview (≤ 300 chars). */
  text?: string;
  at?: string;
  /** When it is due / starts (ISO). */
  dueAt?: string;
  /**
   * Mail sent in bulk (Gmail's Updates tab, a no-reply / newsletter sender):
   * a card from it needs relevance to the person (gap P6 / P7).
   */
  bulk?: true;
}

export type SourceRead =
  | {
      ok: true;
      items: Evidence[];
      cursor: Record<string, unknown>;
      /**
       * Every id the source shows now (seen or not), and whether that is all of
       * it (not one full page). A queued card whose evidence is gone from a
       * complete read was cancelled or handled (gap P9).
       */
      present?: { ids: string[]; complete: boolean };
    }
  | { ok: false; error: string };

export interface SourceContext {
  botId: string;
  cursor: Record<string, unknown>;
  now: Date;
}

export interface ProactiveSource {
  readonly id: ProactiveSourceId;
  read(ctx: SourceContext): Promise<SourceRead>;
}

const clip = (s: string | undefined, n: number) =>
  s ? s.replace(/\s+/gu, " ").trim().slice(0, n) : undefined;

/** Only what is new since the cursor, at most `limit`; the cursor remembers what was seen. */
function fresh(ctx: SourceContext, all: Evidence[], complete: boolean, limit = 20): SourceRead {
  const items = unseen(ctx.cursor, all).slice(0, limit);
  return {
    ok: true,
    items,
    present: { ids: all.map((e) => e.id), complete },
    cursor: seenCursor(
      ctx.cursor,
      items.map((i) => i.id),
    ),
  };
}

/** Deadlines the person mentioned in conversation (memories with `due_at` in the next 14 days). */
export class DeadlineSource implements ProactiveSource {
  readonly id = "deadlines" as const;
  private readonly store: Store;
  constructor(store: Store) {
    this.store = store;
  }
  async read(ctx: SourceContext): Promise<SourceRead> {
    try {
      const to = new Date(ctx.now.getTime() + 14 * 86400_000);
      const rows = this.store.memory.dueBetween(ctx.botId, ctx.now, to, 20);
      // A forgotten or changed deadline is gone from the read (a full page of 20 cannot say so).
      const complete = rows.length < 20;
      return fresh(
        ctx,
        rows.map((m) => ({
          id: `due:${m.id}`,
          source: "deadlines" as const,
          title: m.body.slice(0, 200),
          ...(m.dueAt ? { dueAt: m.dueAt } : {}),
          at: m.createdAt,
        })),
        complete,
      );
    } catch (err) {
      return { ok: false, error: String((err as Error)?.message ?? err).slice(0, 200) };
    }
  }
}

/** Alca's own state: routines that keep failing, cards waiting too long, prepared drafts nobody used. */
export class AlcaStateSource implements ProactiveSource {
  readonly id = "alca" as const;
  private readonly store: Store;
  constructor(store: Store) {
    this.store = store;
  }
  async read(ctx: SourceContext): Promise<SourceRead> {
    try {
      const out: Evidence[] = [];
      const now = ctx.now.getTime();
      for (const r of this.store.routines.list(ctx.botId)) {
        if (!r.enabled || !r.lastError) continue;
        out.push({
          id: `alca:routine:${r.id}:${r.lastError.slice(0, 40)}`,
          source: "alca",
          title: `例行工作「${r.name}」讀取失敗`,
          text: clip(r.lastError, 200) ?? "",
        });
      }
      for (const a of this.store.human.pendingApprovals()) {
        if (a.botId !== ctx.botId) continue;
        if (now - Date.parse(a.requestedAt) < 6 * 3600_000) continue;
        out.push({
          id: `alca:approval:${a.id}`,
          source: "alca",
          title: "有一張審批卡等了超過 6 小時",
          text: clip(a.summary, 200) ?? "",
          at: a.requestedAt,
        });
      }
      for (const d of this.store.routines.drafts({ botId: ctx.botId, status: "ready" })) {
        if (now - Date.parse(d.createdAt) < 24 * 3600_000) continue;
        out.push({
          id: `alca:draft:${d.id}`,
          source: "alca",
          title: `準備好的草稿「${d.title.slice(0, 60)}」還沒處理`,
          at: d.createdAt,
        });
      }
      return fresh(ctx, out, true);
    } catch (err) {
      return { ok: false, error: String((err as Error)?.message ?? err).slice(0, 200) };
    }
  }
}

/** A raw item a connected-app reader returns. */
export interface AppItem {
  id: string;
  title: string;
  from?: string;
  text?: string;
  at?: string;
  startsAt?: string;
  /** Calendar: `eventVersion` of the event (a re-timed or re-statused event is new evidence). */
  version?: string;
  /** Calendar: `confirmed` / `tentative` / `cancelled`. */
  status?: string;
  /** Mail: Gmail label ids (`CATEGORY_PROMOTIONS` …). */
  labels?: string[];
  /** Mail: the thread it belongs to. */
  threadId?: string;
}

/** What a host reader answers: the items, and whether they are the whole window (not one full page). */
export interface AppRead {
  items: AppItem[];
  complete: boolean;
}

/** Gmail tabs that are never a card (dropped even if the search did not leave them out). */
const NOISE_LABELS = new Set(["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_FORUMS", "SPAM", "TRASH"]);
const BULK_SENDER =
  /(?:^|[<\s"'(])(?:no-?reply|do-?not-?reply|donotreply|newsletters?|news|marketing|promo(?:tions?)?|mailer|edm|campaign)[^@\s]*@/iu;

/** Mail from the Updates tab or a bulk sender (see `Evidence.bulk`). */
export function isBulkMail(i: Pick<AppItem, "from" | "labels">): boolean {
  return !!i.labels?.includes("CATEGORY_UPDATES") || (!!i.from && BULK_SENDER.test(i.from));
}

/** `cal:<id>` or, with a version, `cal:<id>@<version>` (≤ 200 characters, the version kept). */
export function evidenceId(prefix: string, id: string, version?: string): string {
  const v = version ? `@${version.slice(0, 40)}` : "";
  return `${`${prefix}:${id}`.slice(0, 200 - v.length)}${v}`;
}

/**
 * Review 2026-11-05 #8: a calendar event's version — the part of the event a
 * card depends on (when it starts and ends, and whether it still holds),
 * hashed: `v` + 12 hex characters. Attendee answers and description edits do
 * not change it, so they do not make new evidence (and a new paid candidate step).
 */
export function eventVersion(start: string, end: string, status: string): string {
  return `v${createHash("sha256").update(`${start}|${end}|${status}`, "utf8").digest("hex").slice(0, 12)}`;
}

/** A version from before `eventVersion`: Google's `updated` time (RFC 3339), which cannot tell a change. */
export const isUpdatedStamp = (v: string): boolean => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/u.test(v);

/** The evidence id without its version (`cal:<id>@<updated>` → `cal:<id>`). */
export function evidenceRef(id: string): string {
  const at = id.startsWith("cal:") ? id.lastIndexOf("@") : -1;
  return at > 0 ? id.slice(0, at) : id;
}

/** Calendar or mail through a reader the host provides (connected apps); read-only. */
export class AppSource implements ProactiveSource {
  readonly id: "calendar" | "mail";
  private readonly reader: (botId: string, now: Date) => Promise<AppItem[] | AppRead>;
  constructor(id: "calendar" | "mail", reader: (botId: string, now: Date) => Promise<AppItem[] | AppRead>) {
    this.id = id;
    this.reader = reader;
  }
  async read(ctx: SourceContext): Promise<SourceRead> {
    let raw: AppItem[];
    let complete = false;
    try {
      const r = await this.reader(ctx.botId, ctx.now);
      raw = Array.isArray(r) ? r : r.items;
      complete = !Array.isArray(r) && r.complete;
    } catch (err) {
      return { ok: false, error: String((err as Error)?.message ?? err).slice(0, 200) };
    }
    const prefix = this.id === "calendar" ? "cal" : "mail";
    const items = raw
      // A cancelled event is nothing to prepare for; promotions / social / forums mail is noise.
      .filter((i) => i.id && i.status !== "cancelled" && !i.labels?.some((l) => NOISE_LABELS.has(l)))
      .map(
        (i): Evidence => ({
          id: evidenceId(prefix, i.id, this.id === "calendar" ? i.version : undefined),
          source: this.id,
          title: clip(i.title, 200) ?? "",
          ...(i.from ? { from: clip(i.from, 120) as string } : {}),
          ...(i.text ? { text: clip(i.text, this.id === "mail" ? 200 : 300) as string } : {}),
          ...(i.at ? { at: i.at } : {}),
          ...(i.startsAt ? { dueAt: i.startsAt } : {}),
          ...(this.id === "mail" && isBulkMail(i) ? { bulk: true as const } : {}),
        }),
      )
      // A calendar event that already started is not something to prepare for.
      .filter((e) => !(this.id === "calendar" && e.dueAt && Date.parse(e.dueAt) < ctx.now.getTime()));
    return fresh(ctx, items, complete);
  }
}
