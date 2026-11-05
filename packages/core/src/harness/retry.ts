/**
 * P15 B7 (plan v11.1 §3 5.9): retrying a model call. Up to 4 retries (5
 * tries), 2 s doubling, each gap at most 30 s with ±20 % jitter; a
 * server-suggested wait is a floor, capped at 15 min. Timeouts retry at most
 * twice. Quota / billing, auth after one refresh, policy and bad requests do
 * not retry. The allowance is given back when a pass made progress (`noteProgress`).
 */

export const RETRY_MAX = 4;
export const RETRY_BASE_MS = 2000;
export const RETRY_GAP_CAP_MS = 30_000;
export const RETRY_TIMEOUT_MAX = 2;
export const RETRY_AFTER_CAP_MS = 15 * 60_000;

export type ErrorClass =
  | "aborted"
  | "overflow"
  | "auth"
  | "policy"
  | "bad_request"
  | "quota"
  | "retryable"
  | "timeout"
  | "fatal";

export interface ProviderErrorInfo {
  code?: string;
  status?: number;
  message?: string;
  headers?: Record<string, string | undefined>;
  aborted?: boolean;
}

const OVERFLOW_RE =
  /(context[_ ]length[_ ]exceeded|maximum context length|prompt is too long|too many tokens in (the )?(prompt|input)|input (is )?too long|exceeds the context window|request too large)/i;
const QUOTA_RE =
  /(insufficient_quota|billing|quota exceeded|credit|balance|monthly (usage )?limit|plan limit|額度不足|餘額)/i;
const RETRY_RE =
  /(overloaded|try again|temporarily|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|stream ended|premature|連不上)/i;
const TIMEOUT_RE = /(timed? ?out|ETIMEDOUT|逾時)/i;

export function classifyError(e: ProviderErrorInfo): ErrorClass {
  if (e.aborted) return "aborted";
  const msg = e.message ?? "";
  const status = e.status ?? statusFromText(msg);
  if (status === 413 || (OVERFLOW_RE.test(msg) && !/rate limit/i.test(msg))) return "overflow";
  const should = e.headers?.["x-should-retry"];
  if (QUOTA_RE.test(msg)) return "quota";
  if (should === "false") return "fatal";
  if (should === "true") return "retryable";
  if (status === 401 || e.code === "engine.auth") return "auth";
  if (status === 403) return "policy";
  if (status === 400 || status === 404 || status === 422) return "bad_request";
  if (TIMEOUT_RE.test(msg) || status === 408) return status === 408 ? "retryable" : "timeout";
  if (status !== undefined && [409, 429, 500, 502, 503, 504, 520, 524, 529].includes(status))
    return "retryable";
  if (e.code === "engine.network" || e.code === "engine.exited" || RETRY_RE.test(msg)) return "retryable";
  if (e.code === "engine.quota") return "retryable";
  return "fatal";
}

function statusFromText(msg: string): number | undefined {
  const m = /[（(](\d{3})[）)]/.exec(msg) ?? /\bHTTP (\d{3})\b/.exec(msg);
  return m ? Number(m[1]) : undefined;
}

export function parseRetryAfter(e: ProviderErrorInfo, now = Date.now()): number | undefined {
  const h = e.headers ?? {};
  const ms = h["retry-after-ms"];
  if (ms && Number.isFinite(Number(ms))) return Number(ms);
  const ra = h["retry-after"];
  if (ra) {
    const s = Number.parseFloat(ra);
    if (Number.isFinite(s) && /^\s*[\d.]+\s*$/.test(ra)) return s * 1000;
    const d = Date.parse(ra);
    if (Number.isFinite(d)) return Math.max(0, d - now);
  }
  const m = /try again in\s*([\d.]+)\s*(ms|s|sec|second)/i.exec(e.message ?? "");
  if (m) return (m[2] ?? "").toLowerCase() === "ms" ? Number(m[1]) : Number(m[1]) * 1000;
  return undefined;
}

/** The wait before retry `attempt` (1-based). `rand` returns [0, 1). */
export function retryDelayMs(
  attempt: number,
  e: ProviderErrorInfo,
  rand: () => number = Math.random,
): number {
  const local = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_GAP_CAP_MS) * (0.8 + 0.4 * rand());
  const server = parseRetryAfter(e);
  return Math.ceil(server === undefined ? local : Math.max(local, Math.min(server, RETRY_AFTER_CAP_MS)));
}

/** Whether a failed try may be retried, given how many retries were already spent. */
export function mayRetry(cls: ErrorClass, retriesSoFar: number, timeoutsSoFar = 0): boolean {
  if (cls === "retryable") return retriesSoFar < RETRY_MAX;
  if (cls === "timeout") return retriesSoFar < RETRY_MAX && timeoutsSoFar < RETRY_TIMEOUT_MAX;
  return false;
}

/**
 * Plan §2.6: the retry allowance of one worker run. Retries and timeouts
 * are counted across the passes of a run; a pass that made progress (a
 * successful tool call) gives the allowance back.
 */
export interface RetryBudget {
  retries: number;
  timeouts: number;
}

export const freshRetryBudget = (): RetryBudget => ({ retries: 0, timeouts: 0 });

/** Progress since the last failure: the allowance starts over. */
export function noteProgress(b: RetryBudget): void {
  b.retries = 0;
  b.timeouts = 0;
}

/**
 * Whether to retry a failed try, and after how long. Spends the allowance
 * when it says yes; `undefined` = give up (the error stands).
 */
export function nextRetry(
  b: RetryBudget,
  e: ProviderErrorInfo,
  rand: () => number = Math.random,
): number | undefined {
  const cls = classifyError(e);
  if (!mayRetry(cls, b.retries, b.timeouts)) return undefined;
  b.retries++;
  if (cls === "timeout") b.timeouts++;
  return retryDelayMs(b.retries, e, rand);
}

/** A back-off that ends early (rejects) when the signal aborts. */
export function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason ?? new Error("aborted"));
    };
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
