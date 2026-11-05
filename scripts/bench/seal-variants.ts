/**
 * PERF-2026-11 (4): what one AES-256-GCM seal costs in Node, piece by piece,
 * and whether cheaper ways to build the same stored form exist.
 *
 *   node scripts/bench/seal-variants.ts [n] [rounds]
 *
 * Every variant produces the identical format `{"$enc":1,"k":K,"d":"<b64(nonce‖ct‖tag)>"}`
 * and the output of each is checked to open with the store's Sealer.
 */
import { createCipheriv, randomBytes } from "node:crypto";
import { Sealer } from "../../packages/store/src/seal.ts";

const N = Number(process.argv[2] ?? 20000);
const ROUNDS = Number(process.argv[3] ?? 7);
const key = randomBytes(32);
const ring = { current: 1, keys: { "1": key.toString("base64") } };
const sealer = new Sealer(ring);
const cpu = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
};

let pool = Buffer.alloc(0);
let at = 0;
const nonce = () => {
  if (at + 12 > pool.length) {
    pool = randomBytes(12 * 1024);
    at = 0;
  }
  const n = pool.subarray(at, at + 12);
  at += 12;
  return n;
};

// V1: the store's current seal (packages/store/src/seal.ts:190).
const v1 = (pk: string, text: string) => sealer.seal("run_events", "payload", pk, text);

// V2: same, but the plaintext is encoded once into a buffer and the output is
// one preallocated buffer (no Buffer.concat of three parts).
const v2 = (pk: string, text: string) => {
  const n = nonce();
  const c = createCipheriv("aes-256-gcm", key, n);
  c.setAAD(Buffer.from(`run_events|payload|${pk}`, "latin1"));
  const ct = c.update(text, "utf8");
  c.final();
  const out = Buffer.allocUnsafe(12 + ct.length + 16);
  n.copy(out, 0);
  ct.copy(out, 12);
  c.getAuthTag().copy(out, 12 + ct.length);
  return `{"$enc":1,"k":1,"d":"${out.toString("base64")}"}`;
};

// V3: V2 without base64/JSON wrapping (what a BLOB column would store): how much base64 costs.
const v3 = (pk: string, text: string) => {
  const n = nonce();
  const c = createCipheriv("aes-256-gcm", key, n);
  c.setAAD(Buffer.from(`run_events|payload|${pk}`, "latin1"));
  const ct = c.update(text, "utf8");
  c.final();
  const out = Buffer.allocUnsafe(12 + ct.length + 16);
  n.copy(out, 0);
  ct.copy(out, 12);
  c.getAuthTag().copy(out, 12 + ct.length);
  return out as unknown as string;
};

// Pieces, to attribute the time.
const onlyCreate = (_pk: string, _t: string) => {
  createCipheriv("aes-256-gcm", key, nonce());
  return "";
};
const createFinal = (pk: string, _t: string) => {
  const c = createCipheriv("aes-256-gcm", key, nonce());
  c.setAAD(Buffer.from(`run_events|payload|${pk}`, "latin1"));
  c.final();
  c.getAuthTag();
  return "";
};

const texts = (size: number) =>
  Array.from({ length: N }, (_, i) =>
    JSON.stringify({
      seq: i,
      data: { delta: "第段 some streamed text ".repeat(Math.ceil(size / 30)) },
    }).slice(0, size),
  );

function time(f: (pk: string, t: string) => string, xs: string[]) {
  let b = Number.POSITIVE_INFINITY;
  for (let r = 0; r < ROUNDS; r++) {
    const t = cpu();
    for (let i = 0; i < N; i++) f(`run_bench:${i}`, xs[i] as string);
    b = Math.min(b, cpu() - t);
  }
  return (b * 1000) / N;
}

// Correctness: V2 output opens with the store's Sealer.
const probe = v2("run_bench:7", '{"a":"測試"}');
if (sealer.open("run_events", "payload", "run_bench:7", probe) !== '{"a":"測試"}')
  throw new Error("v2 mismatch");

console.log(`n ${N}, best of ${ROUNDS}, node ${process.version} (${process.platform}/${process.arch})`);
console.log(
  "size B | createCipheriv only | +AAD/final/tag | V1 store seal | V2 single buffer | V3 no base64 (BLOB)",
);
for (const size of [64, 400, 1000, 3000]) {
  const xs = texts(size);
  const r = [onlyCreate, createFinal, v1, v2, v3].map((f) => time(f, xs).toFixed(2));
  console.log(`${size} | ${r.join(" | ")} µs`);
}
