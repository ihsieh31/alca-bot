import { type ChildProcess, execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CONFINE_HINT, type ConfineSpec, looksConfined, spawnConfined } from "@alca/os";
import { OUTPUT_MAX_BYTES, truncateText } from "../truncate.ts";
import { pipeNote, shellFor } from "./shell.ts";

/**
 * Plan §4 / §2.5: the bash session (moved from the P15 archive and reworked).
 *
 * - `exec` runs a command in the work folder. By default it waits until the
 *   command ends or its timeout (120 s, settable up to 10 min); `background`
 *   (or a `yieldMs`) returns a session id at once (or after the yield) and
 *   `poll` reads the new output later (`input` writes to its stdin).
 * - Every command runs in its own process group. A stop (AbortSignal), the
 *   timeout or `kill` ends the whole tree: the group and every descendant
 *   found under it (TERM, then KILL after 3 s; KILL at once for a stop).
 *   When the shell exits, whatever it left in its group is ended too, and
 *   `closeAll` (worker release, shutdown) ends every group the sessions
 *   started; a last KILL at process exit catches anything still left.
 * - A non-zero exit is a result, not a tool error: `exitCode` says it and
 *   the text shows it. Only a failure to start or an unknown session throws.
 * - Output is cleaned (ANSI, `\r` progress lines, control characters); over
 *   50 KB it is cut head + tail and the whole text goes to `spill`.
 * - The environment is cleaned: no *KEY* / *SECRET* / *TOKEN* / *PASSWORD* /
 *   *CREDENTIAL* variables, pager and colour off.
 *
 * - With bash on the machine the command runs under `bash -o pipefail -c`
 *   (a failure inside a pipeline fails it); with only sh, a piped command's
 *   result says its exit code may hide such a failure (shell.ts).
 *
 * `runToEnd` is the one-shot form the host's own checks use (verify.ts).
 *
 * Next-round §5.2: with `confine` the command runs inside the OS sandbox
 * (Seatbelt / bubblewrap, `@alca/os` confine): writes only in the work folder,
 * its own temp folder (TMPDIR, made per session and removed after it) and the
 * package caches; Alca's folder and the home secrets unreadable. This is the
 * one entry for every command the model chooses (bash tool, the end-of-task
 * checks, the reviewer's git), so all of them are confined together.
 */

export const BASH_DEFAULT_TIMEOUT_MS = 120_000;
export const BASH_MAX_TIMEOUT_MS = 600_000;
export const BASH_BACKGROUND_MAX_MS = 3_600_000;
const MAX_SESSIONS = 32;
const KEEP_AFTER_EXIT_MS = 10 * 60_000;
const BUFFER_MAX = 4_000_000;

const SECRET_NAME = /(KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)/i;
const KEEP = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TEMP", "TMP", "LANG"];

export function cleanEnv(src: NodeJS.ProcessEnv, sessionId: number): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(src)) {
    if (v === undefined || SECRET_NAME.test(k)) continue;
    if (KEEP.includes(k) || k.startsWith("LC_")) env[k] = v;
  }
  return {
    ...env,
    LANG: env.LANG ?? "C.UTF-8",
    TERM: "dumb",
    NO_COLOR: "1",
    PAGER: "cat",
    GIT_PAGER: "cat",
    GH_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    CI: "1",
    ALCA_SESSION: String(sessionId),
  };
}

/** ANSI escapes out, `\r` progress lines collapsed to their last state, control characters dropped. */
export function cleanOutput(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escapes are what this removes
  const osc = /\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escapes are what this removes
  const csi = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this removes
  const ctrl = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;
  return s
    .replace(osc, "")
    .replace(csi, "")
    .split("\n")
    .map((l) => {
      const parts = l.split("\r").filter((p, i, a) => p !== "" || i === a.length - 1);
      return parts.at(-1) ?? "";
    })
    .join("\n")
    .replace(ctrl, "");
}

/** Every descendant of `pid`, from `ps`; [] when it cannot be read. */
export function descendants(pid: number): number[] {
  let rows: string;
  try {
    rows = execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8", timeout: 2000 });
  } catch {
    return [];
  }
  const kids = new Map<number, number[]>();
  for (const line of rows.split("\n")) {
    const [a, b] = line.trim().split(/\s+/).map(Number);
    if (!a || b === undefined || Number.isNaN(b)) continue;
    const list = kids.get(b) ?? [];
    list.push(a);
    kids.set(b, list);
  }
  const out: number[] = [];
  const queue = [pid];
  while (queue.length) {
    const p = queue.shift() as number;
    for (const c of kids.get(p) ?? []) {
      if (out.includes(c)) continue;
      out.push(c);
      queue.push(c);
    }
  }
  return out;
}

/** End a process tree: its group, then each descendant (one that left the group too). */
export function killTree(pid: number | undefined, sig: NodeJS.Signals): void {
  if (!pid) return;
  const tree = process.platform === "win32" ? [] : descendants(pid);
  try {
    if (process.platform === "win32") process.kill(pid, sig);
    else process.kill(-pid, sig);
  } catch {
    // the group may be gone already
  }
  for (const p of [pid, ...tree]) {
    try {
      process.kill(p, sig);
    } catch {
      // already gone
    }
  }
}

/**
 * Process groups started here that may still have members. A session's
 * shell can exit (or be reaped) while something it started in the
 * background lives on in its group, reparented away from the tree that
 * `descendants` walks; the group id is the only handle left. Whatever is
 * still here when this process exits gets a KILL, so a test run or a crash
 * never leaves a detached group behind (a CI runner waits on those).
 */
const liveGroups = new Set<number>();
let exitHook = false;

/** Whether any process is still in group `pgid` (zombies included). */
export function groupAlive(pgid: number): boolean {
  if (process.platform === "win32") return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The live (non-zombie) members of group `pgid`, from `ps`; [] when it cannot be read. */
export function groupMembers(pgid: number): number[] {
  let rows: string;
  try {
    rows = execFileSync("ps", ["-A", "-o", "pid=,pgid=,stat="], { encoding: "utf8", timeout: 2000 });
  } catch {
    return [];
  }
  const out: number[] = [];
  for (const line of rows.split("\n")) {
    const [pid, group, stat] = line.trim().split(/\s+/);
    if (Number(group) === pgid && !stat?.startsWith("Z")) out.push(Number(pid));
  }
  return out;
}

function trackGroup(pgid: number): void {
  liveGroups.add(pgid);
  if (exitHook) return;
  exitHook = true;
  process.on("exit", () => {
    for (const g of liveGroups) signalGroup(g, "SIGKILL");
  });
}

/** Signal a tracked group; forget it once it is empty. */
function signalGroup(pgid: number, sig: NodeJS.Signals): void {
  if (!liveGroups.has(pgid)) return;
  if (!groupAlive(pgid)) {
    liveGroups.delete(pgid);
    return;
  }
  try {
    process.kill(-pgid, sig);
  } catch {
    liveGroups.delete(pgid);
  }
}

/** TERM (or the given signal) to a tracked group now, KILL after `graceMs` if anything is left. */
function endGroup(pgid: number, sig: NodeJS.Signals = "SIGTERM", graceMs = 3000): void {
  signalGroup(pgid, sig);
  if (sig === "SIGKILL" || !liveGroups.has(pgid)) return;
  setTimeout(() => signalGroup(pgid, "SIGKILL"), graceMs).unref();
}

/** Groups started here that still have a member (tests, diagnostics). */
export function liveGroupIds(): number[] {
  return [...liveGroups].filter((g) => groupAlive(g));
}

export type BashStatus = "running" | "exited" | "timeout" | "stopped" | "killed";

interface Session {
  id: number;
  command: string;
  child: ChildProcess;
  /** The session's process group (the shell's pid; detached), undefined on Windows. */
  pgid?: number;
  out: string;
  cursor: number;
  exit: number | null;
  signal: string | null;
  timedOut: boolean;
  stopped: boolean;
  killed: boolean;
  startedAt: number;
  endedAt?: number;
  done: Promise<void>;
  lastUsed: number;
  /** Set when the command ran without pipefail and has a pipe (research audit A4). */
  pipeNote?: string;
  /** The sandbox it ran in (§5), for the hint on a refused write. */
  confined?: ConfineSpec["kind"];
}

/** The structured result of a bash call (the text is what the model sees). */
export interface BashResult {
  text: string;
  status: BashStatus;
  /** null while running, after a timeout, a stop or a kill. */
  exitCode: number | null;
  running: boolean;
  sessionId?: number;
  durationMs: number;
  truncated: boolean;
  spilled?: string;
}

export interface ExecOptions {
  command: string;
  cwd: string;
  timeoutMs?: number;
  /** Return after this long with a session id if the command still runs. */
  yieldMs?: number;
  background?: boolean;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  /** Keep a cut output whole; returns where (shown to the model). */
  spill?: (full: string) => string | undefined;
  /** Pipefail even under sh where it can (the host's end-of-task check). */
  strictPipe?: boolean;
  /** Next-round §5: run inside the OS sandbox (undefined = exactly as before). */
  confine?: ConfineSpec;
}

export interface RunToEndResult {
  exitCode: number | null;
  output: string;
  timedOut?: boolean;
  stopped?: boolean;
  durationMs: number;
  /** The command ran under sh with a pipe: its exit code may hide a failure earlier in the pipe. */
  pipeNote?: string;
}

const WORD: Record<BashStatus, (s: Session, code: number | null) => string> = {
  running: (s) => `執行中（session ${s.id}）`,
  exited: (_s, code) => `已結束，exit code ${code}`,
  timeout: () => "超過時間上限，已終止整個程序樹",
  stopped: () => "已中止，整個程序樹已結束",
  killed: (s) => `被訊號 ${s.signal ?? "SIGKILL"} 結束`,
};

export class BashSessions {
  private readonly sessions = new Map<number, Session>();
  private readonly notes: string[] = [];
  /** Every group these sessions started, kept after a session is forgotten so closeAll still ends it. */
  private readonly groups = new Set<number>();

  private newId(): number {
    for (;;) {
      const id = 10000 + Math.floor(Math.random() * 90000);
      if (!this.sessions.has(id)) return id;
    }
  }

  private reap(): void {
    const now = Date.now();
    for (const s of this.sessions.values())
      if (s.endedAt && now - s.endedAt > KEEP_AFTER_EXIT_MS) this.sessions.delete(s.id);
    if (this.sessions.size < MAX_SESSIONS) return;
    const byUse = [...this.sessions.values()].sort((a, b) => a.lastUsed - b.lastUsed);
    const keep = new Set(byUse.slice(-8).map((s) => s.id));
    const victim = byUse.find((s) => s.endedAt && !keep.has(s.id)) ?? byUse.find((s) => !keep.has(s.id));
    if (!victim) return;
    if (!victim.endedAt) this.killGroup(victim, "SIGKILL");
    this.sessions.delete(victim.id);
    this.notes.push(`已回收 session ${victim.id}（${victim.command.slice(0, 60)}）以釋放資源`);
  }

  /**
   * End a session's whole tree. While the shell runs: its group and every
   * descendant (TERM, then KILL after 3 s). After it has ended: whatever is
   * left in its group (a background child that outlived it).
   */
  private killGroup(s: Session, sig: NodeJS.Signals = "SIGTERM"): void {
    if (!s.endedAt) {
      killTree(s.child.pid, sig);
      if (sig !== "SIGKILL")
        setTimeout(() => {
          if (!s.endedAt) killTree(s.child.pid, "SIGKILL");
          else if (s.pgid) signalGroup(s.pgid, "SIGKILL");
        }, 3000).unref();
      return;
    }
    if (s.pgid) endGroup(s.pgid, sig);
  }

  private start(o: ExecOptions): Session {
    this.reap();
    const id = this.newId();
    const max = o.background ? BASH_BACKGROUND_MAX_MS : BASH_MAX_TIMEOUT_MS;
    const timeoutMs = Math.max(1, Math.min(o.timeoutMs ?? BASH_DEFAULT_TIMEOUT_MS, max));
    const sh = shellFor(o.command, o.strictPipe === true);
    const confine = o.confine ? sessionSpec(o.confine, id) : undefined;
    const child = spawnConfined(confine, sh.file, sh.args, {
      cwd: o.cwd,
      env: cleanEnv(o.env ?? process.env, id),
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const pgid = process.platform !== "win32" && child.pid ? child.pid : undefined;
    if (pgid) {
      trackGroup(pgid);
      this.groups.add(pgid);
    }
    const s: Session = {
      id,
      command: o.command,
      child,
      ...(pgid ? { pgid } : {}),
      out: "",
      cursor: 0,
      exit: null,
      signal: null,
      timedOut: false,
      stopped: false,
      killed: false,
      startedAt: Date.now(),
      lastUsed: Date.now(),
      done: Promise.resolve(),
      ...(confine ? { confined: confine.kind } : {}),
    };
    const note = pipeNote(sh, o.command);
    if (note) s.pipeNote = note;
    const append = (b: Buffer) => {
      s.out += b.toString("utf8");
      if (s.out.length > BUFFER_MAX) {
        const drop = s.out.length - BUFFER_MAX / 2;
        s.out = s.out.slice(drop);
        s.cursor = Math.max(0, s.cursor - drop);
      }
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.stdin?.on("error", () => undefined);
    // The shell is gone: nothing it left in its group may outlive the session
    // (a `cmd &` would otherwise hold the output pipe open, or run forever).
    child.on("exit", () => {
      if (pgid) endGroup(pgid);
    });
    s.done = new Promise((resolve) => {
      child.on("close", (code, signal) => {
        s.exit = code;
        s.signal = signal;
        s.endedAt = Date.now();
        resolve();
      });
      child.on("error", (err) => {
        s.out += `\n${String(err.message)}`;
        s.exit = 127;
        s.endedAt = Date.now();
        resolve();
      });
    });
    const timer = setTimeout(() => {
      s.timedOut = true;
      this.killGroup(s);
    }, timeoutMs);
    timer.unref();
    const onAbort = () => {
      s.stopped = true;
      this.killGroup(s, "SIGKILL");
    };
    if (o.signal?.aborted) onAbort();
    else o.signal?.addEventListener("abort", onAbort, { once: true });
    void s.done.then(() => {
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
      if (confine) removeTmp(confine.tmpDir);
    });
    this.sessions.set(id, s);
    return s;
  }

  async exec(o: ExecOptions): Promise<BashResult> {
    const s = this.start(o);
    const waitMs = o.background
      ? Math.min(o.yieldMs ?? 250, 30_000)
      : o.yieldMs !== undefined
        ? Math.max(250, o.yieldMs)
        : Number.POSITIVE_INFINITY;
    return this.collect(s, waitMs, o.spill, true);
  }

  /** One command to its end, all of its output (the last 2 MB); for the host's checks. */
  async runToEnd(o: Omit<ExecOptions, "background" | "yieldMs" | "spill">): Promise<RunToEndResult> {
    const s = this.start(o);
    await s.done;
    this.sessions.delete(s.id);
    const end = this.status(s);
    return {
      exitCode: end === "exited" ? s.exit : null,
      output: cleanOutput(s.out).slice(-2_000_000),
      ...(s.timedOut ? { timedOut: true } : {}),
      ...(s.stopped ? { stopped: true } : {}),
      durationMs: (s.endedAt ?? Date.now()) - s.startedAt,
      ...(s.pipeNote ? { pipeNote: s.pipeNote } : {}),
    };
  }

  private status(s: Session): BashStatus {
    if (!s.endedAt) return "running";
    if (s.stopped) return "stopped";
    if (s.timedOut) return "timeout";
    if (s.killed || s.signal) return "killed";
    return "exited";
  }

  private async collect(
    s: Session,
    waitMs: number,
    spill?: (full: string) => string | undefined,
    first = false,
  ): Promise<BashResult> {
    if (Number.isFinite(waitMs)) await Promise.race([s.done, new Promise((r) => setTimeout(r, waitMs))]);
    else await s.done;
    s.lastUsed = Date.now();
    const fresh = cleanOutput(s.out.slice(s.cursor));
    s.cursor = s.out.length;
    const t = truncateText(fresh, { mode: "headtail", maxBytes: OUTPUT_MAX_BYTES, headShare: 0.2 });
    let spilled: string | undefined;
    if (t.truncated && spill)
      try {
        spilled = spill(fresh);
      } catch {
        spilled = undefined;
      }
    const status = this.status(s);
    const running = status === "running";
    const exitCode = status === "exited" ? s.exit : null;
    const durationMs = (s.endedAt ?? Date.now()) - s.startedAt;
    const lines = [
      ...(first ? [`$ ${s.command.slice(0, 200)}`] : []),
      ...this.notes.splice(0),
      `status: ${status}`,
      `exit_code: ${exitCode ?? "null"}`,
      `duration: ${(durationMs / 1000).toFixed(1)}s`,
      ...(running ? [`session: ${s.id}`] : []),
      `狀態：${WORD[status](s, exitCode)}`,
      "輸出：",
      t.text.trim() ? t.text : "（無輸出）",
      ...(t.truncated
        ? [
            `[輸出已截斷：原本 ${t.totalLines} 行 / ${t.totalBytes} bytes${spilled ? `；全文：${spilled}` : ""}]`,
          ]
        : []),
      ...(running
        ? [`命令仍在執行。用 bash_poll({sessionId: ${s.id}}) 取得後續輸出，或 bash_kill 結束。`]
        : []),
      ...(status === "timeout"
        ? ["命令超過時間上限被終止。若它本來就需要更久，請加大 timeoutMs 或改用 background: true 再 poll。"]
        : []),
      ...(status === "exited" && exitCode !== 0
        ? ["（非 0 的 exit code 是命令本身的結果，不是工具錯誤；看輸出決定下一步。）"]
        : []),
      ...(first && s.pipeNote ? [s.pipeNote] : []),
      ...(s.confined && status === "exited" && exitCode !== 0 && looksConfined(fresh) ? [CONFINE_HINT] : []),
    ];
    return {
      text: lines.join("\n"),
      status,
      exitCode,
      running,
      ...(running ? { sessionId: s.id } : {}),
      durationMs,
      truncated: t.truncated,
      ...(spilled ? { spilled } : {}),
    };
  }

  async poll(o: {
    sessionId: number;
    input?: string;
    yieldMs?: number;
    signal?: "INT" | "TERM" | "KILL";
    spill?: (full: string) => string | undefined;
  }): Promise<BashResult> {
    const s = this.sessions.get(o.sessionId);
    if (!s) throw new Error(`找不到 session ${o.sessionId}（可能已結束並被回收）。`);
    if (o.signal) {
      if (o.signal === "KILL") s.killed = true;
      this.killGroup(s, `SIG${o.signal}` as NodeJS.Signals);
    }
    if (o.input) {
      if (!s.child.stdin || s.child.stdin.destroyed || s.endedAt)
        throw new Error(`session ${s.id} 的 stdin 已關閉`);
      s.child.stdin.write(o.input);
    }
    const y = o.input
      ? Math.max(250, Math.min(o.yieldMs ?? 250, 30_000))
      : Math.max(1_000, Math.min(o.yieldMs ?? 5_000, 300_000));
    return this.collect(s, s.endedAt ? 0 : y, o.spill);
  }

  kill(id: number): string {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`找不到 session ${id}（可能已結束並被回收）。`);
    s.killed = true;
    this.killGroup(s);
    return `已送出結束訊號給 session ${id}（整個程序樹）`;
  }

  /** Sessions still running (tests, diagnostics). */
  running(): number {
    return [...this.sessions.values()].filter((s) => !s.endedAt).length;
  }

  /** End every session and every group they started (the worker is done or Alca is closing). */
  closeAll(): void {
    for (const s of this.sessions.values()) if (!s.endedAt) killTree(s.child.pid, "SIGKILL");
    for (const g of this.groups) signalGroup(g, "SIGKILL");
    this.groups.clear();
    this.sessions.clear();
  }
}

/** The session's own temp folder inside the bot's (0700, removed when the session ends). */
function sessionSpec(spec: ConfineSpec, id: number): ConfineSpec {
  const tmpDir = join(spec.tmpDir, String(id));
  mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
  return { ...spec, tmpDir };
}

function removeTmp(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // a leftover temp folder is swept with the bot's
  }
}

/** One command to its end in a session of its own (the host's check runner). */
export function runCommand(
  o: Omit<ExecOptions, "background" | "yieldMs" | "spill">,
): Promise<RunToEndResult> {
  return new BashSessions().runToEnd(o);
}
