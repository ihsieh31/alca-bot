/**
 * Next round R7.7 (Phase F2): what column encryption costs on the busiest
 * table. Re-runnable on any commit that has `openStore` (a commit before F2
 * has no Sealer: only the plaintext column prints).
 *
 *   node --disable-warning=ExperimentalWarning scripts/bench-seal.ts [events] [rounds] [chunks/row]
 *
 * One run of `events` protocol events (default 20000) in the shape of a
 * stream: run.started, then text in bursts of 40 `message.delta` with a tool
 * call (2 events) between bursts, then run.finished. Written through
 * `store.runs.appendEvent` into a file database (WAL, as in the app), then
 * read back whole with `store.runs.events` (replay, history_search).
 *
 * Variants, on a commit that batches stream chunks (`RUN_EVENT_BATCH`):
 * chunks per row 1 (no batching), 10 (a stream at ~100 chunks/s with the
 * 100 ms window) and the default cap (a burst). The third argument keeps one.
 *
 * Times are CPU time of this process (user + system), best of `rounds`,
 * plain and sealed interleaved: on a shared machine wall time swings by 2×
 * between runs, CPU time much less.
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as store from "../packages/store/src/index.ts";

const N = Number(process.argv[2] ?? 20000);
const ROUNDS = Number(process.argv[3] ?? 3);
const ONLY = process.argv[4] === undefined ? undefined : Number(process.argv[4]);
const S = store as unknown as Record<string, unknown>;
type Wire = { current: number; keys: Record<string, string> };
const SealerCtor = S.Sealer as (new (w: Wire) => unknown) | undefined;
type Repo = {
  appendEvent(e: unknown, now?: Date): void;
  events(runId: string, after?: number, o?: { types?: string[] }): unknown[];
  flush?(): void;
};
const HISTORY = { types: ["tool.requested", "tool.completed", "message.completed"] };
const RunRepoCtor = S.RunRepo as new (db: unknown, o?: unknown) => Repo;
const cap = (S.RUN_EVENT_BATCH as { maxEvents: number } | undefined)?.maxEvents;
const variants = (cap ? [1, 10, cap] : [0]).filter((k) => ONLY === undefined || k === ONLY);

const cpu = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
};

function stream(runId: string, threadId: string) {
  const out: Array<{ runId: string; seq: number; type: string; payload: unknown }> = [];
  const ev = (type: string, data: unknown) => {
    const seq = out.length;
    const actor = { kind: "agent", id: "bot_b" };
    out.push({
      runId,
      seq,
      type,
      payload: { v: 1, type, seq, runId, threadId, ts: new Date().toISOString(), actor, data },
    });
  };
  ev("run.started", { engine: "bench" });
  let m = 0;
  while (out.length < N - 1) {
    m += 1;
    for (let i = 0; i < 40 && out.length < N - 3; i++)
      ev("message.delta", {
        messageId: `message_${m}`,
        role: "assistant",
        delta: `第${i}段 some streamed text `,
      });
    ev("tool.requested", { callId: `call_${m}`, tool: "web.search", args: { q: "天氣 taipei" } });
    ev("tool.completed", { callId: `call_${m}`, ok: true, result: "晴 25°C ".repeat(8), durationMs: 120 });
  }
  ev("run.finished", { reason: "completed" });
  return out.slice(0, N);
}

interface Once {
  write: number;
  read: number;
  history: number;
}

function once(sealed: boolean, perRow: number): Once {
  const dir = mkdtempSync(join(tmpdir(), "alca-bench-"));
  try {
    const key = { current: 1, keys: { "1": randomBytes(32).toString("base64") } };
    const sealer = sealed && SealerCtor ? new SealerCtor(key) : undefined;
    const s = store.openStore(join(dir, "state.sqlite"), undefined, {
      inlineJobs: true,
      ...(sealer ? { sealer } : {}),
    } as never);
    s.threads.create("thread_bench", "bench");
    s.runs.start({ id: "run_bench", threadId: "thread_bench", initiator: { kind: "user", id: "local" } });
    const repo: Repo = perRow > 0 ? new RunRepoCtor(s.db, { batch: { maxEvents: perRow } }) : s.runs;
    const list = stream("run_bench", "thread_bench");
    const t0 = cpu();
    for (const e of list) repo.appendEvent(e);
    repo.flush?.();
    const write = N / ((cpu() - t0) / 1000);
    let read = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 5; i++) {
      const t = cpu();
      const got = repo.events("run_bench");
      read = Math.min(read, cpu() - t);
      if (got.length !== N) throw new Error(`read ${got.length} of ${N}`);
    }
    // history_search's read (tool calls and finished messages; a commit without `types` reads everything).
    let history = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 5; i++) {
      const t = cpu();
      repo.events("run_bench", -1, HISTORY);
      history = Math.min(history, cpu() - t);
    }
    s.close();
    return { write, read, history };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const pct = (a: number) => `${a >= 0 ? "+" : ""}${(a * 100).toFixed(1)}%`;
console.log(
  `events ${N}, best of ${ROUNDS} (CPU time), node ${process.version}${SealerCtor ? "" : ", no Sealer"}`,
);
console.log(
  "chunks/row | plain ev/s | sealed ev/s | write cost | plain read ms | sealed read ms | read cost",
);
for (const k of variants) {
  const p: Once[] = [];
  const q: Once[] = [];
  for (let r = 0; r < ROUNDS; r++) {
    p.push(once(false, k));
    if (SealerCtor) q.push(once(true, k));
  }
  const pw = Math.max(...p.map((x) => x.write));
  const pr = Math.min(...p.map((x) => x.read));
  const ph = Math.min(...p.map((x) => x.history));
  const label = k === 0 ? "1 (no batching)" : String(k);
  if (!SealerCtor) {
    console.log(`${label} | ${Math.round(pw)} | – | – | ${pr.toFixed(1)} | – | – | ${ph.toFixed(1)} | –`);
    continue;
  }
  const sw = Math.max(...q.map((x) => x.write));
  const sr = Math.min(...q.map((x) => x.read));
  const sh = Math.min(...q.map((x) => x.history));
  console.log(
    `${label} | ${Math.round(pw)} | ${Math.round(sw)} | ${pct(pw / sw - 1)} | ${pr.toFixed(1)} | ${sr.toFixed(1)} | ${pct(sr / pr - 1)} | ${ph.toFixed(1)} | ${sh.toFixed(1)}`,
  );
}
