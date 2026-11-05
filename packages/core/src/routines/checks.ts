import type { RoutineRecord, Store } from "@alca/store";

/**
 * Checks before the model: plain code that looks for something new. A check
 * never calls a model and never changes anything outside Alca. It answers
 * with the new items and the cursor that would be true once they are handled
 * (the runner stores that cursor only after the AI result is saved), or with
 * `ok: false` when it could not read — which is not "nothing new".
 */

export interface RoutineItem {
  /** Stable id within the source (a message id, an event id). */
  id: string;
  title: string;
  from?: string;
  text?: string;
  at?: string;
}

export type CheckResult =
  | { ok: true; items: RoutineItem[]; nextCursor: Record<string, unknown> }
  | { ok: false; error: string };

export interface CheckContext {
  routine: RoutineRecord;
  cursor: Record<string, unknown>;
  /** At most this many items per AI run; the rest stay new for the next one. */
  limit: number;
  now: Date;
  signal: AbortSignal;
}

export interface RoutineCheck {
  readonly kind: string;
  /** A short Traditional Chinese line for the routines view. */
  describe(spec: Record<string, unknown>): string;
  run(ctx: CheckContext): Promise<CheckResult>;
}

/** Keep the last N ids seen, newest last (cursor for sources without a sequence). */
export function seenCursor(
  prev: Record<string, unknown>,
  ids: readonly string[],
  keep = 500,
): Record<string, unknown> {
  const before = Array.isArray(prev.seen)
    ? (prev.seen as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  const set = new Set(before);
  const out = [...before];
  for (const id of ids) if (!set.has(id)) out.push(id);
  return { ...prev, seen: out.slice(-keep) };
}

export function unseen<T extends { id: string }>(cursor: Record<string, unknown>, items: readonly T[]): T[] {
  const seen = new Set(Array.isArray(cursor.seen) ? (cursor.seen as string[]) : []);
  return items.filter((i) => !seen.has(i.id));
}

/** Trigger-based routines: the items the trigger pipeline queued, after the cursor's sequence. */
export class QueueCheck implements RoutineCheck {
  readonly kind = "queue";
  private readonly store: Store;
  constructor(store: Store) {
    this.store = store;
  }
  describe(): string {
    return "觸發器送來的新事件";
  }
  async run(ctx: CheckContext): Promise<CheckResult> {
    const after = Number(ctx.cursor.seq ?? 0) || 0;
    const rows = this.store.routines.itemsAfter(ctx.routine.id, after, ctx.limit);
    const items = rows.map((r) => ({
      id: r.key,
      title: String(r.payload.title ?? r.payload.text ?? "").slice(0, 200),
      ...(typeof r.payload.from === "string" ? { from: r.payload.from } : {}),
      ...(typeof r.payload.text === "string" ? { text: r.payload.text } : {}),
      ...(typeof r.payload.at === "string" ? { at: r.payload.at } : {}),
    }));
    const last = rows.at(-1)?.seq ?? after;
    return { ok: true, items, nextCursor: { ...ctx.cursor, seq: last } };
  }
}

/**
 * A check backed by a read function (a host tool that only reads, a demo
 * source): `read` returns every current item; the cursor remembers ids seen.
 */
export class ReadCheck implements RoutineCheck {
  readonly kind: string;
  private readonly read: (spec: Record<string, unknown>, ctx: CheckContext) => Promise<RoutineItem[]>;
  private readonly label: (spec: Record<string, unknown>) => string;
  constructor(
    kind: string,
    read: (spec: Record<string, unknown>, ctx: CheckContext) => Promise<RoutineItem[]>,
    label: (spec: Record<string, unknown>) => string,
  ) {
    this.kind = kind;
    this.read = read;
    this.label = label;
  }
  describe(spec: Record<string, unknown>): string {
    return this.label(spec);
  }
  async run(ctx: CheckContext): Promise<CheckResult> {
    let all: RoutineItem[];
    try {
      all = await this.read(ctx.routine.check, ctx);
    } catch (err) {
      return { ok: false, error: String((err as Error)?.message ?? err).slice(0, 300) };
    }
    const fresh = unseen(ctx.cursor, all).slice(0, ctx.limit);
    return {
      ok: true,
      items: fresh,
      nextCursor: seenCursor(
        ctx.cursor,
        fresh.map((i) => i.id),
      ),
    };
  }
}
