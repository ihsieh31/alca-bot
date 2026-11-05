import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { createInterface } from "node:readline";
import { HttpError } from "./http.ts";

/**
 * The desktop's approve key (review 2026-11-04b S2.2).
 *
 * The local token in `secrets.json` is readable by anything running as the
 * person — including a bot's shell under 自主 — so with only that token a
 * prompt-injected bot could raise a payment card and then POST
 * /api/approvals/:id itself. Approving (and pairing a new device, and giving a
 * device more scopes, which would let a fake phone approve) now also needs
 * an approve key that:
 *
 * - is made fresh at every start and lives only in this process's memory
 *   (never on disk, in the environment, on a command line or in a log);
 * - reaches a window only through a one-time launch code (2 min, single use)
 *   in the URL fragment of a window the core opens itself (`openInBrowser`;
 *   `alca open` asks the core to do that) — the page trades the code for the
 *   key with `POST /api/ui/session` and keeps it in memory only;
 * - is sent as `x-alca-approve` together with a same-origin `Origin` header.
 * - The desktop shell (Tauri) starts the core with `ALCA_UI_CODES=stdin` and
 *   writes its own one-time codes on the core's stdin, one per line, before it
 *   points its window at `#token=…&ui=<code>` (`acceptFrom`): the shell's
 *   window can approve too, and the code is never on a command line or in the
 *   environment.
 *
 * Residual risk (docs/SECURITY.md): the launch URL is on the command line of
 * `open` / `xdg-open` for the moment it runs; a code taken by someone else
 * makes the person's own window fail its exchange, which it says loudly. A
 * window without the key (the desktop shell's own window, a reload) cannot
 * approve: it opens one that can (`POST /api/ui/open`), and phones approve
 * over Alca Link with the `approve` scope as before.
 */

const CODE_TTL_MS = 2 * 60_000;
/** A code handed in by the shell: lower-case hex, 32–128 characters. */
const CODE_SHAPE = /^[0-9a-f]{32,128}$/;
/** How long an exchange waits for a code the shell is still writing on stdin. */
const STDIN_GRACE_MS = 2000;
const MAX_CODES = 8;
const OPEN_EVERY_MS = 2000;

/** Requests that need the approve key as well as the local token. */
const NEEDS_KEY: ReadonlyArray<[string, RegExp]> = [
  ["POST", /^\/api\/approvals\/[^/]+$/],
  ["POST", /^\/api\/link\/pairings$/],
  ["POST", /^\/api\/link\/enrollments\/[^/]+$/],
  ["POST", /^\/api\/link\/devices\/[^/]+\/scopes$/],
  // Phase 6: answering a worker's NEEDS_INPUT as the person (person-only questions: sign-in, payment, codes).
  ["POST", /^\/api\/workers\/[^/]+\/answer$/],
  // Design §0.2.5: 續做 spends another step budget; the person's own act.
  ["POST", /^\/api\/workers\/[^/]+\/continue$/],
  // Design §0.2.7: keeping or removing a website password is the person's own act.
  ["POST", /^\/api\/connectors\/logins$/],
  ["DELETE", /^\/api\/connectors\/logins\/[^/]+$/],
  // R5.6: importing adds a conversation (and with a bot scope later, bots and triggers): a widening.
  ["POST", /^\/api\/import$/],
  // R7.5 step 5: deleting the old plaintext backups cannot be undone.
  ["POST", /^\/api\/settings\/encryption\/drop-plaintext-backups$/],
  // Next round R8: adding or changing an MCP server (a program that runs / an endpoint it calls) widens what Alca does.
  ["PUT", /^\/api\/connectors\/mcp\/[^/]+$/],
];

export function needsApproveKey(method: string, path: string): boolean {
  return NEEDS_KEY.some(([m, re]) => m === method && re.test(path));
}

/**
 * Requests that carried a valid approve key (marked once in server.ts). A
 * route whose need for the key depends on its body (turning 完全授權 on) reads
 * this instead of a path rule.
 */
const KEYED = new WeakSet<IncomingMessage>();
export function markApproveKey(req: IncomingMessage): void {
  KEYED.add(req);
}
export function carriedApproveKey(req: IncomingMessage): boolean {
  return KEYED.has(req);
}

const eq = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export class UiSessions {
  private readonly key = randomBytes(32).toString("hex");
  private readonly codes = new Map<string, number>();
  private lastOpen = 0;
  private readonly now: () => number;
  /** A code was tried that had been used or never existed (someone else may have taken it). */
  failedExchanges = 0;

  constructor(o: { now?: () => number } = {}) {
    this.now = o.now ?? Date.now;
  }

  /** A one-time launch code for the fragment of a window the core opens. */
  mint(): string {
    const t = this.now();
    for (const [c, exp] of this.codes) if (exp <= t) this.codes.delete(c);
    while (this.codes.size >= MAX_CODES) this.codes.delete(this.codes.keys().next().value as string);
    const code = randomBytes(24).toString("hex");
    this.codes.set(code, t + CODE_TTL_MS);
    return code;
  }

  /** Register a code made elsewhere (the desktop shell, over stdin); false when it is malformed. */
  accept(code: string): boolean {
    const c = code.trim();
    if (!CODE_SHAPE.test(c)) return false;
    const t = this.now();
    for (const [k, exp] of this.codes) if (exp <= t) this.codes.delete(k);
    while (this.codes.size >= MAX_CODES) this.codes.delete(this.codes.keys().next().value as string);
    this.codes.set(c, t + CODE_TTL_MS);
    return true;
  }

  /** Codes arrive on this stream (the core's stdin under the shell), one per line. */
  private external = false;
  acceptFrom(input: NodeJS.ReadableStream): void {
    this.external = true;
    const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
    lines.on("line", (l) => void this.accept(l));
    // The shell went away: nothing more will come (parent-watch ends the core).
    lines.on("close", () => {
      this.external = false;
    });
  }

  /**
   * `exchange`, but a code not seen yet gets a short grace while codes come in
   * over stdin: the shell writes the line and then navigates, and the page's
   * request can be read before the pipe is.
   */
  async exchangeSoon(code: unknown, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))) {
    if (this.external && typeof code === "string" && !this.codes.has(code) && CODE_SHAPE.test(code))
      for (let waited = 0; waited < STDIN_GRACE_MS && !this.codes.has(code); waited += 50) await sleep(50);
    return this.exchange(code);
  }

  /** Trade a launch code for the approve key, once. */
  exchange(code: unknown): string {
    const exp = typeof code === "string" ? this.codes.get(code) : undefined;
    if (typeof code === "string") this.codes.delete(code);
    if (exp === undefined || exp <= this.now()) {
      this.failedExchanges++;
      throw new HttpError(
        403,
        "這個開啟連結已經用過或過期了。如果不是你剛剛用的，可能有別的程式搶先使用；請重新開啟 Alca 視窗。",
      );
    }
    return this.key;
  }

  /** Throttle for `POST /api/ui/open` (a bot holding the token must not spam windows). */
  mayOpen(): boolean {
    const t = this.now();
    if (t - this.lastOpen < OPEN_EVERY_MS) return false;
    this.lastOpen = t;
    return true;
  }

  /** True when the request carries the approve key and a same-origin Origin header. */
  passes(req: IncomingMessage, port: number): boolean {
    const got = String(req.headers["x-alca-approve"] ?? "");
    const origin = String(req.headers.origin ?? "");
    const same = [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`];
    return !!got && eq(got, this.key) && same.includes(origin);
  }

  /** The approve key and a same-origin Origin header, or 403. */
  check(req: IncomingMessage, port: number): void {
    if (!this.passes(req, port))
      throw new HttpError(
        403,
        "核准需要由 Alca 開啟的視窗（或已配對、有核准權限的手機）；只有本機權杖不能核准。",
      );
  }
}
