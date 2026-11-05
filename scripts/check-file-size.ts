// Fails when any source file exceeds the line cap (no god files).
// Usage: node scripts/check-file-size.ts [--max 800] [dir ...]
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|rs)$/;
const SKIP = new Set(["node_modules", "dist", "build", "coverage", ".git", "target"]);
const DEFAULT_ROOTS = ["packages", "apps", "services", "scripts"];

export function countLines(text: string): number {
  if (text.length === 0) return 0;
  const n = text.split("\n").length;
  return text.endsWith("\n") ? n - 1 : n;
}

function* walk(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (SOURCE.test(name)) yield p;
  }
}

export function findOversized(roots: string[], max: number): Array<{ file: string; lines: number }> {
  const out: Array<{ file: string; lines: number }> = [];
  for (const root of roots) {
    for (const file of walk(root)) {
      const lines = countLines(readFileSync(file, "utf8"));
      if (lines > max) out.push({ file, lines });
    }
  }
  return out;
}

let max = 800;
const roots: string[] = [];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--max") max = Number(args[++i]);
  else roots.push(args[i] as string);
}
if (!Number.isInteger(max) || max <= 0) {
  console.error("--max must be a positive integer");
  process.exit(2);
}
const cwd = process.cwd();
const targets = (roots.length ? roots : DEFAULT_ROOTS).map((r) => resolve(cwd, r));
const bad = findOversized(targets, max);
if (bad.length) {
  for (const b of bad) console.error(`✗ ${relative(cwd, b.file)}: ${b.lines} lines (max ${max})`);
  process.exit(1);
}
console.log(`✓ no source file over ${max} lines`);
