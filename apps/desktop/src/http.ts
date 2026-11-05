import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { codeOf } from "@alca/design/i18n";

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
};

export const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export function send(
  res: ServerResponse,
  status: number,
  body: string | Buffer,
  type: string,
  extra: Record<string, string> = {},
): void {
  res.writeHead(status, { ...SECURITY_HEADERS, "content-type": type, "cache-control": "no-store", ...extra });
  res.end(body);
}

export function json(res: ServerResponse, status: number, value: unknown): void {
  send(res, status, JSON.stringify(value), "application/json; charset=utf-8");
}

/**
 * An error answer (R9.3 batch 5): `error` is the text as before (old clients
 * show it); when it is one of the table's `core.*` texts, `code` and `params`
 * let a new UI show it in its own language.
 */
export function errorBody(message: string): {
  error: string;
  code?: string;
  params?: Record<string, string>;
} {
  const c = codeOf(message);
  return c ? { error: message, code: c.code, params: c.params } : { error: message };
}

export async function readJson(req: IncomingMessage, max = 256 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req as AsyncIterable<Buffer>) {
    size += c.length;
    if (size > max) throw new HttpError(413, "body too large");
    chunks.push(c);
  }
  if (size === 0) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("not an object");
    return v as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "body must be a JSON object");
  }
}

/**
 * DNS-rebinding defense: the Host header must name our loopback address and
 * port, and a browser Origin (when sent) must be the same origin.
 */
export function checkHostAndOrigin(req: IncomingMessage, port: number): void {
  const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  const host = String(req.headers.host ?? "");
  if (!allowed.has(host)) throw new HttpError(403, "unexpected Host header");
  const origin = req.headers.origin;
  if (origin !== undefined && !allowed.has(origin.replace(/^http:\/\//, ""))) {
    throw new HttpError(403, "cross-origin request refused");
  }
}

export function checkToken(req: IncomingMessage, token: string): void {
  const header = String(req.headers.authorization ?? "");
  const got = Buffer.from(header);
  const want = Buffer.from(`Bearer ${token}`);
  if (got.length !== want.length || !timingSafeEqual(got, want))
    throw new HttpError(401, "missing or wrong local token");
}
