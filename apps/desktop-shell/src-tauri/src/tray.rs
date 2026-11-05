//! The tray (menu bar on macOS): what the core is doing, how many things wait
//! on the person, and the few actions a shell needs. Words come from
//! `ui/strings.<locale>.json`, generated from the UI string table (`pnpm check:i18n --write`);
//! the language is `advanced.locale` in config.json (R9.3).

use std::sync::OnceLock;

use serde::Deserialize;
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Runtime};

use crate::probe::CoreStatus;
use crate::supervisor::Phase;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Words {
    pub starting: String,
    pub running: String,
    pub attached: String,
    pub waiting: String,
    pub restarting: String,
    pub stopped: String,
    pub open: String,
    pub open_waiting: String,
    pub pair: String,
    pub open_at_login: String,
    pub restart: String,
    pub logs: String,
    pub quit: String,
    pub phones: String,
    pub no_core: String,
    pub start_failed: String,
    pub keeps_stopping: String,
    pub log_file: String,
    pub foot: String,
}

pub fn words() -> &'static Words {
    static W: OnceLock<Words> = OnceLock::new();
    W.get_or_init(|| words_for(crate::paths::locale_is_en()))
}

/// The shell's words in English or 繁中.
pub fn words_for(en: bool) -> Words {
    let json = if en {
        include_str!("../../ui/strings.en.json")
    } else {
        include_str!("../../ui/strings.zh-Hant-TW.json")
    };
    serde_json::from_str(json).expect("ui/strings.<locale>.json")
}

/// The first, disabled line of the menu and the tooltip.
pub fn headline(phase: &Phase, st: Option<&CoreStatus>) -> String {
    let w = words();
    match phase {
        Phase::Starting => w.starting.clone(),
        Phase::Restarting { in_secs } => w.restarting.replace("{n}", &in_secs.to_string()),
        Phase::Stopped { why } => format!("{}：{why}", w.stopped),
        Phase::Running | Phase::Attached => match st {
            Some(s) if s.waiting() > 0 => w.waiting.replace("{n}", &s.waiting().to_string()),
            _ if *phase == Phase::Attached => w.attached.clone(),
            _ => w.running.clone(),
        },
    }
}

/// The tooltip: the headline, plus how many phones are online when any are.
pub fn tooltip(phase: &Phase, st: Option<&CoreStatus>) -> String {
    let line = headline(phase, st);
    match st {
        Some(s) if s.phones_online > 0 => {
            format!("{line} · {}", words().phones.replace("{n}", &s.phones_online.to_string()))
        }
        _ => line,
    }
}

pub struct Tray<R: Runtime> {
    pub icon: TrayIcon<R>,
    pub head: MenuItem<R>,
    pub open: MenuItem<R>,
    pub login: CheckMenuItem<R>,
    idle_png: Image<'static>,
    wait_png: Image<'static>,
}

pub fn build<R: Runtime>(app: &AppHandle<R>, open_at_login: bool) -> tauri::Result<Tray<R>> {
    let w = words();
    let head = MenuItem::with_id(app, "head", &w.starting, false, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", &w.open, true, None::<&str>)?;
    let pair = MenuItem::with_id(app, "pair", &w.pair, true, None::<&str>)?;
    let login = CheckMenuItem::with_id(app, "login", &w.open_at_login, true, open_at_login, None::<&str>)?;
    let restart = MenuItem::with_id(app, "restart", &w.restart, true, None::<&str>)?;
    let logs = MenuItem::with_id(app, "logs", &w.logs, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", &w.quit, true, Some("CmdOrCtrl+Q"))?;
    let sep = || PredefinedMenuItem::separator(app);
    let menu = Menu::with_items(
        app,
        &[&head, &sep()?, &open, &pair, &sep()?, &login, &restart, &logs, &sep()?, &quit],
    )?;
    let idle_png = Image::from_bytes(include_bytes!("../icons/tray.png"))?.to_owned();
    let wait_png = Image::from_bytes(include_bytes!("../icons/tray-waiting.png"))?.to_owned();
    let icon = TrayIconBuilder::with_id("alca")
        .icon(idle_png.clone())
        .icon_as_template(true)
        .tooltip(&w.starting)
        .menu(&menu)
        .show_menu_on_left_click(true)
        .build(app)?;
    Ok(Tray { icon, head, open, login, idle_png, wait_png })
}

impl<R: Runtime> Tray<R> {
    /// Repaint from the latest phase and status (called every couple of seconds).
    pub fn update(&self, phase: &Phase, st: Option<&CoreStatus>) {
        let w = words();
        let line = headline(phase, st);
        let waiting = st.map(|s| s.waiting()).unwrap_or(0);
        let _ = self.head.set_text(&line);
        let _ = self.icon.set_tooltip(Some(&tooltip(phase, st)));
        let _ = self.open.set_text(if waiting > 0 { &w.open_waiting } else { &w.open });
        if waiting > 0 {
            // A colored dot: not a template image (macOS would paint it monochrome).
            let _ = self.icon.set_icon_with_as_template(Some(self.wait_png.clone()), false);
            let _ = self.icon.set_title(Some(waiting.to_string()));
        } else {
            let _ = self.icon.set_icon_with_as_template(Some(self.idle_png.clone()), true);
            let _ = self.icon.set_title(None::<&str>);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn headline_says_what_waits() {
        let st = CoreStatus { approvals: 2, questions: 1, phones_online: 0 };
        assert_eq!(headline(&Phase::Running, Some(&st)), "等你決定：3 件");
        assert_eq!(headline(&Phase::Running, Some(&CoreStatus::default())), "Alca 正在執行");
        assert_eq!(headline(&Phase::Attached, None), "Alca 正在執行（背景服務）");
        assert_eq!(headline(&Phase::Restarting { in_secs: 4 }, None), "核心停止了，4 秒後重新啟動");
    }

    #[test]
    fn english_words_come_from_the_english_file() {
        assert_eq!(words_for(true).running, "Alca is running");
        assert_eq!(words_for(true).waiting.replace("{n}", "3"), "Waiting on you: 3");
        assert_eq!(words_for(false).running, "Alca 正在執行");
    }

    #[test]
    fn tooltip_adds_phones_online() {
        let st = CoreStatus { approvals: 0, questions: 0, phones_online: 2 };
        assert_eq!(tooltip(&Phase::Running, Some(&st)), "Alca 正在執行 · 2 支手機在線上");
        assert_eq!(tooltip(&Phase::Running, Some(&CoreStatus::default())), "Alca 正在執行");
    }
}
