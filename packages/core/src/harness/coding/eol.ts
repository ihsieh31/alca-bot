import type { Eol } from "./text.ts";

/**
 * Research audit A2: a file with mixed line endings keeps them. The text the
 * tools hand around is LF only, so on writing each new line is matched back
 * to the old lines (a Myers line diff): a line that is still there keeps the
 * ending it had, and only the lines the change touched take the file's most
 * common ending.
 */

/** The ending after each line of `body` (one fewer than its lines; the last line has none). */
export function lineEndings(body: string): Eol[] {
  const out: Eol[] = [];
  const re = /\r\n|\n|\r/g;
  for (let m = re.exec(body); m; m = re.exec(body)) out.push(m[0] as Eol);
  return out;
}

/** Above this many edit steps the diff gives up and the changed middle takes the common ending. */
const MAX_D = 4000;

/**
 * For each line of `b`, the index of the same line in `a` it is matched to
 * (or -1): common head and tail first, then a Myers diff over the middle.
 */
export function matchLines(a: readonly string[], b: readonly string[]): number[] {
  const out = new Array<number>(b.length).fill(-1);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) {
    out[head] = head;
    head++;
  }
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    out[b.length - 1 - tail] = a.length - 1 - tail;
    tail++;
  }
  const A = a.slice(head, a.length - tail);
  const B = b.slice(head, b.length - tail);
  if (!A.length || !B.length) return out;
  const pairs = myers(A, B);
  for (const [i, j] of pairs) out[head + j] = head + i;
  return out;
}

/** Matched (i, j) pairs of a shortest edit script; [] when it would take over MAX_D steps. */
function myers(a: readonly string[], b: readonly string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_D);
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && (v[off + k - 1] as number) < (v[off + k + 1] as number))
          ? (v[off + k + 1] as number)
          : (v[off + k - 1] as number) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
  }
  if (found < 0) return [];
  const pairs: Array<[number, number]> = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const pv = trace[d] as Int32Array;
    const k = x - y;
    const prevK =
      k === -d || (k !== d && (pv[off + k - 1] as number) < (pv[off + k + 1] as number)) ? k + 1 : k - 1;
    const px = pv[off + prevK] as number;
    const py = px - prevK;
    while (x > px && y > py) {
      x--;
      y--;
      pairs.push([x, y]);
    }
    x = px;
    y = py;
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    pairs.push([x, y]);
  }
  return pairs.reverse();
}

/** Encode LF text `lf` back over the old LF text and its endings, keeping every untouched line's ending. */
export function encodeMixed(lf: string, oldLf: string, endings: readonly Eol[], common: Eol): string {
  const a = oldLf.split("\n");
  const b = lf.split("\n");
  const match = matchLines(a, b);
  let out = "";
  for (let j = 0; j < b.length; j++) {
    out += b[j];
    if (j === b.length - 1) break;
    const i = match[j] as number;
    out += i >= 0 && i < endings.length ? (endings[i] as Eol) : common;
  }
  return out;
}
