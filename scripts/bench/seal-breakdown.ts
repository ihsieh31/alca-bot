// biome-ignore-all lint/suspicious/noExplicitAny: benchmark script poking at untyped exports and heap snapshots
/**
 * PERF-2026-11 (4): where does the sealed write cost go?
 *
 *   node --disable-warning=ExperimentalWarning scripts/bench/seal-breakdown.ts [rows] [rounds]
 *
 * Isolates, per run_events row, on a real store file (WAL, migrations, triggers):
 *   A  seal() alone, by payload size
 *   B  raw INSERT of precomputed text: plaintext JSON vs the sealed string
 *      (same rows) — SQLite's share of the cost (bigger value, json_valid CHECK)
 *   C  the perf.ts `instrument` wrapper (clip() regex per call) vs a bare statement
 *   D  RunRepo.appendEvent end to end, plain vs sealed, one row per event
 *   E  same as D inside one BEGIN/COMMIT per 64 rows (what a transaction would buy)
 *
 * Times are CPU time (user+sys) of this process, best of `rounds`.
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as store from "../../packages/store/src/index.ts";

const ROWS = Number(process.argv[2] ?? 5000);
const ROUNDS = Number(process.argv[3] ?? 5);
const S = store as unknown as Record<string, any>;
const Sealer = S.Sealer as new (w: {
  current: number;
  keys: Record<string, string>;
}) => {
  seal(t: string, c: string, pk: string, s: string): string;
};
const wire = () => ({ current: 1, keys: { "1": randomBytes(32).toString("base64") } });

const cpu = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
};
const best = (f: () => number) => {
  let b = Number.POSITIVE_INFINITY;
  for (let i = 0; i < ROUNDS; i++) b = Math.min(b, f());
  return b;
};
const us = (ms: number, n: number) => `${((ms * 1000) / n).toFixed(2)} µs`;

function payload(seq: number, bytes: number) {
  const pad = "晴天 sunny ".repeat(Math.max(1, Math.round(bytes / 14)));
  return {
    v: 1,
    type: "tool.completed",
    seq,
    runId: "run_bench",
    threadId: "thread_bench",
    ts: new Date().toISOString(),
    actor: { kind: "agent", id: "bot_b" },
    data: { callId: `call_${seq}`, ok: true, result: pad, durationMs: 120 },
  };
}

function withStore<T>(sealed: boolean, fn: (s: any) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "alca-bench-"));
  try {
    const sealer = sealed ? new Sealer(wire()) : undefined;
    const s = S.openStore(join(dir, "state.sqlite"), undefined, {
      inlineJobs: true,
      ...(sealer ? { sealer } : {}),
    });
    s.threads.create("thread_bench", "bench");
    s.runs.start({ id: "run_bench", threadId: "thread_bench", initiator: { kind: "user", id: "local" } });
    try {
      return fn(s);
    } finally {
      s.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`rows ${ROWS}, best of ${ROUNDS} (CPU time), node ${process.version}, ${process.platform}`);

// A ── seal() alone
console.log("\nA. Sealer.seal() per value");
const sealer = new Sealer(wire());
for (const size of [100, 400, 2000, 8000]) {
  const texts = Array.from({ length: ROWS }, (_, i) => JSON.stringify(payload(i, size)));
  const ms = best(() => {
    const t = cpu();
    for (let i = 0; i < ROWS; i++) sealer.seal("run_events", "payload", `run_bench:${i}`, texts[i] as string);
    return cpu() - t;
  });
  const jsonMs = best(() => {
    const t = cpu();
    for (let i = 0; i < ROWS; i++) JSON.stringify(payload(i, size));
    return cpu() - t;
  });
  console.log(
    `  ~${String((texts[0] as string).length).padStart(5)} B json: seal ${us(ms, ROWS)} / value; build+stringify ${us(jsonMs, ROWS)}`,
  );
}

// B, C ── raw inserts of precomputed text
console.log("\nB/C. raw INSERT INTO run_events, autocommit (one txn per row), precomputed text");
for (const size of [400, 2000]) {
  const plain = Array.from({ length: ROWS }, (_, i) => JSON.stringify(payload(i, size)));
  const sealedT = plain.map((p, i) => sealer.seal("run_events", "payload", `run_bench:${i}`, p));
  const res: Record<string, number> = {};
  for (const [label, texts] of [
    ["plain", plain],
    ["sealed", sealedT],
  ] as const) {
    for (const wrapped of [true, false]) {
      for (const txn of [false, true]) {
        const k = `${label}${wrapped ? "+instr" : ""}${txn ? "+txn64" : ""}`;
        res[k] = best(() =>
          withStore(false, (s) => {
            const db: DatabaseSync = s.db;
            // Bare statement: bypass perf.ts instrument (prepare on the prototype).
            const sql =
              "INSERT INTO run_events (run_id, seq, type, payload, created_at) VALUES (?, ?, ?, ?, ?)";
            const st = wrapped ? db.prepare(sql) : DatabaseSync.prototype.prepare.call(db, sql);
            const exec = (q: string) => DatabaseSync.prototype.exec.call(db, q);
            const ts = new Date().toISOString();
            const t = cpu();
            for (let i = 0; i < ROWS; i++) {
              if (txn && i % 64 === 0) exec("BEGIN IMMEDIATE");
              st.run("run_bench", i, "tool.completed", texts[i] as string, ts);
              if (txn && (i % 64 === 63 || i === ROWS - 1)) exec("COMMIT");
            }
            return cpu() - t;
          }),
        );
      }
    }
  }
  const p = (a: string, b: string) => `${(((res[b] as number) / (res[a] as number) - 1) * 100).toFixed(1)}%`;
  console.log(
    `  payload ~${(plain[0] as string).length} B plain, ~${(sealedT[0] as string).length} B sealed`,
  );
  for (const [k, v] of Object.entries(res)) console.log(`    ${k.padEnd(22)} ${us(v, ROWS)} / row`);
  console.log(
    `    sealed-vs-plain (bare, autocommit): +${p("plain", "sealed")}; instrument overhead (plain): +${p("plain", "plain+instr")}; txn64 saves (plain+instr): ${p("plain+instr", "plain+instr+txn64")}`,
  );
}

// D, E ── appendEvent end to end
console.log("\nD/E. RunRepo.appendEvent (non-batched events, ~400 B), plain vs sealed");
const evs = Array.from({ length: ROWS }, (_, i) => ({
  runId: "run_bench",
  seq: i + 1,
  type: "tool.completed",
  payload: payload(i + 1, 400),
}));
const app: Record<string, number> = {};
for (const sealed of [false, true])
  for (const txn of [false, true]) {
    const k = `${sealed ? "sealed" : "plain"}${txn ? "+txn64" : ""}`;
    app[k] = best(() =>
      withStore(sealed, (s) => {
        const db: DatabaseSync = s.db;
        const t = cpu();
        for (let i = 0; i < ROWS; i++) {
          if (txn && i % 64 === 0) db.exec("BEGIN IMMEDIATE");
          s.runs.appendEvent(evs[i]);
          if (txn && (i % 64 === 63 || i === ROWS - 1)) db.exec("COMMIT");
        }
        return cpu() - t;
      }),
    );
  }
for (const [k, v] of Object.entries(app)) console.log(`  ${k.padEnd(14)} ${us(v, ROWS)} / event`);
const pc = (a: number, b: number) => `${((b / a - 1) * 100).toFixed(1)}%`;
console.log(
  `  seal cost autocommit +${pc(app.plain as number, app.sealed as number)}; inside txn64 +${pc(app["plain+txn64"] as number, app["sealed+txn64"] as number)}`,
);
