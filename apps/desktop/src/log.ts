// The core's own log lines (P13 B1): `advanced.logLevel` in config.json says
// how much is written. The terminal banner of `pnpm desktop` is not a log line
// and is always shown. As a service, stdout / stderr go to <data>/logs/core.log.
export type LogLevel = "error" | "warn" | "info" | "debug";

const RANK: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };
let level: LogLevel = "info";
let sink: { err: (l: string) => void; out: (l: string) => void } = {
  err: (l) => console.error(l),
  out: (l) => console.log(l),
};

export function setLogLevel(l: LogLevel): void {
  level = l;
}

export function logLevel(): LogLevel {
  return level;
}

/** Tests: capture the lines. */
export function setLogSink(s: { err: (l: string) => void; out: (l: string) => void }): () => void {
  const before = sink;
  sink = s;
  return () => {
    sink = before;
  };
}

const at = (l: LogLevel, line: string) => {
  if (RANK[l] > RANK[level]) return;
  const stamped = `${new Date().toISOString()} ${l.toUpperCase().padEnd(5)} ${line}`;
  (l === "error" || l === "warn" ? sink.err : sink.out)(stamped);
};

export const log = {
  error: (line: string) => at("error", line),
  warn: (line: string) => at("warn", line),
  info: (line: string) => at("info", line),
  debug: (line: string) => at("debug", line),
};
