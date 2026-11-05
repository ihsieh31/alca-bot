/**
 * PERF-2026-11 (1): what the core's module graph costs at start.
 *
 *   node --disable-warning=ExperimentalWarning --import ./scripts/bench/module-graph.ts apps/desktop/src/start.ts
 *   (or: node ... scripts/bench/module-graph.ts --entry apps/desktop/src/start.ts)
 *
 * Uses the synchronous module hooks (module.registerHooks, Node ≥ 22.15) to
 * count every module the entry pulls in, its source bytes, and which
 * workspace package / npm package it belongs to. Prints the totals at exit,
 * sorted by bytes, plus the heaviest single files. Nothing is changed.
 */
import { registerHooks } from "node:module";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

type Stat = { n: number; bytes: number; ms: number };
const by = new Map<string, Stat>();
const files: Array<{ url: string; bytes: number }> = [];
const t0 = performance.now();

const group = (url: string) => {
  if (url.startsWith("node:")) return "node:*";
  const nm = /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)/.exec(url);
  if (nm) return `npm:${nm[1]}`;
  const ws = /\/((?:apps|packages|services)\/[^/]+)\//.exec(url);
  return ws ? (ws[1] as string) : "other";
};

registerHooks({
  load(url, context, next) {
    const t = performance.now();
    const r = next(url, context);
    const ms = performance.now() - t;
    const bytes = r.source
      ? typeof r.source === "string"
        ? Buffer.byteLength(r.source)
        : r.source.byteLength
      : 0;
    const g = group(url);
    const s = by.get(g) ?? { n: 0, bytes: 0, ms: 0 };
    s.n++;
    s.bytes += bytes;
    s.ms += ms;
    by.set(g, s);
    if (!url.startsWith("node:")) files.push({ url, bytes });
    return r;
  },
});

function report() {
  const rows = [...by.entries()].filter(([k]) => k !== "node:*").sort((a, b) => b[1].bytes - a[1].bytes);
  const tot = rows.reduce((a, [, s]) => ({ n: a.n + s.n, bytes: a.bytes + s.bytes, ms: a.ms + s.ms }), {
    n: 0,
    bytes: 0,
    ms: 0,
  });
  console.error(
    `\nmodule graph: ${tot.n} files, ${(tot.bytes / 1024).toFixed(0)} KiB source, load hook (read+strip) ${tot.ms.toFixed(0)} ms; wall since hooks ${(performance.now() - t0).toFixed(0)} ms`,
  );
  console.error("group | files | KiB | load ms");
  for (const [k, s] of rows.slice(0, 30))
    console.error(`${k} | ${s.n} | ${(s.bytes / 1024).toFixed(0)} | ${s.ms.toFixed(0)}`);
  console.error("heaviest files:");
  for (const f of files.sort((a, b) => b.bytes - a.bytes).slice(0, 12))
    console.error(
      `  ${(f.bytes / 1024).toFixed(0)} KiB ${f.url.replace(/.*?(node_modules|apps|packages|services)\//, "$1/")}`,
    );
}

const i = process.argv.indexOf("--entry");
if (i > 0) {
  const entry = process.argv[i + 1] as string;
  const t = performance.now();
  await import(pathToFileURL(entry).href);
  console.error(`import(${entry}) ${(performance.now() - t).toFixed(0)} ms`);
  report();
} else process.on("exit", report);
