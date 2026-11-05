// The application layer inside a session: requests both ways, responses,
// and pushed events (the Alca protocol events, the agents and browser
// channels, frames). Every message is one sealed frame.
import type { SecureChannel } from "./channel.ts";
import { LinkError } from "./errors.ts";
import type { Wire, WireMessage } from "./wire.ts";

export type LinkMessage =
  | { k: "ready"; [key: string]: unknown }
  | { k: "req"; id: number; op: string; args?: unknown }
  | { k: "res"; id: number; ok: true; value?: unknown }
  | { k: "res"; id: number; ok: false; error: { code: string; message: string } }
  | { k: "evt"; ch: string; e: unknown }
  | { k: "bye"; reason: string };

/** An error whose code and message may be shown to the other side. */
export class RpcError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "RpcError";
    this.code = code;
  }
}

export type RequestHandler = (op: string, args: Record<string, unknown>) => Promise<unknown> | unknown;
export type EventHandler = (ch: string, e: unknown) => void;

export class LinkPeer {
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private requestHandler: RequestHandler | undefined;
  private eventHandlers: EventHandler[] = [];
  private closeHandlers: Array<(reason: string) => void> = [];
  private inFlight = 0;
  private ended: string | undefined;

  readonly wire: Wire;
  readonly channel: SecureChannel;

  constructor(wire: Wire, channel: SecureChannel) {
    this.wire = wire;
    this.channel = channel;
    wire.onClose((r) => this.finish(r));
  }

  /** Begin reading. Set handlers first: nothing is dispatched before this. */
  start(): void {
    this.wire.onMessage((m: WireMessage) => {
      if (m.t !== "f" || typeof m.d !== "string") return this.close("protocol");
      this.channel.open(m.d).then(
        (v) => this.dispatch(v as LinkMessage),
        (e: unknown) => this.close(e instanceof LinkError ? e.code : "malformed"),
      );
    });
  }

  get closed(): boolean {
    return this.ended !== undefined;
  }

  /** Sealed frames not yet handed to the transport (for dropping video frames under load). */
  get backlog(): number {
    return this.inFlight;
  }

  handle(h: RequestHandler): void {
    this.requestHandler = h;
  }

  onEvent(h: EventHandler): () => void {
    this.eventHandlers.push(h);
    return () => {
      this.eventHandlers = this.eventHandlers.filter((x) => x !== h);
    };
  }

  onClose(h: (reason: string) => void): void {
    if (this.ended !== undefined) h(this.ended);
    else this.closeHandlers.push(h);
  }

  send(m: LinkMessage): Promise<void> {
    if (this.ended !== undefined) return Promise.reject(new LinkError("closed", this.ended));
    this.inFlight++;
    return this.channel.seal(m).then(
      (d) => {
        this.inFlight--;
        this.wire.send({ t: "f", d });
      },
      (e: unknown) => {
        this.inFlight--;
        throw e;
      },
    );
  }

  request<T = unknown>(op: string, args: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    if (this.ended !== undefined) return Promise.reject(new LinkError("closed", this.ended));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new LinkError("timeout", `${op} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.send({ k: "req", id, op, args }).catch((e: unknown) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e instanceof Error ? e : new LinkError("closed"));
      });
    });
  }

  emit(ch: string, e: unknown): void {
    this.send({ k: "evt", ch, e }).catch(() => undefined);
  }

  /** Like `emit`, resolving once the sealed frame is on the wire (or failed). */
  notify(ch: string, e: unknown): Promise<void> {
    return this.send({ k: "evt", ch, e }).catch(() => undefined);
  }

  close(reason = "closed"): void {
    if (this.ended !== undefined) return;
    if (!this.wire.closed && !this.channel.failed)
      this.send({ k: "bye", reason })
        .catch(() => undefined)
        .finally(() => setTimeout(() => this.wire.close(reason), 20));
    else this.wire.close(reason);
    this.finish(reason);
  }

  private finish(reason: string) {
    if (this.ended !== undefined) return;
    this.ended = reason;
    this.channel.close();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new LinkError("closed", reason));
    }
    this.pending.clear();
    for (const h of this.closeHandlers) h(reason);
  }

  private dispatch(m: LinkMessage) {
    if (!m || typeof m !== "object") return;
    if (m.k === "req") {
      const args =
        m.args && typeof m.args === "object" && !Array.isArray(m.args)
          ? (m.args as Record<string, unknown>)
          : {};
      const h = this.requestHandler;
      Promise.resolve()
        .then(() => {
          if (!h) throw new RpcError("unsupported", "this side takes no requests");
          return h(m.op, args);
        })
        .then(
          (value) => this.send({ k: "res", id: m.id, ok: true, value: value ?? null }),
          (e: unknown) =>
            this.send({
              k: "res",
              id: m.id,
              ok: false,
              error:
                e instanceof RpcError
                  ? { code: e.code, message: e.message }
                  : { code: "internal", message: "internal error" },
            }),
        )
        .catch(() => undefined);
      return;
    }
    if (m.k === "res") {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.ok) p.resolve(m.value);
      else p.reject(new RpcError(m.error?.code ?? "error", m.error?.message ?? "error"));
      return;
    }
    if (m.k === "evt") {
      for (const h of this.eventHandlers) h(m.ch, m.e);
      return;
    }
    if (m.k === "bye") this.close(m.reason || "bye");
  }
}
