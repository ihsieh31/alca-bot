/**
 * PERF-2026-11 (1): split a core start into module loading vs startDesktop().
 *
 *   ALCA_VAULT_BACKEND=file node --disable-warning=ExperimentalWarning scripts/bench/start-phases.ts [dataDir]
 *
 * Prints: process uptime at entry (node bootstrap), time to import start.ts
 * (the whole module graph, type-stripped), number of modules loaded, and
 * startDesktop() until it resolves. Run with --cpu-prof to see what inside.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const boot = performance.now();
const dir = process.argv[2] ?? mkdtempSync(join(tmpdir(), "alca-phase-"));
const t0 = performance.now();
const { startDesktop } = await import("../../apps/desktop/src/start.ts");
const t1 = performance.now();
const app = await startDesktop({
  engine: "demo",
  dataDir: dir,
  browser: "off",
  browserDownload: false,
  agents: "router",
  port: 0,
} as never);
const t2 = performance.now();
const mods = (process as unknown as { moduleLoadList?: string[] }).moduleLoadList?.length;
console.log(
  JSON.stringify({
    nodeBootMs: Math.round(boot),
    importMs: Math.round(t1 - t0),
    startDesktopMs: Math.round(t2 - t1),
    totalMs: Math.round(t2),
    builtinModules: mods,
    rssMB: Math.round(process.memoryUsage().rss / 1048576),
    heapUsedMB: Math.round(process.memoryUsage().heapUsed / 1048576),
  }),
);
await (app as { close(): Promise<void> }).close();
process.exit(0);
