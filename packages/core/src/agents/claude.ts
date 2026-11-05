import {
  CLAUDE_BACKGROUND_TOOLS,
  ClaudeCodeEngine,
  type EngineLaunchConfig,
  HARNESS_MATRIX,
  type SessionMemory,
} from "@alca/engines";
import type { Store } from "@alca/store";
import { CONTRACT_TOOL_NAMES } from "../harness/contract.ts";
import { HARNESS_DEFAULTS, type HarnessKind } from "../harness/kinds.ts";
import { harnessProfile, toolAllowed } from "../harness/profiles.ts";
import { buildStablePrompt, type PromptProfile } from "../prompt.ts";
import { PEER_TOOL_NAMES } from "./peers.ts";
import { ROUTER_TOOL_NAMES } from "./router.ts";

/**
 * Claude Code as the router and the workers (P3). Two engine instances, so
 * the two roles get different launch configs:
 *
 * - router: the router profile, only the router tools (as MCP host tools),
 *   built-in CLI tools limited to the question card with `--tools` (an
 *   allowlist, so a tool a newer CLI adds is not there either; mac test
 *   2026-11-04b A8: `CronCreate` was not in the deny list and ran), and the
 *   known ones also removed with `--disallowedTools`. The core also denies any
 *   native tool a router turn asks for, so the flags are layers, not the only one.
 * - workers: the worker profile and the full host tools; one CLI process per
 *   worker (the worker id is the session key), resumed with `--resume`. The
 *   engine removes the background tools (scheduling, sub-agents) from every
 *   launch (CLAUDE_BACKGROUND_TOOLS).
 */

/** Built-in Claude Code tools the router never gets (names from the public CLI docs). */
export const ROUTER_DISALLOWED_TOOLS = Object.freeze([
  "Bash",
  "BashOutput",
  "KillShell",
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Glob",
  "Grep",
  "LS",
  "WebFetch",
  "WebSearch",
  "Task",
  "TodoWrite",
  ...CLAUDE_BACKGROUND_TOOLS,
]);

/**
 * P15 E: built-in tools the general harness never gets (no native shell or
 * file writes; reading stays). The engine checks the CLI's init message and
 * refuses the turn when one of them is still offered.
 */
export const GENERAL_DISALLOWED_TOOLS = Object.freeze([
  "Bash",
  "BashOutput",
  "KillShell",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Task",
  ...CLAUDE_BACKGROUND_TOOLS,
]);

/** The host tool names a harness worker sees, the contract tools included. */
export function harnessToolNames(kind: HarnessKind, names: readonly string[]): string[] {
  return [...new Set([...names.filter((n) => toolAllowed(kind, n)), ...CONTRACT_TOOL_NAMES])];
}

/**
 * Plan §3.2: `--max-turns` per harness launch, a backstop only (the watchdog's
 * step count is the real cap): twice the harness's default steps. NOT yet
 * checked on a real CLI — needs the Mac test with haiku.
 */
export const CLAUDE_MAX_TURNS: Readonly<Record<HarnessKind, number>> = Object.freeze({
  coding: HARNESS_DEFAULTS.coding.maxSteps * 2,
  general: HARNESS_DEFAULTS.general.maxSteps * 2,
});

/** Why a general launch must not run: the CLI still offers a native shell / write tool. */
export function generalInitProblem(init: { tools?: string[] }): string | undefined {
  const offered = init.tools?.filter((t) => GENERAL_DISALLOWED_TOOLS.includes(t)) ?? [];
  return offered.length ? `一般工人不能有原生的 ${offered.join("、")}，但 CLI 仍然提供` : undefined;
}

/** The only built-in tools a router keeps (`--tools`): the question card, and ToolSearch (off by env, harmless). */
export const ROUTER_BUILTIN_TOOLS = Object.freeze(["AskUserQuestion", "ToolSearch"]);

/** Session memory over the store: thread keys use `engine_sessions`, router and worker keys `engine_conversations`. */
export function storeSessions(store: Store, engineId = "claude-code"): SessionMemory {
  return {
    get: (k) =>
      k.startsWith("thr_") ? store.threads.getSession(k, engineId) : store.workers.conversation(k, engineId),
    set: (k, s) =>
      k.startsWith("thr_")
        ? store.threads.setSession(k, engineId, s)
        : store.workers.setConversation(k, engineId, s),
    clear: (k) =>
      k.startsWith("thr_")
        ? store.threads.clearSession(k, engineId)
        : store.workers.clearConversation(k, engineId),
  };
}

export interface ClaudeAgentEnginesOptions {
  command: readonly string[];
  cwd: string;
  store: Store;
  routerProfile: PromptProfile;
  workerProfile: PromptProfile;
  /** Host tools the workers get (their names go into the launch-fixed prompt). */
  workerToolNames: readonly string[];
  /** Read before every turn, so a changed model restarts (and resumes) the process. */
  model?: () => { router?: string; worker?: string };
  baseEnv?: NodeJS.ProcessEnv;
  interruptGraceMs?: number;
  /** Alca's data folder (deny rules for the CLI's own Read / Edit, S2.1). */
  protectedDataDir?: string;
}

/**
 * Plan §3.2: one engine instance per harness with a fixed tool list (so the
 * launch hash stays stable): `coding` keeps the native Edit / Write / Bash —
 * each one still asks the permission tool (`mcp__alca__approve` → the host's
 * gate); `general` has them removed and the CLI's init message must agree
 * before a turn runs. Both carry `--max-turns` as a backstop.
 */
export function claudeAgentEngines(o: ClaudeAgentEnginesOptions): {
  router: ClaudeCodeEngine;
  worker: ClaudeCodeEngine;
  coding: ClaudeCodeEngine;
  general: ClaudeCodeEngine;
} {
  const sessions = storeSessions(o.store);
  const routerPrompt = buildStablePrompt(o.routerProfile, [...ROUTER_TOOL_NAMES, ...PEER_TOOL_NAMES]);
  const workerPrompt = buildStablePrompt(o.workerProfile, o.workerToolNames);
  const harnessPrompt = (kind: HarnessKind) =>
    buildStablePrompt(harnessProfile(o.workerProfile, kind), harnessToolNames(kind, o.workerToolNames));
  const codingPrompt = harnessPrompt("coding");
  const generalPrompt = harnessPrompt("general");
  const cfg = (
    stablePrompt: string,
    model: string | undefined,
    extraArgs?: string[],
  ): EngineLaunchConfig => ({
    engineId: "claude-code",
    cwd: o.cwd,
    stablePrompt,
    env: {},
    // Our gateway decides; the CLI asks us for anything its own mode would prompt for.
    approvalMode: "default",
    ...(model ? { model } : {}),
    ...(extraArgs ? { extraArgs } : {}),
  });
  const common = {
    command: o.command,
    sessions,
    ...(o.baseEnv ? { baseEnv: o.baseEnv } : {}),
    ...(o.interruptGraceMs ? { interruptGraceMs: o.interruptGraceMs } : {}),
    ...(o.protectedDataDir ? { protectedDataDir: o.protectedDataDir } : {}),
  };
  return {
    router: new ClaudeCodeEngine({
      ...common,
      launch: () =>
        cfg(routerPrompt, o.model?.().router, [
          "--tools",
          ROUTER_BUILTIN_TOOLS.join(","),
          "--disallowedTools",
          ROUTER_DISALLOWED_TOOLS.join(","),
        ]),
    }),
    worker: new ClaudeCodeEngine({ ...common, launch: () => cfg(workerPrompt, o.model?.().worker) }),
    coding: new ClaudeCodeEngine({
      ...common,
      launch: () => cfg(codingPrompt, o.model?.().worker, ["--max-turns", String(CLAUDE_MAX_TURNS.coding)]),
      harness: { ...HARNESS_MATRIX.claudeCoding, nativeStepCap: CLAUDE_MAX_TURNS.coding },
    }),
    general: new ClaudeCodeEngine({
      ...common,
      launch: () =>
        cfg(generalPrompt, o.model?.().worker, [
          "--max-turns",
          String(CLAUDE_MAX_TURNS.general),
          "--disallowedTools",
          GENERAL_DISALLOWED_TOOLS.join(","),
        ]),
      verifyInit: generalInitProblem,
      harness: { ...HARNESS_MATRIX.claudeGeneral, nativeStepCap: CLAUDE_MAX_TURNS.general },
    }),
  };
}
