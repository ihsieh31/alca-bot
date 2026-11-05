// biome-ignore-all lint/suspicious/noExplicitAny: benchmark script poking at untyped exports and heap snapshots
/**
 * PERF-2026-11 (4): attribute the sealed-vs-plain gap of scripts/bench-seal.ts
 * (the realistic stream: 40 deltas + tool.requested + tool.completed, repeated)
 * to its parts, by wrapping Sealer.seal / Sealer.open and counting calls & CPU.
 *
 *   node scripts/bench/seal-attribution.ts [events] [rounds] [chunksPerRow]
 *
 * Also runs a variant where every append of a round happens inside BEGIN/COMMIT
 * windows of 64 rows (what a write transaction per flush would buy).
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import * as store from "../../packages/store/src/index.ts";

const N = Number(process.argv[2] ?? 20000);
const ROUNDS = Number(process.argv[3] ?? 5);
const PER_ROW = Number(process.argv[4] ?? 64);
const S = store as unknown as Record<string, any>;
const cpu = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
};

const acc = { seal: 0, sealN: 0, sealBytes: 0, open: 0, openN: 0 };
const proto = S.Sealer.prototype;
const seal0 = proto.seal;
const open0 = proto.open;
// Per-call timing uses the monotonic clock: getrusage() can be tick-granular (4–10 ms) on Linux.
const now = () => performance.now();
proto.seal = function (this: unknown, ...a: [string, string, string, string]) {
  const t = now();
  const r = seal0.apply(this, a);
  acc.seal += now() - t;
  acc.sealN++;
  acc.sealBytes += a[3].length;
  return r;
};
proto.open = function (this: unknown, ...a: [string, string, string, string]) {
  const t = now();
  const r = open0.apply(this, a);
  acc.open += now() - t;
  acc.openN++;
  return r;
};

function stream() {
  const out: Array<{ runId: string; seq: number; type: string; payload: unknown }> = [];
  const ev = (type: string, data: unknown) => {
    const seq = out.length;
    out.push({
      runId: "run_bench",
      seq,
      type,
      payload: {
        v: 1,
        type,
        seq,
        runId: "run_bench",
        threadId: "thread_bench",
        ts: new Date().toISOString(),
        actor: { kind: "agent", id: "bot_b" },
        data,
      },
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

function once(sealed: boolean, txn: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "alca-bench-"));
  try {
    const sealer = sealed
      ? new S.Sealer({ current: 1, keys: { "1": randomBytes(32).toString("base64") } })
      : undefined;
    const s = S.openStore(join(dir, "state.sqlite"), undefined, {
      inlineJobs: true,
      ...(sealer ? { sealer } : {}),
    });
    s.threads.create("thread_bench", "bench");
    s.runs.start({ id: "run_bench", threadId: "thread_bench", initiator: { kind: "user", id: "local" } });
    const repo = new S.RunRepo(s.db, { batch: { maxEvents: PER_ROW } });
    const list = stream();
    const rows0 = (s.db.prepare("SELECT COUNT(*) c FROM run_events").get() as { c: number }).c;
    Object.assign(acc, { seal: 0, sealN: 0, sealBytes: 0, open: 0, openN: 0 });
    const t0 = cpu();
    let k = 0;
    for (const e of list) {
      if (txn && k % 64 === 0) s.db.exec("BEGIN IMMEDIATE");
      repo.appendEvent(e);
      if (txn && k % 64 === 63) s.db.exec("COMMIT");
      k++;
    }
    repo.flush();
    if (txn && k % 64 !== 0) s.db.exec("COMMIT");
    const write = cpu() - t0;
    const sealMs = acc.seal;
    const sealN = acc.sealN;
    const bytes = acc.sealBytes;
    const rows = (s.db.prepare("SELECT COUNT(*) c FROM run_events").get() as { c: number }).c - rows0;
    acc.open = 0;
    acc.openN = 0;
    const t1 = cpu();
    repo.events("run_bench");
    const read = cpu() - t1;
    const r = { write, sealMs, sealN, bytes, rows, read, openMs: acc.open, openN: acc.openN };
    s.close();
    return r;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`events ${N}, chunks/row ${PER_ROW}, best of ${ROUNDS} (CPU), node ${process.version}`);
for (const txn of [false, true]) {
  const P: ReturnType<typeof once>[] = [];
  const Q: ReturnType<typeof once>[] = [];
  for (let r = 0; r < ROUNDS; r++) {
    P.push(once(false, txn));
    Q.push(once(true, txn));
  }
  const p = P.reduce((a, b) => (b.write < a.write ? b : a));
  const q = Q.reduce((a, b) => (b.write < a.write ? b : a));
  const pr = Math.min(...P.map((x) => x.read));
  const qr = Q.reduce((a, b) => (b.read < a.read ? b : a));
  const gap = q.write - p.write;
  console.log(`\n${txn ? "WITH BEGIN/COMMIT per 64 appends" : "autocommit (as the app does today)"}`);
  console.log(
    `  rows written ${q.rows}; plain write ${p.write.toFixed(1)} ms, sealed ${q.write.toFixed(1)} ms → +${((q.write / p.write - 1) * 100).toFixed(1)}% (gap ${gap.toFixed(1)} ms)`,
  );
  console.log(
    `  seal(): ${q.sealN} calls, ${q.sealMs.toFixed(1)} ms (${((q.sealMs * 1000) / q.sealN).toFixed(1)} µs/call, avg ${Math.round(q.bytes / q.sealN)} B) = ${((q.sealMs / gap) * 100).toFixed(0)}% of the gap`,
  );
  console.log(
    `  read: plain ${pr.toFixed(1)} ms, sealed ${qr.read.toFixed(1)} ms; open(): ${qr.openN} calls ${qr.openMs.toFixed(1)} ms`,
  );
}
