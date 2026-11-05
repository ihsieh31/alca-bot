import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  base,
  isAssign,
  SKIP_WORDS,
  skipOptions,
  splitCommands,
  substitutions,
  WRAPPERS,
} from "@alca/policy";

/**
 * Mac test 2026-11-04b A9: under 自主 `printf 'hello\n' > /Users/me/x.txt`
 * wrote outside the work folder without a card — `editTargets` knew only
 * edit tools, and the shell floor thinks `printf` is harmless. These are the
 * places a command line writes to, read from its words (not run):
 *
 * - redirections `>`, `>>`, `&>`, `>|`, `2>` (not `2>&1`, not /dev/null);
 * - `tee` files, the destination of `cp` / `mv` / `install` / `ln` / `rsync`
 *   / `scp` (last operand, or `-t DIR`), every operand of `touch`, `mkdir`,
 *   `truncate`, `rm`, `rmdir`, `unlink`, `chmod`, `chown`, `sed -i`;
 *   `dd of=`, `curl -o` / `--output`, `wget -O` / `--output-document`;
 * - `cd DIR` earlier in the line moves where relative paths point.
 *
 * `~`, `$HOME` and `${HOME}` are expanded. A target built from any other
 * variable, a substitution or a glob cannot be known, nor can a relative
 * path after `cd -` or `cd $X`: those come back with `unknown`, and the
 * caller treats them as outside (asking more, never less).
 */
export interface ShellTarget {
  /** Absolute path, or the word as written when `unknown`. */
  path: string;
  unknown?: boolean;
  /** Phase 5: an operand of a file deleter (`rm`, `rmdir`, `unlink`, `shred`), not a write. */
  deletes?: boolean;
}

const DELETERS = new Set(["rm", "rmdir", "unlink", "shred"]);

const DEV_OK = /^\/dev\/(null|stdout|stderr|tty|fd\/\d+)$/;
const REDIRECT = /^(\d*|&)(>>?\|?|>\|)(.*)$/;
const LAST_OPERAND = new Set(["cp", "mv", "install", "ln", "rsync", "scp", "gcp", "gmv"]);
const EVERY_OPERAND = new Set(["touch", "mkdir", "truncate", "rm", "rmdir", "unlink", "shred"]);
const AFTER_FIRST = new Set(["chmod", "chown", "chgrp"]);
/** Options of these programs that take a value (so the value is not an operand). */
const VALUED: Readonly<Record<string, string>> = {
  cp: "tS",
  mv: "tS",
  install: "mogtSBC",
  ln: "tS",
  rsync: "efT",
  scp: "cFiJloPS",
  truncate: "srR",
  mkdir: "m",
  touch: "drt",
  tee: "",
  chmod: "",
  chown: "",
  chgrp: "",
  sed: "eflsS",
};

export function expandHomeWord(w: string, home = homedir()): string {
  if (w === "~") return home;
  if (w.startsWith("~/")) return join(home, w.slice(2));
  return w.replace(/^\$(?:\{HOME\}|HOME)(?=\/|$)/, home);
}

/** Words that name a path we cannot know without running the line. */
const opaque = (w: string) => /[$`*?[]/.test(w) || /^~[^/]/.test(w);

export function shellWriteTargets(command: string, cwd: string, home = homedir()): ShellTarget[] {
  const out: ShellTarget[] = [];
  let dir: string | undefined = cwd;
  const add = (raw: string, deletes = false) => {
    if (!raw || DEV_OK.test(raw) || /^&?\d+$/.test(raw) || raw === "-") return;
    const e = expandHomeWord(raw, home);
    const d = deletes ? { deletes: true } : {};
    if (opaque(e)) return void out.push({ path: raw, unknown: true, ...d });
    if (isAbsolute(e)) return void out.push({ path: resolve(e), ...d });
    if (dir === undefined) return void out.push({ path: raw, unknown: true, ...d });
    out.push({ path: resolve(dir, e), ...d });
  };
  const lines = [splitCommands(command), ...substitutions(command).map((s) => splitCommands(s))];
  for (const cmds of lines) {
    dir = cwd;
    for (let c = 0; c < cmds.length; c++) {
      const words = cmds[c] as string[];
      // Redirections anywhere in the command (`>` alone takes the next word, or the next command's
      // first word when the splitter cut `>|` at the bar).
      const rest: string[] = [];
      for (let i = 0; i < words.length; i++) {
        const word = words[i] as string;
        // `a>>~/x` stays one word in the splitter: the redirection starts at the first `>`
        // (with its fd digits or `&`). Inside quotes this over-reads, which only asks more.
        let j = word.indexOf(">");
        if (j < 0 || word.startsWith("<")) {
          rest.push(word);
          continue;
        }
        while (j > 0 && /[\d&]/.test(word[j - 1] as string)) j--;
        if (j > 0) rest.push(word.slice(0, j));
        const m = REDIRECT.exec(word.slice(j));
        if (!m) continue;
        const after = m[3] ?? "";
        if (after.startsWith("&")) continue; // 2>&1, >&2
        const last = i === words.length - 1;
        const target = after || (last ? cmds[c + 1]?.[0] : words[i + 1]);
        if (!after) i++;
        if (target !== undefined) add(target);
        else out.push({ path: word, unknown: true });
      }
      operands(rest, add, (to) => {
        if (to === undefined) dir = home;
        else {
          const e = expandHomeWord(to, home);
          dir = opaque(e) || to === "-" ? undefined : isAbsolute(e) ? resolve(e) : dir && resolve(dir, e);
        }
      });
      if (out.length >= 50) return out;
    }
  }
  return out;
}

/** Program-specific write targets of one simple command (redirections already taken out). */
function operands(
  words: string[],
  add: (p: string, deletes?: boolean) => void,
  cd: (to: string | undefined) => void,
): void {
  let i = 0;
  while (i < words.length && (isAssign(words[i] as string) || SKIP_WORDS.has(words[i] as string))) i++;
  for (let guard = 0; guard < 8 && i < words.length; guard++) {
    const p = base(words[i] as string);
    if (p === "env") {
      i = skipOptions(words, i + 1, "uSC", ["unset", "chdir", "split-string"]);
      while (i < words.length && isAssign(words[i] as string)) i++;
      continue;
    }
    const wrap = WRAPPERS[p];
    if (!wrap) break;
    i = skipOptions(words, i + 1, wrap.withArg, wrap.long, wrap.positional);
  }
  const prog = words[i] ? base(words[i] as string) : "";
  const args = words.slice(i + 1);
  if (prog === "cd" || prog === "pushd") {
    cd(args.find((a) => !a.startsWith("-")));
    return;
  }
  const valued = VALUED[prog] ?? "";
  const ops: string[] = [];
  let targetDir: string | undefined;
  for (let k = 0; k < args.length; k++) {
    const a = args[k] as string;
    if (a === "--") {
      ops.push(...args.slice(k + 1));
      break;
    }
    if (a.startsWith("--")) {
      const [name, val] = a.includes("=")
        ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)]
        : [a, undefined];
      if (name === "--target-directory") targetDir = val ?? args[++k];
      else if ((prog === "curl" && name === "--output") || (prog === "wget" && name === "--output-document"))
        add(val ?? (args[++k] as string) ?? "");
      continue;
    }
    if (a.startsWith("-") && a.length > 1) {
      const letters = a.slice(1);
      if ((prog === "curl" && letters === "o") || (prog === "wget" && letters === "O")) {
        add((args[++k] as string) ?? "");
        continue;
      }
      if (prog === "curl" && letters.startsWith("o") && letters.length > 1) {
        add(letters.slice(1));
        continue;
      }
      const at = [...letters].findIndex((l) => valued.includes(l));
      if (at >= 0) {
        if (letters[at] === "t" && LAST_OPERAND.has(prog))
          targetDir = at === letters.length - 1 ? args[++k] : letters.slice(at + 1);
        else if (at === letters.length - 1) k++;
      }
      continue;
    }
    if (prog === "dd" && a.startsWith("of=")) add(a.slice(3));
    ops.push(a);
  }
  if (targetDir !== undefined) add(targetDir);
  else if (LAST_OPERAND.has(prog) && ops.length >= 2) add(ops.at(-1) as string);
  else if (EVERY_OPERAND.has(prog) || prog === "tee") for (const o of ops) add(o, DELETERS.has(prog));
  else if (AFTER_FIRST.has(prog)) for (const o of ops.slice(1)) add(o);
  else if (prog === "sed" && args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith("--in-place")))
    for (const o of ops.slice(args.some((a) => a === "-e" || a.startsWith("--expression")) ? 0 : 1)) add(o);
}

/** Absolute paths a command line names that are outside `dir` (for the card's wording; nothing is denied). */
export function shellMentionsOutside(
  command: string,
  within: (p: string) => boolean,
  home = homedir(),
): string[] {
  const seen = new Set<string>();
  for (const cmd of splitCommands(command))
    for (const w of cmd) {
      const word = w.replace(/^\d*[<>]+&?/, "").replace(/^[A-Za-z_]+=/, "");
      if (!/^(~\/|~$|\/|\$\{?HOME\}?\/)/.test(word) || DEV_OK.test(word)) continue;
      const e = expandHomeWord(word, home);
      if (opaque(e)) continue;
      const p = resolve(e);
      if (!within(p)) seen.add(word);
      if (seen.size >= 5) break;
    }
  return [...seen];
}
