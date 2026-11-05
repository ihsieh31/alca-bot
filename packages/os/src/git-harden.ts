/**
 * Next-round §5.6: git that Alca runs itself (snapshots, the reviewer's
 * diff) must not run programs a repository's own configuration names. A
 * bot can write `.git/config` outside the sandbox's reach on a machine
 * without one, or a cloned repo can carry it; these switches make Alca's
 * git ignore every such execution hook. `filter.<name>.clean/smudge` can
 * only be defined in config (a work tree's `.gitattributes` only refers to
 * one), so `.git/config` being unwritable in the sandbox covers filters;
 * outside it, `GIT_CONFIG_NOSYSTEM` and the switches below are what holds.
 */
export const GIT_HARDEN_ARGS: readonly string[] = Object.freeze([
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.sshCommand=",
  "-c",
  "core.pager=cat",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "protocol.ext.allow=never",
  "--no-pager",
]);

/**
 * For `git diff` / `git show`: no external diff program and no textconv
 * filter (both are programs named by config). Not `-c diff.external=` (the
 * design's first spelling): git 2.47 then tries to run an empty command and
 * the diff dies ("cannot run : No such file or directory").
 */
export const GIT_DIFF_SAFE_ARGS: readonly string[] = Object.freeze(["--no-ext-diff", "--no-textconv"]);

/** Variables that name a program or inject config; never passed to Alca's own git. */
const GIT_ENV_STRIP =
  /^(GIT_EXTERNAL_DIFF|GIT_SSH|GIT_SSH_COMMAND|GIT_ASKPASS|SSH_ASKPASS|GIT_EDITOR|GIT_SEQUENCE_EDITOR|GIT_PAGER|GIT_CONFIG_PARAMETERS|GIT_CONFIG_COUNT|GIT_CONFIG_KEY_\d+|GIT_CONFIG_VALUE_\d+|GIT_CONFIG_GLOBAL|GIT_CONFIG_SYSTEM|GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|GIT_EXEC_PATH|GIT_TEMPLATE_DIR)$/;

/** The environment for Alca's own git: the given one without program / config injectors, system config off. */
export function hardenedGitEnv(src: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(src)) if (v !== undefined && !GIT_ENV_STRIP.test(k)) env[k] = v;
  return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat" };
}

/**
 * `GIT_CONFIG_NOSYSTEM=1 git <hardening>` as shell words, for a command line
 * run through a shell whose environment is cleaned (bash.ts keeps only a few
 * variables, so the variable rides on the command itself).
 */
export function hardenedGitPrefix(): string {
  return ["GIT_CONFIG_NOSYSTEM=1", "git", ...GIT_HARDEN_ARGS]
    .map((w) => (/^[A-Za-z0-9_.=/:-]+$/.test(w) ? w : `'${w}'`))
    .join(" ");
}
