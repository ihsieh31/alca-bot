/**
 * PERF-2026-11 (5): phone PWA payload and boot cost, from a built dist.
 *
 *   node --disable-warning=ExperimentalWarning apps/phone-pwa/scripts/build.ts /tmp/pwa-dist
 *   node --experimental-vm-modules --disable-warning=ExperimentalWarning scripts/bench/pwa-size.ts /tmp/pwa-dist
 *
 * Reports: files and bytes by kind (raw / gzip -9 / brotli q11), the JS module
 * graph reached from index.html's entry (static imports only; dynamic imports
 * listed separately), its depth (= serial request round trips on a cold,
 * un-cached load without modulepreload), and V8 parse+compile time of every
 * module on the boot path (vm.SourceTextModule, best of 5) — a desktop-class
 * CPU number; a phone is typically 3–5× slower.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import vm from "node:vm";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const DIST = resolve(process.argv[2] ?? "apps/phone-pwa/dist");
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
const gz = (b: Buffer) => gzipSync(b, { level: 9 }).length;
const br = (b: Buffer) => brotliCompressSync(b, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
const kb = (n: number) => `${(n / 1024).toFixed(1)}`;

const files = walk(DIST);
const kinds = new Map<string, { n: number; raw: number; gz: number; br: number }>();
for (const f of files) {
  const ext = f.split(".").pop() as string;
  const b = readFileSync(f);
  const k = kinds.get(ext) ?? { n: 0, raw: 0, gz: 0, br: 0 };
  k.n++;
  k.raw += b.length;
  k.gz += gz(b);
  k.br += br(b);
  kinds.set(ext, k);
}
console.log(`dist ${DIST}: ${files.length} files`);
console.log("kind | files | raw KiB | gzip KiB | brotli KiB (sum of per-file)");
for (const [k, v] of [...kinds].sort((a, b) => b[1].raw - a[1].raw))
  console.log(`${k} | ${v.n} | ${kb(v.raw)} | ${kb(v.gz)} | ${kb(v.br)}`);

// Module graph from the entry.
const html = readFileSync(join(DIST, "index.html"), "utf8");
const entry = resolve(DIST, /<script type="module" src="([^"]+)"/.exec(html)?.[1] as string);
const STATIC = /^\s*(?:import|export)\s[^;]*?from\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']/gm;
const DYN = /import\(\s*["']([^"']+)["']\s*\)/g;
const depth = new Map<string, number>();
const dyn = new Set<string>();
const queue: Array<[string, number]> = [[entry, 1]];
while (queue.length) {
  const [f, d] = queue.shift() as [string, number];
  if ((depth.get(f) ?? Number.POSITIVE_INFINITY) <= d) continue;
  depth.set(f, d);
  const src = readFileSync(f, "utf8");
  for (const m of src.matchAll(STATIC)) {
    const spec = (m[1] ?? m[2]) as string;
    if (spec.startsWith(".")) queue.push([resolve(dirname(f), spec), d + 1]);
  }
  for (const m of src.matchAll(DYN))
    if ((m[1] as string).startsWith(".")) dyn.add(resolve(dirname(f), m[1] as string));
}
const boot = [...depth.keys()];
const bytes = boot.map((f) => readFileSync(f));
const raw = bytes.reduce((a, b) => a + b.length, 0);
const all = Buffer.concat(bytes);
console.log(
  `\nboot JS (static graph from ${relative(DIST, entry)}): ${boot.length} modules, ${kb(raw)} KiB raw, ${kb(bytes.reduce((a, b) => a + gz(b), 0))} KiB gzip per-file, ${kb(gz(all))} KiB gzip if concatenated, ${kb(br(all))} KiB brotli concatenated`,
);
console.log(
  `import depth (serial round trips on a cold load w/o modulepreload): ${Math.max(...depth.values())}`,
);
const notBoot = files.filter((f) => f.endsWith(".js") && !depth.has(f) && !f.endsWith("sw.js"));
console.log(
  `JS not on the static boot path: ${notBoot.length} files, ${kb(notBoot.reduce((a, f) => a + statSync(f).size, 0))} KiB (dynamic-import targets: ${dyn.size})`,
);
const big = boot
  .map((f, i) => [relative(DIST, f), (bytes[i] as Buffer).length] as const)
  .sort((a, b) => b[1] - a[1]);
console.log("largest boot modules:");
for (const [f, n] of big.slice(0, 10)) console.log(`  ${kb(n)} KiB ${f}`);

// Parse + compile (V8, lazy) of every boot module.
const SourceTextModule = (vm as unknown as { SourceTextModule?: new (s: string, o?: unknown) => unknown })
  .SourceTextModule;
if (!SourceTextModule) console.log("\n(run with --experimental-vm-modules for parse/compile timing)");
else {
  let bestMs = Number.POSITIVE_INFINITY;
  for (let r = 0; r < 5; r++) {
    const t = performance.now();
    for (const b of bytes) new SourceTextModule(b.toString("utf8"), { identifier: String(Math.random()) });
    bestMs = Math.min(bestMs, performance.now() - t);
  }
  const i18n = boot.filter((f) => f.includes("/i18n/"));
  let i18nMs = Number.POSITIVE_INFINITY;
  for (let r = 0; r < 5; r++) {
    const t = performance.now();
    for (const f of i18n)
      new SourceTextModule(readFileSync(f, "utf8"), { identifier: String(Math.random()) });
    i18nMs = Math.min(i18nMs, performance.now() - t);
  }
  console.log(
    `\nV8 parse+compile of the boot graph (this CPU, best of 5): ${bestMs.toFixed(1)} ms; of which i18n tables (${i18n.length} files): ${i18nMs.toFixed(1)} ms`,
  );
}
