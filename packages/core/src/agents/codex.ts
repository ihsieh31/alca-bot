import {
  type AppServerApprovalPolicy,
  CodexAppServerEngine,
  CodexEngine,
  type EngineLaunchConfig,
} from "@alca/engines";
import type { Store } from "@alca/store";
import type { HarnessKind } from "../harness/kinds.ts";
import { harnessProfile } from "../harness/profiles.ts";
import { buildStablePrompt, type PromptProfile } from "../prompt.ts";
import { harnessToolNames, storeSessions } from "./claude.ts";
import { PEER_TOOL_NAMES } from "./peers.ts";
import { ROUTER_TOOL_NAMES } from "./router.ts";

/**
 * Codex CLI as a bot's router and workers (P9), the same split as Claude
 * Code: engine instances with their own stable prompts; the router gets the
 * router tools, workers the host tools, all over MCP and all gated by the
 * host.
 *
 * - router / plain worker: `codex exec --json` in its read-only sandbox with
 *   approvals off — it reads, every change goes through a host tool.
 * - coding worker (plan §3.3): `codex app-server`, `workspace-write` limited
 *   to the work folder, every patch and command raising an approval request
 *   that goes to the host's gate (`approvalPolicy: "untrusted"`, see
 *   CodexAppServerEngine for why not `on-request`). No fallback: when the
 *   app-server is unavailable its capabilities become "cannot write" and a
 *   coding dispatch is refused.
 * - general worker: `codex app-server` in `read-only`, falling back to the
 *   read-only `codex exec` when the app-server is unavailable.
 * - coding worker of a bot at 完全授權 (Phase 5): `codex app-server`,
 *   `workspace-write` (no network) with `approvalPolicy: "on-request"` — edits
 *   and commands in the folder run without asking, so the host keeps a git
 *   snapshot before every turn (`snapshotEachTurn`). Other levels keep
 *   `untrusted`.
 */
export interface CodexAgentEnginesOptions {
  command: readonly string[];
  cwd: string;
  store: Store;
  routerProfile: PromptProfile;
  workerProfile: PromptProfile;
  workerToolNames: readonly string[];
  model?: string;
  baseEnv?: NodeJS.ProcessEnv;
  /** Alca's own CODEX_HOME (engines' codex/home.ts); unset = the engine's default. */
  home?: string;
  /** The coding worker's approval policy (default `untrusted`; `on-request` makes coding unfit). */
  codingApprovalPolicy?: AppServerApprovalPolicy;
}

export function codexAgentEngines(o: CodexAgentEnginesOptions): {
  router: CodexEngine;
  worker: CodexEngine;
  coding: CodexAppServerEngine;
  general: CodexAppServerEngine;
  codingFullAccess: CodexAppServerEngine;
} {
  const sessions = storeSessions(o.store, "codex");
  const cfg = (stablePrompt: string, approvalMode = "read-only"): EngineLaunchConfig => ({
    engineId: "codex",
    cwd: o.cwd,
    stablePrompt,
    env: {},
    approvalMode,
    ...(o.model ? { model: o.model } : {}),
  });
  const routerPrompt = buildStablePrompt(o.routerProfile, [...ROUTER_TOOL_NAMES, ...PEER_TOOL_NAMES]);
  const workerPrompt = buildStablePrompt(o.workerProfile, o.workerToolNames);
  const harnessPrompt = (kind: HarnessKind) =>
    buildStablePrompt(harnessProfile(o.workerProfile, kind), harnessToolNames(kind, o.workerToolNames));
  const common = {
    command: o.command,
    sessions,
    ...(o.baseEnv ? { baseEnv: o.baseEnv } : {}),
    ...(o.home ? { home: o.home } : {}),
  };
  const generalPrompt = harnessPrompt("general");
  const codingPrompt = harnessPrompt("coding");
  return {
    router: new CodexEngine({ ...common, launch: () => cfg(routerPrompt) }),
    worker: new CodexEngine({ ...common, launch: () => cfg(workerPrompt) }),
    coding: new CodexAppServerEngine({
      ...common,
      launch: () => cfg(codingPrompt, "workspace-write"),
      sandbox: "workspace-write",
      ...(o.codingApprovalPolicy ? { approvalPolicy: o.codingApprovalPolicy } : {}),
    }),
    codingFullAccess: new CodexAppServerEngine({
      ...common,
      launch: () => cfg(codingPrompt, "workspace-write"),
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
    }),
    general: new CodexAppServerEngine({
      ...common,
      launch: () => cfg(generalPrompt),
      sandbox: "read-only",
      fallback: new CodexEngine({ ...common, launch: () => cfg(generalPrompt) }),
    }),
  };
}
