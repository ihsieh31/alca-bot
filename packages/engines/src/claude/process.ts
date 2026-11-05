import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { type EngineEvent, EventQueue } from "../types.ts";
import { ClaudeStreamParser, interruptLine, userMessageLine } from "./parse.ts";

export interface ClaudeProcessOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Hash of the launch config this process was started with. */
  hash: string;
  /** After an interrupt request, how long to wait for the CLI to end the turn before SIGINT. */
  interruptGraceMs: number;
}

/**
 * One long-lived `claude -p --input-format stream-json` process for one thread.
 * Turns are written to stdin one at a time; stdout NDJSON is parsed until the
 * turn's `result` line.
 */
export class ClaudeProcess {
  readonly hash: string;
  readonly parser = new ClaudeStreamParser();
  private readonly child: ChildProcessWithoutNullStreams;
  private current: EventQueue<EngineEvent> | undefined;
  private stderrTail = "";
  private exited = false;
  private exitPromise: Promise<void>;
  private readonly graceMs: number;

  constructor(o: ClaudeProcessOptions) {
    this.hash = o.hash;
    this.graceMs = o.interruptGraceMs;
    this.child = spawn(o.command, [...o.args], { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "pipe"] });
    this.exitPromise = new Promise((resolve) => {
      this.child.on("exit", () => {
        this.exited = true;
        this.onExit();
        resolve();
      });
      this.child.on("error", (err) => {
        this.stderrTail += String(err);
        this.exited = true;
        this.onExit();
        resolve();
      });
    });
    this.child.stdin.on("error", () => {});
    this.child.stderr.on("data", (c: Buffer) => {
      this.stderrTail = (this.stderrTail + c.toString("utf8")).slice(-4000);
    });
    const rl = createInterface({ input: this.child.stdout });
    rl.on("line", (line) => this.onLine(line));
  }

  get alive(): boolean {
    return !this.exited;
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get sessionId(): string | undefined {
    return this.parser.sessionId;
  }

  /** P15 E: the effective tools / permission mode from the CLI's last init message. */
  get init(): { tools?: string[]; permissionMode?: string } | undefined {
    return this.parser.init;
  }

  /** The last few KB the CLI wrote to stderr (review 2026-11-05 #4: why a resumed launch ended). */
  get stderr(): string {
    return this.stderrTail;
  }

  get busy(): boolean {
    return this.current !== undefined;
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // not ours: stray output
    }
    const events = this.parser.feed(msg);
    const q = this.current;
    if (!q) return; // e.g. init before the first turn; the parser kept the session id
    for (const e of events) {
      q.push(e);
      if (e.type === "done") {
        this.current = undefined;
        q.close();
      }
    }
  }

  private onExit(): void {
    const q = this.current;
    this.current = undefined;
    if (!q) return;
    if (this.parser.interrupted) {
      q.push({ type: "done", stop: "interrupted" });
    } else {
      const detail = this.stderrTail.trim().split("\n").slice(-3).join(" ").slice(0, 500);
      q.push({
        type: "error",
        code: "engine.exited",
        message: `claude exited during the turn${detail ? `: ${detail}` : ""}`,
        retryable: true,
      });
      q.push({ type: "done", stop: "error" });
    }
    q.close();
  }

  /** Start a turn: returns the event stream that ends with `done`. */
  send(text: string): EventQueue<EngineEvent> {
    if (this.current) throw new Error("a turn is already running on this process");
    const q = new EventQueue<EngineEvent>();
    if (this.exited) {
      q.push({ type: "error", code: "engine.exited", message: "claude is not running", retryable: true });
      q.push({ type: "done", stop: "error" });
      q.close();
      return q;
    }
    this.parser.beginTurn();
    this.current = q;
    this.child.stdin.write(userMessageLine(text));
    return q;
  }

  /** Ask the CLI to end the turn; escalate to SIGINT if it does not within the grace period. */
  interrupt(): void {
    if (!this.current || this.exited) return;
    this.parser.interrupted = true;
    this.child.stdin.write(interruptLine(`int_${randomUUID()}`));
    const q = this.current;
    const t = setTimeout(() => {
      if (this.current === q && !this.exited) this.child.kill("SIGINT");
    }, this.graceMs);
    t.unref();
  }

  /** Close stdin (lets the CLI finish cleanly), then SIGTERM if it lingers. */
  async stop(timeoutMs = 2000): Promise<void> {
    if (this.exited) return;
    this.child.stdin.end();
    const t = setTimeout(() => this.child.kill("SIGTERM"), timeoutMs);
    t.unref();
    await this.exitPromise;
    clearTimeout(t);
  }
}
