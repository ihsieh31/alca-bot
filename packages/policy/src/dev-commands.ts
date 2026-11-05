import { base, isAssign, isRedirect, splitCommands, substitutions } from "./shell.ts";
import { shellLooks } from "./shell-safe.ts";

/**
 * Plan §4: ordinary development commands — build, test, type-check, lint,
 * format — run in the work folder. A command line made only of those (plus
 * looking-only helpers such as `| tail -n 50`, and `cd` into a sub-folder)
 * is the `write` class: it builds or formats files in place, like the file
 * tools. It no longer falls to the shell floor's "Alca cannot read this, ask
 * first" (`node --test`, `pnpm exec vitest run`, `npx --no-install tsc`,
 * `turbo run test`, `golangci-lint run`).
 *
 * What stays out (and keeps its class or the floor):
 * - anything the classifier finds: `git push`, `npm publish`, `curl -X POST`,
 *   `rm` (delete always asks, in or out of the folder);
 * - a path that leaves the folder: an absolute path, `~`, `..`, a redirection
 *   into one;
 * - variables, substitutions, here-documents, inline code (`node -e`);
 * - package installs and runners that download (`npm install`, plain `npx`,
 *   `pnpm dlx`, `bunx`);
 * - a script name that is not a build / test / lint / format name
 *   (`npm run deploy`).
 */

const SCRIPT =
  /^(test|tests|unit|e2e|spec|build|compile|bundle|lint|lint-fix|fmt|format|prettier|eslint|biome|typecheck|type-check|types|tsc|check|verify|vet|ci)([:._-][\w:.-]+)?$/;

/** Tools that only build, test, type-check, lint or format (the name is enough). */
// biome-ignore format: a word list reads better packed
const TOOLS = new Set([
  "tsc", "vue-tsc", "svelte-check", "vitest", "jest", "mocha", "ava", "eslint", "prettier", "biome", "oxlint",
  "stylelint", "tsup", "rollup", "webpack", "esbuild", "pytest", "mypy", "pyright", "ruff", "black", "isort",
  "flake8", "pylint", "tox", "nox", "rustfmt", "gofmt", "staticcheck", "ctest", "phpunit", "rspec", "rubocop",
  "swiftlint", "swiftformat", "ktlint", "clang-format", "shellcheck", "shfmt", "markdownlint", "gradle",
  "gradlew", "ninja",
]);

/** Multi-purpose tools: only these sub-commands (the first word that is not an option). */
const SUBS: Readonly<Record<string, RegExp>> = {
  cargo: /^(build|b|test|t|check|c|fmt|clippy|bench|doc)$/,
  go: /^(build|test|vet|fmt)$/,
  "golangci-lint": /^(run)$/,
  deno: /^(test|fmt|lint|check|bench)$/,
  bun: /^(test)$/,
  turbo: /^(run|test|build|lint)$/,
  nx: /^(run|test|build|lint|run-many|affected)$/,
  next: /^(build|lint)$/,
  vite: /^(build)$/,
  astro: /^(check|build)$/,
  dprint: /^(fmt|check)$/,
  playwright: /^(test)$/,
  dotnet: /^(build|test|format)$/,
  mvn: /^(test|verify|package|compile|validate)$/,
  sbt: /^(test|compile)$/,
  swift: /^(build|test)$/,
  meson: /^(test|compile)$/,
  rake: /^(test|spec|build)$/,
  dart: /^(test|analyze|format)$/,
  flutter: /^(test|analyze)$/,
  mix: /^(test|format|compile)$/,
  zig: /^(build|test|fmt)$/,
  bazel: /^(build|test)$/,
  composer: /^(test|lint)$/,
};

const MAKE_TARGET = /^(all|build|test|tests|check|lint|fmt|format|typecheck|compile|-j\d*|-k|-s|--silent)$/;
const PY_MODULES = /^(pytest|unittest|mypy|ruff|black|isort|pyright|flake8|pylint|compileall|tox|nox)$/;
const RUNNERS = new Set(["npm", "pnpm", "yarn"]);

/** A word that points outside the folder (absolute, home, a parent) or expands to something unknown. */
function leaves(w: string): boolean {
  const v = w.startsWith("-") && w.includes("=") ? w.slice(w.indexOf("=") + 1) : w;
  if (/[$`]/.test(v)) return true;
  if (/^(\/|~)/.test(v)) return true;
  return /(^|\/)\.\.(\/|$)/.test(v);
}

const firstPositional = (args: readonly string[]) => args.find((a) => !a.startsWith("-"));

/** `npm test`, `pnpm run lint`, `yarn build`, `pnpm exec vitest run`. */
function runnerOk(name: string, args: string[]): boolean {
  const pos = args.filter((a) => !a.startsWith("-"));
  const sub = pos[0];
  if (!sub) return false;
  if (sub === "test" || sub === "t") return true;
  if (sub === "run" || sub === "run-script") return SCRIPT.test(pos[1] ?? "");
  if (sub === "exec" && name === "pnpm") {
    const tool = pos[1] ?? "";
    return toolOk(base(tool), args.slice(args.indexOf(tool) + 1));
  }
  if (name === "yarn" || name === "pnpm") return SCRIPT.test(sub);
  return false;
}

function toolOk(name: string, args: string[]): boolean {
  if (!name) return false;
  if (TOOLS.has(name)) return true;
  const sub = SUBS[name];
  if (sub) return sub.test(firstPositional(args) ?? "");
  if (name === "make" || name === "gmake") return args.every((a) => MAKE_TARGET.test(a));
  if (name === "node" || name === "nodejs")
    // `node --test [files]`: the built-in test runner on files in the folder.
    return args.includes("--test") && !args.some((a) => /^(-e|-p|--eval|--print)(=|$)/.test(a));
  if (name === "python" || name === "python3" || name === "py")
    return args[0] === "-m" && PY_MODULES.test(args[1] ?? "");
  if (name === "uv" || name === "poetry" || name === "pipenv" || name === "bundle") {
    const k = args.indexOf(name === "bundle" ? "exec" : "run");
    return k >= 0 && toolOk(base(args[k + 1] ?? ""), args.slice(k + 2));
  }
  if (name === "npx") {
    // Only without a download: `npx --no-install tsc` / `npx --no tsc` runs what the project has.
    if (!args.includes("--no-install") && !args.includes("--no")) return false;
    const tool = firstPositional(args) ?? "";
    return toolOk(base(tool), args.slice(args.indexOf(tool) + 1));
  }
  if (RUNNERS.has(name)) return runnerOk(name, args);
  return false;
}

/** One simple command: a development command, a `cd` inside the folder, or a helper that only looks. */
function simpleOk(words: string[]): { ok: boolean; dev: boolean } {
  const no = { ok: false, dev: false };
  let i = 0;
  while (i < words.length && isAssign(words[i] as string)) i++;
  const rest = words.slice(i);
  if (!rest.length) return no;
  const args: string[] = [];
  for (let k = 1; k < rest.length; k++) {
    const a = rest[k] as string;
    if (!isRedirect(a)) {
      if (leaves(a)) return no;
      args.push(a);
      continue;
    }
    // Redirections: only into the folder (or 2>&1, /dev/null); a here-document is code Alca does not see.
    if (/^\d*<</.test(a)) return no;
    const inline = a.replace(/^\d*(>>?|<|&>>?|>&|<&)/, "");
    const target = inline || (rest[++k] ?? "");
    if (target === "/dev/null" || /^&?\d$/.test(target)) continue;
    if (!target || leaves(target)) return no;
  }
  const w = rest[0] as string;
  if (leaves(w)) return no;
  const name = base(w);
  if (name === "cd") return { ok: args.length === 1, dev: false };
  if (toolOk(name, args)) return { ok: true, dev: true };
  // `./gradlew test`, `node_modules/.bin/vitest`, `vendor/bin/phpunit`: a local copy of a known tool.
  if (/^(\.\/|node_modules\/\.bin\/|vendor\/bin\/)/.test(w) && (TOOLS.has(name) || !!SUBS[name]))
    return { ok: true, dev: true };
  return {
    ok: shellLooks(rest.map((x) => (/[\s'"]/.test(x) ? `'${x.replace(/'/g, "")}'` : x)).join(" ")),
    dev: false,
  };
}

/**
 * Is this command line only ordinary build / test / lint / format work in
 * the folder? (Callers run the classifier first: a publish, send or delete
 * anywhere in the line wins over this.)
 */
export function devCommand(command: string): boolean {
  const text = command.trim();
  if (!text || text.length > 2000) return false;
  if (/[$`]/.test(text) || substitutions(text).length) return false;
  const cmds = splitCommands(text);
  if (!cmds.length) return false;
  let dev = false;
  for (const words of cmds) {
    const r = simpleOk(words);
    if (!r.ok) return false;
    dev ||= r.dev;
  }
  return dev;
}
