// Worker-harness fixtures (Phase 7): a router that dispatches the person's
// message to a harness, a scripted worker that runs a list of tool calls and
// remembers what each returned, throw-away folders and git repos, and
// readers for the dispatch ledger. Fictional data only; nothing reaches the
// network or a real model.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScriptContext, ScriptStep } from "@alca/engines";
import type { AlcaEvent } from "@alca/protocol";
import type { DispatchEventRecord, DispatchRecord, WorkerRecord } from "@alca/store";
import { type Agents, call, lastLine, say, until } from "./fixtures.ts";

/** The router: the person's message → `worker_start` with `args`; a worker's report → a short reply. */
export const dispatchRouter =
  (args: Record<string, unknown> | ((goal: string) => Record<string, unknown>)) =>
  ({ req, pass }: ScriptContext): ScriptStep[] => {
    if (req.userMessage.includes("<alca:worker")) return say("收到回報");
    const goal = lastLine(req.userMessage);
    return pass === 0
      ? call("s", "worker_start", {
          title: "工作",
          goal,
          ...(typeof args === "function" ? args(goal) : args),
        })
      : say("派了");
  };

export interface Step {
  name: string;
  input: Record<string, unknown>;
}
export interface StepResult extends Step {
  ok: boolean;
  output: string;
}

/**
 * A worker that runs `steps` one per pass (a step may be computed from the
 * results so far), then `report_result` with `report`. Only for single-run
 * tasks: a new run (a verification round, a continuation) starts the list
 * again. `seen.task` / `seen.tools` are what the first pass was given.
 */
export function stepper(
  steps: ReadonlyArray<Step | ((results: StepResult[]) => Step)>,
  report: Record<string, unknown> = { status: "done", summary: "做完了" },
) {
  const seen = { task: "", tools: [] as string[], results: [] as StepResult[] };
  let current: Step | undefined;
  const script = ({ req, pass }: ScriptContext): ScriptStep[] => {
    if (pass === 0) {
      seen.task = req.userMessage;
      seen.tools = (req.tools ?? []).map((t) => t.name);
    }
    const r = req.toolResults?.[0];
    if (pass > 0 && current && r) seen.results.push({ ...current, ok: r.ok, output: r.output });
    current = undefined;
    if (pass < steps.length) {
      const s = steps[pass] as Step | ((results: StepResult[]) => Step);
      current = typeof s === "function" ? s(seen.results) : s;
      return call(`c${pass}`, current.name, current.input);
    }
    if (pass === steps.length) return call("rep", "report_result", report);
    return say("完成");
  };
  return { script, seen };
}

/** Every event of the workers' runs (they are published to `worker:<id>`, not to the thread). */
export function workerEvents(a: Agents): AlcaEvent[] {
  const out: AlcaEvent[] = [];
  const bus = a.core.bus;
  const publishTo = bus.publishTo.bind(bus);
  bus.publishTo = (key, e) => {
    if (key.startsWith("worker:")) out.push(e);
    publishTo(key, e);
  };
  return out;
}

/** The n-th worker report the router got in this thread (optionally one containing `needle`). */
export const reportIn = (a: Agents, threadId: string, o: { needle?: string; n?: number; ms?: number } = {}) =>
  until(() => {
    const ms = a.store.threads
      .messages(threadId)
      .filter(
        (m) =>
          m.role === "system" &&
          m.content.includes("<alca:worker") &&
          (!o.needle || m.content.includes(o.needle)),
      );
    return ms.length >= (o.n ?? 1) ? ms[(o.n ?? 1) - 1] : undefined;
  }, o.ms ?? 20_000);

export interface Ledger {
  row: DispatchRecord | undefined;
  events: DispatchEventRecord[];
  kinds: string[];
}

/** The dispatch a worker serves, with its append-only events. */
export function ledgerOf(a: Agents, w: WorkerRecord | undefined): Ledger {
  const id = w?.grants.dispatchId ?? "";
  const events = id ? a.store.dispatches.events(id) : [];
  return { row: id ? a.store.dispatches.get(id) : undefined, events, kinds: events.map((e) => e.kind) };
}

/** A worker whose run has ended (any status but running / queued). */
export const endedWorker = (a: Agents, threadId: string, i = 0, ms = 20_000) =>
  until(() => {
    const w = a.store.workers.byThread(threadId)[i];
    return w && w.status !== "running" && w.status !== "queued" ? w : undefined;
  }, ms);

/** Throw-away folders, removed by `clean()`. */
export function folders() {
  const made: string[] = [];
  return {
    make(files: Record<string, string | Buffer> = {}, prefix = "alca-eval-"): string {
      const dir = mkdtempSync(join(tmpdir(), prefix));
      made.push(dir);
      for (const [p, body] of Object.entries(files)) {
        mkdirSync(join(dir, p, ".."), { recursive: true });
        writeFileSync(join(dir, p), body);
      }
      return dir;
    },
    clean(): void {
      for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
    },
  };
}

const GIT_ENV = {
  GIT_AUTHOR_NAME: "Eval",
  GIT_AUTHOR_EMAIL: "eval@example.test",
  GIT_COMMITTER_NAME: "Eval",
  GIT_COMMITTER_EMAIL: "eval@example.test",
};

/** Run git in `cwd` with a fictional identity. */
export const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...GIT_ENV },
  }).trim();

/** Make `dir` a git repo with everything in it committed on `main`. */
export function gitInit(dir: string): void {
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "first");
}

/** Approval cards raised so far. */
export const cards = (events: AlcaEvent[]) =>
  events.filter(
    (e): e is Extract<AlcaEvent, { type: "approval.requested" }> => e.type === "approval.requested",
  );

/** The bot's level as a person would set it in the bot settings (完全授權 lives there only). */
export function setBotLevel(a: Agents, level: "full_access"): string {
  const bot = a.store.bots.ensureDefault();
  a.store.bots.update(bot.id, { approvalLevel: level });
  return bot.id;
}
