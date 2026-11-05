import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Undo for files a shell command changes (mac test 2026-11-04 §7b: a model
 * edited with `printf … > note.txt` in Bash, and nothing could be undone).
 *
 * A command's targets cannot be known in advance, so just before a cleared
 * shell call runs, the bot's work folder is read (a "pre-image": each regular
 * file's stat and, under the size limits, its content). When the call
 * reports back, the folder is compared with it: a changed or deleted file is
 * journaled with its earlier content, a new file as "did not exist". Limits
 * keep this cheap and bounded: folders such as .git and node_modules are not
 * read, and a folder over `maxFiles` / `maxBytes` is read only partly (the
 * turn then says some shell changes were not kept). Not covered: anything
 * outside the work folder, symlinks, and changes made by a process the
 * command left running after it reported back.
 */

export interface ShellSnapshotLimits {
  /** Files read at most (the rest of the folder is not compared). */
  maxFiles: number;
  /** File contents kept at most, all together. */
  maxBytes: number;
  /** A larger file is compared by its stat only; its old content is not kept. */
  maxFileBytes: number;
}

export const SHELL_SNAPSHOT_LIMITS: ShellSnapshotLimits = {
  maxFiles: 5000,
  maxBytes: 64_000_000,
  maxFileBytes: 2_000_000,
};

/** Folders that are not read (version control, dependencies, caches). */
const SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  ".next",
]);

export interface PreFile {
  size: number;
  mtimeMs: number;
  ino: number;
  mode: number;
  /** Undefined = over `maxFileBytes` or the byte budget: compared, not kept. */
  content?: Uint8Array;
}

export interface PreImage {
  dir: string;
  files: Map<string, PreFile>;
  /** False when `maxFiles` stopped the listing: changes in the unlisted part are not seen. */
  complete: boolean;
}

export interface ShellChange {
  path: string;
  /** Undefined = the file is new. */
  before?: PreFile;
}

function* walk(dir: string, depth = 0): Generator<string> {
  if (depth > 32) return;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names.sort()) {
    const p = join(dir, name);
    let st: ReturnType<typeof lstatSync> | undefined;
    try {
      st = lstatSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name)) yield* walk(p, depth + 1);
    } else if (st.isFile()) yield p;
  }
}

/** Read the folder as it is now. */
export function preImage(dir: string, limits: ShellSnapshotLimits = SHELL_SNAPSHOT_LIMITS): PreImage {
  const files = new Map<string, PreFile>();
  let bytes = 0;
  let complete = true;
  for (const p of walk(dir)) {
    if (files.size >= limits.maxFiles) {
      complete = false;
      break;
    }
    try {
      const st = lstatSync(p);
      const f: PreFile = { size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, mode: st.mode & 0o777 };
      if (st.size <= limits.maxFileBytes && bytes + st.size <= limits.maxBytes) {
        f.content = new Uint8Array(readFileSync(p));
        bytes += f.content.byteLength;
      }
      files.set(p, f);
    } catch {
      // gone or unreadable between the listing and the read: not compared
    }
  }
  return { dir, files, complete };
}

const same = (a: Uint8Array, b: Uint8Array) =>
  a.byteLength === b.byteLength && Buffer.from(a).equals(Buffer.from(b));

/** What changed in the folder since `pre` (the same limits, so an unread part stays unread). */
export function changesSince(
  pre: PreImage,
  limits: ShellSnapshotLimits = SHELL_SNAPSHOT_LIMITS,
): ShellChange[] {
  const out: ShellChange[] = [];
  const seen = new Set<string>();
  let n = 0;
  let cut = false;
  for (const p of walk(pre.dir)) {
    if (++n > limits.maxFiles + pre.files.size) {
      cut = true;
      break;
    }
    seen.add(p);
    const before = pre.files.get(p);
    if (!before) {
      if (pre.complete) out.push({ path: p });
      continue;
    }
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(p);
    } catch {
      continue;
    }
    if (st.size === before.size && st.mtimeMs === before.mtimeMs && st.ino === before.ino) continue;
    if (before.content && st.size === before.size) {
      try {
        if (same(before.content, readFileSync(p))) continue; // touched, not changed
      } catch {
        // unreadable now: count it as changed
      }
    }
    out.push({ path: p, before });
  }
  if (!cut) for (const [p, before] of pre.files) if (!seen.has(p)) out.push({ path: p, before });
  return out;
}
