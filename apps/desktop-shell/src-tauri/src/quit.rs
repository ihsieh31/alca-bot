//! Quit on SIGTERM / SIGINT / SIGHUP like 結束 Alca does (mac test 2026-11-04: `kill <shell pid>`
//! ended the shell but left the core it had restarted running as an orphan on the port).
//!
//! The handler only sets a flag (all a signal handler may safely do); a thread watches the flag
//! and runs the normal quit, which stops the core the shell started. A shell that dies without a
//! chance to run this (SIGKILL, a crash) is covered by the core itself: started with
//! `ALCA_SUPERVISOR_PID`, it exits when that process is gone (apps/desktop/src/parent-watch.ts).

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

static QUIT: AtomicBool = AtomicBool::new(false);

#[cfg(unix)]
extern "C" fn on_signal(_: libc::c_int) {
    QUIT.store(true, Ordering::SeqCst);
}

/// Install the handlers and call `quit` once (on its own thread) when one fires.
pub fn on_quit_signal(quit: impl FnOnce() + Send + 'static) {
    #[cfg(unix)]
    unsafe {
        let handler = on_signal as extern "C" fn(libc::c_int) as libc::sighandler_t;
        for sig in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
            libc::signal(sig, handler);
        }
    }
    let _ = std::thread::Builder::new().name("alca-quit-signal".into()).spawn(move || {
        while !QUIT.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(200));
        }
        quit();
    });
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn a_sigterm_runs_the_quit_callback() {
        let (tx, rx) = mpsc::channel();
        on_quit_signal(move || {
            let _ = tx.send(());
        });
        unsafe {
            libc::raise(libc::SIGTERM);
        }
        assert!(rx.recv_timeout(Duration::from_secs(5)).is_ok());
    }
}
