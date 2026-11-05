// A core the desktop shell started exits when the shell is gone (mac test
// 2026-11-04: after `kill <shell pid>` the core the shell had restarted kept
// running as an orphan on the port). The shell stops its core on a normal
// quit and on SIGTERM / SIGINT / SIGHUP; this covers the rest (SIGKILL, a
// crash): the shell passes its pid in ALCA_SUPERVISOR_PID and the core checks
// every few seconds that the process is still there and is still its parent.

export interface ParentWatchOptions {
  /** The supervising process (ALCA_SUPERVISOR_PID). */
  pid: number;
  /** Called once when it is gone. */
  onGone: () => void;
  intervalMs?: number;
  /** Tests: is a process alive / who is our parent now. */
  alive?: (pid: number) => boolean;
  parent?: () => number;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it exists but is not ours to signal — still alive.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Start watching; returns a stop function. */
export function watchParent(o: ParentWatchOptions): () => void {
  const alive = o.alive ?? processAlive;
  const parent = o.parent ?? (() => process.ppid);
  const wasChild = parent() === o.pid;
  let done = false;
  const t = setInterval(() => {
    if (done) return;
    // Gone, or (when it was our parent) we were handed to another process: the shell died.
    if (!alive(o.pid) || (wasChild && parent() !== o.pid)) {
      done = true;
      clearInterval(t);
      o.onGone();
    }
  }, o.intervalMs ?? 2000);
  t.unref();
  return () => {
    done = true;
    clearInterval(t);
  };
}

/** The supervisor pid from the environment, when a desktop shell started this core. */
export function supervisorPid(env: NodeJS.ProcessEnv = process.env): number | undefined {
  if (env.ALCA_SUPERVISED !== "desktop-shell") return undefined;
  const pid = Number(env.ALCA_SUPERVISOR_PID);
  return Number.isInteger(pid) && pid > 1 ? pid : undefined;
}
