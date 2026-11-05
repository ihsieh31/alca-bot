import { mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import type { Store } from "@alca/store";

/**
 * Each bot's working folder (P13). Engines that run their own tools start
 * there, and Alca's own file tools never reach outside it. Default
 * `<data>/bots/<id>/work`; a person may point a bot at another folder, which
 * is checked every time it is used:
 *
 * - absolute (or `~/…`), no NUL, resolved through symlinks of its nearest
 *   existing ancestor, so a link cannot smuggle it somewhere else;
 * - never the filesystem root, the home folder itself or a system folder;
 * - never inside Alca's data folder (except the bot's own `bots/<id>/`), and
 *   never a folder that contains the data folder: a bot must not be able to
 *   edit the database, the vault or another bot's files.
 *
 * A setting that fails the check is not used: the bot runs in its default
 * folder and `problem()` says why.
 */

const SYSTEM_DIRS = [
  "/bin",
  "/boot",
  "/dev",
  "/etc",
  "/lib",
  "/lib64",
  "/proc",
  "/sbin",
  "/sys",
  "/usr",
  "/var",
  "/private",
  "/System",
  "/Library",
  "/Applications",
  "/opt/homebrew",
  "C:\\Windows",
  "C:\\Program Files",
  "C:\\Program Files (x86)",
];

/**
 * Folders in the home folder that hold keys, credentials, other apps' data or
 * an engine's own configuration (review 2026-11-04b M4): never a work folder,
 * nor anything inside one. (Their parent is the home folder itself, which is
 * refused already.)
 */
export const SENSITIVE_HOME_DIRS: readonly string[] = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".config",
  ".kube",
  ".docker",
  ".claude",
  ".codex",
  ".gemini",
  ".cursor",
  ".password-store",
  ".local/share/keyrings",
  ".terraform.d",
  ".oci",
  ".mozilla",
  ".pki",
  ".vscode",
  "Library",
  "AppData",
];

/** Is `p` exactly one of the system folders (as resolved)? */
function isSystemDir(p: string): boolean {
  return SYSTEM_DIRS.some((d) => realish(d) === p);
}

/** Is `child` the same as or inside `parent` (both absolute, normalized)? */
export function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Resolve symlinks of the longest existing prefix; the rest is appended as written (it does not exist yet). */
export function realish(p: string): string {
  let head = normalize(p);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(head);
      return tail.length ? join(real, ...tail.reverse()) : real;
    } catch {
      const up = dirname(head);
      if (up === head) return normalize(p);
      tail.push(head.slice(up.length).replace(/^[\\/]+/, ""));
      head = up;
    }
  }
}

export type WorkDirCheck = { ok: true; path: string } | { ok: false; reason: string };

export interface BotWorkDirsOptions {
  /** Alca's data folder. */
  dataDir: string;
  store: Store;
  /** The person's home folder (tests). */
  home?: string;
  /**
   * The folder bots without their own setting work in (the desktop's
   * `--workdir`); checked like a setting, and unused when it fails.
   * Unset = each bot's `<data>/bots/<id>/work`.
   */
  defaultDir?: string;
  /**
   * The OS temp folder (tests). Folders inside it are not system folders even
   * where it lives under one: macOS's tmpdir() is /var/folders/… →
   * /private/var/folders/… (mac test 2026-11-04). Default tmpdir() and /tmp.
   */
  tempDir?: string;
}

export class BotWorkDirs {
  private readonly o: BotWorkDirsOptions;
  private readonly data: string;
  private readonly home: string;
  private readonly temps: string[];

  constructor(o: BotWorkDirsOptions) {
    this.o = o;
    this.data = realish(resolve(o.dataDir));
    this.home = realish(o.home ?? homedir());
    const temps = o.tempDir !== undefined ? [o.tempDir] : [tmpdir(), "/tmp"];
    // Only a real temp folder below the root counts (never "/" or a system folder itself).
    this.temps = temps.map((t) => realish(resolve(t))).filter((t) => dirname(t) !== t && !isSystemDir(t));
  }

  /** Alca's data folder, resolved (no native tool may reach it: protect.ts). */
  get dataDir(): string {
    return this.data;
  }

  /** `<data>/bots/<id>`: the bot's own corner of the data folder. */
  botRoot(botId: string): string {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(botId)) throw new Error("bad bot id");
    return join(this.data, "bots", botId);
  }

  defaultFor(botId: string): string {
    return join(this.botRoot(botId), "work");
  }

  /** Where a bot without a (usable) setting works: the shared default folder, else its own. */
  fallback(botId: string): string {
    if (this.o.defaultDir) {
      const c = this.check(botId, this.o.defaultDir);
      if (c.ok) return c.path;
    }
    return this.defaultFor(botId);
  }

  /** Check a folder a person wants a bot to work in (does not create it). */
  check(botId: string, raw: string): WorkDirCheck {
    const v = raw.trim();
    if (!v) return { ok: false, reason: "資料夾路徑是空的" };
    if (v.includes("\0")) return { ok: false, reason: "路徑含有不允許的字元" };
    if (v.length > 1000) return { ok: false, reason: "路徑太長" };
    const expanded = v === "~" ? this.home : v.startsWith("~/") ? join(this.home, v.slice(2)) : v;
    if (!isAbsolute(expanded)) return { ok: false, reason: "請用完整路徑（例如 ~/Projects/demo）" };
    const p = realish(resolve(expanded));
    if (dirname(p) === p) return { ok: false, reason: "不能用整個磁碟的根目錄" };
    if (p === this.home) return { ok: false, reason: "不能用整個家目錄；請選裡面的一個資料夾" };
    for (const d of SENSITIVE_HOME_DIRS) {
      const sensitive = realish(join(this.home, d));
      if (isWithin(sensitive, p) || isWithin(join(this.home, d), p))
        return { ok: false, reason: `不能用存放金鑰、帳號或其他程式資料的資料夾（~/${d}）` };
    }
    const exempt = isWithin(this.home, p) || this.temps.some((t) => isWithin(t, p));
    for (const d of SYSTEM_DIRS) {
      if (isWithin(realish(d), p) && !exempt) return { ok: false, reason: `不能用系統資料夾（${d}）` };
    }
    if (isWithin(p, this.data))
      return { ok: false, reason: "這個資料夾包含 Alca 的資料，bot 不能在這裡工作" };
    if (isWithin(this.data, p) && !isWithin(this.botRoot(botId), p))
      return { ok: false, reason: "不能用 Alca 資料夾裡別的地方" };
    try {
      const st = statSync(p);
      if (!st.isDirectory()) return { ok: false, reason: "這個路徑不是資料夾" };
    } catch {
      // does not exist yet: created on first use
    }
    return { ok: true, path: p };
  }

  /** Why the bot's own setting is not used right now (undefined = it is fine, or it has none). */
  problem(botId: string): string | undefined {
    const set = this.o.store.bots.get(botId)?.workDir;
    if (!set) return undefined;
    const c = this.check(botId, set);
    return c.ok ? undefined : c.reason;
  }

  /** The folder a bot works in right now, created (0700) when missing. */
  resolve(botId: string): string {
    const set = this.o.store.bots.get(botId)?.workDir;
    const c = set ? this.check(botId, set) : undefined;
    const dir = c?.ok ? c.path : this.fallback(botId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return realish(dir);
  }
}

/**
 * A path a tool names, confined to `root` (P13 file tools): relative paths
 * are taken from the root, `..` and symlinks that lead outside are refused.
 */
export function confine(root: string, p: string, home = homedir()): string {
  if (typeof p !== "string" || p === "" || p.includes("\0")) throw new Error("需要一個檔案路徑");
  // Mac test 2026-11-04b A9: `~/x` was taken as `<work>/~/x` (a folder named `~`). It is the
  // home folder, so it is outside, and said so with where it points.
  const e = p === "~" || p.startsWith("~/") ? join(home, p.slice(2)) : p;
  const base = realish(root);
  const abs = realish(isAbsolute(e) ? resolve(e) : resolve(base, e));
  if (!isWithin(base, abs))
    throw new Error(
      `路徑在工作資料夾外面：${p}${e !== p ? `（就是 ${abs}）` : ""}。Alca 的檔案工具只讀寫工作資料夾裡的檔案；請用工作資料夾裡的路徑，或把 bot 的工作資料夾換到那裡`,
    );
  return abs;
}

/** Display a path relative to the work folder when it is inside. */
export function shown(root: string, abs: string): string {
  return isWithin(root, abs) ? relative(root, abs).split(sep).join("/") || "." : abs;
}
