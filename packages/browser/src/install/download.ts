import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

/**
 * Resumable, verified file download. The partial file is `<dest>.part` with a
 * small `<dest>.part.json` beside it (url, ETag, total size, the server's
 * hashes), so a retry — in this run or after a restart — asks only for the
 * missing bytes (`Range` + `If-Range`). When the server names a hash
 * (Google Cloud Storage's `x-goog-hash: crc32c=…,md5=…`, which Chrome for
 * Testing downloads carry) the whole file is checked against it; otherwise
 * the size is. A mismatch throws away the partial file.
 */

export class DownloadError extends Error {
  readonly status: number | undefined;
  /** Worth another attempt (network trouble, 5xx, 429, a checksum mismatch). */
  readonly retryable: boolean;
  constructor(message: string, opts: { status?: number; retryable: boolean }) {
    super(message);
    this.name = "DownloadError";
    this.status = opts.status;
    this.retryable = opts.retryable;
  }
}

export interface DownloadProgress {
  received: number;
  total: number | undefined;
}

export interface DownloadOptions {
  url: string;
  dest: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  onProgress?: (p: DownloadProgress) => void;
  /** Extra attempts after the first (default 3). */
  retries?: number;
  /** First back-off; doubles each attempt (default 1000 ms). */
  backoffMs?: number;
  /** A size the caller already knows; checked when the server gives no hash. */
  expectedSize?: number;
}

export interface DownloadResult {
  path: string;
  size: number;
  /** What the file was checked against. */
  verified: "md5" | "crc32c" | "size";
  md5: string;
}

interface PartMeta {
  url: string;
  etag?: string;
  total?: number;
  md5?: string;
  crc32c?: string;
}

// ── CRC-32C (Castagnoli), as GCS reports it (base64, big-endian) ─────────
const CRC32C_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32c(buf: Uint8Array, prev = 0): number {
  let c = ~prev >>> 0;
  for (let i = 0; i < buf.length; i++)
    c = (CRC32C_TABLE[(c ^ (buf[i] as number)) & 0xff] as number) ^ (c >>> 8);
  return ~c >>> 0;
}

export function crc32cBase64(n: number): string {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b.toString("base64");
}

/** `x-goog-hash: crc32c=AAAAAA==,md5=…` → { crc32c, md5 } (both base64). */
export function parseGoogHash(header: string | null): { md5?: string; crc32c?: string } {
  const out: { md5?: string; crc32c?: string } = {};
  for (const part of (header ?? "").split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim().toLowerCase();
    const v = part.slice(i + 1).trim();
    if (k === "md5" && v) out.md5 = v;
    if (k === "crc32c" && v) out.crc32c = v;
  }
  return out;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    const t = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    function onAbort() {
      clearTimeout(t);
      reject(signal?.reason ?? new Error("aborted"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });

function readMeta(file: string): PartMeta | undefined {
  try {
    const m = JSON.parse(readFileSync(file, "utf8")) as PartMeta;
    return typeof m.url === "string" ? m : undefined;
  } catch {
    return undefined;
  }
}

function sizeOf(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

async function hashFile(file: string): Promise<{ md5: string; crc32c: string }> {
  const md5 = createHash("md5");
  let crc = 0;
  for await (const chunk of createReadStream(file, { highWaterMark: 1 << 20 })) {
    md5.update(chunk as Buffer);
    crc = crc32c(chunk as Buffer, crc);
  }
  return { md5: md5.digest("base64"), crc32c: crc32cBase64(crc) };
}

const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/** One attempt: fetch what is missing into the part file. Returns the full size when it got everything. */
async function attempt(o: DownloadOptions, part: string, metaFile: string): Promise<PartMeta> {
  const doFetch = o.fetch ?? fetch;
  let meta = readMeta(metaFile);
  if (!meta || meta.url !== o.url) {
    rmSync(part, { force: true });
    meta = { url: o.url };
  }
  let have = sizeOf(part);
  if (meta.total !== undefined && have > meta.total) {
    rmSync(part, { force: true });
    have = 0;
  }
  if (meta.total !== undefined && have === meta.total && have > 0) return meta;
  const headers: Record<string, string> = {};
  if (have > 0) {
    headers.range = `bytes=${have}-`;
    if (meta.etag) headers["if-range"] = meta.etag;
  }
  let res: Response;
  try {
    res = await doFetch(o.url, { headers, ...(o.signal ? { signal: o.signal } : {}), redirect: "follow" });
  } catch (err) {
    if (o.signal?.aborted) throw err;
    throw new DownloadError(`下載連線失敗：${String((err as Error)?.message ?? err)}`, { retryable: true });
  }
  if (res.status === 416 && have > 0) {
    // Nothing left to send, or the part is longer than the file: start over next time.
    rmSync(part, { force: true });
    throw new DownloadError("續傳位置不符，重新下載", { status: 416, retryable: true });
  }
  if (res.status !== 200 && res.status !== 206) {
    throw new DownloadError(`下載失敗：HTTP ${res.status}`, {
      status: res.status,
      retryable: RETRY_STATUS.has(res.status),
    });
  }
  let start = 0;
  let total: number | undefined;
  if (res.status === 206) {
    const m = /bytes (\d+)-(\d+)\/(\d+|\*)/.exec(res.headers.get("content-range") ?? "");
    start = m ? Number(m[1]) : Number.NaN;
    if (start !== have) {
      rmSync(part, { force: true });
      throw new DownloadError("伺服器回傳的續傳範圍不對，重新下載", { status: 206, retryable: true });
    }
    if (m?.[3] && m[3] !== "*") total = Number(m[3]);
  } else {
    have = 0;
    const len = Number(res.headers.get("content-length") ?? Number.NaN);
    if (Number.isFinite(len)) total = len;
  }
  const stored = Number(res.headers.get("x-goog-stored-content-length") ?? Number.NaN);
  if (total === undefined && Number.isFinite(stored)) total = stored;
  const hashes = parseGoogHash(res.headers.get("x-goog-hash"));
  const etag = res.headers.get("etag") ?? undefined;
  meta = {
    url: o.url,
    ...(etag ? { etag } : {}),
    ...(total !== undefined ? { total } : {}),
    ...hashes,
  };
  writeFileSync(metaFile, JSON.stringify(meta));
  if (!res.body) throw new DownloadError("下載沒有內容", { retryable: true });
  let received = have;
  let lastReport = 0;
  const report = (force = false) => {
    const now = Date.now();
    if (!force && now - lastReport < 200) return;
    lastReport = now;
    o.onProgress?.({ received, total });
  };
  report(true);
  const body = Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>);
  body.on("data", (c: Buffer) => {
    received += c.length;
    report();
  });
  try {
    await pipeline(body, createWriteStream(part, { flags: have > 0 ? "a" : "w" }), {
      ...(o.signal ? { signal: o.signal } : {}),
    });
  } catch (err) {
    if (o.signal?.aborted) throw err;
    throw new DownloadError(`下載中斷（已收到 ${received} bytes）`, { retryable: true });
  }
  report(true);
  const got = sizeOf(part);
  if (meta.total !== undefined && got < meta.total)
    throw new DownloadError(`下載不完整（${got}/${meta.total} bytes）`, { retryable: true });
  if (meta.total === undefined) meta.total = got;
  return meta;
}

/** Download `url` to `dest`, resuming and retrying; the file appears at `dest` only once it checks out. */
export async function downloadFile(o: DownloadOptions): Promise<DownloadResult> {
  const part = `${o.dest}.part`;
  const metaFile = `${o.dest}.part.json`;
  const retries = o.retries ?? 3;
  const backoff = o.backoffMs ?? 1000;
  let lastErr: unknown;
  for (let i = 0; i <= retries; i++) {
    if (i > 0) await sleep(backoff * 2 ** (i - 1), o.signal);
    try {
      const meta = await attempt(o, part, metaFile);
      const size = sizeOf(part);
      const h = await hashFile(part);
      let verified: DownloadResult["verified"] = "size";
      const bad = (what: string) => {
        rmSync(part, { force: true });
        rmSync(metaFile, { force: true });
        return new DownloadError(`下載的檔案${what}不符，已刪除並重試`, { retryable: true });
      };
      if (meta.total !== undefined && size !== meta.total) throw bad("大小");
      if (o.expectedSize !== undefined && size !== o.expectedSize) throw bad("大小");
      if (meta.crc32c) {
        if (h.crc32c !== meta.crc32c) throw bad(" CRC32C ");
        verified = "crc32c";
      }
      if (meta.md5) {
        if (h.md5 !== meta.md5) throw bad(" MD5 ");
        verified = "md5";
      }
      rmSync(o.dest, { force: true });
      renameSync(part, o.dest);
      rmSync(metaFile, { force: true });
      return { path: o.dest, size, verified, md5: h.md5 };
    } catch (err) {
      lastErr = err;
      if (o.signal?.aborted) throw err;
      if (!(err instanceof DownloadError) || !err.retryable) throw err;
    }
  }
  throw lastErr;
}

/** True when a partial download of `url` is waiting at `dest` (for "繼續下載" wording). */
export function hasPartial(dest: string, url: string): boolean {
  return existsSync(`${dest}.part`) && readMeta(`${dest}.part.json`)?.url === url;
}
