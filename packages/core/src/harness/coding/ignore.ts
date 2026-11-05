import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * Plan §4: the built-in file walk grep / glob fall back to when ripgrep is
 * not installed. It honours `.gitignore` files the way ripgrep does for the
 * common cases — one per folder, read as the walk enters it, deeper files
 * after shallower ones, the last matching line wins, `!` re-includes, a
 * trailing `/` matches folders only, a pattern with a `/` in it is anchored
 * to its file's folder, `**` spans folders — plus `.git/info/exclude`. `.git`
 * itself is never walked. Not covered: global excludes and `.ignore` files.
 */

interface Rule {
  re: RegExp;
  negate: boolean;
  dirOnly: boolean;
  /** Folder of the .gitignore, relative to the walk root ("" = root). */
  base: string;
}

const escapeChar = (c: string) => (/[.+^$()|\]\\]/.test(c) ? `\\${c}` : c);

/** A glob (gitignore / ripgrep `--glob` flavour) as a regex over a `/`-separated path. */
export function globToRegex(glob: string, anchored: boolean): RegExp {
  const g = glob;
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i] as string;
    if (c === "*") {
      if (g[i + 1] === "*") {
        const slashBefore = i === 0 || g[i - 1] === "/";
        const slashAfter = g[i + 2] === "/" || i + 2 === g.length;
        if (slashBefore && slashAfter) {
          re += g[i + 2] === "/" ? "(?:.*/)?" : ".*";
          i += g[i + 2] === "/" ? 2 : 1;
          continue;
        }
        i++;
      }
      re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "[") {
      const end = g.indexOf("]", i + 1);
      if (end < 0) re += "\\[";
      else {
        let body = g.slice(i + 1, end);
        if (body.startsWith("!")) body = `^${body.slice(1)}`;
        re += `[${body.replace(/\\/g, "\\\\")}]`;
        i = end;
      }
    } else if (c === "{") {
      const end = g.indexOf("}", i + 1);
      if (end < 0) re += "\\{";
      else {
        const alts = g
          .slice(i + 1, end)
          .split(",")
          .map((p) => [...p].map((x) => (x === "*" ? "[^/]*" : escapeChar(x))).join(""));
        re += `(?:${alts.join("|")})`;
        i = end;
      }
    } else if (c === "\\" && i + 1 < g.length) re += `\\${g[++i]}`;
    else re += escapeChar(c);
  }
  return new RegExp(anchored ? `^${re}$` : `(?:^|/)${re}$`);
}

export function parseIgnore(text: string, base: string): Rule[] {
  const rules: Rule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.replace(/(?<!\\)\s+$/, "");
    if (!line || line.startsWith("#")) continue;
    let negate = false;
    if (line.startsWith("!")) {
      negate = true;
      line = line.slice(1);
    } else if (line.startsWith("\\!") || line.startsWith("\\#")) line = line.slice(1);
    let dirOnly = false;
    if (line.endsWith("/")) {
      dirOnly = true;
      line = line.slice(0, -1);
    }
    if (!line) continue;
    const anchored = line.includes("/");
    if (line.startsWith("/")) line = line.slice(1);
    rules.push({ re: globToRegex(line, anchored), negate, dirOnly, base });
  }
  return rules;
}

/** The ignore rules in force for one folder of the walk (its parents' plus its own). */
export class IgnoreStack {
  private readonly rules: Rule[];
  constructor(rules: Rule[] = []) {
    this.rules = rules;
  }

  /** The stack for a folder: this one plus that folder's `.gitignore`. */
  enter(root: string, dir: string): IgnoreStack {
    let text: string;
    try {
      text = readFileSync(join(dir, ".gitignore"), "utf8");
    } catch {
      return this;
    }
    const base = relative(root, dir).split(sep).join("/");
    return new IgnoreStack([...this.rules, ...parseIgnore(text, base)]);
  }

  /** Whether a path (relative to the walk root, `/`-separated) is ignored. */
  ignored(rel: string, isDir: boolean): boolean {
    let out = false;
    for (const r of this.rules) {
      if (r.dirOnly && !isDir) continue;
      let p = rel;
      if (r.base) {
        if (!rel.startsWith(`${r.base}/`)) continue;
        p = rel.slice(r.base.length + 1);
      }
      if (r.re.test(p)) out = !r.negate;
    }
    return out;
  }
}

/**
 * Every file under `start` that the ignore rules keep, as absolute paths;
 * `root` is where the rules begin (the repository root, or the work folder).
 */
export function walkFiles(
  root: string,
  start: string,
  maxFiles = 50_000,
): { files: string[]; capped: boolean } {
  let stack = new IgnoreStack();
  try {
    stack = new IgnoreStack(parseIgnore(readFileSync(join(root, ".git", "info", "exclude"), "utf8"), ""));
  } catch {
    // no exclude file
  }
  stack = stack.enter(root, root);
  const relStart = relative(root, start);
  let at = root;
  for (const part of relStart ? relStart.split(sep) : []) {
    at = join(at, part);
    stack = stack.enter(root, at);
  }
  const files: string[] = [];
  let capped = false;
  const walk = (dir: string, rules: IgnoreStack) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of entries) {
      if (capped) return;
      if (e.name === ".git") continue;
      const p = join(dir, e.name);
      const rel = relative(root, p).split(sep).join("/");
      const isDir = e.isDirectory();
      if (rules.ignored(rel, isDir)) continue;
      if (isDir) walk(p, rules.enter(root, p));
      else if (e.isFile()) {
        files.push(p);
        if (files.length >= maxFiles) capped = true;
      }
    }
  };
  walk(start, stack);
  return { files, capped };
}
