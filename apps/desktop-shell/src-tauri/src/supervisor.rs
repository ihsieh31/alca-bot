//! Runs the local core as a child process and keeps it running.
//!
//! - If a core already answers on the port (the always-on `alca service`, or
//!   one started by hand), the shell attaches to it and starts nothing.
//! - A core that exits on its own is restarted with backoff (1 s, 2 s, 4 s …
//!   30 s; reset after a minute of uptime). Five crashes in two minutes stop
//!   the retries until the person presses 重新啟動核心.
//! - Shutdown sends SIGTERM (the core closes its server, Link and SQLite and
//!   releases its ports), waits up to 8 s, then kills.
//! - A core we started reads one-time launch codes from its stdin
//!   (`ALCA_UI_CODES=stdin`, review 2026-11-04b S2.2): before the window opens
//!   the core's UI, the shell writes a fresh code there and puts the same code
//!   in the window's URL fragment, so the window can approve and pair. Codes
//!   never go on a command line or in the environment.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use crate::paths;
use crate::probe;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Phase {
    Starting,
    /// We started it and it answers.
    Running,
    /// Someone else runs it (the background service); we only show it.
    Attached,
    /// It exited; next try after a pause.
    Restarting {
        in_secs: u64,
    },
    /// Too many crashes, or nothing to run.
    Stopped {
        why: String,
    },
}

pub struct Supervisor {
    pub phase: Arc<Mutex<Phase>>,
    child: Arc<Mutex<Option<Child>>>,
    stopping: Arc<AtomicBool>,
    /// Set by `restart`: the next exit is ours, not a crash.
    manual: Arc<AtomicBool>,
    wake: Arc<(Mutex<bool>, Condvar)>,
    port: u16,
    resources: Option<PathBuf>,
}

/// Backoff for the n-th consecutive crash (n starts at 1).
pub fn backoff_secs(n: u32) -> u64 {
    (1u64 << n.saturating_sub(1).min(5)).min(30)
}

impl Supervisor {
    pub fn new(port: u16, resources: Option<PathBuf>) -> Arc<Self> {
        Arc::new(Self {
            phase: Arc::new(Mutex::new(Phase::Starting)),
            child: Arc::new(Mutex::new(None)),
            stopping: Arc::new(AtomicBool::new(false)),
            manual: Arc::new(AtomicBool::new(false)),
            wake: Arc::new((Mutex::new(false), Condvar::new())),
            port,
            resources,
        })
    }

    pub fn phase(&self) -> Phase {
        self.phase.lock().map(|p| p.clone()).unwrap_or(Phase::Starting)
    }

    fn set(&self, p: Phase) {
        if let Ok(mut g) = self.phase.lock() {
            *g = p;
        }
    }

    /// Start the supervising thread.
    pub fn start(self: &Arc<Self>) {
        let me = Arc::clone(self);
        std::thread::Builder::new()
            .name("alca-core-supervisor".into())
            .spawn(move || me.run())
            .expect("supervisor thread");
    }

    /// The person pressed 重新啟動核心.
    pub fn restart(&self) {
        self.manual.store(true, Ordering::SeqCst);
        self.kill_child(Duration::from_secs(8));
        let (m, cv) = &*self.wake;
        if let Ok(mut w) = m.lock() {
            *w = true;
            cv.notify_all();
        }
    }

    fn sleep_or_wake(&self, d: Duration) {
        let (m, cv) = &*self.wake;
        if let Ok(mut w) = m.lock() {
            if !*w {
                let (g, _) = cv.wait_timeout(w, d).unwrap_or_else(|e| e.into_inner());
                w = g;
            }
            *w = false;
        }
    }

    fn run(&self) {
        let mut crashes: Vec<Instant> = Vec::new();
        let mut streak = 0u32;
        while !self.stopping.load(Ordering::SeqCst) {
            if probe::healthy(self.port) {
                // Somebody else's core: watch it, never touch it.
                self.set(Phase::Attached);
                self.sleep_or_wake(Duration::from_secs(3));
                continue;
            }
            let Some((bin, args)) = paths::core_command(self.resources.as_deref()) else {
                self.set(Phase::Stopped { why: crate::tray::words().no_core.clone() });
                self.sleep_or_wake(Duration::from_secs(5));
                continue;
            };
            self.manual.store(false, Ordering::SeqCst);
            self.set(Phase::Starting);
            let started = Instant::now();
            match self.spawn(&bin, &args) {
                Ok(child) => {
                    if let Ok(mut c) = self.child.lock() {
                        *c = Some(child);
                    }
                }
                Err(e) => {
                    let why = crate::tray::words().start_failed.replace("{e}", &e.to_string());
                    self.set(Phase::Stopped { why });
                    self.sleep_or_wake(Duration::from_secs(10));
                    continue;
                }
            }
            // Poll the child (it is shared with shutdown, so no blocking wait()).
            loop {
                if self.stopping.load(Ordering::SeqCst) {
                    return;
                }
                let exited = self
                    .child
                    .lock()
                    .ok()
                    .and_then(|mut c| c.as_mut().map(|ch| !matches!(ch.try_wait(), Ok(None))))
                    .unwrap_or(true);
                if exited {
                    break;
                }
                if probe::healthy(self.port) {
                    self.set(Phase::Running);
                }
                std::thread::sleep(Duration::from_millis(500));
            }
            if let Ok(mut c) = self.child.lock() {
                *c = None;
            }
            if self.stopping.load(Ordering::SeqCst) {
                return;
            }
            if self.manual.swap(false, Ordering::SeqCst) {
                // 重新啟動核心: start again right away, with a clean slate.
                crashes.clear();
                streak = 0;
                continue;
            }
            // It exited by itself: a crash.
            let now = Instant::now();
            if now.duration_since(started) > Duration::from_secs(60) {
                streak = 0;
            }
            streak += 1;
            crashes.retain(|t| now.duration_since(*t) < Duration::from_secs(120));
            crashes.push(now);
            if crashes.len() >= 5 {
                self.set(Phase::Stopped { why: crate::tray::words().keeps_stopping.clone() });
                crashes.clear();
                streak = 0;
                self.sleep_or_wake(Duration::from_secs(24 * 3600));
                continue;
            }
            let wait = backoff_secs(streak);
            self.set(Phase::Restarting { in_secs: wait });
            self.sleep_or_wake(Duration::from_secs(wait));
        }
    }

    fn spawn(&self, bin: &PathBuf, args: &[String]) -> std::io::Result<Child> {
        let dir = paths::log_dir();
        std::fs::create_dir_all(&dir)?;
        let log = OpenOptions::new().create(true).append(true).open(dir.join("core.log"))?;
        let mut cmd = Command::new(bin);
        cmd.args(args)
            // A pipe the shell writes launch codes on (one per line); nothing else is sent.
            .stdin(Stdio::piped())
            .stdout(Stdio::from(log.try_clone()?))
            .stderr(Stdio::from(log))
            .env("ALCA_SUPERVISED", "desktop-shell")
            // A mode flag, not a secret: "read launch codes from stdin".
            .env("ALCA_UI_CODES", "stdin")
            // The core exits when this process is gone, even if it could not stop it (SIGKILL, a crash).
            .env("ALCA_SUPERVISOR_PID", std::process::id().to_string());
        #[cfg(target_os = "linux")]
        unsafe {
            use std::os::unix::process::CommandExt;
            // Linux can also tell the core directly when the shell dies.
            cmd.pre_exec(|| {
                libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM);
                Ok(())
            });
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        cmd.spawn()
    }

    fn kill_child(&self, grace: Duration) {
        let Ok(mut guard) = self.child.lock() else { return };
        let Some(child) = guard.as_mut() else { return };
        #[cfg(unix)]
        unsafe {
            // SIGTERM: the core's handler closes everything and exits 0.
            libc::kill(child.id() as libc::pid_t, libc::SIGTERM);
        }
        #[cfg(not(unix))]
        let _ = child.kill();
        let until = Instant::now() + grace;
        while Instant::now() < until {
            if matches!(child.try_wait(), Ok(Some(_))) {
                *guard = None;
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = child.kill();
        let _ = child.wait();
        *guard = None;
    }

    /// A one-time launch code the core we started has accepted, for the window's URL; `None`
    /// when the core is someone else's (the service: that window cannot approve and opens one
    /// that can) or the pipe is gone.
    pub fn launch_code(&self) -> Option<String> {
        let mut guard = self.child.lock().ok()?;
        let stdin = guard.as_mut()?.stdin.as_mut()?;
        let code = paths::launch_code()?;
        stdin.write_all(paths::launch_line(&code).as_bytes()).ok()?;
        stdin.flush().ok()?;
        Some(code)
    }

    /// Quit: stop restarting, then stop the core we started (an attached one keeps running).
    pub fn shutdown(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        self.kill_child(Duration::from_secs(8));
        let (m, cv) = &*self.wake;
        if let Ok(mut w) = m.lock() {
            *w = true;
            cv.notify_all();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_doubles_up_to_thirty_seconds() {
        let v: Vec<u64> = (1..=8).map(backoff_secs).collect();
        assert_eq!(v, vec![1, 2, 4, 8, 16, 30, 30, 30]);
    }
}
