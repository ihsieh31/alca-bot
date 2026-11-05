import type { Engine, EngineCapabilities, HarnessCaps } from "./types.ts";

/**
 * Plan §3.1: the engine capability matrix. Every engine instance says what it
 * can do for a worker harness (`EngineCapabilities.harness`); the host reads
 * it when a dispatch names a harness and refuses the dispatch when the engine
 * cannot do the work safely (`checkHarnessFit`). The router never picks an
 * engine itself: a refusal goes back to it as a plain error so it can
 * re-dispatch or tell the person.
 */

/** The two harnesses (core's `HarnessKind`; engines does not depend on core). */
export type HarnessFitKind = "coding" | "general";

const row = (r: HarnessCaps): HarnessCaps => Object.freeze(r);
const cli = (
  writes: HarnessCaps["writes"],
  asksBeforeWrite: HarnessCaps["asksBeforeWrite"],
  asksBeforeExec: HarnessCaps["asksBeforeExec"],
  usageStreaming: HarnessCaps["usageStreaming"],
): HarnessCaps =>
  row({
    loop: "cli",
    writes,
    asksBeforeWrite,
    asksBeforeExec,
    nativeStepCap: null,
    interrupt: true,
    usageStreaming,
    resume: true,
  });

/** The matrix rows: one per engine family and launch, as each driver declares it. */
export const HARNESS_MATRIX = Object.freeze({
  /** Alca's own loop over a model API: every write and command is a host tool, gated. */
  api: row({
    loop: "own",
    writes: "host_tools",
    asksBeforeWrite: "every",
    asksBeforeExec: "every",
    nativeStepCap: null,
    interrupt: true,
    usageStreaming: "per_turn",
    resume: true,
  }),
  /** Claude Code with its native Edit / Write / Bash, each one asking the permission tool. */
  claudeCoding: cli("native", "every", "every", "per_message"),
  /** Claude Code without native shell or writes (removed, read back from init): host tools only. */
  claudeGeneral: cli("host_tools", "every", "every", "per_message"),
  /**
   * `codex exec --json`: a read-only sandbox with approvals off. Native commands
   * run unasked (they cannot write); changes only through host tools.
   */
  codexExec: cli("host_tools", "every", "never", "per_turn"),
  /**
   * `codex app-server`, workspace-write with `approvalPolicy: "untrusted"`: every
   * patch and every command outside Codex's known-safe reads raises an approval
   * request, which goes to the host's gate.
   */
  codexAppServerCoding: cli("native", "every", "every", "per_message"),
  /**
   * `codex app-server` with `approvalPolicy: "on-request"`: commands inside the
   * sandbox and patches inside the writable roots run WITHOUT asking (Codex
   * asks only to escalate), so it cannot take coding work.
   */
  codexAppServerOnRequest: cli("native", "some", "some", "per_message"),
  /** `codex app-server`, read-only sandbox (general, reviewer): changes only through host tools. */
  codexAppServerReadOnly: cli("host_tools", "every", "never", "per_message"),
  /** An ACP agent kept in its asking mode (strict): native edits and commands ask the host. */
  acpCoding: cli("native", "every", "every", "none"),
  /** An ACP agent whose native edit / execute kinds are refused without asking (general). */
  acpGeneral: cli("host_tools", "every", "every", "none"),
  /** An ACP agent at the bot's level: an auto-edit mode may write without asking. */
  acpAtLevel: cli("native", "some", "some", "none"),
});

/** The harness capabilities of an engine: its own declaration, else derived from its capabilities. */
export function harnessCapsOf(e: Pick<Engine, "capabilities"> | EngineCapabilities): HarnessCaps {
  const c = "capabilities" in e ? e.capabilities : e;
  if (c.harness) return c.harness;
  if (!c.ownsToolLoop) return { ...HARNESS_MATRIX.api, interrupt: c.interrupt, resume: c.resume };
  // An undeclared tool-owning engine: assume the worst about its native tools.
  const asks = c.permissionPrompt === "none" ? "never" : "some";
  return {
    loop: "cli",
    writes: c.nativeToolsReadOnly ? "host_tools" : "native",
    asksBeforeWrite: asks,
    asksBeforeExec: asks,
    nativeStepCap: null,
    interrupt: c.interrupt,
    usageStreaming: c.streaming ? "per_message" : "per_turn",
    resume: c.resume,
  };
}

export type HarnessFit =
  | {
      ok: true;
      /**
       * Phase 5: the bot is at 完全授權, so native writes may run unasked; the
       * host keeps a git snapshot before every turn where it can (best effort:
       * a folder that is not git, or a snapshot that fails, still runs).
       */
      snapshotEachTurn?: true;
    }
  | {
      ok: false;
      /** Stable code for the router and the ledger. */
      code: "harness.engine_unfit";
      /** One sentence for the router (zh), with what to do next. */
      reason: string;
    };

const WORD: Record<HarnessCaps["asksBeforeWrite"], string> = {
  every: "每次都問",
  some: "有時不問",
  never: "從不問",
};

const unfit = (reason: string): HarnessFit => ({ ok: false, code: "harness.engine_unfit", reason });

/** Phase 5: what the host knows about the dispatch when it checks the fit. */
export interface HarnessFitContext {
  /** The level the work runs at (`full_access` = the bot's own 完全授權). */
  level?: string;
}

/**
 * Can this engine run this harness? (plan §3.1)
 * - coding: Alca's own loop, or a CLI whose native writes AND commands all ask
 *   the host first; and it must be able to write at all. Phase 5: at
 *   完全授權 a CLI that asks only sometimes (`some`, e.g. Codex on-request in
 *   its network-less workspace sandbox) also fits; never one that never asks.
 *   At 完全授權 every coding fit keeps a git snapshot before every turn where
 *   it can (`snapshotEachTurn`, best effort): a folder that is not git is not
 *   refused (decision of 11-05, replacing mac B2's refusal).
 * - general: no native write or command may run unasked (a CLI with native
 *   writes must ask for every one; read-only or host-tool engines fit), at
 *   every level.
 */
export function checkHarnessFit(
  engine: Pick<Engine, "capabilities"> | EngineCapabilities,
  kind: HarnessFitKind,
  label = "這個 bot 的引擎",
  ctx: HarnessFitContext = {},
): HarnessFit {
  const h = harnessCapsOf(engine);
  const asksAll = h.asksBeforeWrite === "every" && h.asksBeforeExec === "every";
  if (kind === "coding") {
    if (h.writes === "none")
      return unfit(`${label}現在不能改檔，不能做 coding 工作；請改派給能改程式的 bot，或告訴使用者。`);
    const sometimes = h.asksBeforeWrite === "some" && h.asksBeforeExec !== "never";
    const fits = h.loop === "own" || asksAll || (ctx.level === "full_access" && sometimes);
    // Mac test B2: at 完全授權 the gate clears every write and command of an engine that
    // "always asks" too, so in practice every engine writes unasked there. Whatever the
    // engine (own loop, Claude Code, ACP, Codex), coding at full access keeps a snapshot
    // before every turn where it can. 11-05: whether the folder is git does not change the
    // fit; without a snapshot the turn still runs and the host records why.
    if (fits && ctx.level === "full_access") return { ok: true, snapshotEachTurn: true };
    if (fits) return { ok: true };
    return unfit(
      `${label}改檔或執行指令時不一定會先問 Alca（寫入：${WORD[h.asksBeforeWrite]}、指令：${WORD[h.asksBeforeExec]}），不能做 coding 工作；請改派給其他 bot，或告訴使用者。${h.note ?? ""}`,
    );
  }
  if (h.writes !== "native" || asksAll) return { ok: true };
  return unfit(`${label}的原生工具可能不經確認就改檔或執行指令，不能做 general 工作；請改派或告訴使用者。`);
}
