// PERF-2026-11 / review #16: where the desktop core keeps Node's compile
// cache. Loaded by main.ts before anything else, so node: builtins only — a
// workspace import here would be compiled before the cache is on.
//
// Node's default folder is os.tmpdir()/node-compile-cache: on a multi-user
// computer that is the shared, world-writable /tmp, where another account can
// create the folder first and feed this core poisoned code cache. The cache
// lives in the person's own data folder instead (<data>/cache/compile, 0700,
// the folder itself 0700 as lockDownDataDir keeps it).
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import module from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** The data folder main.ts will open: --data-dir (either form), else $ALCA_DATA_DIR, else ~/.alca. */
export function dataDirFromArgv(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): string {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--data-dir" && argv[i + 1]) return resolve(argv[i + 1] as string);
    if (a.startsWith("--data-dir=")) return resolve(a.slice("--data-dir=".length));
  }
  return resolve(env.ALCA_DATA_DIR || join(homedir(), ".alca"));
}

/** A folder this account owns, owner-only (made if missing; never through a link). */
function privateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`not a folder: ${dir}`);
  if (typeof process.getuid === "function" && st.uid !== process.getuid())
    throw new Error(`not ours: ${dir}`);
  if ((st.mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
}

/**
 * Turn the compile cache on. NODE_DISABLE_COMPILE_CACHE turns it off; a
 * NODE_COMPILE_CACHE the person set is theirs (Node has already enabled it
 * there). Returns the folder used, or undefined when off or it failed — a
 * failure only costs the speed-up.
 */
export function enableCompileCache(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (env.NODE_DISABLE_COMPILE_CACHE) return undefined;
  try {
    if (env.NODE_COMPILE_CACHE) return module.enableCompileCache?.()?.directory;
    const root = dataDirFromArgv(argv, env);
    privateDir(root);
    privateDir(join(root, "cache"));
    const dir = join(root, "cache", "compile");
    privateDir(dir);
    return module.enableCompileCache?.(dir)?.directory ?? undefined;
  } catch {
    // read-only folder and the like: start without the cache
    return undefined;
  }
}
