import {
  type ActorT,
  type EventData,
  type EventOf,
  type EventType,
  type InitiatorT,
  PROTOCOL_VERSION,
} from "./events.ts";
import { newId } from "./ids.ts";
import { parseEvent } from "./validate.ts";

export interface RunEmitterOptions {
  threadId: string;
  runId: string;
  initiator: InitiatorT;
  actor: ActorT;
  sessionId?: string;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
  /** Injectable id generator for deterministic tests. */
  eventId?: () => string;
}

/**
 * Builds validated events for one run and assigns seq numbers monotonically.
 * Every emitted event is validated, so a bug surfaces at the producer.
 */
export class RunEmitter {
  private seq = 0;
  private lastMs = 0;
  private readonly opts: RunEmitterOptions;

  constructor(opts: RunEmitterOptions) {
    this.opts = opts;
  }

  get nextSeq(): number {
    return this.seq;
  }

  emit<T extends EventType>(type: T, data: EventData<T>, actor?: ActorT): EventOf<T> {
    const nowMs = Math.max((this.opts.now?.() ?? new Date()).getTime(), this.lastMs);
    this.lastMs = nowMs;
    const raw = {
      v: PROTOCOL_VERSION,
      id: this.opts.eventId?.() ?? newId("event"),
      ts: new Date(nowMs).toISOString(),
      ...(this.opts.sessionId ? { sessionId: this.opts.sessionId } : {}),
      threadId: this.opts.threadId,
      runId: this.opts.runId,
      seq: this.seq,
      initiator: this.opts.initiator,
      actor: actor ?? this.opts.actor,
      type,
      data,
    };
    const parsed = parseEvent(raw) as EventOf<T>;
    this.seq += 1;
    return parsed;
  }
}
