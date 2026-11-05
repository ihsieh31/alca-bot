import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ConfineSpec } from "@alca/os";
import { runCommand } from "../../harness/coding/bash.ts";
import { truncateText } from "../../harness/truncate.ts";

/**
 * Plan §2.5: the host's own check after a coding worker changed files. A
 * task is `done` only with a fresh, passing check after the last change; the
 * host runs it (never the model), for API engines and CLIs alike, and does not
 * count it as steps.
 *
 * Commands come from, in order: the dispatch's `checks`; the check commands
 * AGENTS.md / CLAUDE.md name; then the project files (package.json scripts
 * typecheck / lint / test; pyproject, Cargo.toml, go.mod).
 */

export const VERIFY_TIMEOUT_MS = 10 * 60_000;
/** What goes back to the model from a red check (the whole output is spilled). */
export const VERIFY_FEEDBACK_BYTES = 8 * 1024;

/** Whether the last change came after the last passing check (or there was no passing check). */
export function verifyStale(lastEditSeq: number, lastPassSeq: number | undefined): boolean {
  if (lastEditSeq <= 0) return false;
  return lastPassSeq === undefined || lastEditSeq > lastPassSeq;
}

const RUNNER_RE =
  /^(p?npm|yarn|bun|npx|pnpx|node|deno|make|just|cargo|go|pytest|python3?|uv|poetry|tox|ruff|mypy|tsc|vitest|jest|biome|eslint|gradle|\.\/)/;

/** Check commands an AGENTS.md / CLAUDE.md names: in a section about checks / tests, or a `check:` line. */
export function checksFromInstructions(md: string): string[] {
  const out: string[] = [];
  const add = (c: string) => {
    const t = c.trim().replace(/^\$\s*/, "");
    if (t && RUNNER_RE.test(t) && !out.includes(t) && out.length < 8) out.push(t.slice(0, 300));
  };
  let inSection = false;
  let inFence = false;
  for (const line of md.split("\n")) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading && !inFence) {
      inSection = /(check|test|verif|lint|檢查|驗證|測試)/i.test(heading[1] ?? "");
      continue;
    }
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    const tagged = /^\s*[-*]?\s*(?:check|檢查)[:：]\s*`?([^`]+)`?/i.exec(line);
    if (tagged?.[1]) {
      add(tagged[1]);
      continue;
    }
    if (!inSection) continue;
    if (inFence) add(line);
    else for (const m of line.matchAll(/`([^`]+)`/g)) add(m[1] ?? "");
  }
  return out;
}

function packageManager(dir: string): string {
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(dir, "yarn.lock"))) return "yarn";
  if (existsSync(join(dir, "bun.lockb")) || existsSync(join(dir, "bun.lock"))) return "bun";
  return "npm";
}

/** Check commands the project files suggest. */
export function checksFromProject(dir: string): string[] {
  const out: string[] = [];
  const pkg = join(dir, "package.json");
  if (existsSync(pkg)) {
    try {
      const scripts =
        (JSON.parse(readFileSync(pkg, "utf8")) as { scripts?: Record<string, string> }).scripts ?? {};
      const pm = packageManager(dir);
      for (const s of ["typecheck", "lint", "test"])
        if (typeof scripts[s] === "string") out.push(pm === "npm" ? `npm run ${s}` : `${pm} ${s}`);
    } catch {
      // an unreadable package.json suggests nothing
    }
  }
  if (existsSync(join(dir, "pyproject.toml"))) out.push("python -m pytest -q");
  if (existsSync(join(dir, "Cargo.toml"))) out.push("cargo test --quiet");
  if (existsSync(join(dir, "go.mod"))) out.push("go test ./...");
  return out;
}

/** The commands to run, by the plan's order of sources; empty = nothing to verify with. */
export function checkCommands(
  dispatchChecks: readonly string[] | undefined,
  dir: string | undefined,
): string[] {
  if (dispatchChecks?.length) return [...dispatchChecks];
  if (!dir) return [];
  for (const f of ["AGENTS.md", "CLAUDE.md"]) {
    const p = join(dir, f);
    if (!existsSync(p)) continue;
    try {
      const found = checksFromInstructions(readFileSync(p, "utf8"));
      if (found.length) return found;
    } catch {
      // try the next source
    }
  }
  return checksFromProject(dir);
}

export interface VerifyCheckResult {
  command: string;
  exitCode: number | null;
  output: string;
  timedOut?: boolean;
}

export interface VerifyResult {
  ok: boolean;
  results: VerifyCheckResult[];
  /** The failing part, cut to what goes back to the model. */
  feedback: string;
  /** Everything (for the spill). */
  full: string;
}

/**
 * Run one check in `cwd` through a bash session (plan §2.5, Phase 3), always
 * with pipefail (`bash -o pipefail`; under sh where it can, with a note): its own
 * process group, a stop or the timeout ends the whole tree (grandchildren
 * included), the environment is cleaned of secrets, the output cleaned. A
 * stopped or timed-out check has no exit code (`null`), never a red one.
 */
export async function runCheck(
  command: string,
  cwd: string,
  signal?: AbortSignal,
  timeoutMs = VERIFY_TIMEOUT_MS,
  confine?: ConfineSpec,
): Promise<VerifyCheckResult> {
  const r = await runCommand({
    command,
    cwd,
    timeoutMs,
    strictPipe: true,
    ...(signal ? { signal } : {}),
    ...(confine ? { confine } : {}),
  });
  return {
    command,
    exitCode: r.timedOut || r.stopped || signal?.aborted ? null : r.exitCode,
    output: r.pipeNote ? `${r.output}\n${r.pipeNote}` : r.output,
    ...(r.timedOut ? { timedOut: true } : {}),
  };
}

/** §5.7: the bot asked for the sandbox and none is usable — no check runs, the round is red with the reason. */
export function refusedChecks(commands: readonly string[], reason: string): VerifyResult {
  const results = (commands.length ? commands : ["（檢查）"]).slice(0, 1).map((command) => ({
    command,
    exitCode: null,
    output: reason,
  }));
  const text = `$ ${results[0]?.command}\n${reason}`;
  return { ok: false, results, feedback: text, full: text };
}

/** Run the commands one after another; the first red one ends the round. */
export async function runChecks(
  commands: readonly string[],
  cwd: string,
  signal?: AbortSignal,
  confine?: ConfineSpec,
): Promise<VerifyResult> {
  const results: VerifyCheckResult[] = [];
  for (const c of commands) {
    if (signal?.aborted) break;
    const r = await runCheck(c, cwd, signal, VERIFY_TIMEOUT_MS, confine);
    results.push(r);
    if (r.exitCode !== 0) break;
  }
  const ok = results.length === commands.length && results.every((r) => r.exitCode === 0);
  const full = results
    .map((r) => `$ ${r.command}\n${r.output}\n[exit ${r.exitCode ?? (r.timedOut ? "timeout" : "stopped")}]`)
    .join("\n");
  const bad = results.find((r) => r.exitCode !== 0);
  const feedback = bad
    ? truncateText(
        `$ ${bad.command}\n${bad.output}\n[exit ${bad.exitCode ?? (bad.timedOut ? "timeout" : "stopped")}]`,
        {
          mode: "headtail",
          maxBytes: VERIFY_FEEDBACK_BYTES,
          headShare: 0.2,
        },
      ).text
    : "";
  return { ok, results, feedback, full };
}
