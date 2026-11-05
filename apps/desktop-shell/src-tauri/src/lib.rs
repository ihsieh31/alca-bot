//! Alca desktop shell (Tauri 2): one window around the local core's own UI.
//!
//! The shell owns nothing: the core (Node, loopback only) keeps every bit of
//! state in its data directory and runs fine without the shell (headless, or
//! as `alca service`). The shell starts and supervises it when nobody else
//! does, shows it in a window, and adds a tray, open-at-login, `alca://`
//! links and a single instance.

mod paths;
mod probe;
mod quit;
mod supervisor;
mod tray;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_deep_link::DeepLinkExt;

use supervisor::{Phase, Supervisor};

/// Started at login (the autostart entry passes this): stay in the tray.
const HIDDEN_ARG: &str = "--hidden";

struct Shell {
    sup: Arc<Supervisor>,
    port: u16,
    /// What the window should open once the core answers (e.g. `open=pair` from alca://pair).
    pending: Mutex<Option<String>>,
    /// The window shows the core's UI (not the splash).
    loaded: Mutex<bool>,
}

fn window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("main")
}

fn show(app: &AppHandle) {
    if let Some(w) = window(app) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Point the window at the core's UI, with an optional hash action (`open=pair`).
fn load_core_ui(app: &AppHandle, extra: &str) -> bool {
    let shell = app.state::<Shell>();
    let Some(token) = paths::token() else { return false };
    let Some(w) = window(app) else { return false };
    // Only a core we started can take a code (an attached service's window cannot approve).
    let code = shell.sup.launch_code();
    let Ok(url) = paths::ui_url(shell.port, &token, code.as_deref(), extra).parse() else { return false };
    if w.navigate(url).is_ok() {
        if let Ok(mut l) = shell.loaded.lock() {
            *l = true;
        }
        return true;
    }
    false
}

/// `alca://pair` → the 手機 dialog with a fresh code; `alca://open` → just the window.
fn handle_link(app: &AppHandle, url: &str) {
    let action = deep_link_action(url);
    show(app);
    let ready = matches!(app.state::<Shell>().sup.phase(), Phase::Running | Phase::Attached);
    if ready && load_core_ui(app, action) {
        return;
    }
    if let Ok(mut p) = app.state::<Shell>().pending.lock() {
        *p = Some(action.to_owned());
    }
}

/// Map an `alca://…` URL to the UI's hash action. Unknown paths only open the window.
pub fn deep_link_action(url: &str) -> &'static str {
    let rest = url.trim_start_matches("alca://").trim_start_matches('/');
    let head = rest.split(['/', '?', '#']).next().unwrap_or("");
    match head {
        "pair" => "open=pair",
        _ => "",
    }
}

/// Splash text while the core is not up yet (the splash page defines `alcaStatus`).
fn splash(app: &AppHandle, phase: &Phase) {
    let Some(w) = window(app) else { return };
    let (kind, text) = match phase {
        Phase::Stopped { why } => ("stopped", why.clone()),
        Phase::Restarting { in_secs } => {
            ("restarting", tray::headline(phase, None).replace("{n}", &in_secs.to_string()))
        }
        _ => ("starting", tray::words().starting.clone()),
    };
    let log = paths::log_dir().join("core.log").to_string_lossy().into_owned();
    let words = tray::words();
    let js = format!(
        "window.alcaStatus && window.alcaStatus({}, {}, {}, {})",
        serde_json::to_string(kind).unwrap_or_default(),
        serde_json::to_string(&text).unwrap_or_default(),
        serde_json::to_string(&words.log_file.replace("{path}", &log)).unwrap_or_default(),
        serde_json::to_string(&words.foot).unwrap_or_default()
    );
    let _ = w.eval(&js);
}

/// Every two seconds: tray from the core's `/api/status`, window from the phase.
fn watch(app: AppHandle) {
    std::thread::spawn(move || loop {
        let shell = app.state::<Shell>();
        let phase = shell.sup.phase();
        let up = matches!(phase, Phase::Running | Phase::Attached);
        let st = if up { paths::token().and_then(|t| probe::status(shell.port, &t)) } else { None };
        let loaded = shell.loaded.lock().map(|l| *l).unwrap_or(false);
        let a = app.clone();
        let p = phase.clone();
        let s = st.clone();
        let pending = if up && !loaded {
            shell.pending.lock().ok().map(|mut x| x.take().unwrap_or_default())
        } else {
            None
        };
        let _ = app.run_on_main_thread(move || {
            if let Some(t) = a.try_state::<TrayHolder>() {
                if let Ok(t) = t.0.lock() {
                    t.update(&p, s.as_ref());
                }
            }
            if let Some(extra) = pending {
                load_core_ui(&a, &extra);
            } else if !up {
                splash(&a, &p);
            }
        });
        if !up {
            if let Ok(mut l) = shell.loaded.lock() {
                // The core went away: the window falls back to the splash on its next load.
                *l = false;
            }
        }
        std::thread::sleep(Duration::from_secs(2));
    });
}

struct TrayHolder(Mutex<tray::Tray<tauri::Wry>>);

pub fn run() {
    let port = paths::port();
    tauri::Builder::default()
        // First: a second launch (or an alca:// link on Windows / Linux) goes to this instance.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(url) = argv.iter().find(|a| a.starts_with("alca://")) {
                handle_link(app, url);
            } else {
                show(app);
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(autostart_plugin())
        .setup(move |app| {
            let handle = app.handle().clone();
            let resources = app.path().resource_dir().ok();
            let sup = Supervisor::new(port, resources);
            sup.start();
            app.manage(Shell {
                sup: Arc::clone(&sup),
                port,
                pending: Mutex::new(None),
                loaded: Mutex::new(false),
            });
            // `kill <pid>` / Ctrl+C / a closed terminal quit like 結束 Alca: the core we started stops too.
            let quitting = handle.clone();
            quit::on_quit_signal(move || {
                sup.shutdown();
                quitting.exit(0);
            });

            let hidden = std::env::args().any(|a| a == HIDDEN_ARG);
            let win = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Alca")
                .inner_size(1180.0, 780.0)
                .min_inner_size(760.0, 520.0)
                .visible(!hidden)
                .build()?;
            // Closing the window keeps Alca in the tray; 結束 Alca quits.
            let w2 = win.clone();
            win.on_window_event(move |e| {
                if let WindowEvent::CloseRequested { api, .. } = e {
                    api.prevent_close();
                    let _ = w2.hide();
                }
            });

            #[cfg(any(windows, target_os = "linux"))]
            let _ = app.deep_link().register_all();
            let h2 = handle.clone();
            app.deep_link().on_open_url(move |e| {
                if let Some(u) = e.urls().first() {
                    handle_link(&h2, u.as_str());
                }
            });
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                if let Some(u) = urls.first() {
                    handle_link(&handle, u.as_str());
                }
            }

            let login = app.autolaunch().is_enabled().unwrap_or(false);
            let t = tray::build(&handle, login)?;
            let login_item = t.login.clone();
            t.icon.on_menu_event(move |app, ev| match ev.id().as_ref() {
                "open" => {
                    show(app);
                    if !app.state::<Shell>().loaded.lock().map(|l| *l).unwrap_or(false) {
                        load_core_ui(app, "");
                    }
                }
                "pair" => handle_link(app, "alca://pair"),
                "login" => {
                    let al = app.autolaunch();
                    let on = al.is_enabled().unwrap_or(false);
                    let _ = if on { al.disable() } else { al.enable() };
                    let _ = login_item.set_checked(al.is_enabled().unwrap_or(!on));
                }
                "restart" => app.state::<Shell>().sup.restart(),
                "logs" => {
                    let dir = paths::log_dir();
                    let _ = std::fs::create_dir_all(&dir);
                    let opener = if cfg!(target_os = "macos") {
                        "open"
                    } else if cfg!(windows) {
                        "explorer"
                    } else {
                        "xdg-open"
                    };
                    let _ = std::process::Command::new(opener).arg(dir).spawn();
                }
                "quit" => app.exit(0),
                _ => {}
            });
            app.manage(TrayHolder(Mutex::new(t)));
            watch(handle.clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Alca desktop shell")
        .run(|app, ev| match ev {
            RunEvent::ExitRequested { .. } | RunEvent::Exit => {
                // Release the core's ports: stop the core we started (an attached service keeps running).
                app.state::<Shell>().sup.shutdown();
            }
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { .. } => show(app),
            _ => {}
        });
}

/// 登入時開啟: a LaunchAgent on macOS (the builder option exists only there), the platform default elsewhere.
fn autostart_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    let b = tauri_plugin_autostart::Builder::new().args([HIDDEN_ARG]);
    #[cfg(target_os = "macos")]
    let b = b.macos_launcher(tauri_plugin_autostart::MacosLauncher::LaunchAgent);
    b.build()
}

#[cfg(test)]
mod tests {
    use super::deep_link_action;

    #[test]
    fn deep_links_map_to_ui_actions() {
        assert_eq!(deep_link_action("alca://pair"), "open=pair");
        assert_eq!(deep_link_action("alca://pair?from=web"), "open=pair");
        assert_eq!(deep_link_action("alca:///pair/"), "open=pair");
        assert_eq!(deep_link_action("alca://open"), "");
        assert_eq!(deep_link_action("alca://anything-else"), "");
    }
}
