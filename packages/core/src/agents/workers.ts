import type { Settings } from "@alca/config";
import type { Engine } from "@alca/engines";
import type { AlcaEvent, EventData, EventType, InitiatorT, WorkerStateT } from "@alca/protocol";
import { atomic, type WorkerBudget, type WorkerGrants, type WorkerRecord } from "@alca/store";
import type { AlcaCore } from "../agent.ts";
import { botPromptLanguage, type PromptLanguage } from "../conversation-rules.ts";
import type { CodingTools } from "../harness/coding/tools/index.ts";
import { contractTools, RESULT_SCHEMA_MAX_BYTES } from "../harness/contract.ts";
import { GitSnapshots } from "../harness/git-snapshots.ts";
import { historyTools } from "../harness/history.ts";
import { type HarnessKind, parseBotHarness, resolveBudget } from "../harness/kinds.ts";
import { routerMayAnswer } from "../harness/needs-input.ts";
import { HARNESS_NOTES, harnessProfile, harnessTools } from "../harness/profiles.ts";
import { budgetUsage } from "../harness/usage.ts";
import { callSignature, outcomeKey } from "../loop-guard.ts";
import type { PromptProfile } from "../prompt.ts";
import type { HostTool } from "../turn.ts";
import { type ConfinePlan, confineBox, type SandboxState } from "../workspace/sandbox.ts";
import { checkTokenBudget } from "./harness-run/budget.ts";
import { codingContext, codingTodos, codingToolsFor } from "./harness-run/coding.ts";
import { capLine, continueDispatch, pruneHandoffs } from "./harness-run/continue.ts";
import { dispatchFit, type FullAccessDeps, snapshotBeforeTurn } from "./harness-run/full-access.ts";
import { type GeneralDeps, generalToolsFor } from "./harness-run/general.ts";
import type { HarnessResult } from "./harness-run/ledger.ts";
import { WorkerLedger } from "./harness-run/ledger.ts";
import { followUp, taskMessage } from "./harness-run/messages.ts";
import { reconcileDispatches } from "./harness-run/reconcile.ts";
import { harnessLines } from "./harness-run/report.ts";
import { type Live, type RunResult, runHarness } from "./harness-run/run.ts";
import { finalizeWorker, settleJob } from "./harness-run/settle.ts";
import { RunTally } from "./harness-run/tally.ts";
import { harnessView, shownStatus } from "./harness-run/view.ts";
import { answerWait, expireWaits, stopOpenWait, type WaitDeps, wakeWait } from "./harness-run/waits.ts";

export type WorkersPolicy = Settings["engineering"]["workers"];

export interface StartWorkerInput {
  /** A worker id made up front (a wake claims its wait for this id before the worker exists). */
  id?: string;
  botId: string;
  threadId: string;
  parentRunId?: string;
  title: string;
  goal: string;
  initiator: InitiatorT;
  speculative?: boolean;
  /** Stream keys whose follow-up events should come straight to this worker. */
  subscribe?: readonly string[];
  budget?: WorkerBudget;
  /** Memory / skill ids the router hands over, and the harness of the dispatch (plan §0.2). */
  grants?: WorkerGrants;
}

/** Events of a worker's run that also go to the thread: the cards a person must answer. */
const CARD_EVENTS = new Set([
  "approval.requested",
  "approval.resolved",
  "question.asked",
  "question.answered",
  "handoff.requested",
]);

export interface SupervisorOptions {
  core: AlcaCore;
  engine: Engine;
  /** A bot's own worker engine (P7: engine + model per bot; per harness); undefined = `engine`. */
  engineFor?: (botId: string, harness?: HarnessKind) => Engine | undefined;
  /** Plan §3.2: the default worker engine per harness (one instance each); unset = `engine`. */
  harnessEngines?: Partial<Record<HarnessKind, Engine>>;
  tools: () => readonly HostTool[];
  profile: PromptProfile;
  policy: () => WorkersPolicy;
  /** A worker changed (agents channel `worker.updated`). */
  changed: (w: WorkerStateT) => void;
  /** A worker is done (or needs a person): tell its bot's router. */
  report: (w: WorkerRecord) => void;
  /** A worker's open question expired unanswered (plan §2.8): tell its router once. */
  expired?: (w: WorkerRecord) => void;
  /** The granted memory / skill blocks of a worker's task (P5). */
  context?: (w: WorkerRecord) => string[];
  /** A worker reached a final state (P5: skill proposals). */
  finished?: (w: WorkerRecord) => void;
  /** The folder a coding worker's checks run in (default: the bot's working folder). */
  workDir?: (botId: string) => string | undefined;
  /** Plan §4: the coding tools a coding worker on an API engine gets (its own inner loop). */
  coding?: CodingTools;
  /** Plan §5: tools only general workers get (web_fetch, the script / vault / takeover browser tools). */
  general?: () => readonly HostTool[];
  /** Design §0.2.5: the folder of handoff files (`<data>/handoffs`); none = the handoff rides in the task only. */
  handoffDir?: string;
  now?: () => Date;
}

/**
 * Workers: one isolated session per task. Each has its own id, job, engine
 * conversation, runs and browser Space. They start and stop asynchronously;
 * the router gets the result through its inbox. The turn loop of one
 * execution is `harness-run/run.ts`; this class starts, stops, feeds events
 * to it, and settles what it returns — in the store, the job and (for a
 * harness worker) the dispatch ledger.
 */
export class WorkerSupervisor {
  private readonly o: SupervisorOptions;
  private readonly live = new Map<string, Live>();
  private readonly now: () => Date;
  private closing = false;
  readonly ledger: WorkerLedger;
  /** Phase 5: hidden git snapshots before coding turns at 完全授權 (restore / purge for the UI). */
  readonly snapshots: GitSnapshots;

  constructor(o: SupervisorOptions) {
    this.o = o;
    this.now = o.now ?? (() => new Date());
    this.ledger = new WorkerLedger(o.core.store, this.now);
    this.snapshots = new GitSnapshots({ store: o.core.store, now: this.now });
  }

  private get fullAccess(): FullAccessDeps {
    return {
      store: this.store,
      snapshots: this.snapshots,
      now: this.now,
      levelOf: (botId, threadId) => this.levelOf(botId, threadId),
    };
  }

  private get store() {
    return this.o.core.store;
  }

  /** The engine a bot's workers run on (for one harness). B7: release uses the same one. */
  engineOf(botId: string, harness?: HarnessKind): Engine {
    try {
      return (
        (harness ? this.o.engineFor?.(botId, harness) : this.o.engineFor?.(botId)) ??
        (harness ? this.o.harnessEngines?.[harness] : undefined) ??
        this.o.engine
      );
    } catch {
      return (harness ? this.o.harnessEngines?.[harness] : undefined) ?? this.o.engine;
    }
  }

  state(w: WorkerRecord): WorkerStateT {
    const harness = harnessView(this.store, w, this.harnessResult(w), this.sandboxOf(w));
    return {
      workerId: w.id,
      botId: w.botId,
      threadId: w.threadId,
      title: w.title,
      status: shownStatus(w.status, harness?.phase),
      speculative: w.speculative,
      ...(w.runId ? { runId: w.runId } : {}),
      ...(w.parentRunId ? { parentRunId: w.parentRunId } : {}),
      steps: w.steps,
      createdAt: w.createdAt,
      ...(w.startedAt ? { startedAt: w.startedAt } : {}),
      ...(w.finishedAt ? { finishedAt: w.finishedAt } : {}),
      ...(w.lastActivityAt ? { lastActivityAt: w.lastActivityAt } : {}),
      ...(w.stopReason ? { stopReason: w.stopReason } : {}),
      ...(w.result
        ? {
            result: {
              mode: w.result.mode,
              summary: w.result.summary.slice(0, 600),
              chars: w.result.chars,
              ...(w.result.spillId ? { spillId: w.result.spillId } : {}),
            },
          }
        : {}),
      subscriptions: this.store.triggers.subscriptionsOf(w.id),
      ...(harness ? { harness } : {}),
    };
  }

  private changed(id: string): void {
    const w = this.store.workers.get(id);
    if (w) this.o.changed(this.state(w));
  }

  get(id: string): WorkerRecord | undefined {
    return this.store.workers.get(id);
  }

  list(threadId: string): WorkerRecord[] {
    return this.store.workers.byThread(threadId);
  }

  isLive(id: string): boolean {
    return this.live.has(id);
  }

  /** Emit into a live worker's current run (e.g. the browser handing its Space to the person). */
  emitToRun<T extends EventType>(workerId: string, type: T, data: EventData<T>): boolean {
    const l = this.live.get(workerId);
    if (!l?.emit) return false;
    l.emit(type, data);
    return true;
  }

  /** The last (call, result) keys of a running worker (watchdog). */
  recentCalls(id: string): readonly string[] {
    return this.live.get(id)?.recent ?? [];
  }

  /** The level a bot's work runs at: its own or the team's, the strictest in a peer chain (B12). */
  levelOf(botId: string, threadId: string): string {
    try {
      return this.o.core.levelFor(botId, threadId);
    } catch {
      return "confirm_each_step";
    }
  }

  /** The panel's sandbox label for a worker (cheap: no spec). */
  private sandboxOf(w: WorkerRecord): SandboxState | undefined {
    return w.grants.harness === "coding"
      ? this.o.core.confineOf(w.botId, w.threadId, false)?.state
      : undefined;
  }

  /** Dispatch a task. Returns at once ("started"); the worker runs in the background. */
  start(input: StartWorkerInput): WorkerRecord {
    return this.launch(this.insert(input));
  }

  /**
   * The database half of `start`: every check and row (dispatch, job, worker,
   * subscriptions) in one atomic block, so a throw leaves nothing behind and,
   * inside a caller's block (a claimed wait), rolls that back too.
   */
  private insert(input: StartWorkerInput): WorkerRecord {
    return atomic(this.store.db, () => this.insertRows(input));
  }

  /** The side effects of `start`, only after the rows are committed. */
  private launch(w: WorkerRecord): WorkerRecord {
    this.changed(w.id);
    this.pump();
    return this.store.workers.get(w.id) as WorkerRecord;
  }

  private insertRows(input: StartWorkerInput): WorkerRecord {
    const p = this.o.policy();
    // A router that keeps dispatching (e.g. one worker per report) must not grow the queue without bound.
    const open = this.store.workers.active(input.botId).length;
    if (open >= p.maxConcurrent * 4)
      throw new Error(`這個 bot 已經有 ${open} 個工人還沒做完；請等它們完成或先停掉一些。`);
    const kind = input.grants?.harness;
    const rs = input.grants?.resultSchema;
    if (rs && (!kind || Buffer.byteLength(JSON.stringify(rs)) > RESULT_SCHEMA_MAX_BYTES))
      throw new Error(`resultSchema 只給 harness 工人，序列化後最多 ${RESULT_SCHEMA_MAX_BYTES} 位元組`);
    // Plan §3.1: the host checks the engine's capabilities (Phase 5: by level); the router gets the refusal.
    if (kind) {
      const level = this.levelOf(input.botId, input.threadId);
      const fit = dispatchFit(this.engineOf(input.botId, kind), kind, level);
      if (!fit.ok) throw Object.assign(new Error(fit.reason), { code: fit.code });
    }
    const budget: WorkerBudget = kind
      ? resolveBudget(
          kind,
          parseBotHarness(this.store.bots.get(input.botId)?.harness)[kind],
          {
            ...(input.budget?.maxSteps ? { maxSteps: input.budget.maxSteps } : {}),
            ...(input.budget?.maxRunMs ? { maxWallSec: Math.ceil(input.budget.maxRunMs / 1000) } : {}),
            ...(input.budget?.maxTokens ? { maxTokens: input.budget.maxTokens } : {}),
          },
          p.maxTokens,
        )
      : {
          maxSteps: input.budget?.maxSteps ?? p.maxSteps,
          maxRunMs: input.budget?.maxRunMs ?? p.maxRunSec * 1000,
          maxTokens: input.budget?.maxTokens ?? p.maxTokens,
        };
    const grants: WorkerGrants = { ...(input.grants ?? {}) };
    if (kind && !grants.dispatchId)
      grants.dispatchId = this.ledger.open({
        botId: input.botId,
        threadId: input.threadId,
        harness: kind,
        level: this.levelOf(input.botId, input.threadId),
      });
    const job = this.o.core.jobs.create({
      kind: "subagent",
      threadId: input.threadId,
      botId: input.botId,
      // BUG-4: the title and goal live on the worker row (goal sealed); not copied here.
      input: { speculative: !!input.speculative },
    });
    const w = this.store.workers.create(
      {
        ...(input.id ? { id: input.id } : {}),
        botId: input.botId,
        threadId: input.threadId,
        jobId: job.id,
        parentRunId: input.parentRunId ?? null,
        title: input.title,
        goal: input.goal,
        initiator: input.initiator,
        speculative: !!input.speculative,
        budget,
        ...(Object.keys(grants).length ? { grants } : {}),
      },
      this.now(),
    );
    this.o.core.jobs.record(job.id, "worker.created", { workerId: w.id });
    for (const key of input.subscribe ?? []) {
      const s = this.store.triggers.ensureStream(input.botId, key, key, this.now());
      this.store.triggers.subscribe(s.id, w.id, this.now());
    }
    return this.store.workers.get(w.id) as WorkerRecord;
  }

  private get generalDeps(): GeneralDeps {
    return {
      store: this.store,
      now: this.now,
      live: (id) => this.live.get(id),
      fenced: (w, token) => this.ledger.fenced(w, token),
    };
  }

  private get waits(): WaitDeps {
    return {
      store: this.store,
      now: this.now,
      levelOf: (botId, threadId) => this.levelOf(botId, threadId),
      insert: (input) => this.insert(input),
      launch: (w) => this.launch(w),
    };
  }

  /** Plan §2.8: answer a worker's NEEDS_INPUT (one answer per wait, held by the database). */
  answer(workerId: string, answers: readonly string[], turnInitiator: string): WorkerRecord {
    const next = answerWait(this.waits, workerId, answers, turnInitiator);
    // Phase 6: the asking worker's panel turns from 等你回答 to 已接手.
    this.changed(workerId);
    return next;
  }

  /**
   * Design §0.2.5: 續做 a dispatch whose step budget ran out (router or person;
   * never automatic). Throws the refusal: the limit, no progress twice, or
   * nothing waiting to be continued.
   */
  continue(workerId: string, by: "user" | "router"): WorkerRecord {
    const next = continueDispatch(this.waits, workerId, by);
    this.changed(workerId);
    return next;
  }

  /** Design §0.2.5: a pruned dispatch's handoff files go with it (after `dispatches.prune`). */
  pruneHandoffs(): number {
    return pruneHandoffs(this.o.handoffDir, this.store);
  }

  /** Design §0.2.5: run-out dispatches nobody continued in 72 h settle as budget. */
  expireCaps(): number {
    const gone = this.store.dispatches.caps.expire(this.now().getTime());
    for (const id of gone) {
      const w = this.store.dispatches.get(id)?.activeWorkerId;
      if (w) this.changed(w);
    }
    return gone.length;
  }

  /** Plan §2.9: an awaited event arrived — claim the wait (CAS) before any worker exists; null = already taken. */
  wake(waitId: string, note: string, opts?: { fenced?: boolean }): WorkerRecord | null {
    return wakeWait(this.waits, waitId, note, opts);
  }

  /** Plan §5: event waits whose wake time has come start their continuation workers. */
  wakeDue(): number {
    let n = 0;
    for (const wt of this.store.dispatches.dueEventWaits(this.now().getTime())) {
      try {
        if (this.wake(wt.id, "到了你指定的時間（wakeInMinutes）")) n++;
      } catch {
        // The continuation could not be created; the claim rolled back with it
        // (design §0.2.1), so the wait stays open and the next sweep retries
        // until it expires. One bad wait must not hold up the others.
      }
    }
    return n;
  }

  /** Plan §2.8: text questions unanswered for 72 hours expire; each tells its router once. */
  expireWaits(): number {
    const gone = expireWaits(this.waits);
    for (const w of gone) this.o.expired?.(w);
    return gone.length;
  }

  /** Stop a worker (person, router or watchdog). Queued ones finish at once; running ones are interrupted. */
  async stop(id: string, reason: string): Promise<boolean> {
    const w = this.store.workers.get(id);
    if (!w) return false;
    const l = this.live.get(id);
    if (l) {
      l.stopReason ??= reason;
      l.abort.abort();
      await l.stop();
      return true;
    }
    if (w.status === "queued" || w.status === "needs_review") {
      settleJob(this.o.core.jobs, w, "cancelled", reason);
      this.store.workers.finish(id, "stopped", this.now(), { stopReason: reason });
      if (w.grants.dispatchId)
        this.store.dispatches.park(w.grants.dispatchId, "stopped", this.now().getTime(), "settled");
      this.changed(id);
      this.o.report(this.store.workers.get(id) as WorkerRecord);
      return true;
    }
    // Design §0.2.5: a run-out dispatch waiting for 續做 settles as stopped.
    if (
      w.grants.dispatchId &&
      this.store.dispatches.caps.close(w.grants.dispatchId, "stopped", this.now().getTime())
    ) {
      this.changed(id);
      return true;
    }
    // Ended with its question still open: the wait closes and the dispatch settles as stopped.
    if (stopOpenWait(this.waits, w, reason)) {
      this.changed(id);
      return true;
    }
    return false;
  }

  /** A stream event for a subscribed worker: it gets it on its next turn, never through the router. */
  deliver(workerId: string, body: string, streamId: string | null, eventId: string | null): void {
    this.store.workers.addWorkerInbox({ workerId, streamId, eventId, body }, this.now());
    this.pump();
  }

  /** Start queued workers while each bot has capacity. */
  pump(): void {
    if (this.closing) return;
    const max = this.o.policy().maxConcurrent;
    const perBot = new Map<string, number>();
    for (const id of this.live.keys()) {
      const b = this.store.workers.get(id)?.botId;
      if (b) perBot.set(b, (perBot.get(b) ?? 0) + 1);
    }
    for (const w of this.store.workers.active()) {
      if (w.status !== "queued" || this.live.has(w.id)) continue;
      const n = perBot.get(w.botId) ?? 0;
      if (n >= max) continue;
      perBot.set(w.botId, n + 1);
      void this.run(w);
    }
  }

  /**
   * After a restart (call after `AlcaCore.recover`, which already requeued or
   * parked the jobs): unfinished workers follow their job.
   */
  recover(): { resumed: number; review: number; closed: number } {
    let resumed = 0;
    let review = 0;
    let closed = 0;
    const rows = [
      ...this.store.workers.active(),
      ...this.store.db
        .prepare("SELECT id FROM workers WHERE status = 'needs_review'")
        .all()
        .map((r) => this.store.workers.get((r as { id: string }).id) as WorkerRecord),
    ];
    for (const w of rows) {
      const job = this.o.core.jobs.get(w.jobId);
      if (!job) continue;
      if (job.needsReview) {
        if (w.status !== "needs_review") {
          this.store.workers.setStatus(w.id, "needs_review", { stopReason: "restart.outbound" });
          review++;
          this.o.report(this.store.workers.get(w.id) as WorkerRecord);
        }
      } else if (job.status === "queued") {
        this.store.workers.setStatus(w.id, "queued");
        resumed++;
      } else if (job.status === "succeeded" || job.status === "failed" || job.status === "cancelled") {
        this.store.workers.finish(w.id, job.status === "succeeded" ? "succeeded" : "stopped", this.now(), {
          stopReason: "restart",
        });
        closed++;
      }
      this.changed(w.id);
    }
    return { resumed, review, closed };
  }

  /** Plan §2.9: after `recover`, the dispatch ledger decides requeue once / park / fail. */
  reconcile(): ReturnType<typeof reconcileDispatches> {
    return reconcileDispatches({
      store: this.store,
      jobs: this.o.core.jobs,
      now: this.now,
      report: (w) => this.o.report(w),
      changed: (id) => this.changed(id),
    });
  }

  private languageOf(w: WorkerRecord): PromptLanguage {
    try {
      return botPromptLanguage(this.store.bots.get(w.botId));
    } catch {
      return "zh";
    }
  }

  /** The tools of a run: a harness worker gets its harness's set, the contract and its task history. */
  private toolsOf(w: WorkerRecord, reportOnly: boolean): readonly HostTool[] {
    const kind = w.grants.harness;
    if (!kind) return this.o.tools();
    const contract = contractTools({
      report: (id, r) => {
        const l = this.live.get(id);
        if (!l) return "這個工人已經結束了";
        if (!this.ledger.fenced(w, l.token)) return "這個工人已經被取代，結果不會被採用；請停止。";
        l.tally.report = r;
        return undefined;
      },
      handoff: (id, h) => {
        const l = this.live.get(id);
        if (!l) return "這個工人已經結束了";
        if (w.grants.handoffFrom)
          return "這件工作已經換手過一次，不能再換手；請在 report_result 說明卡在哪裡";
        l.tally.handoff = h;
        return undefined;
      },
      harnessOf: () => kind,
      resultSchema: w.grants.resultSchema,
    });
    if (reportOnly) return contract.filter((t) => t.spec.name === "report_result");
    if (kind === "general")
      return [
        ...generalToolsFor(this.generalDeps, this.o.tools(), this.o.general?.() ?? []),
        ...contract,
        ...historyTools(this.store),
      ];
    const coding = codingToolsFor(this.o.coding, w, this.engineOf(w.botId, kind), (tool, full) =>
      this.addSpill(w, `${tool} 的完整輸出`, full),
    );
    return [...harnessTools(kind, [...this.o.tools(), ...coding]), ...contract, ...historyTools(this.store)];
  }

  private onEvent(workerId: string, e: AlcaEvent): void {
    const { core } = this.o;
    core.bus.publishTo(`worker:${workerId}`, e);
    if (CARD_EVENTS.has(e.type)) core.bus.publish(e);
    const l = this.live.get(workerId);
    const now = this.now();
    switch (e.type) {
      case "tool.requested":
        l?.calls.set(e.data.callId, callSignature(e.data.tool, e.data.args));
        l?.tally.requested(e.data.callId, e.data.tool, e.data.args, e.data.actionClass);
        this.store.workers.activity(workerId, now);
        break;
      case "tool.completed": {
        const output = e.data.ok ? resultText(e.data.result) : (e.data.error ?? "");
        if (l) {
          // A failed step the worker did not get past makes its result a failure, whatever its turn said.
          if (e.data.ok) l.lastToolError = null;
          else {
            l.toolErrors++;
            l.lastToolError = (e.data.error ?? "工具回報失敗").slice(0, 300);
          }
        }
        const sig = l?.calls.get(e.data.callId);
        if (l && sig) {
          l.recent.push(outcomeKey(sig, e.data.ok, output));
          if (l.recent.length > 200) l.recent.splice(0, l.recent.length - 200);
        }
        const done = l?.tally.completed(e.data.callId, e.data.ok, output);
        this.store.workers.activity(workerId, now, { steps: 1 });
        const w = this.store.workers.get(workerId);
        if (l && w?.grants.harness && done) {
          this.ledger.progress(w, l.token, { steps: w.steps, tool: done.tool });
          if (done.outward) this.ledger.outward(w, l.token, done.tool);
          // Plan §2.3: a step is a tool.completed, for every engine; at the budget the turn ends.
          const max = w.budget.maxSteps ?? this.o.policy().maxSteps;
          if (!l.tally.budgetHit && !l.tally.budgetPass && w.steps >= max) {
            l.tally.budgetHit = true;
            void l.stop();
          }
          // Mac test B3: tokens too — before the next call would cross the budget, not after.
          checkTokenBudget(w, l);
          // Plan §5: after await_event the turn ends at once (no polling in the same turn).
          if (done.tool === "await_event" && done.ok && l.tally.awaiting) void l.stop();
        }
        this.changed(workerId);
        break;
      }
      case "message.delta":
        // Text is activity too; write it at most once a second.
        if (l && now.getTime() - l.lastFlush > 1000) {
          l.lastFlush = now.getTime();
          this.store.workers.activity(workerId, now);
        }
        break;
      case "approval.requested":
      case "question.asked":
        this.store.workers.setWaiting(workerId, true, now);
        this.changed(workerId);
        break;
      case "approval.resolved":
      case "question.answered":
        this.store.workers.setWaiting(workerId, false, now);
        this.changed(workerId);
        break;
      case "run.finished": {
        // Harness workers book tokens as usage arrives (plan §2.3); plain ones at the end of a run.
        const u = e.data.usage;
        if (u && !l?.tally.kind) {
          const b = budgetUsage(u);
          this.store.workers.activity(workerId, now, { tokens: b.counted, cachedTokens: b.cached });
        }
        break;
      }
      default:
        break;
    }
  }

  private async run(first: WorkerRecord): Promise<void> {
    const { core } = this.o;
    const kind = first.grants.harness;
    const live: Live = {
      runId: "",
      stop: async () => undefined,
      abort: new AbortController(),
      recent: [],
      calls: new Map(),
      lastFlush: 0,
      toolErrors: 0,
      lastToolError: null,
      tally: new RunTally(kind),
      sessionKey: first.id,
    };
    if (kind) {
      live.token = this.ledger.begin(first);
      if (!live.token) {
        // Superseded (another worker holds the dispatch): it must not run or write anything.
        settleJob(this.o.core.jobs, first, "cancelled", "superseded");
        this.store.workers.finish(first.id, "stopped", this.now(), { stopReason: "superseded" });
        this.changed(first.id);
        return;
      }
    }
    const job = core.jobs.get(first.jobId);
    if (job?.status === "queued") core.jobs.start(job.id, `worker:${first.id}`);
    this.live.set(first.id, live);
    const engine = this.engineOf(first.botId, kind);
    let res: RunResult;
    try {
      res = await runHarness(
        {
          core,
          ledger: this.ledger,
          now: this.now,
          closing: () => this.closing,
          engine: () => engine,
          tools: (w, reportOnly) => this.toolsOf(w, reportOnly),
          profile: (w) => {
            // R9.6: the worker rules in the bot's language (the Chinese profile is the same object as before).
            const lang = this.languageOf(w);
            if (w.grants.harness)
              return { ...harnessProfile(this.o.profile, w.grants.harness, lang), language: lang };
            return lang === "zh" ? this.o.profile : { ...this.o.profile, language: lang };
          },
          language: (w) => this.languageOf(w),
          maxSteps: (w) => w.budget.maxSteps ?? this.o.policy().maxSteps,
          onEvent: (id, e) => this.onEvent(id, e),
          taskMessage: (w, resumed) =>
            taskMessage(
              {
                language: (x) => this.languageOf(x),
                context: (x) => [
                  ...(this.o.context?.(x) ?? []),
                  ...codingContext(this.o.coding, x, engine, this.workDirOf(x)),
                ],
              },
              w,
              resumed,
            ),
          todos: (w) => codingTodos(this.o.coding, w),
          followUp,
          workDir: (w) => this.workDirOf(w),
          confine: (w) => confineBox(this.o.core.confineOf(w.botId, w.threadId)),
          spill: (w, title, body) => this.addSpill(w, title, body),
          beforeTurn: (w) => snapshotBeforeTurn(this.fullAccess, w, engine, this.workDirOf(w)),
          reviewer: (w) => parseBotHarness(this.store.bots.get(w.botId)?.harness).reviewer === true,
          changed: (id) => this.changed(id),
        },
        first,
        live,
      );
    } finally {
      this.live.delete(first.id);
    }
    // Shutting down: leave the worker unfinished so recovery resumes it after the restart.
    if (this.closing && !live.stopReason) return;
    finalizeWorker(
      {
        store: this.store,
        jobs: core.jobs,
        ledger: this.ledger,
        now: this.now,
        policy: this.o.policy,
        noChecks: (w) => HARNESS_NOTES[this.languageOf(w)].noChecks,
        changed: (id) => this.changed(id),
        report: (w) => this.o.report(w),
        finished: this.o.finished,
        handoffDir: this.o.handoffDir,
        todos: (w) => codingTodos(this.o.coding, w),
      },
      first.id,
      res,
      live,
    );
    // B7: release the conversation this execution really used, on the engine it ran on.
    void engine.release?.(live.sessionKey)?.catch?.(() => undefined);
    // Plan §4: the worker's shell sessions end with it; what it read is forgotten.
    this.o.coding?.release(first.id);
    this.pump();
  }

  /** The folder a coding worker's checks run in: its dispatch's subfolder of the bot's folder, if inside. */
  /** Keep a long text for a worker (a check's output, a cut tool output); its id. */
  addSpill(w: WorkerRecord, title: string, body: string): string {
    return this.store.workers.addSpill(
      { botId: w.botId, ownerKind: "worker", ownerId: w.id, title, body },
      this.now(),
    ).id;
  }

  /** The folder a worker works in (its coding tools' root). */
  /** Next-round §5: the OS sandbox a worker's commands run in (its bot, its conversation's level). */
  confineFor(workerId: string, withSpec = true): ConfinePlan | undefined {
    const w = this.store.workers.get(workerId);
    return w ? this.o.core.confineOf(w.botId, w.threadId, withSpec) : undefined;
  }

  workDirFor(workerId: string): string | undefined {
    const w = this.store.workers.get(workerId);
    return w ? this.workDirOf(w) : undefined;
  }

  private workDirOf(w: Pick<WorkerRecord, "botId" | "grants">): string | undefined {
    const base = this.o.workDir?.(w.botId) ?? this.o.core.workDirOf(w.botId);
    if (!base || !w.grants.workdir) return base;
    const sub = w.grants.workdir.replace(/^\/+/, "");
    if (sub.split(/[\\/]/).includes("..")) return base;
    return `${base.replace(/\/+$/, "")}/${sub}`;
  }

  /** What the harness recorded for a worker (its report and counted actions). */
  harnessResult(w: WorkerRecord): HarnessResult | undefined {
    return w.grants.harness ? this.ledger.result(w) : undefined;
  }

  /** The harness part of a worker's report to the router: counted actions and its own words, side by side. */
  harnessLines(w: WorkerRecord): string[] | undefined {
    const r = this.harnessResult(w);
    if (!r) return undefined;
    const qs = r.report.questions ?? [];
    const cap = capLine(this.store, w);
    return [
      ...harnessLines(r, routerMayAnswer(qs, this.levelOf(w.botId, w.threadId))),
      ...(cap ? [cap] : []),
    ];
  }

  /** Shut down: interrupt live workers but keep them unfinished, so a restart resumes them. */
  async close(): Promise<void> {
    this.closing = true;
    for (const l of this.live.values()) l.abort.abort();
    this.o.coding?.closeAll();
    await Promise.all([...this.live.values()].map((l) => l.stop()));
  }
}

const resultText = (v: unknown): string =>
  typeof v === "string" ? v : v === undefined ? "" : JSON.stringify(v);
