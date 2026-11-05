# Performance notes

Code comments tagged **`PERF-2026-11`** point here. They come from a measure-first performance review of
the desktop core, the store, Alca Link, workers and the phone PWA in November 2026. This page keeps the
decisions and the numbers that justify them; the scripts that produced the numbers are in `scripts/bench/`
and `scripts/bench-seal.ts`.

Absolute numbers were taken on a shared 2-vCPU Linux box and vary ±30–50 % between runs; read the ratios.

## What was changed, and why

| #   | Change                                                                                                                                                                 | Where                                                                 | Before → after                                                               |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 1   | Per-connection **statement cache** (LRU, 512). Emptied by any non-transaction `exec()` (migrations, PRAGMAs), by a prepared DDL statement, and on `close()` / `open()` | `packages/store/src/perf.ts`                                          | prepare + get as the repos do: 17.2 → 4.2 µs; `DeviceRepo.get` 13.1 → 1.6 µs |
| 2   | `AlcaCore.traces` keeps the newest 64 runs (was one entry per run, never removed)                                                                                      | `packages/core/src/agent.ts`                                          | ~2 KiB per run, unbounded → ≤ 64 runs                                        |
| 3   | **Reconnect backoff**: first retry 250 ms, ±20 % jitter, doubling to 30 s, shared by the core's host and the phone's client                                            | `packages/link/src/backoff.ts`, `host.ts`, `client.ts`                | relay restart → phone back online: ~2.9 s → ~0.3 s (median)                  |
| 4   | SQL stats bounded: savepoint names and `IN (?, …)` lists fold to one key; at most 1 000 keys between hourly resets                                                     | `packages/store/src/perf.ts`                                          | 1 000 nested `atomic()` blocks: 2 004 keys → 6                               |
| 5   | `pendingCards` reads only approval / question events, filtered in SQL                                                                                                  | `packages/core/src/agents/system.ts`, `AlcaCore.runEvents`            | 20k-event run: 12.95 → 0.058 ms per live worker per (re)connect              |
| 6   | Link checks a device's rights from a cached row, re-read only when `DeviceRepo.revision` changes                                                                       | `apps/desktop/src/link-rpc.ts`, `packages/store/src/repos/devices.ts` | per streamed event per phone: 13.1 µs → ~0                                   |
| 7   | **SSE backpressure**: a client with more than 4 MiB queued is cut off; the UI reconnects and the stream replays                                                        | `apps/desktop/src/sse-out.ts`                                         | stalled client: unbounded memory → ≤ 4 MiB                                   |
| 8   | The offline demo engines keep the newest 32 requests                                                                                                                   | `apps/desktop/src/demo-engine.ts`                                     | unbounded → ≤ 32                                                             |
| 9   | Node's **compile cache** is turned on before the core loads (`NODE_DISABLE_COMPILE_CACHE=1` turns it off)                                                              | `apps/desktop/src/main.ts`, `compile-cache.ts`, `core-main.ts`        | −2 to −15 % warm start (within noise on a loaded machine)                    |

Each change has a regression test that names the tag (for example `packages/store/test/stmt-cache.test.ts`,
`packages/core/test/traces-bounded.test.ts`, `packages/link/test/backoff.test.ts`,
`apps/desktop/test/sse-backpressure.test.ts`).

## Findings that did not lead to a change

- **Cold start** is 80–85 % loading ~700 TypeScript modules (Node's ESM loader and type stripping);
  `startDesktop()` itself takes about 0.1 s. Bundling the core at pack time would roughly halve it (see below).
- **Sealed storage** (column encryption) costs one `seal()` per sealed row (~3 µs fixed + ~2.4 µs per KB). On
  a Mac that is about 0.45 µs per streamed event. The useful target is µs per event or main-thread time,
  not a percentage of a write-only micro-benchmark.
- **Phone PWA**: ~260 boot modules, ~970 KiB raw / ~350 KiB gzip, no bundling.

## Open follow-ups

- **Bundle the core at pack time.** Needs `esbuild` as a pinned devDependency of `scripts/pack-core.ts`, two ESM
  entry points (`apps/desktop/src/main.ts` and `packages/store/src/db-worker-main.ts`), `werift` kept external,
  and every `import.meta.url` asset lookup made bundle-relative. Expected about −50 % cold start.
- Phone PWA: load the PAKE code lazily (an already-paired phone does not need it at boot), ship one locale,
  bundle.
- Desktop timeline: batch streamed deltas per animation frame.
- Link: coalesce `message.delta` per phone every 30–50 ms.
- Move sealing and inserting run events onto the existing database worker (`packages/store/src/db-worker.ts`).
