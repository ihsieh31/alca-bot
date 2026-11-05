import {
  defaultSettings,
  effectiveLevel,
  type PermissionLevelT,
  type Settings,
  strictestLevel,
} from "@alca/config";
import type { Engine } from "@alca/engines";
import { JobRuntime, recoverJobs } from "@alca/jobs";
import { ActionGateway } from "@alca/policy";
import {
  type ActorT,
  type AlcaEvent,
  type EventData,
  type EventType,
  type FinishReasonT,
  type InitiatorT,
  newId,
  RunEmitter,
} from "@alca/protocol";
import { appendAudit, type Store, type StoredMessage, type Thread } from "@alca/store";
import {
  type ActiveRun,
  type AlcaCoreOptions,
  NotFoundError,
  type RouterMode,
  type RunSpec,
  ThreadBusyError,
  ThreadInUseError,
  type ThreadState,
} from "./agent-types.ts";
import { EventBus, HumanLatch } from "./bus.ts";
import { botPromptLanguage, type PromptLanguage } from "./conversation-rules.ts";
import type { TurnHooks, TurnInfo, TurnObserver } from "./learning.ts";
import { LoopGuard } from "./loop-guard.ts";
import { DEFAULT_PROFILE, type PromptProfile } from "./prompt.ts";
import { RunSlots, SlotHold, TURN_TIMEOUT_CODE, TurnClock, TurnTimeout } from "./run-limits.ts";
import { type PhaseTrace, runPipeline } from "./runner.ts";
import { threadTitle } from "./thread-title.ts";
import {
  type Emit,
  type HostTool,
  type HumanWaits,
  initialState,
  type TurnContext,
  type TurnDeps,
  type TurnGuards,
  type TurnRole,
  type TurnState,
} from "./turn.ts";
import type { ConfinePlan } from "./workspace/sandbox.ts";

export {
  type AlcaCoreOptions,
  NotFoundError,
  type RouterMode,
  type RunSpec,
  ThreadBusyError,
  ThreadInUseError,
  type ThreadState,
} from "./agent-types.ts";

/**
 * The core facade: threads, turns, human answers, interrupts. Owns the event
 * bus that surfaces subscribe to; every event is persisted to `run_events`
 * before it is published.
 */
/** R5.4: what else a conversation delete takes (user defaults: memories kept, backups scrubbed). */
export interface DeleteThreadOptions {
  /** Also forget the memories learned in it. */
  memories?: boolean;
  /** Also take it out of the backup files (default true). */
  scrubBackups?: boolean;
  /** The backup scrub's result (per file), when it is done. */
  onBackups?: (r: Array<{ file: string; ok: boolean; absent?: boolean; error?: string }>) => void;
}

/** How many runs' phase traces `AlcaCore.traces` keeps (PERF-2026-11). */
export const TRACE_KEEP = 64;

export class AlcaCore {
  readonly store: Store;
  readonly engine: Engine;
  readonly bus = new EventBus();
  readonly jobs: JobRuntime;
  readonly gateway: ActionGateway;
  private readonly human = new HumanLatch();
  private readonly active = new Map<string, ActiveRun>();
  private readonly o: AlcaCoreOptions;
  private readonly now: () => Date;
  private readonly settings: () => Settings;
  /** Phase traces of the newest TRACE_KEEP runs (tests and diagnostics). */
  readonly traces = new Map<string, PhaseTrace[]>();
  /** Every run doing work at once, across threads, routers and workers (`engineering.maxConcurrentRuns`). */
  readonly slots: RunSlots;

  constructor(opts: AlcaCoreOptions) {
    this.o = opts;
    this.store = opts.store;
    this.engine = opts.engine;
    this.hooks = opts.hooks;
    this.now = opts.now ?? (() => new Date());
    const fallback = defaultSettings();
    this.settings = opts.settings ?? (() => fallback);
    this.slots = new RunSlots(() => this.settings().engineering.maxConcurrentRuns);
    this.jobs = new JobRuntime(this.store.db, { now: this.now });
    this.gateway = new ActionGateway({
      db: this.store.db,
      human: this.store.human,
      rules: () => [...(opts.rules?.() ?? []), ...this.extraRules.flatMap((f) => f())],
      level: (c) => this.levelFor(c.botId, c.threadId),
      now: this.now,
    });
  }

  /**
   * Restart recovery: runs left open by a previous process are closed as
   * interrupted, their cards expired (nobody can act on them now), and the
   * job tree is recovered (outbound jobs → needs_review, never re-run).
   */
  recover(): { runs: number; approvals: number; questions: number; jobs: number } {
    const open = this.store.runs.open();
    for (const r of open) this.store.runs.finish(r.id, "interrupted", this.now());
    const approvals = this.gateway.expireAllPending();
    let questions = 0;
    for (const q of this.store.human.pendingQuestions())
      if (this.store.human.expireQuestion(q.id, this.now())) questions++;
    const jobs = recoverJobs(this.jobs, this.now()).length;
    return { runs: open.length, approvals, questions, jobs };
  }

  private readonly extraRules: Array<() => readonly unknown[]> = [];

  /** Host-made policy rules besides the person's (P7: the team's peer approval rule). */
  addRules(fn: () => readonly unknown[]): void {
    this.extraRules.push(fn);
  }

  /**
   * The permission level a bot's call runs under: the bot's own level, or the
   * team's. In a peer conversation (a teammate asked this bot) it is the
   * strictest level of every bot in the chain: a delegation never widens what
   * the asking bot may do.
   */
  levelFor(botId?: string, threadId?: string): PermissionLevelT {
    const team = this.settings().permissions.level;
    const of = (id: string): PermissionLevelT => {
      try {
        return effectiveLevel(this.store.bots.get(id)?.approvalLevel, team);
      } catch {
        return team;
      }
    };
    const bots = new Set<string>(botId ? [botId] : []);
    if (threadId) {
      try {
        const req = this.store.team.byPeerThread(threadId);
        for (const b of req?.chain ?? []) bots.add(b);
      } catch {
        // stores without the team tables: the bot's own level
      }
    }
    return strictestLevel([...bots].map(of), team);
  }

  /** The bot new threads go to when none is named. */
  get defaultBotId(): string {
    return this.o.botId ?? this.store.bots.ensureDefault().id;
  }

  createThread(title?: string, botId?: string): Thread {
    const bot = botId ?? this.defaultBotId;
    if (!this.store.bots.get(bot)) throw new NotFoundError(`bot ${bot}`);
    return this.store.threads.create(newId("thread"), title ?? null, this.now(), bot);
  }

  /** Newest activity first; paged with `before` (the last thread of the previous page). */
  listThreads(
    o: { limit?: number; archived?: boolean; before?: { updatedAt: string; id: string } } = {},
  ): Thread[] {
    return this.store.threads.list(o.limit ?? 100, {
      ...(o.archived ? { archived: true } : {}),
      ...(o.before ? { before: o.before } : {}),
    });
  }

  /** Archive a thread (hidden from the list, everything kept) or bring it back. */
  archiveThread(threadId: string, archived = true): Thread {
    if (!this.store.threads.get(threadId)) throw new NotFoundError(`thread ${threadId}`);
    if (archived && this.active.has(threadId)) throw new ThreadBusyError(threadId);
    this.store.threads.setArchived(threadId, archived, this.now());
    return this.store.threads.get(threadId) as Thread;
  }

  /**
   * Delete a thread: refused while a turn runs or while routines, triggers or
   * workers still work in it (ThreadInUseError names them).
   */
  deleteThread(threadId: string, o: DeleteThreadOptions = {}): { deleted: true; backups: "queued" | "kept" } {
    if (!this.store.threads.get(threadId)) throw new NotFoundError(`thread ${threadId}`);
    if (this.active.has(threadId)) throw new ThreadBusyError(threadId);
    const d = this.store.threads.dependents(threadId);
    if (d.routines + d.triggers + d.workers > 0) throw new ThreadInUseError(threadId, d);
    const now = this.now();
    const memories = o.memories === true;
    // R5 / R2.3: the content goes now in one short transaction; the event trail and the
    // backups on the database worker (the hourly prune finishes a trail a crash cut short).
    this.store.threads.erase(threadId, now, { memories, trail: "later" });
    appendAudit(this.store.db, {
      ts: now.toISOString(),
      initiator: { kind: "user", id: "local" },
      actor: { kind: "system", id: "core" },
      action: "data.erased",
      actionClass: "write",
      target: threadId,
      decision: "allow",
      detail: { scope: "thread", memories, backups: o.scrubBackups !== false },
    });
    void this.store.jobs.run("eraseTrail", [threadId]).catch(() => undefined);
    if (o.scrubBackups === false) return { deleted: true, backups: "kept" };
    void this.store.jobs
      .run("scrubBackups", [threadId], now.toISOString(), memories)
      .then((r) => o.onBackups?.(r))
      .catch(() => undefined);
    return { deleted: true, backups: "queued" };
  }

  messages(threadId: string): StoredMessage[] {
    return this.store.threads.messages(threadId);
  }

  threadState(threadId: string): ThreadState {
    const thread = this.store.threads.get(threadId);
    if (!thread) throw new NotFoundError(`thread ${threadId}`);
    const runId = this.active.get(threadId)?.runId ?? null;
    return {
      thread,
      activeRunId: runId,
      pendingApprovals: runId ? this.store.human.pendingApprovals(runId) : [],
      pendingQuestions: runId ? this.store.human.pendingQuestions(runId) : [],
    };
  }

  /** Stored protocol events of a run (replay / resync). */
  /** Stored events of a run; `types` filters in SQL, so stream-chunk batch rows are never opened (PERF-2026-11). */
  runEvents(runId: string, afterSeq = -1, types?: readonly string[]): AlcaEvent[] {
    return this.store.runs.events(runId, afterSeq, types ? { types } : {}).map((e) => e.payload as AlcaEvent);
  }

  isBusy(threadId: string): boolean {
    return this.active.has(threadId);
  }

  /** Router mode (P3): set by `AgentSystem`. Absent = direct mode (the thread turn has every host tool). */
  private router: RouterMode | undefined;

  private hooks: TurnHooks | undefined;

  /** Memory + learning around every turn (P5). */
  useHooks(hooks: TurnHooks): void {
    this.hooks = hooks;
  }

  private readonly observers: TurnObserver[] = [];

  /** P14: another watcher around every turn (the offer ledger). */
  useObserver(o: TurnObserver): void {
    this.observers.push(o);
  }

  private guards: TurnGuards | undefined;

  /** P13: host checks around every tool call (work folder, shell review, undo snapshots). */
  useGuards(guards: TurnGuards): void {
    this.guards = guards;
  }

  /**
   * Next-round §5.4: whether a bot's commands run in the OS sandbox (at its
   * level in this conversation) and with what; undefined without guards.
   */
  confineOf(botId: string, threadId?: string, withSpec = true): ConfinePlan | undefined {
    try {
      return (this.guards ?? this.o.guards)?.confine?.(botId, this.levelFor(botId, threadId), withSpec);
    } catch {
      return undefined;
    }
  }

  /** A bot's working folder (P13 guards), where a coding worker's checks run (plan §2.5). */
  workDirOf(botId: string): string | undefined {
    try {
      return (this.guards ?? this.o.guards)?.workDir?.(botId);
    } catch {
      return undefined;
    }
  }

  /** P14: the conversation rules in the bot's language (a pure function of the bot, so the layer stays stable). */
  private profileFor(p: PromptProfile, botId: string, role: TurnRole): PromptProfile {
    if (role === "worker" || p.conversation === false || p.language) return p;
    let lang: PromptLanguage = "zh";
    try {
      lang = botPromptLanguage(this.store.bots.get(botId));
    } catch {
      lang = "zh";
    }
    return lang === "zh" ? p : { ...p, language: lang };
  }

  private restrict: TurnDeps["restrict"];

  /** P14: a reason a worker may not run a call at all (read-only research workers); checked before the gate. */
  useRestrict(fn: NonNullable<TurnDeps["restrict"]>): void {
    this.restrict = fn;
  }

  /** Switch the thread turn to a bot's resident router (called once by `AgentSystem`). */
  useRouter(mode: RouterMode): void {
    this.router = mode;
  }

  get mode(): "direct" | "router" {
    return this.router ? "router" : "direct";
  }

  /** Every host tool (in router mode: the workers' tools). */
  get hostTools(): readonly HostTool[] {
    return this.o.tools ?? [];
  }

  /**
   * Start a turn on a thread: the person's message (or a system note such as
   * a worker report). In router mode it runs as the bot's router; otherwise
   * as the thread's own turn. Resolves as soon as the run exists; `done`
   * resolves when it finishes.
   */
  send(
    threadId: string,
    text: string,
    opts: {
      initiator?: InitiatorT;
      attended?: boolean;
      messageRole?: "user" | "system";
      /** Answer as this bot instead of the thread's own (P7: the person @mentioned a teammate). */
      botId?: string;
    } = {},
  ): { runId: string; done: Promise<FinishReasonT> } {
    const thread = this.store.threads.get(threadId);
    if (!thread) throw new NotFoundError(`thread ${threadId}`);
    if (this.active.has(threadId)) throw new ThreadBusyError(threadId);
    if (opts.botId && !this.store.bots.get(opts.botId)) throw new NotFoundError(`bot ${opts.botId}`);
    const botId = opts.botId ?? thread.botId ?? this.defaultBotId;
    const r = this.router;
    const spec: RunSpec = {
      threadId,
      text,
      track: true,
      botId,
      ...(opts.initiator ? { initiator: opts.initiator } : {}),
      ...(opts.attended !== undefined ? { attended: opts.attended } : {}),
      ...(opts.messageRole ? { messageRole: opts.messageRole } : {}),
      ...(r
        ? {
            role: "router" as const,
            engine: r.engineFor?.(botId) ?? r.engine,
            tools: r.tools,
            profile: r.profile,
            sessionKey: r.sessionKey(botId),
            contextLines: r.contextLines(threadId, text, botId),
            before: () => r.acquire(botId),
            after: () => r.release(botId),
          }
        : {}),
    };
    const { runId, done } = this.launch(spec);
    return { runId, done: done.then((s) => s.finish?.reason ?? "completed") };
  }

  /**
   * Start any run on a thread: a thread turn, a router turn, or a worker's
   * run (P3). Phase 0 happens here (run row, job, the incoming message, the
   * first events), then the pipeline runs.
   */
  launch(spec: RunSpec): { runId: string; done: Promise<TurnState>; stop: () => Promise<void>; emit: Emit } {
    const { threadId, text } = spec;
    const thread = this.store.threads.get(threadId);
    if (!thread) throw new NotFoundError(`thread ${threadId}`);
    const initiator = spec.initiator ?? { kind: "user", id: "local" };
    const attended = spec.attended ?? (initiator.kind === "user" || this.bus.watching(threadId));
    const role = spec.role ?? "thread";
    const engine = spec.engine ?? this.engine;
    const runId = newId("run");
    const controller = new AbortController();
    const settings = this.settings();

    const botId = spec.botId ?? thread.botId ?? this.defaultBotId;
    this.store.runs.start(
      {
        id: runId,
        threadId,
        initiator,
        engine: engine.id,
        botId,
        ...(spec.parentRunId ? { parentRunId: spec.parentRunId } : {}),
        ...(spec.workerId ? { workerId: spec.workerId } : {}),
      },
      this.now(),
    );
    let jobId = spec.jobId;
    if (!jobId) {
      // BUG-4: never the message itself (it is sealed in `messages`; a job title is not).
      const job = this.jobs.create({ kind: "turn", threadId, runId, title: "turn", botId });
      this.jobs.start(job.id, "core");
      jobId = job.id;
    }
    if (!thread.title && role !== "worker") this.store.threads.setTitle(threadId, threadTitle(text));

    const emitter = new RunEmitter({
      threadId,
      runId,
      initiator,
      actor: { kind: "agent", id: spec.workerId ?? botId },
      now: this.now,
    });
    const publish = spec.publish ?? ((e: AlcaEvent) => this.bus.publish(e));
    /** Set when the core closed the run itself (a stuck engine): later events of the run are dropped. */
    let sealed = false;
    const emit: Emit = (type, data, actor) => {
      const e = emitter.emit(type, data, actor);
      if (sealed) return e;
      this.store.runs.appendEvent({ runId, seq: e.seq, type: e.type, payload: e }, this.now());
      publish(e);
      return e;
    };

    emit("run.started", {
      engine: engine.id,
      ...(spec.parentRunId ? { parentRunId: spec.parentRunId } : {}),
    });
    const msgRole = spec.messageRole ?? "user";
    const userMsgId = newId("message");
    this.store.threads.addMessage(
      { id: userMsgId, threadId, runId, role: msgRole, content: text },
      this.now(),
    );
    emit(
      "message.completed",
      { messageId: userMsgId, role: msgRole, text },
      msgRole === "user" ? { kind: "user", id: initiator.id } : { kind: "system", id: "alca" },
    );

    const info: TurnInfo = {
      threadId,
      runId,
      botId,
      role,
      text,
      messageId: userMsgId,
      messageRole: msgRole,
      initiatorKind: initiator.kind,
    };
    const hooks = this.hooks;
    let memoryNotes: string[] = [];
    try {
      memoryNotes = hooks?.beforeTurn(info) ?? [];
    } catch {
      memoryNotes = []; // memory must never break a turn
    }
    for (const ob of this.observers)
      try {
        memoryNotes.push(...(ob.before?.(info) ?? []));
      } catch {
        // an observer must never break a turn
      }
    let mustFollow: string[] = [];
    try {
      mustFollow = hooks?.mustFollow?.(info) ?? [];
    } catch {
      mustFollow = [];
    }
    const tools = spec.tools ?? this.o.tools ?? [];
    const key = spec.sessionKey ?? threadId;
    // P13 limits: a slot among maxConcurrentRuns, and a time budget for thread / router turns.
    const hold = new SlotHold(this.slots, role === "worker" ? "worker" : "turn");
    const limitSec = settings.engineering.turnTimeoutSec;
    let forceClose: (() => void) | undefined;
    const forced = new Promise<"forced">((resolve) => {
      forceClose = () => resolve("forced");
    });
    const clock =
      role !== "worker" && spec.track
        ? new TurnClock(limitSec * 1000, () => {
            if (controller.signal.aborted) return;
            emit("error", {
              code: TURN_TIMEOUT_CODE,
              message: `這一輪超過 ${limitSec} 秒沒有完成，已經停止。可以再傳一次訊息重試。`,
              retryable: true,
            });
            controller.abort(new TurnTimeout(limitSec));
            void engine.interrupt(key).catch(() => undefined);
            const t = setTimeout(() => forceClose?.(), this.o.forceCloseGraceMs ?? 15_000);
            t.unref?.();
          })
        : undefined;
    // Waiting for a person: the clock stops and the slot goes back until the answer comes.
    const human: HumanWaits = {
      wait: async (id, signal) => {
        clock?.pause();
        hold.give();
        try {
          await this.human.wait(id, signal);
        } finally {
          try {
            await hold.take(signal);
          } finally {
            clock?.resume();
          }
        }
      },
      notify: (id) => this.human.notify(id),
    };
    const deps: TurnDeps = {
      store: this.store,
      jobs: this.jobs,
      gateway: this.gateway,
      engine,
      tools: new Map(tools.map((t) => [t.spec.name, t])),
      human,
      emit,
      now: this.now,
      timeZone: this.o.timeZone ?? "Asia/Taipei",
      profile: this.profileFor(spec.profile ?? this.o.profile ?? DEFAULT_PROFILE, botId, role),
      recall:
        role === "worker"
          ? () => []
          : hooks
            ? (q, i) => hooks.recall(q, i)
            : (this.o.recall ??
              ((q) =>
                this.store.memory
                  .search(q, { visibleTo: botId, limit: 3 })
                  .map((m) => ({ id: m.id, body: m.body })))),
      loopGuardPolicy: settings.engineering.loopGuard,
      maxPasses: spec.maxPasses ?? this.o.maxPasses ?? 8,
      ...(spec.harnessExec ? { harnessExec: true } : {}),
      ...(spec.retry ? { retry: spec.retry } : {}),
      ...(spec.onUsage ? { onUsage: spec.onUsage } : {}),
      ...(spec.passBoundary ? { passBoundary: spec.passBoundary } : {}),
      ...((this.guards ?? this.o.guards) ? { guards: this.guards ?? this.o.guards } : {}),
      ...(hooks?.applied ? { applied: (i) => hooks.applied?.(i) ?? [] } : {}),
      ...(this.restrict ? { restrict: this.restrict } : {}),
    };
    const ctx: TurnContext = {
      threadId,
      runId,
      attended,
      signal: controller.signal,
      deps,
      initiator,
      jobId,
      botId,
      role,
      ownsJob: !spec.jobId,
      ...(spec.workerId ? { workerId: spec.workerId } : {}),
      ...(spec.sessionKey ? { sessionKey: spec.sessionKey } : {}),
      ...(spec.contextLines?.length ? { contextLines: spec.contextLines } : {}),
      ...(memoryNotes.length ? { memoryNotes } : {}),
      ...(mustFollow.length ? { mustFollow } : {}),
      ...(spec.speculative ? { speculative: true } : {}),
      guard: new LoopGuard(settings.engineering.loopGuard, attended),
    };
    const trace: PhaseTrace[] = [];
    this.traces.set(runId, trace);
    // PERF-2026-11: keep the newest runs only (was one entry per run, never removed).
    if (this.traces.size > TRACE_KEEP) this.traces.delete(this.traces.keys().next().value as string);
    const slot = spec.before?.();
    const done = (async () => {
      let acquired = false;
      try {
        if (slot) {
          // Wait (e.g. for the bot's router to finish another thread's turn); an interrupt still ends the run.
          await Promise.race([
            slot.then(() => {
              acquired = true;
            }),
            new Promise<void>((resolve) =>
              controller.signal.addEventListener("abort", () => resolve(), { once: true }),
            ),
          ]);
        } else acquired = true;
        // A free slot among every run; an interrupt while queued still ends the run (persist runs without one).
        await hold.take(controller.signal).catch(() => undefined);
        clock?.start();
        const pipeline = runPipeline(initialState(text), ctx, this.o.pipeline, trace);
        const end = await Promise.race([pipeline, forced]);
        if (end === "forced") {
          // The engine ignored its interrupt: close the run here so the thread is usable again.
          pipeline.catch(() => undefined);
          const finish = {
            reason: "failed" as const,
            error: { code: TURN_TIMEOUT_CODE, message: `turn timed out after ${limitSec}s` },
          };
          emit("run.finished", { reason: "failed" });
          sealed = true;
          this.store.runs.finish(runId, "failed", this.now());
          const jid = ctx.jobId;
          if (ctx.ownsJob && this.jobs.get(jid)?.status === "waiting") this.jobs.resume(jid);
          if (ctx.ownsJob && this.jobs.get(jid)?.status === "running") this.jobs.fail(jid, TURN_TIMEOUT_CODE);
          this.store.threads.touch(threadId, this.now());
          void engine.release?.(key).catch(() => undefined);
          return { ...initialState(text), finish };
        }
        if (hooks) void hooks.afterTurn(info, end).catch(() => undefined);
        for (const ob of this.observers)
          try {
            ob.after?.(info, end);
          } catch {
            // an observer must never break a turn
          }
        return end;
      } catch (err) {
        // Last resort: never leave the run open.
        this.store.runs.finish(runId, "failed", this.now());
        throw err;
      } finally {
        clock?.stop();
        hold.give();
        if (slot && !acquired) {
          // Interrupted while waiting: release the slot as soon as we would have got it.
          void slot.then(() => spec.after?.());
        } else spec.after?.();
        if (spec.track && this.active.get(threadId)?.runId === runId) this.active.delete(threadId);
      }
    })();
    const active: ActiveRun = {
      runId,
      controller,
      emit,
      engine,
      key,
      // Internal handle only (interrupt awaits it); the caller gets `done` and sees any rejection there.
      done: done.then(
        (s) => s.finish?.reason ?? "completed",
        () => "failed" as const,
      ),
    };
    if (spec.track) this.active.set(threadId, active);
    const stop = async () => {
      controller.abort();
      await engine.interrupt(key);
      await done.catch(() => undefined);
    };
    return { runId, done, stop, emit };
  }

  /**
   * Emit an event into the thread's active run from outside the pipeline
   * (e.g. the browser host handing a Space to the user mid-run). Returns
   * undefined when no run is active.
   */
  emitToActiveRun<T extends EventType>(threadId: string, type: T, data: EventData<T>, actor?: ActorT) {
    return this.active.get(threadId)?.emit(type, data, actor);
  }

  /** Answer an approval card once. A second answer (another device, a double click) changes nothing. */
  answerApproval(
    approvalId: string,
    decision: "approved" | "denied",
    by = { kind: "user" as const, id: "local" },
  ): { resolved: boolean } {
    const r = this.gateway.resolveApproval(approvalId, decision, by);
    if (!r.record) throw new NotFoundError(`approval ${approvalId}`);
    if (r.resolved) this.human.notify(approvalId);
    return { resolved: r.resolved };
  }

  answerQuestion(questionId: string, answer: string): { resolved: boolean } {
    if (!this.store.human.question(questionId)) throw new NotFoundError(`question ${questionId}`);
    const resolved = this.store.human.answerQuestion(questionId, answer, this.now());
    if (resolved) this.human.notify(questionId);
    return { resolved };
  }

  /** Stop the thread's running turn (engine interrupt + abort pending waits). */
  async interrupt(threadId: string): Promise<boolean> {
    const a = this.active.get(threadId);
    if (!a) return false;
    a.controller.abort();
    await a.engine.interrupt(a.key);
    await a.done.catch(() => undefined);
    return true;
  }

  async close(): Promise<void> {
    for (const t of [...this.active.keys()]) await this.interrupt(t);
    await this.engine.dispose();
    if (this.router && this.router.engine !== this.engine) await this.router.engine.dispose();
  }
}
