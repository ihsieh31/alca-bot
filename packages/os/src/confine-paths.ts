import { existsSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

/**
 * Next-round §5.2: the path lists the OS sandbox and the string guards share,
 * so the two layers can never drift apart.
 */

/** What is in Alca's data folder besides the bots' own folders (desktop data-dir.ts and friends). */
export const DATA_ENTRIES: readonly string[] = Object.freeze([
  "secrets.json",
  "secrets.json.bak",
  "vault.json",
  "vault.json.bak",
  "vault.key",
  "*.corrupt-*",
  "*.reset-*",
  "config.json",
  "rules.json",
  "link.json",
  "telegram.json",
  "state.sqlite*",
  "core.pid",
  "audit.anchor",
  "backups/**",
  "logs/**",
  "browser/**",
  "engines/**",
]);

/**
 * Engine and tool configuration a write inside the work folder could plant
 * (allow rules, hooks, MCP servers): asked at every level by the guards
 * (protect.ts), and not writable inside the OS sandbox.
 */
export const PROTECTED_CONFIG_MARKS: readonly string[] = Object.freeze([
  ".claude",
  ".codex",
  ".gemini",
  ".opencode",
  ".qwen",
  ".cursor",
  ".continue",
  ".goose",
  ".mcp.json",
  ".envrc",
  ".git/hooks",
  ".git/config",
  ".husky",
  ".npmrc",
]);

/** Secrets in the home folder no sandboxed command may read (relative to home). */
export const HOME_SECRETS: readonly string[] = Object.freeze([
  ".ssh",
  ".aws",
  ".gnupg",
  ".config/gh",
  ".netrc",
  ".git-credentials",
  ".config/git/credentials",
  ".docker/config.json",
  ".kube",
  ".claude/.credentials.json",
  ".codex/auth.json",
  "Library/Keychains",
]);

/**
 * Content-addressed package caches a build writes (low risk, high breakage
 * when read-only). Never shell rc files, `~/.gitconfig`, `~/.ssh` or a PATH folder.
 */
export const DEFAULT_WRITABLE_CACHES: readonly string[] = Object.freeze([
  ".npm",
  "Library/Caches/pnpm",
  ".local/share/pnpm/store",
  ".cache/pnpm",
  "Library/Caches/Yarn",
  ".cache/yarn",
  ".cache/pip",
  "Library/Caches/pip",
  ".cargo/registry",
  "go/pkg/mod",
]);

/** One spelling per path (macOS /var is /private/var); a missing path resolves its nearest parent. */
export function realOrResolved(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    const parent = dirname(abs);
    if (parent === abs) return abs;
    return join(realOrResolved(parent), abs.slice(parent.length).replace(/^[\\/]+/, ""));
  }
}

/** `child` is `parent` or inside it. */
export function within(parent: string, child: string): boolean {
  const r = relative(parent, child);
  if (r === "") return true;
  if (r === ".." || r.startsWith(`..${sep}`)) return false;
  return !r.startsWith(sep) && !/^[A-Za-z]:/.test(r);
}

/**
 * Everything under `dataDir` a sandboxed command may not read, as real
 * paths: each entry beside the way down to a `keep` path (the bot's work
 * folder, its temp folder), so those stay reachable and nothing else does.
 * Entries that do not exist yet are named from DATA_ENTRIES (literal names
 * only) so a later `secrets.json.bak` is covered too where the platform can
 * deny a missing path (Seatbelt); `existing` filters for bubblewrap.
 */
export function dataDenyRead(dataDir: string, keep: readonly string[]): string[] {
  const data = realOrResolved(dataDir);
  const keeps = keep.map(realOrResolved);
  const out = new Set<string>();
  const walk = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      const p = join(dir, n);
      const onTheWay = keeps.filter((k) => within(p, k));
      if (!onTheWay.length) out.add(p);
      else if (!onTheWay.some((k) => k === p)) walk(p);
    }
  };
  if (keeps.some((k) => within(data, k))) walk(data);
  else out.add(data);
  for (const e of DATA_ENTRIES) {
    const lit = e.replace(/\/\*\*$/, "");
    if (/[*?]/.test(lit)) continue;
    const p = join(data, lit);
    if (!keeps.some((k) => within(p, k))) out.add(p);
  }
  return [...out].sort();
}

/** The home-folder secrets as real paths (missing ones too; `existing` filters). */
export function homeDenyRead(home = homedir()): string[] {
  return HOME_SECRETS.map((s) => realOrResolved(join(home, s)));
}

/** The protected configuration paths inside a work folder (missing ones too). */
export function configDenyWrite(workDir: string): string[] {
  const w = realOrResolved(workDir);
  return PROTECTED_CONFIG_MARKS.map((m) => join(w, ...m.split("/")));
}

/** The default package caches as real paths (only those that exist: a sandbox cannot create them). */
export function defaultWritableCaches(home = homedir()): string[] {
  return DEFAULT_WRITABLE_CACHES.map((c) => join(home, c))
    .filter((p) => existsSync(p))
    .map(realOrResolved);
}

export const existing = (paths: readonly string[]): string[] => paths.filter((p) => existsSync(p));
