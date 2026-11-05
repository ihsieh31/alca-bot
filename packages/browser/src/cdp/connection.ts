/**
 * Minimal CDP client over any message transport. The browser host is the only
 * holder of a connection; nothing here is exposed to agent code.
 * Target sessions use flat mode: every message may carry a `sessionId`.
 */

export interface CdpTransport {
  send(text: string): void;
  onMessage(fn: (text: string) => void): void;
  onClose(fn: (reason: string) => void): void;
  close(): void;
}

export class CdpError extends Error {
  readonly method: string;
  readonly code: number | undefined;
  constructor(method: string, message: string, code?: number) {
    super(`${method}: ${message}`);
    this.name = "CdpError";
    this.method = method;
    this.code = code;
  }
}

export class CdpClosedError extends Error {
  constructor(reason: string) {
    super(`browser connection closed: ${reason}`);
    this.name = "CdpClosedError";
  }
}

/** Pseudo-event fired once when the connection goes away. */
export const CLOSED_EVENT = "alca.closed";

type Params = Record<string, unknown>;
// biome-ignore lint/suspicious/noExplicitAny: CDP results are untyped JSON; callers narrow.
type Json = any;
type Listener = (params: Json, sessionId: string | undefined) => void;

/** What the host and page drivers need from a connection (the fake implements this too). */
export interface Cdp {
  send(method: string, params?: Params, sessionId?: string): Promise<Json>;
  /** Subscribe to an event; `sessionId` undefined = browser-level, "*" = any session. */
  on(method: string, fn: Listener, sessionId?: string): () => void;
  readonly closed: boolean;
  close(): void;
}

/** A target session bound to one `sessionId`. */
export class CdpSession {
  readonly cdp: Cdp;
  readonly sessionId: string;
  constructor(cdp: Cdp, sessionId: string) {
    this.cdp = cdp;
    this.sessionId = sessionId;
  }
  send(method: string, params: Params = {}): Promise<Json> {
    return this.cdp.send(method, params, this.sessionId);
  }
  on(method: string, fn: (params: Json) => void): () => void {
    return this.cdp.on(method, (p) => fn(p), this.sessionId);
  }
}

export class CdpConnection implements Cdp {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { method: string; resolve: (v: Json) => void; reject: (e: Error) => void }
  >();
  private readonly listeners = new Map<string, Set<{ fn: Listener; sessionId: string | undefined }>>();
  private closedReason: string | undefined;
  private readonly transport: CdpTransport;
  private readonly timeoutMs: number;

  constructor(transport: CdpTransport, opts: { timeoutMs?: number } = {}) {
    this.transport = transport;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    transport.onMessage((text) => this.receive(text));
    transport.onClose((reason) => this.shutdown(reason));
  }

  get closed(): boolean {
    return this.closedReason !== undefined;
  }

  /** `opts.timeoutMs` overrides the connection's timeout for this one call. */
  send(
    method: string,
    params: Params = {},
    sessionId?: string,
    opts: { timeoutMs?: number } = {},
  ): Promise<Json> {
    if (this.closedReason) return Promise.reject(new CdpClosedError(this.closedReason));
    const id = this.nextId++;
    const ms = opts.timeoutMs ?? this.timeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new CdpError(method, `timed out after ${ms} ms`));
      }, ms);
      timer.unref?.();
      this.pending.set(id, {
        method,
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.transport.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(method: string, fn: Listener, sessionId?: string): () => void {
    let set = this.listeners.get(method);
    if (!set) {
      set = new Set();
      this.listeners.set(method, set);
    }
    const entry = { fn, sessionId };
    set.add(entry);
    return () => set.delete(entry);
  }

  close(): void {
    this.transport.close();
    this.shutdown("closed by host");
  }

  private receive(text: string): void {
    let msg: { id?: number; method?: string; params?: Json; result?: Json; error?: Json; sessionId?: string };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new CdpError(p.method, String(msg.error.message ?? "error"), msg.error.code));
      else p.resolve(msg.result ?? {});
      return;
    }
    if (!msg.method) return;
    const set = this.listeners.get(msg.method);
    if (!set) return;
    for (const l of [...set]) {
      if (l.sessionId === "*" || l.sessionId === msg.sessionId) {
        try {
          l.fn(msg.params ?? {}, msg.sessionId);
        } catch {
          // a listener bug must not break the connection
        }
      }
    }
  }

  private shutdown(reason: string): void {
    if (this.closedReason) return;
    this.closedReason = reason;
    for (const p of this.pending.values()) p.reject(new CdpClosedError(reason));
    this.pending.clear();
    const set = this.listeners.get(CLOSED_EVENT);
    for (const l of set ?? []) l.fn({ reason }, undefined);
  }
}
