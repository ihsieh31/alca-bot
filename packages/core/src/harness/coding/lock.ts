import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/**
 * Plan §4: `withFileLock` — one writer per file at a time inside this Alca
 * process. Two workers (or two calls of one worker) that read-modify-write
 * the same file queue instead of one silently undoing the other. Locks are
 * keyed by the real path (a symlink and its target are one file) and taken
 * in sorted order when a call writes several files, so two multi-file
 * patches cannot deadlock.
 *
 * Not a lock against other programs: an editor or a formatter can still
 * change the file; the read-state check and the hash read-back catch that.
 */

const tails = new Map<string, Promise<unknown>>();

function keyOf(path: string): string {
  const abs = resolve(path);
  try {
    return realpathSync(abs);
  } catch {
    // A file that does not exist yet: its folder's real path plus the name.
    try {
      return join(realpathSync(dirname(abs)), basename(abs));
    } catch {
      return abs;
    }
  }
}

async function lockOne<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const before = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => {
    release = r;
  });
  const tail = before.then(() => mine);
  tails.set(key, tail);
  await before.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  }
}

/** Run `fn` holding the lock of every path (sorted, deduplicated). */
export async function withFileLock<T>(
  paths: string | readonly string[],
  fn: () => Promise<T> | T,
): Promise<T> {
  const keys = [...new Set((typeof paths === "string" ? [paths] : paths).map(keyOf))].sort();
  const run = (i: number): Promise<T> =>
    i >= keys.length ? Promise.resolve().then(fn) : lockOne(keys[i] as string, () => run(i + 1));
  return run(0);
}

/** How many files are locked or queued right now (tests). */
export const lockedFiles = (): number => tails.size;
