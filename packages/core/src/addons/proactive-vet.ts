import type { OfferRecord } from "@alca/store";
import { type DropReason, sameMatter } from "./proactive-pick.ts";
import { evidenceRef, isUpdatedStamp, type ProactiveSourceId, type SourceRead } from "./proactive-sources.ts";

/**
 * Gap analysis 2026-11 P8 / P9 / P10: before a candidate becomes a card, and
 * again before a queued card is shown, check it still stands — its evidence
 * is still there (a cancelled event, a forgotten deadline, an approval that
 * was answered are gone), it is not the same matter as a card already made
 * (a calendar event and its confirmation mail), and no suppress rule written
 * since covers it (the caller re-runs `suppressed`).
 *
 * Presence comes from the last complete read of each source (a full page
 * proves nothing). Mail is not judged by presence: the mail read is unread
 * inbox mail, and a mail that was only opened is not handled — whether the
 * person replied needs a read of the thread (follow-up).
 */

/** Per source: every evidence id the last complete read showed, and when. */
export type Presence = Partial<Record<ProactiveSourceId, { ids: string[]; at: string }>>;

/** How far the calendar read looks ahead (an event further out is absent by design). */
const CALENDAR_WINDOW_MS = 14 * 86400_000;
/** Cards made in this window count for duplicates. */
export const DEDUPE_DAYS = 14;

const SOURCE_OF: Record<string, ProactiveSourceId> = {
  cal: "calendar",
  mail: "mail",
  due: "deadlines",
  alca: "alca",
};

/** Most ids one source's presence keeps (a longer complete read counts as incomplete). */
export const PRESENCE_MAX = 500;

/** The presence after a read: a complete read replaces the source's ids; an incomplete one forgets them. */
export function withPresence(
  prev: Presence,
  src: ProactiveSourceId,
  r: Extract<SourceRead, { ok: true }>,
  now: Date,
): Presence {
  const out = { ...prev };
  // Review 2026-11-05 #9: past PRESENCE_MAX ids the snapshot would be cut, and a cut list
  // proves nothing (everything after the cut would read as gone): it counts as incomplete.
  if (r.present?.complete && r.present.ids.length <= PRESENCE_MAX)
    out[src] = { ids: [...r.present.ids], at: now.toISOString() };
  else delete out[src];
  return out;
}

/** `gone` (not in the last complete read), `changed` (there in another version), or undefined (still there / unknown). */
export function evidenceState(
  presence: Presence,
  id: string,
  dueAt?: string | null,
): "gone" | "changed" | undefined {
  const src = SOURCE_OF[id.slice(0, id.indexOf(":"))];
  if (!src || src === "mail") return undefined;
  const snap = presence[src];
  if (!snap || snap.ids.includes(id)) return undefined;
  const ref = evidenceRef(id);
  const now = snap.ids.find((x) => evidenceRef(x) === ref);
  if (now) {
    // Review 2026-11-05 #7: an id with no version (a card queued before ids carried one), or
    // one versioned by Google's `updated` (before #8), cannot tell a change: still there.
    if (ref === id || isUpdatedStamp(id.slice(ref.length + 1))) return undefined;
    return "changed";
  }
  if (src === "calendar") {
    const due = dueAt ? Date.parse(dueAt) : Number.NaN;
    // Outside the window the read covers: absent by design, not cancelled.
    if (!Number.isNaN(due) && due > Date.parse(snap.at) + CALENDAR_WINDOW_MS) return undefined;
  }
  return "gone";
}

/**
 * The fact a card is about: `propose` stores the action as
 * `<action>（背景：<fact>）`; older or other cards fall back to the text.
 * Matters are compared on facts (the proposal frame and the action would
 * only add words the two do not share).
 */
export function offerFact(o: Pick<OfferRecord, "text" | "action">): string {
  const m = /（背景：([\s\S]*)）$/u.exec(o.action);
  return m?.[1]?.trim() || o.text;
}

/** A card about the same matter among `offers` (facts compared with `sameMatter`). */
export function duplicateOf(
  c: { text: string; dueAt?: string | null },
  offers: readonly OfferRecord[],
): OfferRecord | undefined {
  return offers.find((o) => sameMatter(c, { text: offerFact(o), dueAt: o.dueAt }));
}

/** Why a candidate (or a queued card) should not be shown now, from presence and earlier cards; `text` is its fact. */
export function vet(
  c: { text: string; dueAt?: string | null; evidenceIds: readonly string[] },
  presence: Presence,
  offers: readonly OfferRecord[],
): DropReason | undefined {
  for (const id of c.evidenceIds) {
    const st = evidenceState(presence, id, c.dueAt);
    if (st) return st;
  }
  return duplicateOf(c, offers) ? "duplicate" : undefined;
}
