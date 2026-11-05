import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * The one way the repo writes a settings or secret file: a temp file next to
 * the target (O_EXCL), fsync, rename over the target, fsync the folder. A crash
 * at any point leaves either the old file or the new one, never half of one.
 *
 * With `backup`, the current file is first copied (the same way) to
 * `<path>.bak`, but only when it still passes `validate`, so a broken file
 * never overwrites a good backup.
 *
 * What it does not promise: on macOS `fsync` does not force the drive's own
 * cache (that needs F_FULLFSYNC, which Node does not expose), so after a power
 * cut the file may be the previous version. The `.bak` covers that.
 */
export interface AtomicWriteOptions {
  /** File mode for the target (and its `.bak`). Default 0o600. */
  mode?: number;
  /** Copy the current file to `<path>.bak` first, when it passes `validate`. */
  backup?: boolean;
  /** Whether the current contents are worth keeping as the backup. Default: always. */
  validate?: (current: Buffer) => boolean;
  /**
   * Called after each step ("written" = temp file synced, "backup" = `.bak`
   * replaced, "renamed" = target replaced). Tests throw here to simulate a
   * crash between steps; production code leaves it unset.
   */
  onStep?: (step: "written" | "backup" | "renamed") => void;
}

const tempName = (dir: string, base: string) =>
  join(dir, `.${base}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);

function fsyncDir(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    // Windows cannot open a folder for reading; the rename itself is what matters there.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Write `data` to a fresh temp file in `dir` and fsync it; returns the temp path. */
function writeTemp(dir: string, base: string, data: Buffer, mode: number): string {
  const tmp = tempName(dir, base);
  const fd = openSync(tmp, "wx", mode);
  try {
    let off = 0;
    while (off < data.length) off += writeSync(fd, data, off, data.length - off);
    fsyncSync(fd);
  } catch (err) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw err;
  }
  closeSync(fd);
  return tmp;
}

function replaceWith(tmp: string, path: string, mode: number): void {
  try {
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  fsyncDir(dirname(path));
  chmodSync(path, mode);
}

function passes(validate: ((b: Buffer) => boolean) | undefined, b: Buffer): boolean {
  if (!validate) return true;
  try {
    return validate(b);
  } catch {
    return false;
  }
}

export function writeFileAtomic(path: string, data: string | Buffer, o: AtomicWriteOptions = {}): void {
  const mode = o.mode ?? 0o600;
  const dir = dirname(path);
  const base = basename(path);
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  const tmp = writeTemp(dir, base, bytes, mode);
  try {
    o.onStep?.("written");
    if (o.backup && existsSync(path)) {
      const current = readFileSync(path);
      if (passes(o.validate, current)) {
        const bakTmp = writeTemp(dir, `${base}.bak`, current, mode);
        replaceWith(bakTmp, `${path}.bak`, mode);
      }
      o.onStep?.("backup");
    }
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  replaceWith(tmp, path, mode);
  o.onStep?.("renamed");
}

/** Something is on disk but neither the file nor its `.bak` can be read. */
export class SecretFileCorruptError extends Error {
  readonly path: string;
  readonly backup: string;
  constructor(path: string, detail?: string) {
    super(
      `${path} cannot be read and ${path}.bak does not help${detail ? ` (${detail})` : ""}. ` +
        "Nothing was changed or regenerated.",
    );
    this.name = "SecretFileCorruptError";
    this.path = path;
    this.backup = `${path}.bak`;
  }
}

export type Recovered<T> =
  | { state: "absent" }
  | { state: "ok"; value: T }
  | { state: "recovered"; value: T; note: string; corruptCopy?: string };

function tryParse<T>(
  path: string,
  parse: (b: Buffer) => T,
): { ok: true; value: T; raw: Buffer } | { ok: false } {
  if (!existsSync(path)) return { ok: false };
  try {
    const raw = readFileSync(path);
    return { ok: true, value: parse(raw), raw };
  } catch {
    return { ok: false };
  }
}

const stamp = () =>
  new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");

/**
 * Read a file written by `writeFileAtomic(…, { backup: true })`.
 *
 * - the file parses → ok;
 * - the file is missing or does not parse, and `<path>.bak` parses → the bad
 *   file (if any) is kept as `<path>.corrupt-<time>`, the backup is written
 *   back to `<path>` and returned → recovered (with a note saying where the
 *   bad copy is);
 * - neither file exists → absent;
 * - anything else (something is there but nothing parses) → throws
 *   SecretFileCorruptError; nothing is renamed or regenerated.
 */
export function readWithRecovery<T>(
  path: string,
  parse: (b: Buffer) => T,
  o: { mode?: number } = {},
): Recovered<T> {
  const main = tryParse(path, parse);
  if (main.ok) return { state: "ok", value: main.value };
  const mainExists = existsSync(path);
  const bakPath = `${path}.bak`;
  const bak = tryParse(bakPath, parse);
  if (!bak.ok) {
    if (!mainExists && !existsSync(bakPath)) return { state: "absent" };
    throw new SecretFileCorruptError(
      path,
      mainExists ? "the file does not parse" : "only a broken .bak is left",
    );
  }
  const mode = o.mode ?? 0o600;
  let corruptCopy: string | undefined;
  if (mainExists) {
    corruptCopy = `${path}.corrupt-${stamp()}`;
    renameSync(path, corruptCopy);
    chmodSync(corruptCopy, mode);
  }
  writeFileAtomic(path, bak.raw, { mode });
  if (!corruptCopy)
    return { state: "recovered", value: bak.value, note: `${path} was missing; restored from ${bakPath}` };
  return {
    state: "recovered",
    value: bak.value,
    note: `${path} was broken; restored from ${bakPath}; the broken copy is kept at ${corruptCopy}`,
    corruptCopy,
  };
}

/** Remove temp files `writeFileAtomic` left behind for `base` in `dir` (a crash between steps). */
export function sweepStaleTemps(dir: string, base: string): number {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  const head = `.${base}.`;
  let n = 0;
  for (const name of names) {
    if (!name.startsWith(head) || !name.endsWith(".tmp")) continue;
    // `.<base>.<pid>.<hex>.tmp` or, for the backup, `.<base>.bak.<pid>.<hex>.tmp`.
    const rest = name.slice(head.length, -".tmp".length).replace(/^bak\./, "");
    if (!/^\d+\.[0-9a-f]{8}$/.test(rest)) continue;
    rmSync(join(dir, name), { force: true });
    n++;
  }
  return n;
}
