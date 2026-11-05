/**
 * PERF-2026-11 (3): core memory with N concurrent workers, per-worker
 * overhead, and growth over repeated rounds (leak check).
 *
 *   node --expose-gc --disable-warning=ExperimentalWarning scripts/bench/workers-mem.ts [rounds] [passes] [holdMs]
 *
 * In-process, with the scripted engine (`ScriptedEngine`, the offline engine
 * the tests and `--engine demo` use) for the router and the workers, on a
 * sealed file store with the database worker inline — the same objects the
 * desktop core builds, minus HTTP and Chromium. One router turn starts N
 * workers at once (maxConcurrent = N). Each worker: waits `holdMs` (so all N
 * are alive together; RSS/heap are sampled then), then `passes` passes of
 * streamed text (~240 chars in 4-char chunks) + one read-only host tool call,
 * then a final answer. The router answers each worker report.
 *
 * Real engines (claude-code / codex) run one CLI process per worker; that
 * process's own RSS is NOT included here (see the report for the fake CLI).
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSettings } from "../../packages/config/src/index.ts";
import { AgentSystem, AlcaCore, type HostTool } from "../../packages/core/src/index.ts";
import {
  type ScriptContext,
  ScriptedEngine,
  type ScriptStep,
  streamText,
} from "../../packages/engines/src/index.ts";
import { openStore, Sealer } from "../../packages/store/src/index.ts";

const ROUNDS = Number(process.argv[2] ?? 6);
const PASSES = Number(process.argv[3] ?? 5);
const HOLD = Number(process.argv[4] ?? 1500);
const gc = (globalThis as { gc?: () => void }).gc ?? (() => {});
const MB = (b: number) => (b / 1048576).toFixed(1);

const say = (t: string): ScriptStep[] => streamText(t, 4);
const TEXT = "正在查資料，找到幾個來源，整理中。".repeat(15);

const read: HostTool = {
  spec: { name: "lookup", description: "lookup", inputSchema: { type: "object" } },
  actionClass: "read",
  run: async () => "結果：".repeat(200),
};

function mem() {
  gc();
  const m = process.memoryUsage();
  return { rss: m.rss, heap: m.heapUsed, ext: m.external + m.arrayBuffers };
}

export async function scenario(n: number) {
  const dir = mkdtempSync(join(tmpdir(), "alca-wmem-"));
  const sealer = new Sealer({ current: 1, keys: { "1": randomBytes(32).toString("base64") } });
  const store = openStore(join(dir, "state.sqlite"), undefined, { inlineJobs: true, sealer } as never);
  const settings = parseSettings({
    permissions: { level: "autonomous" as never },
    engineering: { workers: { watchdogSec: 3600, maxConcurrent: n, inlineChars: 4000 } },
  } as never);
  const router = new ScriptedEngine(
    ({ req, pass }: ScriptContext) => {
      const m = req.userMessage;
      if (m.includes("<alca:worker")) return say("收到。");
      if (pass > 0) return say("派好了。");
      const k = Number(/go (\d+)/.exec(m)?.[1] ?? 1);
      return [
        ...Array.from({ length: k }, (_, i) => ({
          type: "tool.call" as const,
          id: `r${i}`,
          name: "worker_start",
          input: { title: `w${i}`, goal: `job ${i}` },
        })),
        { type: "done" as const, stop: "tool_use" as const },
      ];
    },
    { id: "router" },
  );
  const worker = new ScriptedEngine(
    ({ pass }: ScriptContext) => {
      const pre: ScriptStep[] = pass === 0 ? [{ type: "wait", ms: HOLD }] : [];
      if (pass < PASSES)
        return [
          ...pre,
          ...say(TEXT),
          { type: "tool.call", id: `t${pass}`, name: "lookup", input: { q: pass } },
          { type: "done", stop: "tool_use" },
        ];
      return say(`完成。${TEXT}`);
    },
    { id: "worker" },
  );
  const core = new AlcaCore({ store, engine: router, settings: () => settings, tools: [read] });
  const agents = new AgentSystem({
    core,
    routerEngine: router,
    workerEngine: worker,
    settings: () => settings,
    tickMs: 0,
  });
  const close = async () => {
    await agents.close();
    await core.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { core, agents, store, close, engines: [router, worker] };
}

export async function round(s: Awaited<ReturnType<typeof scenario>>, n: number) {
  const t = s.core.createThread(`round ${n}`);
  const t0 = performance.now();
  await s.core.send(t.id, `go ${n}`).done;
  // Sample while all N hold.
  await new Promise((r) => setTimeout(r, HOLD / 2));
  const live = s.store.workers
    .byThread(t.id)
    .filter((w) => w.status === "running" || w.status === "waiting").length;
  const during = mem();
  for (;;) {
    const ws = s.store.workers.byThread(t.id);
    if (ws.length === n && ws.every((w) => ["succeeded", "failed", "stopped"].includes(w.status))) break;
    if (performance.now() - t0 > 120_000) throw new Error("workers did not finish");
    await new Promise((r) => setTimeout(r, 20));
  }
  await new Promise((r) => setTimeout(r, 300)); // router answers the reports
  // ScriptedEngine keeps every request it saw (`requests`, for test asserts): a
  // bench artifact (and a demo-engine-only leak), so it is cleared unless KEEP_REQ=1.
  if (!process.env.KEEP_REQ) for (const e of s.engines) e.requests.length = 0;
  // CLEAR_TRACES=1 simulates the fix for AlcaCore.traces (packages/core/src/agent.ts:568, never deleted).
  if (process.env.CLEAR_TRACES) s.core.traces.clear();
  return { live, during, ms: performance.now() - t0, after: mem() };
}

if (!process.env.ALCA_BENCH_LIB) {
  console.log(`node ${process.version}, passes ${PASSES}, hold ${HOLD} ms, rounds ${ROUNDS}`);
  const base = mem();
  console.log(
    `process baseline (modules loaded, nothing open): rss ${MB(base.rss)} MB heap ${MB(base.heap)} MB`,
  );
  for (const n of [1, 4, 8]) {
    const s = await scenario(n);
    const idle = mem();
    const rows: string[] = [];
    const heaps: number[] = [];
    for (let r = 0; r < ROUNDS; r++) {
      const x = await round(s, n);
      heaps.push(x.after.heap);
      rows.push(
        `  round ${r + 1}: ${x.live}/${n} live; during rss ${MB(x.during.rss)} heap ${MB(x.during.heap)} (+${MB(x.during.heap - idle.heap)}) | after rss ${MB(x.after.rss)} heap ${MB(x.after.heap)} | ${x.ms.toFixed(0)} ms`,
      );
    }
    const slope = heaps.length > 2 ? (heaps.at(-1)! - heaps[1]!) / (heaps.length - 2) : 0;
    console.log(`\nN=${n}: store+core+agents idle rss ${MB(idle.rss)} heap ${MB(idle.heap)} MB`);
    for (const l of rows) console.log(l);
    console.log(
      `  heap growth per round after warm-up: ${(slope / 1024).toFixed(0)} KiB (${(slope / n / 1024).toFixed(0)} KiB per worker-run)`,
    );
    await s.close();
  }
}
