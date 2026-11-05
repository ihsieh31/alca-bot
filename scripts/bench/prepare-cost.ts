/**
 * PERF-2026-11 (4, 6): the cost of `db.prepare(sql)` on every call (the
 * pattern most repos use) vs a cached statement, through the perf.ts
 * instrument wrapper the app installs on every connection, and the cost of
 * the Link per-event scope check (`core.store.devices.get` in
 * apps/desktop/src/link-rpc.ts `still()`).
 *
 *   node --disable-warning=ExperimentalWarning scripts/bench/prepare-cost.ts [n]
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { openStore } from "../../packages/store/src/index.ts";

const N = Number(process.argv[2] ?? 20000);
const dir = mkdtempSync(join(tmpdir(), "alca-prep-"));
const s = openStore(join(dir, "state.sqlite"), undefined, { inlineJobs: true } as never);
const db = s.db as DatabaseSync;
s.threads.create("thread_x", "x");
const run = s.runs.start({ id: "run_x", threadId: "thread_x", initiator: { kind: "user", id: "local" } });

const best = (f: () => void) => {
  let b = Number.POSITIVE_INFINITY;
  for (let r = 0; r < 5; r++) {
    const t = performance.now();
    for (let i = 0; i < N; i++) f();
    b = Math.min(b, performance.now() - t);
  }
  return ((b * 1000) / N).toFixed(2);
};
const SQL = "SELECT * FROM runs WHERE id = ?";
const cachedInstr = db.prepare(SQL);
const bare = DatabaseSync.prototype.prepare.call(db, SQL);
console.log(`n ${N}, µs per call (best of 5), node ${process.version}`);
console.log(
  `  prepare+get every call (instrumented, as repos do): ${best(() => db.prepare(SQL).get(run.id))}`,
);
console.log(`  cached statement, instrumented:                     ${best(() => cachedInstr.get(run.id))}`);
console.log(
  `  prepare+get every call, bare node:sqlite:            ${best(() => DatabaseSync.prototype.prepare.call(db, SQL).get(run.id))}`,
);
console.log(`  cached statement, bare node:sqlite:                  ${best(() => bare.get(run.id))}`);
console.log(`  RunRepo.get(id) (real repo method):                  ${best(() => s.runs.get(run.id))}`);
console.log(
  `  DeviceRepo.get(id) (Link still() per event):          ${best(() => s.devices.get("dev_none"))}`,
);
s.close();
rmSync(dir, { recursive: true, force: true });
