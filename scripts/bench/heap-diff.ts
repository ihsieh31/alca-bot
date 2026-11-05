// biome-ignore-all lint/suspicious/noExplicitAny: benchmark script poking at untyped exports and heap snapshots
/**
 * PERF-2026-11 (3): what the per-round heap growth of workers-mem.ts is made of.
 *
 *   node --expose-gc --disable-warning=ExperimentalWarning scripts/bench/heap-diff.ts [n] [roundsBetween]
 *
 * Imports workers-mem's scenario through an env switch, takes a heap snapshot
 * after round 2 and after round 2+roundsBetween, and prints the constructors /
 * string groups whose count and self size grew the most, plus retainer chains
 * (edge names) for the top grown Map / Array / Object entries.
 */

import { readFileSync, rmSync } from "node:fs";
import { writeHeapSnapshot } from "node:v8";

process.env.ALCA_BENCH_LIB = "1";
const { scenario, round } = (await import("./workers-mem.ts")) as unknown as {
  scenario(n: number): Promise<any>;
  round(s: any, n: number): Promise<unknown>;
};
const N = Number(process.argv[2] ?? 4);
const BETWEEN = Number(process.argv[3] ?? 4);
const gc = (globalThis as { gc?: () => void }).gc ?? (() => {});

type Agg = Map<string, { n: number; size: number }>;
/** Plain objects grouped by their property names (the "shape" of what is retained). */
function shapes(snap: any): Map<string, number> {
  const f = snap.snapshot.meta.node_fields as string[];
  const ef = snap.snapshot.meta.edge_fields as string[];
  const types = snap.snapshot.meta.node_types[0] as string[];
  const etypes = snap.snapshot.meta.edge_types[0] as string[];
  const W = f.length;
  const EW = ef.length;
  const iT = f.indexOf("type");
  const iN = f.indexOf("name");
  const iE = f.indexOf("edge_count");
  const eT = ef.indexOf("type");
  const eN = ef.indexOf("name_or_index");
  const nodes = snap.nodes as number[];
  const edges = snap.edges as number[];
  const strings = snap.strings as string[];
  const out = new Map<string, number>();
  let e = 0;
  for (let i = 0; i < nodes.length; i += W) {
    const ec = nodes[i + iE] as number;
    if (types[nodes[i + iT] as number] === "object" && strings[nodes[i + iN] as number] === "Object") {
      const props: string[] = [];
      for (let j = 0; j < ec; j++) {
        const k = e + j * EW;
        if (etypes[edges[k + eT] as number] === "property")
          props.push(strings[edges[k + eN] as number] as string);
      }
      const key = props.slice(0, 8).join(",");
      out.set(key, (out.get(key) ?? 0) + 1);
    }
    e += ec * EW;
  }
  return out;
}

function aggregate(file: string): { agg: Agg; snap: any } {
  const snap = JSON.parse(readFileSync(file, "utf8"));
  const f = snap.snapshot.meta.node_fields as string[];
  const types = snap.snapshot.meta.node_types[0] as string[];
  const W = f.length;
  const iT = f.indexOf("type");
  const iN = f.indexOf("name");
  const iS = f.indexOf("self_size");
  const nodes = snap.nodes as number[];
  const strings = snap.strings as string[];
  const agg: Agg = new Map();
  for (let i = 0; i < nodes.length; i += W) {
    const t = types[nodes[i + iT] as number];
    let name = strings[nodes[i + iN] as number] as string;
    if (t === "string" || t === "concatenated string" || t === "sliced string")
      name = `"${name.slice(0, 40).replace(/\s+/g, " ")}"`;
    const k = `${t}:${name}`;
    const a = agg.get(k) ?? { n: 0, size: 0 };
    a.n++;
    a.size += nodes[i + iS] as number;
    agg.set(k, a);
  }
  return { agg, snap };
}

const s = await scenario(N);
for (let r = 0; r < 2; r++) await round(s, N);
gc();
const f1 = writeHeapSnapshot("/tmp/alca-h1.heapsnapshot");
for (let r = 0; r < BETWEEN; r++) await round(s, N);
gc();
const f2 = writeHeapSnapshot("/tmp/alca-h2.heapsnapshot");
await s.close();
const A = aggregate(f1);
const B = aggregate(f2);
const a = A.agg;
const b = B.agg;
const sa = shapes(A.snap);
const sb = shapes(B.snap);
rmSync(f1);
rmSync(f2);
const diff = [...b.entries()]
  .map(([k, v]) => ({ k, dn: v.n - (a.get(k)?.n ?? 0), ds: v.size - (a.get(k)?.size ?? 0) }))
  .filter((x) => x.dn > 0)
  .sort((x, y) => y.ds - x.ds);
const runs = N * BETWEEN;
console.log(
  `N=${N}, ${BETWEEN} rounds between snapshots (${runs} worker runs + ${BETWEEN * (N + 1)} router turns)`,
);
console.log("Δcount | Δself KiB | per worker-run | kind:name");
for (const x of diff.slice(0, 40))
  console.log(
    `${String(x.dn).padStart(7)} | ${(x.ds / 1024).toFixed(1).padStart(8)} | ${(x.dn / runs).toFixed(1).padStart(6)} | ${x.k.slice(0, 110)}`,
  );
console.log("\nplain Object shapes that grew (first 8 property names):");
for (const [k, v] of [...sb.entries()]
  .map(([k, v]) => [k, v - (sa.get(k) ?? 0)] as const)
  .filter(([, d]) => d > 0)
  .sort((x, y) => y[1] - x[1])
  .slice(0, 15))
  console.log(`${String(v).padStart(6)}  {${k}}`);
