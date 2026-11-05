import type { ActionClass } from "./rules.ts";

/**
 * Shell command classification (escalation floor only, see classify.ts).
 *
 * Mac test 2026-11-04: `/\bgit\s+push\b/` missed `git -C <dir> push` (what a
 * model actually ran), `git -c k=v push`, and `/(^|\s)rm\s/` missed `/bin/rm`.
 * Commands are now split into simple commands (`;` `&&` `||` `|` `&`,
 * newlines, subshells, `$(…)` and backticks), quotes and backslashes are
 * undone, leading `VAR=…` and wrappers (env, command, sudo, doas, nohup, time,
 * nice, timeout, xargs, exec, …) are skipped, `sh -c '…'` / `eval` / `env -S`
 * scripts and `find -exec` commands are classified recursively, and the
 * program is matched by its base name (`/usr/bin/git` is git). Git's global
 * options (-C, -c, --git-dir, --work-tree, …) and `-c alias.x=push` are
 * understood. The old whole-text patterns still run afterwards, so this only
 * ever finds more, never less.
 */

/** Highest first: when one command line does several things, the strictest class wins. */
const ORDER: readonly ActionClass[] = ["payment", "send", "publish", "delete"];
const MAX_DEPTH = 6;

/**
 * `$(( … ))` holding only digits, operators and special parameters
 * (`$(( $? + 1 ))`, mac test 2026-11-04b A4): the index of its last `)`, else
 * -1. Anything with a name, a quote, an escape or a nested substitution in it
 * is not "pure" and is read as a command line (which asks).
 */
export function pureArithmeticEnd(text: string, dollar: number): number {
  if (!text.startsWith("$((", dollar)) return -1;
  let depth = 0;
  for (let j = dollar + 1; j < text.length; j++) {
    if (text[j] === "(") depth++;
    else if (text[j] === ")" && --depth === 0) {
      const inner = text.slice(dollar + 2, j);
      if (!inner.endsWith(")")) return -1;
      return /[A-Za-z_`'"\\$]/.test(inner.replace(/\$[?#$!@*0-9-]/g, "")) ? -1 : j;
    }
  }
  return -1;
}

/** Split into simple commands, outside quotes; a token list per command (quotes and escapes undone). */
export function splitCommands(text: string): string[][] {
  const out: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: "'" | '"' | null = null;
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endCmd = () => {
    endWord();
    if (words.length) out.push(words);
    words = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (quote === "'") {
      if (c === "'") quote = null;
      else word += c;
      continue;
    }
    if (c === "\\") {
      const n = text[i + 1];
      i++;
      if (n === "\n" || n === undefined) continue; // line continuation
      word += n;
      inWord = true;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
      continue;
    }
    if (c === " " || c === "\t") {
      endWord();
      continue;
    }
    // `2>&1`, `&>file`, `>&2` are redirections, not a background `&`.
    if (c === "&" && (word.endsWith(">") || word.endsWith("<") || text[i + 1] === ">")) {
      word += c;
      inWord = true;
      continue;
    }
    if (
      c === ";" ||
      c === "&" ||
      c === "|" ||
      c === "\n" ||
      c === "\r" ||
      c === "(" ||
      c === ")" ||
      c === "`"
    ) {
      const pure = c === "(" && word.endsWith("$") ? pureArithmeticEnd(text, i - 1) : -1;
      if (pure > 0) {
        word += text.slice(i, pure + 1);
        inWord = true;
        i = pure;
        continue;
      }
      if (c === "(" && word.endsWith("$")) {
        word = word.slice(0, -1);
        if (!word) inWord = false;
      }
      endCmd();
      continue;
    }
    word += c;
    inWord = true;
  }
  endCmd();
  return out;
}

/** `$(…)` and backtick bodies anywhere (even inside double quotes), for a second look. */
export function substitutions(text: string): string[] {
  const out: string[] = [];
  for (let i = text.indexOf("$("); i >= 0; i = text.indexOf("$(", i + 2)) {
    let depth = 0;
    for (let j = i + 1; j < text.length; j++) {
      if (text[j] === "(") depth++;
      else if (text[j] === ")" && --depth === 0) {
        if (pureArithmeticEnd(text, i) < 0) out.push(text.slice(i + 2, j));
        break;
      }
    }
  }
  for (const m of text.matchAll(/`([^`]*)`/g)) out.push(m[1] as string);
  return out;
}

export const base = (w: string): string => {
  const b = w.slice(w.lastIndexOf("/") + 1);
  return b.toLowerCase().replace(/\.exe$/, "");
};
export const isAssign = (w: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w);
export const isRedirect = (w: string) => /^\d*(>>?|<<?<?|&>>?|>&|<&)/.test(w);
export const SKIP_WORDS = new Set([
  "!",
  "{",
  "}",
  "if",
  "then",
  "else",
  "elif",
  "do",
  "while",
  "until",
  "fi",
  "done",
]);

/** Wrappers that run the rest of the line as a command: option letters that take a value. */
export const WRAPPERS: Readonly<Record<string, { withArg: string; long?: string[]; positional?: number }>> = {
  sudo: {
    withArg: "ughpCUrtTDR",
    long: [
      "user",
      "group",
      "host",
      "prompt",
      "close-from",
      "other-user",
      "role",
      "type",
      "command-timeout",
      "chdir",
    ],
  },
  doas: { withArg: "uC" },
  command: { withArg: "" },
  builtin: { withArg: "" },
  exec: { withArg: "a" },
  nohup: { withArg: "" },
  time: { withArg: "fo" },
  nice: { withArg: "n", long: ["adjustment"] },
  ionice: { withArg: "cnp" },
  timeout: { withArg: "sk", long: ["signal", "kill-after"], positional: 1 },
  stdbuf: { withArg: "ioe" },
  xargs: {
    withArg: "adEeIiLlnPs",
    long: ["arg-file", "delimiter", "max-args", "max-procs", "max-chars", "max-lines", "process-slot-var"],
  },
  setsid: { withArg: "" },
  caffeinate: { withArg: "tw" },
  chronic: { withArg: "" },
  unbuffer: { withArg: "" },
  flock: { withArg: "wEc", positional: 1 },
  watch: { withArg: "nd" },
  arch: { withArg: "" },
  "run-one": { withArg: "" },
};

/** Skip a wrapper's own options (and fixed positionals), return the index of the wrapped command. */
export function skipOptions(
  args: string[],
  i: number,
  withArg: string,
  long: string[] = [],
  positional = 0,
): number {
  while (i < args.length) {
    const a = args[i] as string;
    if (a === "--") return i + 1 + positional;
    if (!a.startsWith("-") || a === "-") break;
    if (a.startsWith("--")) {
      i += !a.includes("=") && long.includes(a.slice(2)) ? 2 : 1;
      continue;
    }
    const letters = a.slice(1);
    // `-u root` takes the next word; `-uroot` carries it; a letter that takes a value ends the cluster.
    const k = [...letters].findIndex((l) => withArg.includes(l));
    i += k >= 0 && k === letters.length - 1 ? 2 : 1;
  }
  return i + positional;
}

const GIT_WITH_ARG = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--super-prefix",
  "--config-env",
]);

function classifyGit(args: string[], depth: number): ActionClass | undefined {
  const aliases = new Map<string, string>();
  let i = 0;
  while (i < args.length) {
    const a = args[i] as string;
    if (!a.startsWith("-")) break;
    const value = GIT_WITH_ARG.has(a) ? args[i + 1] : undefined;
    const kv = a === "-c" ? value : a.startsWith("-c") && a.length > 2 ? a.slice(2) : undefined;
    const m = kv ? /^alias\.([^=]+)=(.*)$/s.exec(kv) : null;
    if (m) aliases.set((m[1] as string).toLowerCase(), m[2] as string);
    i += GIT_WITH_ARG.has(a) ? 2 : 1;
  }
  const sub = args[i]?.toLowerCase();
  if (!sub) return undefined;
  const rest = args.slice(i + 1);
  const alias = aliases.get(sub);
  if (alias !== undefined) {
    if (alias.startsWith("!")) return classifyShell(alias.slice(1), depth + 1);
    return classifyGit([...(splitCommands(alias)[0] ?? []), ...rest], depth + 1);
  }
  if (sub === "push") return "publish";
  if (sub === "send-email" || sub === "imap-send") return "send";
  if (sub === "clean" || sub === "rm") return "delete";
  if (sub === "reset" && rest.includes("--hard")) return "delete";
  if (sub === "branch" && rest.some((r) => /^-[a-zA-Z]*D/.test(r) || r === "--delete"))
    return rest.some((r) => /^-[a-zA-Z]*D/.test(r) || r === "--force" || /^-[a-zA-Z]*f/.test(r))
      ? "delete"
      : undefined;
  if (sub === "stash" && (rest[0] === "drop" || rest[0] === "clear")) return "delete";
  return undefined;
}

/** `scp a host:b`, `rsync a host:b`: a file leaves this computer. */
const remoteCopy = (args: string[]): ActionClass | undefined =>
  args.some((a) => !a.startsWith("-") && /^[^/\s]*[^/\s\\]:/.test(a) && !/^[A-Za-z]:\\/.test(a))
    ? "send"
    : undefined;

const firstPlain = (args: string[]) => args.find((a) => !a.startsWith("-"))?.toLowerCase();

function classifyProgram(name: string, args: string[], depth: number): ActionClass | undefined {
  const line = args.join(" ");
  switch (name) {
    case "rm":
    case "rmdir":
    case "shred":
    case "unlink":
    case "srm":
    case "trash":
    case "trash-put":
    case "rimraf":
      return "delete";
    case "git":
    case "hub":
      return classifyGit(args, depth);
    case "truncate":
    case "dropdb":
      return "delete";
    case "rsync":
      return args.some((a) => /^--(delete|remove-source-files)/.test(a)) ? "delete" : remoteCopy(args);
    case "scp":
    case "sftp":
      return remoteCopy(args);
    case "ssh":
    case "mosh": {
      // `ssh host 'cmd'`: whatever the remote command is, at least what it reads as here.
      const k = skipOptions(args, 0, "bcDEeFIiJLlmOopQRSWw");
      const remote = args.slice(k + 1).join(" ");
      return remote ? classifyShell(remote, depth + 1) : undefined;
    }
    case "kubectl":
    case "oc": {
      const sub = firstPlain(args);
      if (sub === "delete" || sub === "drain") return "delete";
      return ["apply", "create", "replace", "patch", "rollout", "scale", "set", "edit"].includes(sub ?? "")
        ? "publish"
        : undefined;
    }
    case "helm": {
      const sub = firstPlain(args);
      if (sub === "uninstall" || sub === "delete") return "delete";
      return ["install", "upgrade", "push", "rollback"].includes(sub ?? "") ? "publish" : undefined;
    }
    case "terraform":
    case "tofu":
    case "pulumi": {
      const sub = firstPlain(args);
      if (sub === "destroy") return "delete";
      return sub === "apply" || sub === "up" || sub === "import" ? "publish" : undefined;
    }
    case "aws":
    case "gcloud":
    case "gsutil":
    case "az":
    case "doctl": {
      const plain = args.filter((a) => !a.startsWith("-"));
      if (plain.some((a) => /^(rm|delete|remove|destroy|terminate-instances|delete-\w+|rb)$/.test(a)))
        return "delete";
      if (
        plain.some((a) => /^(cp|mv|sync|put-object|deploy|publish|send-email|send-raw-email|invoke)$/.test(a))
      )
        return "publish";
      return undefined;
    }
    case "cargo":
    case "poetry":
    case "flit":
    case "hatch":
    case "dotnet":
    case "gradle":
    case "gradlew":
      return args.some((a) => a === "publish" || a === "upload") ||
        (name === "dotnet" && args[0] === "nuget" && args[1] === "push")
        ? "publish"
        : undefined;
    case "twine":
      return firstPlain(args) === "upload" ? "publish" : undefined;
    case "gem":
      return firstPlain(args) === "push" ? "publish" : undefined;
    case "mvn":
      return args.includes("deploy") ? "publish" : undefined;
    case "python":
    case "python3":
    case "py": {
      // `python -m twine upload`, `python -m pip …`: the module's own command line.
      const m = args.indexOf("-m");
      return m >= 0 && args[m + 1]
        ? classifyProgram(base(args[m + 1] as string), args.slice(m + 2), depth + 1)
        : undefined;
    }
    case "osascript":
      return /\bsend\b|\bmessages?\b|\bmail\b/i.test(line) ? "send" : undefined;
    case "http":
    case "https":
    case "xh":
    case "xhs":
      // HTTPie: an explicit method, or request items (key=value, key:=json, key@file) send data.
      return /^(POST|PUT|PATCH|DELETE)$/i.test(args.find((a) => !a.startsWith("-")) ?? "") ||
        args.some((a, k) => k > 0 && /^[^-=:@/][^=:@\s]*(=|:=|@|=@|:=@)/.test(a) && !/^https?:/.test(a))
        ? "send"
        : undefined;
    case "nc":
    case "ncat":
    case "netcat":
    case "socat":
    case "telnet":
      return "send";
    case "npm":
    case "pnpm":
    case "yarn":
    case "bun":
      return args.includes("publish") || (args.includes("dist-tag") && args.includes("add"))
        ? "publish"
        : undefined;
    case "gh": {
      const plain = args.filter(
        (x, k) => !x.startsWith("-") && !["-R", "--repo"].includes(args[k - 1] ?? ""),
      );
      const [a, b] = plain;
      if ((a === "issue" || a === "pr") && b === "comment") return "send";
      if (["release", "pr", "issue", "repo", "gist"].includes(a ?? "") && b === "create") return "publish";
      if (a === "pr" && b === "merge") return "publish";
      if (
        a === "api" &&
        /(^|\s)(-X|--method)\s*(POST|PUT|PATCH|DELETE)\b|(^|\s)(-f|-F|--field|--raw-field|--input)\b/i.test(
          line,
        )
      )
        return "send";
      return undefined;
    }
    case "docker":
    case "podman": {
      const sub = firstPlain(args);
      if (sub === "push") return "publish";
      if (["rm", "rmi", "prune"].includes(sub ?? "") || args.includes("prune")) return "delete";
      return undefined;
    }
    case "wrangler":
      return ["deploy", "publish"].includes(firstPlain(args) ?? "") ? "publish" : undefined;
    case "vercel":
    case "netlify":
      return args.includes("--prod") || args.includes("--production") ? "publish" : undefined;
    case "firebase":
    case "fly":
    case "flyctl":
      return firstPlain(args) === "deploy" ? "publish" : undefined;
    case "sendmail":
    case "mail":
    case "mailx":
    case "mutt":
    case "msmtp":
      return "send";
    case "curl":
      return /(^|\s)(-X|--request)\s*(POST|PUT|PATCH|DELETE)\b/i.test(line) ||
        // A GET can carry data too: a URL built from a command or a variable, or a file it reads.
        args.some((a) => /\$|`/.test(a)) ||
        args.some(
          (a) =>
            /^(-d|--data(-\w+)?|-F|--form(-string)?|-T|--upload-file|--json)(=|$)/.test(a) ||
            /^-[a-zA-Z]*[dFT]$/.test(a),
        )
        ? "send"
        : undefined;
    case "wget":
      return args.some((a) => /^--(post-data|post-file|method|body-data|body-file)(=|$)/.test(a))
        ? "send"
        : undefined;
    case "stripe":
      return /\b(charges?|payments?|payouts?|payment_intents?)\b/i.test(line) ? "payment" : undefined;
    case "find": {
      if (args.includes("-delete")) return "delete";
      const x = args.findIndex((a) => ["-exec", "-execdir", "-ok", "-okdir"].includes(a));
      if (x < 0) return undefined;
      const end = args.findIndex((a, k) => k > x && (a === ";" || a === "+"));
      return classifyWords(args.slice(x + 1, end < 0 ? undefined : end), depth + 1);
    }
    default:
      return undefined;
  }
}

/** A `>` / `>|` / `N>` redirection into a file (not `>>`, not `>&N`, not /dev/null). */
function truncates(words: string[]): boolean {
  for (let k = 0; k < words.length; k++) {
    const m = /^\d*>\|?(.*)$/.exec(words[k] as string);
    if (!m || (words[k] as string).includes(">>") || /^\d*>&/.test(words[k] as string)) continue;
    const target = m[1] || words[k + 1] || "";
    if (target && !/^\/dev\/(null|stdout|stderr|tty)$/.test(target)) return true;
  }
  return false;
}

/** One simple command (already split and unquoted). */
export function classifyWords(words: string[], depth = 0): ActionClass | undefined {
  if (depth > MAX_DEPTH) return undefined;
  let i = 0;
  for (;;) {
    while (i < words.length && (isAssign(words[i] as string) || SKIP_WORDS.has(words[i] as string))) i++;
    // A redirection before the command (`>out rm x`, `2> /dev/null rm x`).
    while (i < words.length && isRedirect(words[i] as string)) i += /[<>&]$/.test(words[i] as string) ? 2 : 1;
    const w = words[i];
    if (w === undefined) return truncates(words) ? "delete" : undefined;
    const name = base(w);
    // `: > notes.md`, `true > f`, `cat /dev/null > f`: the idioms that empty a file.
    if ((name === ":" || name === "true" || name === "false") && truncates(words)) return "delete";
    if (name === "cat" && words.includes("/dev/null") && truncates(words)) return "delete";
    const args: string[] = [];
    for (let k = i + 1; k < words.length; k++) {
      const a = words[k] as string;
      if (!isRedirect(a)) args.push(a);
      else if (/[<>&]$/.test(a)) k++; // `> file`: the target is not an argument
    }
    if (name === "env") {
      // `env -S 'cmd args'` splits a string into a command line.
      const s = args.findIndex(
        (a) => a === "-S" || a === "--split-string" || a.startsWith("--split-string="),
      );
      if (s >= 0) {
        const a = args[s] as string;
        return classifyShell(a.includes("=") ? a.slice(a.indexOf("=") + 1) : (args[s + 1] ?? ""), depth + 1);
      }
      i = skipOptions(words, i + 1, "uCP", ["unset", "chdir"]);
      continue;
    }
    if (["sh", "bash", "zsh", "dash", "ksh", "mksh", "fish", "ash", "busybox"].includes(name)) {
      if (name === "busybox" && args[0] && args[0] !== "sh" && args[0] !== "ash") {
        i += 1;
        continue;
      }
      const from = name === "busybox" ? 1 : 0;
      const c = args.findIndex((a, k) => k >= from && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a));
      if (c < 0) return undefined; // runs a script file: plain execute
      const script = args.slice(c + 1).find((a) => !/^[-+][a-zA-Z]+$/.test(a));
      return script === undefined ? undefined : classifyShell(script, depth + 1);
    }
    if (name === "eval") return classifyShell(args.join(" "), depth + 1);
    const wrap = WRAPPERS[name];
    if (wrap) {
      i = skipOptions(words, i + 1, wrap.withArg, wrap.long, wrap.positional ?? 0);
      continue;
    }
    return classifyProgram(name, args, depth);
  }
}

const NET_CLIENTS = new Set(["curl", "wget", "http", "https", "xh", "nc", "ncat", "socat", "telnet"]);

const rank = (c: ActionClass | undefined) => (c ? ORDER.indexOf(c) : -1);

/** The strictest always-confirm class any part of a command line has, if any. */
export function classifyShell(text: string, depth = 0): ActionClass | undefined {
  if (depth > MAX_DEPTH || !text) return undefined;
  let best: ActionClass | undefined;
  const consider = (c: ActionClass | undefined) => {
    if (c && rank(c) >= 0 && (best === undefined || rank(c) < rank(best))) best = c;
  };
  const cmds = splitCommands(text);
  for (const words of cmds) consider(classifyWords(words, depth));
  const subs = substitutions(text);
  for (const sub of subs) consider(classifyShell(sub, depth + 1));
  // `curl "https://x/?k=$(cat secret)"`: the substitution splits the line, so the URL word
  // no longer shows the `$(`; a network client next to a substitution sends what it computes.
  if (subs.length && cmds.some((w) => NET_CLIENTS.has(base(w.find((x) => !isAssign(x)) ?? ""))))
    consider("send");
  return best;
}
