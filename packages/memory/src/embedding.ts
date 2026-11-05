import { createHash } from "node:crypto";
import { segment } from "@alca/store";

/**
 * Optional embedding hook for hybrid search. Off by default: Alca ships no
 * embedding model and makes no network call for memory. Plug in a local
 * model (e.g. one served on the same machine) by implementing `Embedder`;
 * vectors are stored per item with the embedder's id, and search merges
 * full-text rank with cosine rank (reciprocal rank fusion).
 */
export interface Embedder {
  /** Stable id of the model; vectors from another id are ignored. */
  readonly id: string;
  embed(texts: readonly string[]): Promise<Float32Array[]>;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/**
 * A tiny local embedder: hashed bag of CJK bigrams and words. No model, no
 * network; useful for tests and as an example of the hook, not a semantic
 * model.
 */
export class HashingEmbedder implements Embedder {
  readonly id: string;
  private readonly dims: number;
  constructor(dims = 256) {
    this.dims = dims;
    this.id = `hashing-${dims}`;
  }
  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    return texts.map((t) => {
      const v = new Float32Array(this.dims);
      for (const tok of segment(t)) {
        const h = createHash("sha1").update(tok).digest();
        const i = h.readUInt32BE(0) % this.dims;
        v[i] = (v[i] as number) + ((h[4] as number) & 1 ? 1 : -1);
      }
      return v;
    });
  }
}

/** Reciprocal rank fusion of several ranked id lists. */
export function fuseRanks(lists: ReadonlyArray<readonly string[]>, k = 60): string[] {
  const score = new Map<string, number>();
  for (const list of lists)
    for (const [i, id] of list.entries()) score.set(id, (score.get(id) ?? 0) + 1 / (k + i + 1));
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}
