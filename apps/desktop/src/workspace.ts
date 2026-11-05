import type { Settings } from "@alca/config";
import {
  type AgentSystem,
  type AlcaCore,
  BotWorkDirs,
  EditJournal,
  fileTools,
  type HostTool,
  ShellReviewer,
  shown,
  WorkspaceGuards,
} from "@alca/core";
import { tSource } from "@alca/design/i18n";
import type { Engine } from "@alca/engines";
import type { ConfineProbe } from "@alca/os";
import { isShellToolName } from "@alca/policy";
import type { Store } from "@alca/store";

/**
 * P13 agent features on the desktop: each bot's working folder, Alca's own
 * file tools, undo of a turn's file edits, the optional shell review and
 * 提前做. Shared by the loopback routes (workspace-routes.ts).
 */

export class WorkspaceApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface WorkspaceOptions {
  dataDir: string;
  store: Store;
  settings: () => Settings;
  /** `--workdir`: the folder bots without their own setting work in (default: `<data>/bots/<id>/work`). */
  defaultDir?: string;
  /** The engine a bot's shell review asks (its pick, else its own router engine). */
  reviewEngine: (botId: string) => Engine | undefined;
  /** Next-round §5: the OS sandbox probe (start-up, cached). */
  confiner?: () => ConfineProbe | undefined;
  /** macOS: Alca's own API port, refused from inside the sandbox. */
  corePort?: () => number | undefined;
}

export interface Workspace {
  workDirs: BotWorkDirs;
  journal: EditJournal;
  guards: WorkspaceGuards;
  /** Host tools: file_list, file_read, file_write, file_edit (confined to the bot's folder). */
  tools: HostTool[];
  /** Late binding: the agent system (for 提前做) once it exists. */
  bind(core: AlcaCore, agents: AgentSystem | undefined): WorkspaceApi;
}

export function createWorkspace(o: WorkspaceOptions): Workspace {
  const workDirs = new BotWorkDirs({
    dataDir: o.dataDir,
    store: o.store,
    ...(o.defaultDir ? { defaultDir: o.defaultDir } : {}),
  });
  const journal = new EditJournal({ store: o.store, policy: () => o.settings().engineering.undo });
  let agents: AgentSystem | undefined;
  const guards = new WorkspaceGuards({
    store: o.store,
    workDirs,
    journal,
    reviewer: new ShellReviewer({
      engineFor: o.reviewEngine,
      timeoutMs: () => o.settings().engineering.shellReview.timeoutSec * 1000,
    }),
    // 提前做 and routine runs: nobody is there to answer a card (research audit B4).
    background: (workerId) => agents?.background(workerId),
    ...(o.confiner ? { confiner: o.confiner } : {}),
    ...(o.corePort ? { corePort: o.corePort } : {}),
  });
  return {
    workDirs,
    journal,
    guards,
    tools: fileTools((botId) => workDirs.resolve(botId)),
    bind: (core, a) => {
      agents = a;
      core.useGuards(guards);
      return new WorkspaceApi(core, a, workDirs, journal);
    },
  };
}

export class WorkspaceApi {
  readonly core: AlcaCore;
  readonly agents: AgentSystem | undefined;
  readonly workDirs: BotWorkDirs;
  readonly journal: EditJournal;

  constructor(core: AlcaCore, agents: AgentSystem | undefined, workDirs: BotWorkDirs, journal: EditJournal) {
    this.core = core;
    this.agents = agents;
    this.workDirs = workDirs;
    this.journal = journal;
  }

  /** A bot's folder now, and why its own setting is not used (if so). */
  folder(botId: string): { path: string; setting: string | null; problem: string | null } {
    const bot = this.core.store.bots.get(botId);
    if (!bot) throw new WorkspaceApiError(404, tSource("core.common.noBot"));
    return {
      path: this.workDirs.resolve(botId),
      setting: bot.workDir,
      problem: this.workDirs.problem(botId) ?? null,
    };
  }

  /** The turns of a conversation that changed files, newest first, with the files (shown from the bot's folder). */
  edits(threadId: string) {
    const thread = this.core.store.threads.get(threadId);
    if (!thread) throw new WorkspaceApiError(404, tSource("core.common.noThread"));
    return this.journal.turns(threadId).map((t) => {
      const root = this.safeRoot(t.botId);
      return {
        ...t,
        canUndo: !t.undone && !t.pruned,
        paths: this.journal.files(t.turnRunId).map((s) => ({
          path: root ? shown(root, s.path) : s.path,
          created: !s.existed,
          tool: s.tool,
          ...(isShellToolName(s.tool) ? { shell: true } : {}),
          ...(s.skipped ? { skipped: s.skipped } : {}),
        })),
      };
    });
  }

  undo(threadId: string, turnRunId: string) {
    if (!this.core.store.threads.get(threadId))
      throw new WorkspaceApiError(404, tSource("core.common.noThread"));
    const r = this.journal.undo(threadId, turnRunId);
    if (!r.ok) throw new WorkspaceApiError(409, r.reason);
    return r;
  }

  /** 提前做: what a bot has queued, is preparing, or prepared. */
  early(o: { botId?: string; threadId?: string } = {}) {
    return this.core.store.early.list({ ...o, limit: 50 });
  }

  /** Ask a bot to prepare something ahead (a request, not a trigger). */
  offerEarly(body: Record<string, unknown>) {
    const early = this.agents?.early;
    if (!early) throw new WorkspaceApiError(409, tSource("core.workspace.earlyNeedsRouter"));
    const threadId = typeof body.threadId === "string" ? body.threadId : "";
    const thread = this.core.store.threads.get(threadId);
    if (!thread) throw new WorkspaceApiError(404, tSource("core.common.noThread"));
    const goal = typeof body.goal === "string" ? body.goal.trim() : "";
    if (!goal) throw new WorkspaceApiError(400, tSource("core.workspace.needWhat"));
    const botId = typeof body.botId === "string" ? body.botId : (thread.botId ?? this.core.defaultBotId);
    if (!this.core.store.bots.get(botId)) throw new WorkspaceApiError(404, tSource("core.common.noBot"));
    const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : goal.slice(0, 40);
    return early.offer({ botId, threadId, source: "request", title, goal });
  }

  private safeRoot(botId: string): string | undefined {
    try {
      return this.workDirs.resolve(botId);
    } catch {
      return undefined;
    }
  }
}
