import {
  base,
  isAssign,
  isRedirect,
  SKIP_WORDS,
  skipOptions,
  splitCommands,
  substitutions,
  WRAPPERS,
} from "./shell.ts";

/**
 * Shell commands Alca can vouch for (review 2026-11-04b H1).
 *
 * The classifier (shell.ts) only finds what it recognizes: a payment, a send,
 * a publish or a delete. Under 自主 everything else used to run, so
 * `python3 -c "import os; os.remove('a')"`, `X=rm; $X -rf build`,
 * `mv notes.md /tmp`, `osascript -e …` or a GET that smuggles data in its URL
 * went through without a card. This is the other half of the floor:
 *
 *   a shell command runs without a person only when every simple command in
 *   it is a program on the known list, used in a way Alca can read.
 *
 * Anything else — an inline interpreter script (`-c`, `-e`, stdin), a program
 * named by a variable or a substitution, a network or remote tool, a package
 * runner that downloads and runs code (`npx`, `dlx`), `mv`, process killers,
 * cluster / cloud CLIs, a program not on the list — needs a person, at every
 * level, whatever the user's allow rules say (deny rules still deny). The
 * reason comes back as a sentence for the card.
 *
 * Deliberately allowed (ordinary development under 自主): running a script
 * FILE (`node x.js`, `python3 run.py`, `bash build.sh`, `./gradlew`,
 * `npm test`, `make`). A file the bot wrote can still do anything; only an OS
 * sandbox closes that (docs/SECURITY.md, "What the shell floor is not").
 */

/** Programs whose ordinary use only reads, builds, tests or edits files in place. */
// biome-ignore format: a word list reads better packed
const KNOWN = new Set([
  // files and text
  "ls", "ll", "la", "cat", "bat", "head", "tail", "less", "more", "wc", "nl", "sort", "uniq", "cut", "tr",
  "paste", "join", "column", "tee", "grep", "egrep", "fgrep", "rg", "ag", "ack", "fd", "find", "tree", "du",
  "df", "stat", "file", "which", "whereis", "type", "pwd", "cd", "pushd", "popd", "echo", "printf", "true",
  "false", "test", "[", "[[", "date", "cal", "sleep", "printenv", "uname", "hostname", "whoami", "id", "ps",
  "jq", "yq", "sed", "awk", "gawk", "mawk", "diff", "cmp", "comm", "patch", "md5sum", "md5", "sha1sum",
  "sha256sum", "shasum", "base64", "xxd", "hexdump", "od", "strings", "basename", "dirname", "realpath",
  "readlink", "mktemp", "mkdir", "touch", "cp", "ln", "chmod", "tar", "zip", "unzip", "gzip", "gunzip",
  "bzip2", "bunzip2", "xz", "unxz", "zcat", "seq", "expr", "bc", "shuf", "split", "fold", "fmt", "iconv",
  "nproc", "uptime", "clear", "man", "sw_vers", "locale", "tput", "cksum", "rev", "tac", "lsof", ":",
  // build and test
  "make", "gmake", "cmake", "ninja", "meson", "gcc", "g++", "cc", "c++", "clang", "clang++", "ld", "go",
  "cargo", "rustc", "rustfmt", "rustup", "swift", "swiftc", "javac", "java", "mvn", "gradle", "gradlew",
  "dotnet", "node", "nodejs", "deno", "bun", "tsc", "tsx", "ts-node", "npm", "pnpm", "yarn", "corepack",
  "vitest", "jest", "mocha", "playwright", "eslint", "prettier", "biome", "oxlint", "python", "python3", "py",
  "pip", "pip3", "uv", "poetry", "pytest", "ruff", "black", "mypy", "pyright", "ruby", "bundle", "rake",
  "rspec", "gem", "php", "composer", "perl", "git", "gh", "docker", "podman", "pandoc", "ffmpeg", "magick",
  "convert", "latexmk", "pdflatex", "xelatex", "wasm-pack", "protoc", "bash", "sh", "zsh", "dash",
]);

/** Interpreters: inline code flags, and whether a bare call (no file) reads code from stdin. */
const INTERPRETERS: Readonly<Record<string, { inline: RegExp; stdin: boolean }>> = {
  python: { inline: /^-[a-zA-Z]*c/, stdin: true },
  python3: { inline: /^-[a-zA-Z]*c/, stdin: true },
  py: { inline: /^-[a-zA-Z]*c/, stdin: true },
  node: { inline: /^(-e|-p|--eval|--print|-pe|-ep)(=|$)/, stdin: true },
  nodejs: { inline: /^(-e|-p|--eval|--print)(=|$)/, stdin: true },
  deno: { inline: /^eval$/, stdin: false },
  bun: { inline: /^(-e|--eval|-p|--print)(=|$)/, stdin: false },
  perl: { inline: /^-[a-zA-Z]*[eE]/, stdin: true },
  ruby: { inline: /^-[a-zA-Z]*e/, stdin: true },
  php: { inline: /^-[a-zA-Z]*r/, stdin: true },
  bash: { inline: /^-[a-zA-Z]*c/, stdin: true },
  sh: { inline: /^-[a-zA-Z]*c/, stdin: true },
  zsh: { inline: /^-[a-zA-Z]*c/, stdin: true },
  dash: { inline: /^-[a-zA-Z]*c/, stdin: true },
};

/** Sub-commands of known tools that hand control to something Alca cannot read. */
const RUNNERS: Readonly<Record<string, ReadonlySet<string>>> = {
  npm: new Set(["exec", "x"]),
  pnpm: new Set(["dlx", "exec"]),
  yarn: new Set(["dlx"]),
  bun: new Set(["x"]),
  uv: new Set(["tool"]),
  docker: new Set(["exec"]),
  podman: new Set(["exec"]),
  gh: new Set(["extension", "ext", "alias"]),
};

/** Why a well-known program that is not on the list needs a person (the card says this). */
const REASONS: ReadonlyArray<[RegExp, string]> = [
  [/^(curl|wget|http|https|xh|xhs|nc|ncat|netcat|socat|telnet|ftp|aria2c)$/, "會連到網路，可能把資料送出去"],
  [/^(ssh|scp|sftp|rsync|mosh)$/, "會連到另一台電腦"],
  [/^(mv|rename)$/, "會移走或覆蓋檔案"],
  [/^(kill|pkill|killall|launchctl|systemctl|crontab|at)$/, "會改動其他程式或排程"],
  [/^(osascript|automator|shortcuts|open|xdg-open|start)$/, "會操作其他 app（例如寄信、開網址）"],
  [/^(npx|bunx|uvx|pipx|pnpx)$/, "會下載並執行套件"],
  [
    /^(kubectl|oc|helm|terraform|tofu|pulumi|aws|gcloud|gsutil|az|doctl|flyctl|fly|heroku)$/,
    "會改動遠端的服務",
  ],
  [/^(security|defaults|sudo|doas|su|chown|chflags|xattr)$/, "會改動系統、權限或鑰匙圈"],
  [/^(sqlite3|psql|mysql|mongosh|redis-cli)$/, "資料庫指令列可以執行任意指令"],
];

const MAX_DEPTH = 6;
const NO_EXTRA: ReadonlySet<string> = new Set();

/**
 * Phase 5: programs a bot at 完全授權 may also run without a card — the file
 * deleters the person agreed to (in or out of the folder). Network tools,
 * inline scripts and everything else on the floor still ask.
 */
export const FULL_ACCESS_KNOWN: ReadonlySet<string> = new Set(["rm", "rmdir", "unlink"]);

/** Why this one simple command needs a person, or undefined when Alca can read it. */
function wordsNeedPerson(words: string[], depth: number, extra: ReadonlySet<string>): string | undefined {
  let i = 0;
  for (;;) {
    while (i < words.length && (isAssign(words[i] as string) || SKIP_WORDS.has(words[i] as string))) i++;
    while (i < words.length && isRedirect(words[i] as string)) i += /[<>&]$/.test(words[i] as string) ? 2 : 1;
    const w = words[i];
    if (w === undefined) return undefined;
    if (/[$`]/.test(w)) return "要執行的程式來自變數或指令代換，Alca 看不出它是什麼";
    const name = base(w);
    const args = words.slice(i + 1).filter((a) => !isRedirect(a));
    if (name === "env") {
      const s = args.findIndex((a) => a === "-S" || a.startsWith("--split-string"));
      if (s >= 0) {
        const a = args[s] as string;
        return shellNeedsPerson(
          a.includes("=") ? a.slice(a.indexOf("=") + 1) : (args[s + 1] ?? ""),
          depth + 1,
          extra,
        );
      }
      i = skipOptions(words, i + 1, "uCP", ["unset", "chdir"]);
      continue;
    }
    if (name === "eval") return shellNeedsPerson(args.join(" "), depth + 1, extra);
    if (name === "source" || name === ".") return undefined; // a script file (like `bash file`)
    const wrap = WRAPPERS[name];
    if (wrap) {
      i = skipOptions(words, i + 1, wrap.withArg, wrap.long, wrap.positional ?? 0);
      continue;
    }
    // `./script`, `node_modules/.bin/vitest`: a file in the work folder (allowed like `bash file`).
    const local = /^\.{1,2}\//.test(w) || w.startsWith("node_modules/.bin/");
    if (!KNOWN.has(name) && !extra.has(name) && !local) {
      const why = REASONS.find(([re]) => re.test(name))?.[1];
      return why ? `${name}：${why}` : `Alca 不認得「${name.slice(0, 40)}」這個程式`;
    }
    return programNeedsPerson(name, args, depth, extra);
  }
}

function programNeedsPerson(
  name: string,
  args: string[],
  depth: number,
  extra: ReadonlySet<string>,
): string | undefined {
  const interp = INTERPRETERS[name];
  if (interp) {
    const c = args.findIndex((a) => interp.inline.test(a));
    if (c >= 0) {
      // `sh -c '<script>'` is read like any command line; other languages are not.
      if (["bash", "sh", "zsh", "dash"].includes(name)) {
        const script = args.slice(c + 1).find((a) => !/^[-+][a-zA-Z]+$/.test(a));
        return script === undefined ? undefined : shellNeedsPerson(script, depth + 1, extra);
      }
      return `用 ${name} 直接執行一段程式碼，Alca 看不懂它會做什麼`;
    }
    if (name === "python" || name === "python3" || name === "py") {
      const m = args.indexOf("-m");
      if (m >= 0) return undefined; // a module (`python -m pytest`); publish modules are classified
    }
    const file = args.find((a) => !a.startsWith("-") || a === "-");
    if ((file === undefined || file === "-") && interp.stdin)
      return `${name} 從標準輸入讀一段程式碼，Alca 看不懂它會做什麼`;
    return undefined;
  }
  const sub = args.find((a) => !a.startsWith("-"));
  if (sub && RUNNERS[name]?.has(sub)) return `「${name} ${sub}」會執行 Alca 看不到的程式`;
  if (
    (name === "awk" || name === "gawk" || name === "mawk") &&
    args.some((a) => /\bsystem\s*\(|\|\s*"|\|&/.test(a))
  )
    return "awk 程式會執行其他指令";
  if (name === "sed" && args.some((a) => /(^|[;\n])\s*e(\s|$)|\/e[gIip0-9]*$/.test(a)))
    return "sed 的 e 指令會執行其他指令";
  if (name === "find") {
    const x = args.findIndex((a) => ["-exec", "-execdir", "-ok", "-okdir"].includes(a));
    if (x >= 0) {
      const end = args.findIndex((a, k) => k > x && (a === ";" || a === "+"));
      return wordsNeedPerson(args.slice(x + 1, end < 0 ? undefined : end), depth + 1, extra);
    }
  }
  if (name === "git") {
    const k = args.findIndex((a) => !a.startsWith("-"));
    const g = k >= 0 ? (args[k] as string) : "";
    if (args.some((a, j) => j < k && a.startsWith("-c") && /alias\./.test(a + (args[j + 1] ?? ""))))
      return undefined; // aliases are classified by shell.ts
    if (g === "config" && !args.some((a) => /^--(get|list|get-all|get-regexp|show-origin)$|^-l$/.test(a)))
      return "改 git 設定（例如 alias、hooksPath）會影響之後的指令";
  }
  if (name === "docker" || name === "podman") {
    if (sub === "run" && args.some((a) => /^(-v|--volume|--mount|--privileged)(=|$)/.test(a)))
      return "容器會掛載這台電腦的資料夾或取得特權";
  }
  return undefined;
}

/**
 * Expansions whose value is run or read again as code (mac test 2026-11-04b
 * A4 review). A plain `$X`, `${X}` or a special parameter (`$?`, `$#`, `$$`,
 * `$!`, `$0`…`$9`, `$@`, `$*`) is only text in an argument and stays allowed —
 * `ls; echo "exit: $?"` is as readable as `ls`. These are not:
 *
 * - `${!X}` and `${X@P}` / `${X@E}`: the value is expanded once more, and a
 *   prompt expansion runs any `$(…)` inside it;
 * - `$'\x24(…)'`-style escapes: text Alca cannot read as written;
 * - arithmetic on a variable (`$((X))`, `$[X]`, `((X))`, `let X`, and the
 *   numeric tests of `[[ … ]]`): bash evaluates `a[$(cmd)]` inside the value.
 *   Digits and special parameters only (`$(( $? + 1 ))`) are fine.
 */
function opaqueExpansion(text: string): string | undefined {
  if (/\$\{![A-Za-z_@*#0-9]|\$\{[^}]*@[PEAKaQUuLk]\}/.test(text))
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell syntax shown to the person
    return "變數的值會再被展開一次（${!X}、${X@P}），Alca 看不出它是什麼";
  if (/\$'[^']*\\(x[0-9a-fA-F]|u[0-9a-fA-F]|U[0-9a-fA-F]|[0-7]|c)/.test(text))
    return "用跳脫碼寫的文字（$'\\x…'），Alca 看不出它是什麼";
  const named = (expr: string) => /[A-Za-z_]/.test(expr.replace(/\$[?#$!@*0-9-]|\$\{[?#$!@*0-9-]\}/g, ""));
  const arith = [
    ...[...text.matchAll(/\$\(\(([\s\S]*?)\)\)/g)].map((m) => m[1] as string),
    ...[...text.matchAll(/\$\[([^\]]*)\]/g)].map((m) => m[1] as string),
    ...[...text.matchAll(/(?:^|[;&|(\s])\(\(([\s\S]*?)\)\)/g)].map((m) => m[1] as string),
    ...[...text.matchAll(/(?:^|[;&|\s])let\s+([^;&|\n]*)/g)].map((m) => m[1] as string),
  ];
  for (const m of text.matchAll(/\[\[([\s\S]*?)\]\]/g)) {
    const t = (m[1] as string).trim().split(/\s+/);
    t.forEach((w, k) => {
      if (/^-(eq|ne|lt|le|gt|ge)$/.test(w)) arith.push(t[k - 1] ?? "", t[k + 1] ?? "");
    });
  }
  if (arith.some(named)) return "算式裡的變數可能藏著指令（bash 會再算一次它的值）";
  return undefined;
}

/**
 * Why a shell command line needs a person even where the level would let it
 * run, or undefined when every part of it is known (see the file comment).
 */
export function shellNeedsPerson(
  text: string,
  depth = 0,
  extra: ReadonlySet<string> = NO_EXTRA,
): string | undefined {
  if (depth > MAX_DEPTH) return "指令層層包裝，Alca 看不完";
  if (!text.trim()) return undefined;
  const opaque = opaqueExpansion(text);
  if (opaque) return opaque;
  for (const words of splitCommands(text)) {
    const r = wordsNeedPerson(words, depth, extra);
    if (r) return r;
  }
  for (const sub of substitutions(text)) {
    const r = shellNeedsPerson(sub, depth + 1, extra);
    if (r) return r;
  }
  // A here-document feeding an interpreter (`python3 <<EOF`) is caught above as stdin code.
  return undefined;
}

/** Programs that only look (what a CLI's own read-only list lets through without asking). */
// biome-ignore format: a word list reads better packed
const LOOKS = new Set([
  "ls", "cat", "head", "tail", "wc", "grep", "egrep", "fgrep", "rg", "ag", "fd", "find", "pwd", "echo", "which",
  "type", "file", "stat", "du", "df", "tree", "date", "sort", "uniq", "cut", "tr", "jq", "nl", "diff", "cmp",
  "basename", "dirname", "realpath", "readlink", "true", "false", "test", "[", "[[", "uname", "whoami", "id", "cd",
]);
const GIT_LOOKS = new Set([
  "status",
  "log",
  "diff",
  "show",
  "rev-parse",
  "ls-files",
  "blame",
  "describe",
  "shortlog",
]);

/**
 * Does this command line only look (no writes, no redirection into a file,
 * nothing run on its behalf)? Used to tell a CLI's own harmless auto-allow
 * (`ls`, `git status`) from a native call that should have asked (S1.3).
 */
export function shellLooks(text: string): boolean {
  if (/[<>]/.test(text.replace(/2>&1|>\s*\/dev\/null|2>\s*\/dev\/null/g, ""))) return false;
  if (substitutions(text).length || opaqueExpansion(text)) return false;
  for (const words of splitCommands(text)) {
    let i = 0;
    while (i < words.length && isAssign(words[i] as string)) i++;
    const w = words[i];
    if (w === undefined) continue;
    const name = base(w);
    const args = words.slice(i + 1);
    if (name === "git") {
      const sub = args.find((a) => !a.startsWith("-"));
      if (!sub || !GIT_LOOKS.has(sub) || args.some((a) => /^-c|^--output/.test(a))) return false;
      continue;
    }
    if (!LOOKS.has(name)) return false;
    if (name === "find" && args.some((a) => /^-(exec|execdir|ok|okdir|delete|fprint)/.test(a))) return false;
  }
  return true;
}
