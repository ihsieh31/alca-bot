// A Wire is one bidirectional, ordered message pipe between a device and the
// core (a relay channel or a direct LAN socket). Handshake messages and
// sealed frames are JSON objects on it; the relay forwards them unread.
import { LinkError } from "./errors.ts";

export type WireMessage = Record<string, unknown>;

export interface Wire {
  send(m: WireMessage): void;
  /** Next message; rejects on close or timeout. Only one pending recv at a time. */
  recv(timeoutMs?: number): Promise<WireMessage>;
  /** After the handshake: every further message goes here instead of recv(). */
  onMessage(handler: (m: WireMessage) => void): void;
  onClose(handler: (reason: string) => void): void;
  close(reason?: string): void;
  readonly closed: boolean;
}

/**
 * Wire built on push callbacks: the transport calls `push` for every message
 * and `end` when it closes; `sendRaw` writes one message out.
 */
export class QueueWire implements Wire {
  private queue: WireMessage[] = [];
  private waiter: { resolve: (m: WireMessage) => void; reject: (e: Error) => void } | undefined;
  private handler: ((m: WireMessage) => void) | undefined;
  private closeHandlers: Array<(reason: string) => void> = [];
  private endReason: string | undefined;

  private readonly sendRaw: (m: WireMessage) => void;
  private readonly closeRaw: (reason: string) => void;

  constructor(sendRaw: (m: WireMessage) => void, closeRaw: (reason: string) => void = () => undefined) {
    this.sendRaw = sendRaw;
    this.closeRaw = closeRaw;
  }

  get closed(): boolean {
    return this.endReason !== undefined;
  }

  push(m: WireMessage): void {
    if (this.closed) return;
    if (this.handler) {
      this.handler(m);
      return;
    }
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = undefined;
      w.resolve(m);
      return;
    }
    if (this.queue.length > 256) {
      this.end("backlog");
      return;
    }
    this.queue.push(m);
  }

  end(reason = "closed"): void {
    if (this.closed) return;
    this.endReason = reason;
    this.waiter?.reject(new LinkError("closed", reason));
    this.waiter = undefined;
    for (const h of this.closeHandlers) h(reason);
  }

  send(m: WireMessage): void {
    if (!this.closed) this.sendRaw(m);
  }

  recv(timeoutMs = 15_000): Promise<WireMessage> {
    const next = this.queue.shift();
    if (next) return Promise.resolve(next);
    if (this.closed) return Promise.reject(new LinkError("closed", this.endReason));
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.waiter = undefined;
        reject(new LinkError("timeout", "no answer in time"));
      }, timeoutMs);
      this.waiter = {
        resolve: (m) => {
          clearTimeout(t);
          resolve(m);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      };
    });
  }

  onMessage(handler: (m: WireMessage) => void): void {
    this.handler = handler;
    for (const m of this.queue.splice(0)) handler(m);
  }

  onClose(handler: (reason: string) => void): void {
    if (this.endReason !== undefined) handler(this.endReason);
    else this.closeHandlers.push(handler);
  }

  close(reason = "closed"): void {
    if (this.closed) return;
    this.closeRaw(reason);
    this.end(reason);
  }
}

/** Two wires joined back to back (tests, in-process links). */
export function wirePair(): [QueueWire, QueueWire] {
  let a!: QueueWire;
  let b!: QueueWire;
  const clone = (m: WireMessage) => JSON.parse(JSON.stringify(m)) as WireMessage;
  a = new QueueWire(
    (m) => queueMicrotask(() => b.push(clone(m))),
    (r) => queueMicrotask(() => b.end(r)),
  );
  b = new QueueWire(
    (m) => queueMicrotask(() => a.push(clone(m))),
    (r) => queueMicrotask(() => a.end(r)),
  );
  return [a, b];
}

export const str = (m: WireMessage, key: string): string => {
  const v = m[key];
  if (typeof v !== "string" || v.length > 4096) throw new LinkError("malformed", `missing ${key}`);
  return v;
};
