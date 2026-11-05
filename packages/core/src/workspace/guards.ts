import { resolve } from "node:path";
import type { PermissionLevelT } from "@alca/config";
import type { ConfineProbe } from "@alca/os";
import { isShellToolName } from "@alca/policy";
import { appendAudit, type Store } from "@alca/store";
import type { GuardCall, TurnGuards } from "../turn.ts";
import { type EditJournal, editTargets } from "./journal.ts";
import { plantsConfig, reachesDataFolder } from "./protect.ts";
import { buildConfineSpec, type ConfinePlan, parseBotSandbox, sandboxOn } from "./sandbox.ts";
import { type ShellReviewer, shellCommandOf } from "./shell-review.ts";
import {
  changesSince,
  type PreImage,
  preImage,
  SHELL_SNAPSHOT_LIMITS,
  type ShellSnapshotLimits,
} from "./shell-snapshot.ts";
import { shellMentionsOutside, shellWriteTargets } from "./shell-targets.ts";
import { type BotWorkDirs, confine, isWithin, realish } from "./workdir.ts";

export interface WorkspaceGuardsOptions {
  store: Store;
  workDirs?: BotWorkDirs;
  journal?: EditJournal;
  reviewer?: ShellReviewer;
  /** A worker nobody can answer for (提前做, a routine's AI run): the reason its cards become denials. */
  background?: (workerId: string) => string | undefined;
  /** How much of the work folder is read before a shell command (undo of its changes). */
  shellSnapshot?: ShellSnapshotLimits;
  /** Next-round §5: the OS sandbox probe (start-up, cached); undefined = none known (treated as unavailable). */
  confiner?: () => ConfineProbe | undefined;
  /** macOS: Alca's own API port, refused from inside the sandbox. */
  corePort?: () => number | undefined;
}

/** The tools whose `unsandboxed: true` asks to run outside the sandbox (Alca's own bash). */
const UNSANDBOXED_TOOLS = new Set(["bash"]);
export const UNSANDBOXED_REASON = "這個指令會在沙箱外、以你的權限執行（bot 要求 unsandboxed），先問你";

interface PendingShell {
  call: GuardCall;
  pre: PreImage;
}

/** Shell calls in flight at most; the oldest is dropped (a call that never reported back). */
const MAX_PENDING_SHELL = 16;

/**
 * The P13 guards in one place (`AlcaCore.useGuards`):
 * - engines start in the bot's working folder;
 * - a file edit outside that folder asks first, even under 自主;
 * - with the bot's shell review on, a shell command under 自主 is shown to
 *   a model first and asks when the risk is high or the review fails;
 * - every file edit that is cleared to run is snapshotted for undo, and a
 *   shell command's changes inside the work folder are found by comparing
 *   the folder before and after it (shell-snapshot.ts);
 * - an early-work or routine worker never puts a card up (nobody is there): it is denied.
 */
export class WorkspaceGuards implements TurnGuards {
  private readonly o: WorkspaceGuardsOptions;
  private readonly pending = new Map<string, PendingShell>();
  constructor(o: WorkspaceGuardsOptions) {
    this.o = o;
  }

  workDir(botId: string): string | undefined {
    try {
      return this.o.workDirs?.resolve(botId);
    } catch {
      return undefined;
    }
  }

  noAsk(info: { runId: string; workerId?: string }): string | undefined {
    return info.workerId ? this.o.background?.(info.workerId) : undefined;
  }

  /** S2.1: Alca's data folder is out of reach of every native tool, at every level. */
  forbid(call: GuardCall): string | undefined {
    if (!this.o.workDirs) return undefined;
    try {
      return reachesDataFolder(call.tool, call.args, {
        data: this.o.workDirs.dataDir,
        workDir: this.workDir(call.botId),
      });
    } catch {
      return "無法確認這個動作碰不碰得到 Alca 的資料夾，所以不執行";
    }
  }

  /**
   * Where a call's relative paths start: the worker's dispatch `workdir`
   * inside the bot's folder (plan §4: the coding tools work there), else the
   * bot's folder.
   */
  private callDir(call: GuardCall): string | undefined {
    const dir = this.workDir(call.botId);
    const sub = call.workerId ? this.o.store.workers.get(call.workerId)?.grants.workdir : undefined;
    if (!dir || !sub) return dir;
    try {
      return confine(dir, sub);
    } catch {
      return dir;
    }
  }

  /**
   * Next-round §5.4: whether a bot's commands run in the OS sandbox at this
   * level, and with what. Cheap except for the spec (`withSpec`), which
   * lists the data folder. Never throws: an error is `unavailable`.
   */
  confine(botId: string, level: PermissionLevelT, withSpec = true): ConfinePlan {
    try {
      const bot = this.o.store.bots.get(botId);
      const s = parseBotSandbox(bot?.sandbox ?? null);
      if (!sandboxOn(s, level)) return { state: "off" };
      const required = s.mode === "on";
      const probe = this.o.confiner?.();
      const dir = this.workDir(botId);
      const reason = !probe
        ? "還沒偵測到可用的沙箱"
        : !probe.ok || probe.kind === "none"
          ? (probe.reason ?? "沒有可用的沙箱")
          : !dir || !this.o.workDirs
            ? "這個 bot 沒有工作資料夾"
            : undefined;
      if (reason || !probe || probe.kind === "none" || !dir || !this.o.workDirs) {
        this.noteUnavailable(botId, reason ?? "沒有可用的沙箱", required);
        return {
          state: "unavailable",
          reason: reason ?? "沒有可用的沙箱",
          ...(required ? { required } : {}),
        };
      }
      if (!withSpec) return { state: probe.kind };
      const others: string[] = [];
      for (const b of this.o.store.bots.list())
        if (b.id !== botId) {
          const d = this.workDir(b.id);
          if (d) others.push(d);
        }
      const spec = buildConfineSpec({
        kind: probe.kind,
        dataDir: this.o.workDirs.dataDir,
        botId,
        workDir: dir,
        otherDirs: others,
        sandbox: s,
        corePort: this.o.corePort?.(),
      });
      return { state: probe.kind, spec, ...(required ? { required } : {}) };
    } catch (err) {
      return {
        state: "unavailable",
        reason: `沙箱設定讀取失敗：${String((err as Error)?.message ?? err).slice(0, 120)}`,
      };
    }
  }

  private readonly unavailableNoted = new Set<string>();

  /** §5.7: one audit row per bot per start when its sandbox should be on but none is usable. */
  private noteUnavailable(botId: string, reason: string, required: boolean): void {
    if (this.unavailableNoted.has(botId)) return;
    this.unavailableNoted.add(botId);
    try {
      appendAudit(this.o.store.db, {
        ts: new Date().toISOString(),
        initiator: { kind: "agent", id: botId },
        actor: { kind: "system", id: "sandbox" },
        action: "sandbox.unavailable",
        actionClass: "read",
        decision: required ? "deny" : "allow",
        detail: { botId, reason: reason.slice(0, 300), ...(required ? { required: true } : {}) },
      });
    } catch {
      // the audit row is a record, not a condition
    }
  }

  folder(call: GuardCall): string | undefined {
    // §5.7: the one way out of the sandbox asks at every level, 完全授權 included.
    if (call.args.unsandboxed === true && UNSANDBOXED_TOOLS.has(call.tool)) {
      const plan = this.confine(call.botId, call.level, false);
      if (plan.state === "seatbelt" || plan.state === "bwrap") return UNSANDBOXED_REASON;
    }
    const dir = this.workDir(call.botId);
    const here = this.callDir(call);
    const targets = editTargets(call.tool, call.args, here);
    // S1.4: engine / tool configuration asks even inside the folder, at every level.
    const config = plantsConfig(call.tool, call.args, targets);
    if (config) return config;
    if (!dir || !here || !this.o.workDirs) return undefined;
    const outside = targets.filter((p) => !isWithin(dir, realish(p)));
    // A9: a shell command's own write targets (`> /abs`, `tee`, `cp … /x`, `touch ~/x`), not only edit tools.
    const command = shellCommandOf(call.tool, call.args);
    // Phase 5: at 完全授權 deleting files outside the folder runs without a card (writes there still ask).
    const shellTargets = (command !== undefined ? shellWriteTargets(command, here) : []).filter(
      (t) => !(call.level === "full_access" && t.deletes),
    );
    for (const t of shellTargets)
      if (t.unknown || !isWithin(dir, realish(t.path)))
        outside.push(t.unknown ? `${t.path}（看不出實際位置）` : t.path);
    if (!outside.length) return this.owns(call, here, [...targets, ...shellTargets.map((t) => t.path)]);
    const more = outside.length > 1 ? ` 等 ${outside.length} 個` : "";
    return command !== undefined
      ? `指令要寫入工作資料夾外（${outside[0]}${more}）`
      : `要修改工作資料夾外的檔案（${outside[0]}${more}）`;
  }

  /**
   * Plan §4: a worker dispatched with `ownsPaths` (parallel workers on one
   * repo) asks before writing anywhere else in the folder.
   */
  private owns(call: GuardCall, here: string, targets: readonly string[]): string | undefined {
    const owns = call.workerId ? this.o.store.workers.get(call.workerId)?.grants.ownsPaths : undefined;
    if (!owns?.length || !targets.length) return undefined;
    const roots = owns.map((o) => realish(resolve(here, o)));
    const stray = targets.filter((p) => !roots.some((r) => r === realish(p) || isWithin(r, realish(p))));
    if (!stray.length) return undefined;
    const more = stray.length > 1 ? ` 等 ${stray.length} 個` : "";
    return `要修改指派範圍（ownsPaths：${owns.join("、")}）以外的檔案（${stray[0]}${more}）`;
  }

  /**
   * A9: for a card that goes up anyway — the shell command names paths outside
   * the work folder (`ls -la ~/x`). Wording only; never makes a call ask.
   */
  outsideNote(call: GuardCall): string | undefined {
    const dir = this.workDir(call.botId);
    const command = shellCommandOf(call.tool, call.args);
    if (!dir || command === undefined) return undefined;
    const named = shellMentionsOutside(command, (p) => isWithin(dir, realish(p)));
    if (!named.length) return undefined;
    const more = named.length > 1 ? ` 等 ${named.length} 個` : "";
    return `指令用到工作資料夾外的路徑（${named[0]}${more}）`;
  }

  async review(call: GuardCall): Promise<string | undefined> {
    const dir = this.workDir(call.botId);
    const outside = this.folder(call);
    if (outside) return outside;
    const command = shellCommandOf(call.tool, call.args);
    if (!command || !this.o.reviewer || call.level === "confirm_each_step") return undefined;
    if (this.o.store.bots.get(call.botId)?.shellReview !== "on") return undefined;
    const v = await this.o.reviewer.review({
      botId: call.botId,
      threadId: call.threadId,
      command,
      ...(dir ? { cwd: dir } : {}),
      signal: call.signal,
    });
    const escalated = v.risk === "high";
    try {
      appendAudit(this.o.store.db, {
        ts: new Date().toISOString(),
        initiator: { kind: "agent", id: call.botId },
        actor: { kind: "system", id: "shell_review" },
        action: "shell_review",
        actionClass: "read",
        decision: escalated ? "ask" : "allow",
        detail: {
          tool: call.tool,
          command: command.slice(0, 500),
          risk: v.risk,
          reason: v.reason,
          ...(v.failed ? { failed: true } : {}),
          runId: call.runId,
          ...(call.workerId ? { workerId: call.workerId } : {}),
        },
      });
    } catch {
      // the audit row is a record of the review, not a condition of the gate
    }
    if (!escalated) return undefined;
    return v.failed ? `指令審查沒有結果，改為先問你（${v.reason}）` : `指令審查：風險高（${v.reason}）`;
  }

  beforeRun(call: GuardCall): void {
    if (!this.o.journal) return;
    const dir = this.callDir(call);
    if (dir && call.callId && shellCommandOf(call.tool, call.args) !== undefined) {
      const limits = this.limits();
      this.pending.set(`${call.runId}:${call.callId}`, { call, pre: preImage(dir, limits) });
      while (this.pending.size > MAX_PENDING_SHELL)
        this.pending.delete(this.pending.keys().next().value as string);
      return;
    }
    const paths = editTargets(call.tool, call.args, dir);
    if (!paths.length) return;
    this.o.journal.snapshot({
      botId: call.botId,
      threadId: call.threadId,
      runId: call.runId,
      ...(call.workerId ? { workerId: call.workerId } : {}),
      tool: call.tool,
      paths: paths.map((p) => realish(p)),
    });
  }

  afterRun(info: { runId: string; callId: string }): void {
    const key = `${info.runId}:${info.callId}`;
    const p = this.pending.get(key);
    if (!p || !this.o.journal) return;
    this.pending.delete(key);
    const changes = changesSince(p.pre, this.limits());
    const items = changes.map((c) =>
      !c.before
        ? { path: c.path, existed: false }
        : c.before.content
          ? { path: c.path, existed: true, content: c.before.content, mode: c.before.mode }
          : { path: c.path, existed: true, size: c.before.size, skipped: "檔案太大，指令改之前沒有保留" },
    );
    if (!p.pre.complete && items.length)
      items.push({
        path: p.pre.dir,
        existed: true,
        skipped: "工作資料夾太大，指令改的其他檔案沒有比對，不能復原",
      } as (typeof items)[number]);
    if (!items.length) return;
    this.o.journal.keep(
      {
        botId: p.call.botId,
        threadId: p.call.threadId,
        runId: p.call.runId,
        ...(p.call.workerId ? { workerId: p.call.workerId } : {}),
        // An ACP agent's shell tool is named by its free-text title: journaled as "shell".
        tool: isShellToolName(p.call.tool) ? p.call.tool : "shell",
      },
      items,
    );
  }

  private limits(): ShellSnapshotLimits {
    return this.o.shellSnapshot ?? SHELL_SNAPSHOT_LIMITS;
  }
}
