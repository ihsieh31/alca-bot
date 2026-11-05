/**
 * Next round R7.7 (Phase F2): streamed text is merged in memory before it is
 * written. Consecutive `message.delta` events of one run are held and
 * written as ONE `run_events` row, filed under the first one's `seq`:
 *
 *     {"$batch":{"e":<template>,"i":[item, ...]}}
 *
 *   - a chunk whose envelope equals the batch's template (same message,
 *     speaker, run) is `[seq, ts, delta]`; the template is the first chunk
 *     with `seq` 0, `ts` "" and `data.delta` "", stored once;
 *   - any other chunk (another message, not in the protocol's shape) is
 *     `[seq, type, event]`.
 *
 * Why: one AES-GCM seal or open costs about 6 µs in Node whatever the size
 * (cipher object, auth tag, base64, UTF-8), several times a plaintext row's
 * own cost, and a stream wrote one row per chunk. Batched, a stream costs
 * one insert and one seal per batch and one open per batch on read, and the
 * envelope is stored once. Nothing else changes: every event keeps its own
 * `seq` and `ts`, the bus still gets each chunk at once, `RunRepo.events()`
 * hands them back one by one, equal to what was appended, and every other
 * event is written alone, at once, as before.
 *
 * When a batch is written: when any other event of the run is appended (so
 * the order on disk is the order of `seq`); at `maxEvents` chunks or
 * `maxChars` characters; `windowMs` after its first chunk (a timer); before
 * every read of the run; on close. A crash loses at most `windowMs` of
 * chunks of a run that did not finish anyway (the run is closed as
 * interrupted at the next start, and `message.completed`, written at once,
 * is the text that counts).
 */
export interface EventBatching {
  maxEvents: number;
  maxChars: number;
  windowMs: number;
}

export const RUN_EVENT_BATCH: Readonly<EventBatching> = { maxEvents: 64, maxChars: 32_000, windowMs: 100 };

const KEY = "$batch";

/** One streamed chunk taken apart: the envelope (as JSON, to compare) and what differs per chunk. */
export interface Chunk {
  template: string;
  ts: string;
  delta: string;
}

/** The chunk of a protocol `message.delta` event, or undefined. */
export function chunkOf(type: string, seq: number, payload: unknown): Chunk | undefined {
  if (type !== "message.delta" || payload === null || typeof payload !== "object" || Array.isArray(payload))
    return undefined;
  const p = payload as { seq?: unknown; ts?: unknown; data?: unknown };
  if (p.seq !== seq || typeof p.ts !== "string") return undefined;
  const d = p.data as { delta?: unknown } | null | undefined;
  if (d === null || typeof d !== "object" || Array.isArray(d) || typeof d.delta !== "string")
    return undefined;
  return {
    template: JSON.stringify({ ...p, seq: 0, ts: "", data: { ...d, delta: "" } }),
    ts: p.ts,
    delta: d.delta,
  };
}

/** The payload text of one batch row. */
export function batchText(template: string | null, items: readonly string[]): string {
  return `{"${KEY}":{"e":${template ?? "null"},"i":[${items.join(",")}]}}`;
}

export const chunkItem = (seq: number, c: Chunk) => JSON.stringify([seq, c.ts, c.delta]);
export const eventItem = (seq: number, type: string, json: string) =>
  `[${seq},${JSON.stringify(type)},${json}]`;

/** The events of a batch row as [seq, type, event], or undefined for an ordinary row. */
export function expandBatch(payload: unknown): Array<[number, string, unknown]> | undefined {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const b = (payload as Record<string, unknown>)[KEY] as { e?: unknown; i?: unknown } | undefined;
  if (!b || typeof b !== "object" || !Array.isArray(b.i)) return undefined;
  const e = (b.e ?? null) as (Record<string, unknown> & { data: Record<string, unknown> }) | null;
  return (b.i as Array<[number, string, unknown]>).map(([seq, a, x]) =>
    typeof x === "string" && e
      ? [seq, "message.delta", { ...e, seq, ts: a, data: { ...e.data, delta: x } }]
      : [seq, a, x],
  );
}
