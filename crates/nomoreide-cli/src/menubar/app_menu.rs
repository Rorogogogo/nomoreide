//! The app's own menu bar, shown while the window is open: Start at Login,
//! Hide, Quit, and the Edit and View menus the dashboard needs. Without an
//! Edit menu a WKWebView has no Cmd-C/Cmd-V at all, and terminals and commit
//! messages are where people paste most.

use tray_icon::menu::accelerator::{Accelerator, Code, Modifiers};
use tray_icon::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};

pub(super) struct AppMenu {
    login: CheckMenuItem,
    // Held so the menu outlives `install`.
    _menu: Menu,
}

impl AppMenu {
    pub(super) fn install(starts_at_login: bool) -> Self {
        let login =
            CheckMenuItem::with_id("app-login", "Start at Login", true, starts_at_login, None);
        let menu = Menu::new();
        if let Err(error) = build(&menu, &login) {
            eprintln!("nomoreide menubar: cannot build the app menu: {error}");
        }
        menu.init_for_nsapp();
        Self { login, _menu: menu }
    }

    pub(super) fn set_login(&self, on: bool) {
        self.login.set_checked(on);
    }
}

fn build(menu: &Menu, login: &CheckMenuItem) -> tray_icon::menu::Result<()> {
    let key = |code| Some(Accelerator::new(Some(Modifiers::SUPER), code));
    let app = Submenu::with_items(
        "NoMoreIDE",
        true,
        &[
            login,
            &PredefinedMenuItem::separator(),
            &PredefinedMenuItem::hide(None),
            &PredefinedMenuItem::hide_others(None),
            &PredefinedMenuItem::separator(),
            &MenuItem::with_id("quit", "Quit Menu Bar App", true, key(Code::KeyQ)),
        ],
    )?;
    let edit = Submenu::with_items(
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(None),
            &PredefinedMenuItem::redo(None),
            &PredefinedMenuItem::separator(),
            &PredefinedMenuItem::cut(None),
            &PredefinedMenuItem::copy(None),
            &PredefinedMenuItem::paste(None),
            &PredefinedMenuItem::select_all(None),
        ],
    )?;
    let view = Submenu::with_items(
        "View",
        true,
        &[
            &MenuItem::with_id("reload", "Reload", true, key(Code::KeyR)),
            &PredefinedMenuItem::fullscreen(None),
        ],
    )?;
    let window = Submenu::with_items(
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(None),
            &PredefinedMenuItem::close_window(None),
        ],
    )?;
    menu.append_items(&[&app, &edit, &view, &window])
}
