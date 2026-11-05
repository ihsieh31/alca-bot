/**
 * PERF-2026-11 (§6, item 5): the read behind `AgentSystem.pendingCards`, run
 * on every SSE connect and phone `watch.thread` for each live worker run.
 * Before: every event of the run (opening every batched / sealed stream row),
 * then a filter in JS. After: `RunRepo.events(runId, -1, { types })`, filtered
 * in SQL, so batch rows are never opened.
 *
 *   node --disable-warning=ExperimentalWarning scripts/bench/pending-cards.ts [events] [rounds]
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { openStore, Sealer } from "../../packages/store/src/index.ts";

const N = Number(process.argv[2] ?? 20000);
const ROUNDS = Number(process.argv[3] ?? 7);
const CARDS = ["approval.requested", "approval.resolved", "question.asked", "question.answered"];

function once(sealed: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "alca-cards-"));
  try {
    const key = { current: 1, keys: { "1": randomBytes(32).toString("base64") } };
    const s = openStore(join(dir, "state.sqlite"), undefined, {
      inlineJobs: true,
      ...(sealed ? { sealer: new Sealer(key as never) } : {}),
    } as never);
    s.threads.create("thread_b", "b");
    s.runs.start({ id: "run_b", threadId: "thread_b", initiator: { kind: "user", id: "local" } });
    let seq = 0;
    const ev = (type: string, data: unknown) =>
      s.runs.appendEvent({
        runId: "run_b",
        seq,
        type,
        payload: { v: 1, type, seq: seq++, runId: "run_b", threadId: "thread_b", ts: "", actor: {}, data },
      });
    ev("run.started", {});
    while (seq < N - 2) {
      ev("message.delta", {
        messageId: `m${Math.floor(seq / 500)}`,
        role: "assistant",
        delta: "一段串流文字 text ",
      });
      if (seq === Math.floor(N / 2)) ev("approval.requested", { approvalId: "apr_1" });
      if (seq === N - 10) ev("question.asked", { questionId: "q_1" });
    }
    s.runs.flush?.("run_b");
    const time = (f: () => unknown[]) => {
      let best = Number.POSITIVE_INFINITY;
      let n = 0;
      for (let r = 0; r < ROUNDS; r++) {
        const t = performance.now();
        n = f().length;
        best = Math.min(best, performance.now() - t);
      }
      return { ms: best, n };
    };
    const before = time(() => s.runs.events("run_b").filter((e) => CARDS.includes(e.type)));
    const after = time(() => s.runs.events("run_b", -1, { types: CARDS }));
    s.close();
    return { before, after };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`events ${N}, best of ${ROUNDS} (wall ms), node ${process.version}`);
console.log("store | all events + JS filter (before) | SQL types filter (after) | cards");
for (const sealed of [false, true]) {
  const r = once(sealed);
  console.log(
    `${sealed ? "sealed" : "plain"} | ${r.before.ms.toFixed(2)} | ${r.after.ms.toFixed(3)} | ${r.before.n}/${r.after.n}`,
  );
}
