// Phase 7 — restarts and races in the worker harness: restart reconciliation
// (an outward action is never redone), the dispatch writer fence, a wait that
// survives a restart, two workers on one file, git snapshots, and the sweep
// after a dispatch settled. File-backed stores are reopened the way a crashed
// desktop would reopen them. Fictional data only.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CodingTools,
  GitSnapshots,
  type HostTool,
  SNAPSHOT_KEEP_MS,
  SNAPSHOT_REF_PREFIX,
  SNAPSHOTS_PER_REPO,
} from "@alca/core";
import type { Script, ScriptContext, ScriptStep } from "@alca/engines";
import type { WorkerRecord } from "@alca/store";
import { type Agents, agentSystem, call, evalStore, lastLine, say, tool, until } from "../src/fixtures.ts";
import type { Scenario } from "../src/harness.ts";
import { dispatchRouter, folders, git, gitInit, ledgerOf, reportIn } from "../src/harness-fixtures.ts";

/** Start a system on a file-backed store; `reopen` closes it the way a crash would and starts a new one. */
function crashable(
  path: string,
  o: { router: Script; worker: Script; tools?: HostTool[]; now?: () => Date },
) {
  const make = () =>
    agentSystem({
      router: o.router,
      worker: o.worker,
      level: "autonomous",
      store: evalStore(path),
      ...(o.tools ? { tools: o.tools } : {}),
      system: { webFetch: false, ...(o.now ? { now: o.now } : {}) },
    });
  let a: Agents = make();
  return {
    get a() {
      return a;
    },
    async reopen() {
      await a.close();
      a.store.close();
      a = make();
      a.core.recover();
      const r = a.agents.recover();
      a.agents.start();
      return r;
    },
    async close() {
      await a.close();
      a.store.close();
    },
  };
}

export const restartHarnessScenarios: Scenario[] = [
  {
    id: "harness.restart.outward-not-redone",
    category: "restart",
    title:
      "crash after an approved send: that dispatch goes to needs_review and never sends again; a quiet one resumes once",
    timeoutMs: 40_000,
    async run(ctx) {
      const f = folders();
      const send = tool("mail_send", "send");
      let resumed = "";
      const goals = new Map<string, { goal: string; again: boolean }>();
      const worker = ({ req, pass }: ScriptContext): ScriptStep[] => {
        if (pass === 0)
          goals.set(req.runId, {
            goal: lastLine(req.userMessage),
            again: req.userMessage.includes("重啟切斷"),
          });
        const { goal, again } = goals.get(req.runId) ?? { goal: "", again: false };
        if (goal === "寄出報價" && pass === 0) return call("m", "mail_send", { to: "buyer@example.test" });
        if (goal === "整理筆記" && again) {
          if (pass > 0) return say("完成");
          resumed = req.userMessage;
          return call("r", "report_result", { status: "done", summary: "接著做完了" });
        }
        return [{ type: "wait", ms: 60_000 }];
      };
      const sys = crashable(join(f.make(), "state.sqlite"), {
        router: dispatchRouter({ harness: "general" }),
        worker,
        tools: [send],
      });
      try {
        const t = sys.a.core.createThread();
        await sys.a.core.send(t.id, "寄出報價").done;
        const card = await until(() => sys.a.store.human.pendingApprovals()[0], 15_000);
        sys.a.core.answerApproval(card.id, "approved");
        await until(() => send.calls.length === 1);
        await sys.a.core.send(t.id, "整理筆記").done;
        await until(
          () =>
            sys.a.store.workers.byThread(t.id).length === 2 &&
            sys.a.store.workers.byThread(t.id).every((w) => w.status === "running"),
        );
        const [sender, quiet] = sys.a.store.workers.byThread(t.id) as [WorkerRecord, WorkerRecord];
        const r = await sys.reopen();
        ctx.check(
          "reconciliation: one parked for review, one requeued",
          r.ledger?.review === 1 && r.ledger?.requeued === 1,
          r.ledger,
        );
        await until(() => sys.a.store.workers.get(quiet.id)?.status === "succeeded", 15_000);
        ctx.check("the send ran exactly once", send.calls.length === 1, send.calls);
        ctx.check(
          "the sender is needs_review",
          sys.a.store.workers.get(sender.id)?.status === "needs_review",
        );
        const s = ledgerOf(sys.a, sender);
        ctx.check(
          "its dispatch: interrupted_after_outward",
          s.row?.status === "needs_review" && s.row.outcome === "interrupted_after_outward",
          s.row,
        );
        ctx.check("the outward action is in the ledger", s.kinds.includes("outward"), s.kinds);
        ctx.check("no second approval was asked", sys.a.store.human.pendingApprovals().length === 0);
        ctx.check(
          "the quiet one resumed with the restart note",
          resumed.includes("上個回合被重啟切斷"),
          resumed.slice(0, 300),
        );
        const q = ledgerOf(sys.a, quiet);
        ctx.check(
          "its dispatch: done after one requeue",
          q.row?.outcome === "done" && q.row.requeues === 1,
          q.row,
        );
      } finally {
        await sys.close();
        f.clean();
      }
    },
  },
  {
    id: "harness.restart.writer-fence",
    category: "restart",
    title:
      "writer fence: after a requeue the old execution can neither settle nor overwrite; the new one settles once",
    async run(ctx) {
      const store = evalStore();
      try {
        const d = store.dispatches.open(
          { botId: "bot_fic", threadId: "thr_fic", harness: "coding", level: "autonomous" },
          1000,
        );
        ctx.check("execution A begins", store.dispatches.begin(d.id, "wkr_a", "wkr_a:one", 1001));
        ctx.check(
          "another worker cannot begin while A holds it",
          !store.dispatches.begin(d.id, "wkr_b", "wkr_b:one", 1002),
        );
        store.dispatches.requeue(d.id, 1003); // a restart cut A off
        ctx.check("A's continuation begins as B", store.dispatches.begin(d.id, "wkr_a", "wkr_a:two", 1004));
        ctx.check(
          "A is no longer the writer",
          !store.dispatches.fenced(d.id, "wkr_a:one") && store.dispatches.fenced(d.id, "wkr_a:two"),
        );
        ctx.check(
          "A's late settle is refused",
          !store.dispatches.settle(d.id, "wkr_a:one", "done", { by: "A" }, 1005),
        );
        ctx.check("B settles", store.dispatches.settle(d.id, "wkr_a:two", "done", { by: "B" }, 1006));
        ctx.check(
          "B cannot settle twice",
          !store.dispatches.settle(d.id, "wkr_a:two", "failed", { by: "B2" }, 1007),
        );
        const row = store.dispatches.get(d.id);
        ctx.check(
          "the report is B's",
          (row?.report as { by?: string } | undefined)?.by === "B" && row?.outcome === "done",
          row,
        );
        ctx.check(
          "exactly one reported event",
          store.dispatches.events(d.id).filter((e) => e.kind === "reported").length === 1,
        );
      } finally {
        store.close();
      }
    },
  },
  {
    id: "harness.restart.wait-survives",
    category: "restart",
    title:
      "an await_event wait survives a restart: still open after reopening, then the clock wakes one continuation",
    timeoutMs: 40_000,
    async run(ctx) {
      const f = folders();
      let clock = Date.parse("Thu 2026-11-05 5:00 PM CST (UTC+08:00)");
      const worker = ({ req, pass }: ScriptContext): ScriptStep[] => {
        if (!req.userMessage.includes("等待的事件到了"))
          return pass === 0
            ? call("w", "await_event", { note: "等包裹送達再通知", wakeInMinutes: 30 })
            : say("等");
        return pass === 0
          ? call("rep", "report_result", { status: "done", summary: "包裹到了。" })
          : say("完成");
      };
      const sys = crashable(join(f.make(), "state.sqlite"), {
        router: dispatchRouter({ harness: "general" }),
        worker,
        now: () => new Date(clock),
      });
      try {
        const t = sys.a.core.createThread();
        await sys.a.core.send(t.id, "包裹到了告訴我").done;
        await reportIn(sys.a, t.id);
        const w1 = sys.a.store.workers.byThread(t.id)[0] as WorkerRecord;
        const dsp = w1.grants.dispatchId ?? "";
        const wait = sys.a.store.dispatches.waitOf(w1.id);
        await until(() => !sys.a.core.isBusy(t.id));
        const r = await sys.reopen();
        ctx.check(
          "reconciliation leaves a waiting dispatch alone",
          (r.ledger?.requeued ?? 0) + (r.ledger?.failed ?? 0) + (r.ledger?.review ?? 0) === 0,
          r.ledger,
        );
        ctx.check(
          "after the restart the wait is still open",
          sys.a.store.dispatches.wait(wait?.id ?? "")?.state === "open",
        );
        ctx.check(
          "the dispatch is still waiting_event",
          sys.a.store.dispatches.get(dsp)?.status === "waiting_event",
        );
        sys.a.agents.sweep();
        ctx.check("not woken before its time", sys.a.store.workers.byThread(t.id).length === 1);
        clock += 31 * 60_000;
        sys.a.agents.sweep();
        sys.a.agents.sweep();
        await until(() => sys.a.store.dispatches.get(dsp)?.outcome === "done", 15_000);
        const all = sys.a.store.workers.byThread(t.id);
        ctx.check(
          "one continuation, on the same dispatch",
          all.length === 2 && all.every((w) => w.grants.dispatchId === dsp),
          all.length,
        );
        ctx.check("the wait closed", sys.a.store.dispatches.wait(wait?.id ?? "")?.state === "closed");
      } finally {
        await sys.close();
        f.clean();
      }
    },
  },
  {
    id: "harness.restart.same-path-race",
    category: "restart",
    title:
      "two workers edit one file at once: the lock queues them, the second is told the file changed, nothing is lost",
    async run(ctx) {
      const f = folders();
      const dir = f.make({ "shared.ts": "a = 1;\nb = 1;\n" });
      const tools = new CodingTools({ dirFor: () => dir, rg: false, spill: () => undefined });
      const byName = new Map(tools.tools().map((x) => [x.spec.name, x] as const));
      const run = (name: string, args: Record<string, unknown>, workerId: string) =>
        (byName.get(name) as HostTool).run(args, new AbortController().signal, {
          actionClass: "write",
          threadId: "thr_fic",
          runId: `run_${workerId}`,
          botId: "bot_fic",
          workerId,
        });
      try {
        await run("read", { path: "shared.ts" }, "wkr_a");
        await run("read", { path: "shared.ts" }, "wkr_b");
        const [x, y] = await Promise.allSettled([
          run("edit", { path: "shared.ts", edits: [{ old: "a = 1;", new: "a = 2;" }] }, "wkr_a"),
          run("edit", { path: "shared.ts", edits: [{ old: "b = 1;", new: "b = 2;" }] }, "wkr_b"),
        ]);
        ctx.check("the first edit applied", x.status === "fulfilled", x);
        ctx.check(
          "the second was refused as stale",
          y.status === "rejected" && /已被修改/.test(String(y.reason)),
          y,
        );
        const mid = readFileSync(join(dir, "shared.ts"), "utf8");
        ctx.check("no lost update: only the first change", mid === "a = 2;\nb = 1;\n", mid);
        await run("read", { path: "shared.ts" }, "wkr_b");
        await run("edit", { path: "shared.ts", edits: [{ old: "b = 1;", new: "b = 2;" }] }, "wkr_b");
        const end = readFileSync(join(dir, "shared.ts"), "utf8");
        ctx.check("after re-reading, both changes are there", end === "a = 2;\nb = 2;\n", end);
      } finally {
        tools.closeAll();
        f.clean();
      }
    },
  },
  {
    id: "harness.restart.snapshots",
    category: "restart",
    title:
      "git snapshots: at most 20 per repo (oldest first), restore brings files back, expired ones are swept",
    timeoutMs: 40_000,
    async run(ctx) {
      const f = folders();
      const dir = f.make({ "a.txt": "one\n" });
      gitInit(dir);
      const store = evalStore();
      let clock = Date.UTC(2026, 10, 5, 1, 0, 0);
      const snaps = new GitSnapshots({ store, now: () => new Date(clock) });
      const refs = () =>
        git(dir, "for-each-ref", "--format=%(refname)", SNAPSHOT_REF_PREFIX).split("\n").filter(Boolean);
      try {
        for (let i = 0; i < SNAPSHOTS_PER_REPO + 3; i++) {
          clock += 1000;
          writeFileSync(join(dir, "a.txt"), `v${i}\n`);
          snaps.take(dir, "dsp_cap");
        }
        ctx.check("capped at 20 refs", refs().length === SNAPSHOTS_PER_REPO, refs().length);
        ctx.check(
          "the three oldest went first",
          ![1, 2, 3].some((n) => refs().includes(`${SNAPSHOT_REF_PREFIX}/dsp_cap/${n}`)) &&
            refs().includes(`${SNAPSHOT_REF_PREFIX}/dsp_cap/4`),
        );
        snaps.purge({ repo: dir });
        writeFileSync(join(dir, "a.txt"), "before the turn\n");
        const s = snaps.take(dir, "dsp_r");
        writeFileSync(join(dir, "a.txt"), "broken by the turn\n");
        writeFileSync(join(dir, "stray.txt"), "made by the turn\n");
        const head = git(dir, "rev-parse", "HEAD");
        const r = snaps.restore(dir, s?.ref as string);
        ctx.check(
          "restore puts the file back",
          readFileSync(join(dir, "a.txt"), "utf8") === "before the turn\n",
        );
        ctx.check(
          "restore removes the newer file",
          r.removed === 1 && !git(dir, "status", "--porcelain").includes("stray.txt"),
        );
        ctx.check("HEAD is untouched", git(dir, "rev-parse", "HEAD") === head);
        snaps.purge({ repo: dir });
        const done = store.dispatches.open(
          { botId: "bot_fic", threadId: "thr_fic", harness: "coding", level: "full_access" },
          clock,
        );
        const open = store.dispatches.open(
          { botId: "bot_fic", threadId: "thr_fic", harness: "coding", level: "full_access" },
          clock,
        );
        snaps.take(dir, done.id);
        snaps.take(dir, open.id);
        store.dispatches.park(done.id, "done", clock, "settled");
        clock += SNAPSHOT_KEEP_MS - 60_000;
        ctx.check("kept within seven days", snaps.sweep().expired === 0 && refs().length === 2);
        clock += 120_000;
        ctx.check("swept after seven days", snaps.sweep().expired === 1);
        ctx.check(
          "an unsettled dispatch's snapshot stays",
          refs().join() === `${SNAPSHOT_REF_PREFIX}/${open.id}/1`,
          refs(),
        );
      } finally {
        store.close();
        f.clean();
      }
    },
  },
  {
    id: "harness.restart.sweep-after-settle",
    category: "restart",
    title: "after a dispatch settles, later sweeps neither expire, wake nor restart it",
    timeoutMs: 30_000,
    async run(ctx) {
      let now = Date.parse("Wed 2026-11-04 9:00 AM CST (UTC+08:00)");
      const continued = new Map<string, boolean>();
      const worker = ({ req, pass }: ScriptContext): ScriptStep[] => {
        if (pass === 0) continued.set(req.runId, req.userMessage.includes("回答（"));
        if (!continued.get(req.runId))
          return pass === 0
            ? call("q", "report_result", {
                status: "needs_input",
                summary: "要地址",
                questions: [{ question: "收件地址是什麼？" }],
              })
            : say("等");
        return pass === 0 ? call("d", "report_result", { status: "done", summary: "寄好了" }) : say("完成");
      };
      const a = agentSystem({
        router: dispatchRouter({ harness: "general" }),
        worker,
        level: "autonomous",
        system: { webFetch: false, now: () => new Date(now) },
      });
      try {
        const t = a.core.createThread();
        await a.core.send(t.id, "寄一張卡片").done;
        await reportIn(a, t.id, { needle: "NEEDS_INPUT" });
        await until(() => !a.core.isBusy(t.id));
        const first = a.store.workers.byThread(t.id)[0] as WorkerRecord;
        const next = a.agents.workers.answer(first.id, ["虛構市北區 1 號"], "user");
        await until(() => a.store.workers.get(next.id)?.status === "succeeded", 15_000);
        const before = ledgerOf(a, first);
        ctx.check(
          "settled done",
          before.row?.status === "settled" && before.row.outcome === "done",
          before.row,
        );
        now += 73 * 3600_000;
        const swept = [a.agents.sweep(), a.agents.sweep()];
        ctx.check(
          "nothing expires after it settled",
          swept.every((s) => s.expired === 0),
          swept,
        );
        const after = ledgerOf(a, first);
        ctx.check("the outcome is still done", after.row?.outcome === "done", after.row);
        ctx.check(
          "no event was appended by the sweeps",
          after.events.length === before.events.length,
          after.kinds,
        );
        ctx.check("no new worker", a.store.workers.byThread(t.id).length === 2);
        ctx.check("the wait is closed", a.store.dispatches.waitOf(first.id)?.state === "closed");
        ctx.check("no due event waits", a.store.dispatches.dueEventWaits(now).length === 0);
      } finally {
        await a.close();
      }
    },
  },
  {
    id: "harness.restart.claim-then-insert-fails",
    category: "restart",
    title:
      "design §0.2.1: the clock's wake claims the wait but the continuation cannot be created → the claim rolls back; the next sweep wakes it once; an old stuck dispatch is settled at restart",
    timeoutMs: 40_000,
    async run(ctx) {
      const f = folders();
      let clock = Date.parse("Thu 2026-11-05 5:00 PM CST (UTC+08:00)");
      const worker = ({ req, pass }: ScriptContext): ScriptStep[] => {
        if (!req.userMessage.includes("等待的事件到了"))
          return pass === 0
            ? call("w", "await_event", { note: "等包裹送達再通知", wakeInMinutes: 30 })
            : say("等");
        return pass === 0
          ? call("rep", "report_result", { status: "done", summary: "包裹到了。" })
          : say("完成");
      };
      const sys = crashable(join(f.make(), "state.sqlite"), {
        router: dispatchRouter({ harness: "general" }),
        worker,
        now: () => new Date(clock),
      });
      try {
        const t = sys.a.core.createThread();
        await sys.a.core.send(t.id, "包裹到了告訴我").done;
        await reportIn(sys.a, t.id);
        const w1 = sys.a.store.workers.byThread(t.id)[0] as WorkerRecord;
        const dsp = w1.grants.dispatchId ?? "";
        const wait = sys.a.store.dispatches.waitOf(w1.id);
        await until(() => !sys.a.core.isBusy(t.id));
        clock += 31 * 60_000;
        const jobs = sys.a.core.jobs;
        const create = jobs.create.bind(jobs);
        jobs.create = () => {
          throw new Error("disk I/O error");
        };
        sys.a.agents.sweep();
        jobs.create = create;
        ctx.check(
          "the failed wake left the wait open",
          sys.a.store.dispatches.wait(wait?.id ?? "")?.state === "open",
        );
        ctx.check(
          "the dispatch is still waiting_event (not queued for a missing worker)",
          sys.a.store.dispatches.get(dsp)?.status === "waiting_event",
          sys.a.store.dispatches.get(dsp),
        );
        ctx.check("no worker was made", sys.a.store.workers.byThread(t.id).length === 1);
        sys.a.agents.sweep();
        await until(() => sys.a.store.dispatches.get(dsp)?.outcome === "done", 15_000);
        ctx.check(
          "the next sweep woke exactly one continuation",
          sys.a.store.workers.byThread(t.id).length === 2,
        );

        // Data left by the old two-transaction code: a claim with no worker.
        const t2 = sys.a.core.createThread();
        await sys.a.core.send(t2.id, "包裹到了告訴我").done;
        await reportIn(sys.a, t2.id);
        const w2 = sys.a.store.workers.byThread(t2.id)[0] as WorkerRecord;
        const dsp2 = w2.grants.dispatchId ?? "";
        await until(() => !sys.a.core.isBusy(t2.id));
        const wait2 = sys.a.store.dispatches.waitOf(w2.id);
        sys.a.store.dispatches.claim(wait2?.id ?? "", "wkr_01NEVERMADE00000000000000", clock);
        const r = await sys.reopen();
        ctx.check("restart reconciliation counts the orphan", r.ledger?.orphaned === 1, r.ledger);
        ctx.check(
          "the stuck dispatch is settled as failed",
          sys.a.store.dispatches.get(dsp2)?.status === "settled" &&
            sys.a.store.dispatches.get(dsp2)?.outcome === "failed",
          sys.a.store.dispatches.get(dsp2),
        );
      } finally {
        await sys.close();
        f.clean();
      }
    },
  },
];
