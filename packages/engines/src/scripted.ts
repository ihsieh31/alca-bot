import {
  conversationKey,
  type Engine,
  type EngineCapabilities,
  type EngineEvent,
  type EngineTurnRequest,
  type PermissionAnswer,
  type PermissionRequest,
} from "./types.ts";

/**
 * One scripted step. Besides plain engine events a script can pause, or
 * simulate a tool-owning engine asking the host for permission: the step
 * emits `tool.call`, waits for `onPermission`, then emits the matching
 * `tool.result` (the output depends on the answer).
 */
export type ScriptStep =
  | EngineEvent
  | { type: "wait"; ms: number }
  | {
      type: "permission";
      call: { id: string; name: string; input: Record<string, unknown> };
      allowedOutput?: string;
    };

export interface ScriptContext {
  req: EngineTurnRequest;
  /** 0-based index of this turn() call on the engine. */
  turnIndex: number;
  /** 0-based index of this turn() call within the same run (host-loop passes). */
  pass: number;
}

/** A fixed list of turns consumed in order, or a function computing each turn. */
export type Script = readonly (readonly ScriptStep[])[] | ((ctx: ScriptContext) => readonly ScriptStep[]);

export const SCRIPTED_CAPABILITIES: EngineCapabilities = Object.freeze({
  kind: "scripted",
  persistentProcess: false,
  streaming: true,
  resume: false,
  interrupt: true,
  ownsToolLoop: false,
  nativePermissionModes: [],
  permissionPrompt: "host_loop",
  systemPromptAtLaunch: false,
  supportsPromptCache: false,
  supportsImages: false,
});

/**
 * Deterministic engine for tests, replays and the offline demo. It records
 * every request so tests can assert prompt-cache discipline.
 */
export class ScriptedEngine implements Engine {
  readonly id: string;
  readonly capabilities: EngineCapabilities;
  readonly requests: EngineTurnRequest[] = [];
  readonly permissionAnswers: PermissionAnswer[] = [];
  private readonly script: Script;
  private turnIndex = 0;
  private readonly passes = new Map<string, number>();
  private readonly active = new Map<string, AbortController>();

  constructor(script: Script, opts: { id?: string; capabilities?: Partial<EngineCapabilities> } = {}) {
    this.script = script;
    this.id = opts.id ?? "scripted";
    this.capabilities = Object.freeze({ ...SCRIPTED_CAPABILITIES, ...opts.capabilities });
  }

  private stepsFor(req: EngineTurnRequest): readonly ScriptStep[] {
    const pass = this.passes.get(req.runId) ?? 0;
    this.passes.set(req.runId, pass + 1);
    const ctx: ScriptContext = { req, turnIndex: this.turnIndex, pass };
    this.turnIndex += 1;
    if (typeof this.script === "function") return this.script(ctx);
    return (
      this.script[ctx.turnIndex] ?? [
        { type: "error", code: "script.exhausted", message: "no more scripted turns", retryable: false },
      ]
    );
  }

  async *turn(req: EngineTurnRequest): AsyncIterable<EngineEvent> {
    this.requests.push(req);
    const steps = this.stepsFor(req);
    const local = new AbortController();
    const key = conversationKey(req);
    this.active.set(key, local);
    const aborted = () => local.signal.aborted || req.signal.aborted;
    try {
      let sawDone = false;
      for (const step of steps) {
        if (aborted()) break;
        if (step.type === "wait") {
          await sleep(step.ms, local.signal, req.signal);
          continue;
        }
        if (step.type === "permission") {
          yield { type: "tool.call", ...step.call };
          const answer: PermissionAnswer = req.onPermission
            ? await req.onPermission({
                toolName: step.call.name,
                input: step.call.input,
                toolUseId: step.call.id,
              })
            : { behavior: "deny", message: "no permission handler" };
          this.permissionAnswers.push(answer);
          if (aborted()) break;
          yield answer.behavior === "allow"
            ? { type: "tool.result", id: step.call.id, ok: true, output: step.allowedOutput ?? "ok" }
            : { type: "tool.result", id: step.call.id, ok: false, output: answer.message };
          continue;
        }
        if (step.type === "done") sawDone = true;
        yield step;
      }
      if (aborted()) yield { type: "done", stop: "interrupted" };
      else if (!sawDone) yield { type: "done", stop: "end_turn" };
    } finally {
      if (this.active.get(key) === local) this.active.delete(key);
    }
  }

  async interrupt(key: string): Promise<void> {
    this.active.get(key)?.abort();
  }

  async dispose(): Promise<void> {
    for (const c of this.active.values()) c.abort();
    this.active.clear();
  }
}

function sleep(ms: number, ...signals: AbortSignal[]): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      for (const s of signals) s.removeEventListener("abort", done);
      resolve();
    }
    for (const s of signals) s.addEventListener("abort", done, { once: true });
  });
}

/** Split text into small deltas, so scripted turns stream like a real engine. */
export function streamText(text: string, chunk = 4, delayMs = 0): ScriptStep[] {
  const out: ScriptStep[] = [];
  const chars = [...text];
  for (let i = 0; i < chars.length; i += chunk) {
    if (delayMs > 0 && i > 0) out.push({ type: "wait", ms: delayMs });
    out.push({ type: "text.delta", text: chars.slice(i, i + chunk).join("") });
  }
  out.push({ type: "text.end" });
  return out;
}

export type { PermissionRequest };
