/**
 * PERF-2026-11 (1) + (3, idle): core cold start to ready, and idle RSS.
 *
 *   node scripts/bench/cold-start.ts [runs] [idleSec]
 *
 * Spawns `apps/desktop/src/main.ts --engine demo --browser off` exactly as
 * `pnpm desktop:demo` would (minus Chromium), with ALCA_VAULT_BACKEND=file
 * (no keychain in CI / Linux sandboxes). For each run it records, from spawn:
 *   - t_banner: the 「Alca 已啟動」 line on stdout (startDesktop resolved)
 *   - t_health: first 200 from GET /api/health (the HTTP server answers)
 * "first" = a fresh data dir (creates vault.key, core.dbKey, runs all
 * migrations); "warm" = a second start on the same dir. Then it waits
 * `idleSec` and reads VmRSS / VmHWM of the core from /proc (Linux) or
 * `ps -o rss` (macOS).
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const RUNS = Number(process.argv[2] ?? 5);
const IDLE = Number(process.argv[3] ?? 10);
const ROOT = new URL("../../", import.meta.url).pathname;

function rssKb(pid: number): { rss: number; hwm: number } {
  try {
    const s = readFileSync(`/proc/${pid}/status`, "utf8");
    const g = (k: string) => Number(new RegExp(`${k}:\\s+(\\d+)`).exec(s)?.[1] ?? 0);
    return { rss: g("VmRSS"), hwm: g("VmHWM") };
  } catch {
    const rss = Number(
      execFileSync("ps", ["-o", "rss=", "-p", String(pid)])
        .toString()
        .trim(),
    );
    return { rss, hwm: Number.NaN };
  }
}

async function once(dir: string, measureIdle: boolean) {
  const t0 = performance.now();
  const child = spawn(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "apps/desktop/src/main.ts",
      "--engine",
      "demo",
      "--data-dir",
      dir,
      "--browser",
      "off",
      "--no-browser-download",
      "--no-open",
      "--port",
      "0",
    ],
    { cwd: ROOT, env: { ...process.env, ALCA_VAULT_BACKEND: "file" }, stdio: ["ignore", "pipe", "pipe"] },
  );
  let out = "";
  let banner = Number.NaN;
  const url = await new Promise<string>((res, rej) => {
    const to = setTimeout(() => rej(new Error(`no banner in 60 s:\n${out}`)), 60_000);
    child.stdout.on("data", (b: Buffer) => {
      out += b.toString();
      if (Number.isNaN(banner) && out.includes("已啟動")) banner = performance.now() - t0;
      const m = /網址：(http:\/\/127\.0\.0\.1:\d+)/.exec(out);
      if (m) {
        clearTimeout(to);
        res(m[1] as string);
      }
    });
    child.stderr.on("data", (b: Buffer) => {
      out += b.toString();
    });
    child.on("exit", (c) => rej(new Error(`exited ${c}:\n${out}`)));
  });
  let health = Number.NaN;
  for (;;) {
    try {
      const r = await fetch(`${url}/api/health`);
      if (r.ok) {
        health = performance.now() - t0;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 5));
  }
  let mem: { rss: number; hwm: number } | undefined;
  let mem0: { rss: number; hwm: number } | undefined;
  if (measureIdle) {
    mem0 = rssKb(child.pid as number);
    await new Promise((r) => setTimeout(r, IDLE * 1000));
    mem = rssKb(child.pid as number);
  }
  const exited = new Promise((r) => child.on("exit", r));
  child.kill("SIGTERM");
  await exited;
  return { banner, health, mem0, mem };
}

const med = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] as number;
};

console.log(`node ${process.version} ${process.platform}/${process.arch}, runs ${RUNS}`);
const first: number[] = [];
const firstH: number[] = [];
const warm: number[] = [];
const warmH: number[] = [];
let idle: Awaited<ReturnType<typeof once>> | undefined;
for (let i = 0; i < RUNS; i++) {
  const dir = mkdtempSync(join(tmpdir(), "alca-cold-"));
  try {
    const a = await once(dir, false);
    first.push(a.banner);
    firstH.push(a.health);
    const b = await once(dir, i === RUNS - 1);
    warm.push(b.banner);
    warmH.push(b.health);
    if (b.mem) idle = b;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const f = (xs: number[]) =>
  `median ${med(xs).toFixed(0)} ms (min ${Math.min(...xs).toFixed(0)}, max ${Math.max(...xs).toFixed(0)})`;
console.log(`first start  banner ${f(first)}; /api/health ${f(firstH)}`);
console.log(`warm start   banner ${f(warm)}; /api/health ${f(warmH)}`);
if (idle?.mem && idle.mem0)
  console.log(
    `idle RSS: at ready ${(idle.mem0.rss / 1024).toFixed(1)} MB; after ${IDLE}s idle ${(idle.mem.rss / 1024).toFixed(1)} MB (peak ${(idle.mem.hwm / 1024).toFixed(1)} MB)`,
  );
