import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScriptContext, ScriptStep } from "@alca/engines";
import { CAP_EXPIRE_MS, type WorkerRecord } from "@alca/store";
import { afterEach, describe, expect, it } from "vitest";
import { call, type Harness, lastLine, makeAgents, say, until } from "./agents-helpers.ts";

/**
 * Design §0.2.5 (S10): a harness worker whose step budget runs out leaves a
 * handoff file (0600, secrets redacted) and its dispatch waits for 續做 —
 * never continued on its own. The router or the person continues it (a new
 * worker on the same dispatch, the handoff in its task); two continuations in
 * a row without progress are refused; 72 hours without one settle it as
 * `budget`. Fictional data only.
 */

const SECRET = "ghp_abcdefghijklmnopqrstuvwxxxxxxxxxxxxx";

let h: Harness | undefined;
let dir: string | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const router =
  (continueId: () => string | undefined) =>
  ({ req, pass }: ScriptContext): ScriptStep[] => {
    const id = continueId();
    if (req.userMessage.includes("<alca:")) {
      if (id && req.userMessage.includes("可以續做") && pass === 0)
        return call("c", "worker_start", { title: "續", goal: "續", continueDispatch: id });
      return say("收到");
    }
    // Only the person's request dispatches (the panel's 續做 note is not a new task).
    return pass === 0 && req.userMessage.includes("報表")
      ? call("s", "worker_start", {
          title: "整理資料",
          goal: `${lastLine(req.userMessage)}（token ${SECRET}）`,
          harness: "general",
          budget: { maxSteps: 2 },
        })
      : say("派了");
  };

/** A worker that never finishes within its budget and reports partial in the report-only pass. */
const worker =
  (tasks: string[]) =>
  ({ req, pass }: ScriptContext): ScriptStep[] => {
    if (pass === 0) tasks.push(req.userMessage);
    if (req.userMessage.includes("步數預算用完了"))
      return pass === 0
        ? call("r", "report_result", {
            status: "partial",
            summary: `做了一半，還剩第二段（密碼是 hunter22）`,
            changes: [],
            claims: [],
          })
        : say("回報了");
    return call(`x${pass}`, "no_such_tool", {});
  };

function boot(o: { routerContinues?: boolean; clock?: () => number } = {}) {
  dir = mkdtempSync(join(tmpdir(), "alca-handoffs-"));
  const tasks: string[] = [];
  h = makeAgents({
    // The router reads the dispatch id from its report (here: the newest dispatch).
    router: router(() =>
      o.routerContinues
        ? (
            h?.store.db.prepare("SELECT id FROM dispatches ORDER BY created_at DESC LIMIT 1").get() as
              | { id: string }
              | undefined
          )?.id
        : undefined,
    ),
    worker: worker(tasks),
    level: "autonomous",
    system: { handoffDir: dir, ...(o.clock ? { now: () => new Date((o.clock as () => number)()) } : {}) },
  });
  return { tasks };
}

const settledOut = (H: Harness, threadId: string, n: number) =>
  until(() => {
    const ws = H.store.workers.byThread(threadId);
    return ws.length === n && ws.every((w) => w.finishedAt) ? ws : undefined;
  }, 20_000);

describe("續做 after the step budget runs out (design §0.2.5)", () => {
  it("waits in needs_review with a 0600 handoff file without secrets; never continues by itself", async () => {
    const { tasks } = boot();
    const H = h as Harness;
    const t = H.core.createThread();
    await H.core.send(t.id, "把三份報表整理成一張表").done;
    const [w1] = (await settledOut(H, t.id, 1)) as WorkerRecord[];
    const dsp = w1?.grants.dispatchId as string;
    expect(H.store.dispatches.get(dsp)).toMatchObject({ status: "needs_review", finishedAt: null });
    const st = H.store.dispatches.caps.state(dsp);
    expect(st).toMatchObject({ continues: 0, waiting: true });
    const file = st.exhausted[0]?.handoff as string;
    expect(file).toBe(join(dir as string, `${dsp}-1.md`));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const text = readFileSync(file, "utf8");
    expect(text).toContain("把三份報表整理成一張表");
    expect(text).toContain("做了一半");
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("hunter22");
    // The panel offers 續做; the router was told it may continue.
    const view = H.agents.workerStates(t.id)[0]?.harness;
    expect(view?.cap).toMatchObject({ state: "waiting", n: 1, continues: 0, max: 6 });
    expect(view?.phase).toBe("needs_review");
    // Nothing continues on its own (even after a sweep).
    H.agents.sweep();
    await new Promise((r) => setTimeout(r, 200));
    expect(H.store.workers.byThread(t.id)).toHaveLength(1);
    expect(tasks).toHaveLength(2); // the first pass and the report-only pass
  }, 30_000);

  it("the person's 續做 starts a new worker on the same dispatch with the handoff; a second press is refused", async () => {
    const { tasks } = boot();
    const H = h as Harness;
    const t = H.core.createThread();
    await H.core.send(t.id, "把三份報表整理成一張表").done;
    const [w1] = (await settledOut(H, t.id, 1)) as WorkerRecord[];
    const dsp = w1?.grants.dispatchId as string;
    const next = H.agents.continueWorker(w1?.id as string);
    expect(() => H.agents.continueWorker(w1?.id as string)).toThrow(/已經結束或已經在續做/);
    const ws = await settledOut(H, t.id, 2);
    const w2 = ws.find((w) => w.id === next.workerId) as WorkerRecord;
    expect(w2.grants.dispatchId).toBe(dsp);
    const task = tasks.find((x) => x.includes("<alca:handoff")) as string;
    expect(task).toContain(`file="${join(dir as string, `${dsp}-1.md`)}"`);
    expect(task).toContain("這是第 1 次續做");
    // The handoff block adds no secret (the goal is the router's own words, as before).
    expect(task.slice(task.indexOf("<alca:handoff"))).not.toContain(SECRET);
    expect(H.agents.workerStates(t.id).find((s) => s.workerId === w1?.id)?.harness?.phase).toBe("continued");
    // It ran out again: the second handoff, continues = 1.
    expect(H.store.dispatches.caps.state(dsp)).toMatchObject({ continues: 1, waiting: true });
    expect(H.store.dispatches.events(dsp).filter((e) => e.kind === "continued")[0]?.detail).toMatchObject({
      n: 1,
      by: "user",
    });
  }, 30_000);

  it("the router continues; two continuations without progress are refused and the dispatch ends as budget", async () => {
    boot({ routerContinues: true });
    const H = h as Harness;
    const t = H.core.createThread();
    await H.core.send(t.id, "把三份報表整理成一張表").done;
    const dsp = await until(() => H.store.workers.byThread(t.id)[0]?.grants.dispatchId, 10_000);
    await until(() => (H.store.dispatches.get(dsp)?.status === "settled" ? true : undefined), 20_000);
    expect(H.store.dispatches.get(dsp)).toMatchObject({ outcome: "budget" });
    const st = H.store.dispatches.caps.state(dsp);
    expect(st.continues).toBe(2);
    expect(st.exhausted.map((e) => e.progress)).toEqual([false, false, false]);
    expect(H.store.dispatches.events(dsp).at(-1)?.kind).toBe("cap.refused");
    expect(H.store.dispatches.caps.refusal(dsp)).toMatch(/最近兩次續做都沒有進展/);
    const last = H.store.workers.byThread(t.id).at(-1) as WorkerRecord;
    expect(() => H.agents.continueWorker(last.id)).toThrow(/最近兩次續做都沒有進展/);
    expect(H.agents.workerStates(t.id).find((s) => s.workerId === last.id)?.harness?.cap?.state).toBe(
      "refused",
    );
  }, 30_000);

  it("72 hours without 續做 settle it as budget; the handoff file goes with the pruned dispatch", async () => {
    let now = Date.parse("2026-11-05T09:00:00Z");
    boot({ clock: () => now });
    const H = h as Harness;
    const t = H.core.createThread();
    await H.core.send(t.id, "把三份報表整理成一張表").done;
    const [w1] = (await settledOut(H, t.id, 1)) as WorkerRecord[];
    const dsp = w1?.grants.dispatchId as string;
    const file = H.store.dispatches.caps.state(dsp).exhausted[0]?.handoff as string;
    now += CAP_EXPIRE_MS - 60_000;
    H.agents.sweep();
    expect(H.store.dispatches.get(dsp)?.status).toBe("needs_review");
    now += 60_000;
    H.agents.sweep();
    expect(H.store.dispatches.get(dsp)).toMatchObject({ status: "settled", outcome: "budget" });
    expect(H.agents.workerStates(t.id)[0]?.harness?.cap?.state).toBe("expired");
    expect(() => H.agents.continueWorker(w1?.id as string)).toThrow(/已經結束/);
    // 30 days later the dispatch is pruned, and its handoff file with it.
    now += 31 * 86_400_000;
    H.agents.sweep();
    expect(H.store.dispatches.get(dsp)).toBeUndefined();
    expect(() => statSync(file)).toThrow();
  }, 30_000);
});
