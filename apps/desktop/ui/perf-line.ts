// R2.2: the shape GET /api/settings/perf answers and the one line 設定 → 資料 shows (no DOM here).
import { t } from "./i18n/index.ts";

export interface PerfSnap {
  loop: { p50: number; p99: number; max: number; samples: number };
  slow: Array<{ at: string; ms: number; sql: string; kind: string; conn: string }>;
  top: Array<{ sql: string; calls: number; totalMs: number; maxMs: number }>;
  lockWaitMs: { count: number; max: number };
  jobs: Record<string, { lastMs: number; maxMs: number; at: string }>;
}
export interface PerfView {
  now: PerfSnap;
  lastHour?: PerfSnap;
  slowLastHour: number;
  warnLastHour: number;
  warnings: string[];
}

/** 事件迴圈：p99 12 ms｜慢查詢 0 筆（過去 1 小時）, from the last closed hour when there is one. */
export function perfLine(p: PerfView): string {
  const loop = (p.lastHour ?? p.now).loop;
  return t("desktop.perfLine.eventLoopP99SlowQueries", {
    p0: loop.samples ? `${Math.round(loop.p99)} ms` : "—",
    slowLastHour: p.slowLastHour,
  });
}
