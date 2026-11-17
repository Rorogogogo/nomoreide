//! The macOS app: the menu-bar icon, the dashboard window, and the event loop.
//!
//! The window is a plain WKWebView on the daemon's own page. That page
//! authenticates itself (the daemon's shell route hands it the credential),
//! so nothing is injected and the dashboard behaves exactly as in a browser —
//! `isTauri()` is false, the title bar is native, links leave for the browser.
//!
//! While the window is open the app is a normal one — Dock icon, Cmd-Tab, its
//! own menu bar — because the menu-bar icon can sit hidden behind the notch.
//! Closing the window hides it and the app goes back to living in the menu bar.

use std::cell::RefCell;
use std::io::Read;
use std::os::unix::net::UnixListener;
use std::rc::Rc;

use nomoreide_daemon_client::RuntimePaths;
use tao::event::{Event, StartCause, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopWindowTarget};
use tao::platform::macos::{ActivationPolicy, EventLoopExtMacOS, EventLoopWindowTargetExtMacOS};
use tao::window::{Window, WindowBuilder};
use tokio::sync::mpsc::UnboundedSender;
use tray_icon::menu::MenuEvent;
use tray_icon::{TrayIcon, TrayIconBuilder};
use wry::{WebView, WebViewBuilder};

use super::app_menu::AppMenu;
use super::menu::{summary, tray_menu, Command};
use super::poller::{Action, Snapshot};
use super::{icon, login, poller, Request};

const DOCK_ICON: &[u8] = include_bytes!("../../assets/dock-icon.png");

#[derive(Debug)]
pub(super) enum Msg {
    Open,
    Menu(MenuEvent),
    Snapshot(Snapshot),
    Quit,
}

pub(super) async fn run(request: Request, paths: &RuntimePaths, port: u16) -> u8 {
    let background = match request {
        Request::Login(on) => {
            return match login::set_login(on) {
                Ok(()) if on => {
                    println!("NoMoreIDE will start in the menu bar at login.");
                    0
                }
                Ok(()) => {
                    println!("NoMoreIDE will no longer start at login.");
                    0
                }
                Err(error) => {
                    eprintln!("nomoreide menubar: {error}");
                    1
                }
            }
        }
        Request::Run { background } => background,
    };
    if login::open_running(paths) {
        if !background {
            println!("NoMoreIDE is already in the menu bar; opened its window.");
        }
        return 0;
    }
    let socket = login::socket(paths);
    let _ = std::fs::create_dir_all(&paths.state_dir);
    let _ = std::fs::remove_file(&socket);
    let listener = match UnixListener::bind(&socket) {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!(
                "nomoreide menubar: cannot listen on {}: {error}",
                socket.display()
            );
            return 1;
        }
    };
    // Blocks this (main) thread for the life of the app; the tokio workers
    // keep running the poller.
    App::run(background, paths.clone(), port, listener, socket)
}

struct App {
    actions: UnboundedSender<Action>,
    snapshot: Snapshot,
    tray: Option<TrayIcon>,
    app_menu: AppMenu,
    window: Option<Window>,
    webview: Option<WebView>,
    /// The page's origin; links elsewhere open in the browser.
    origin: Rc<RefCell<String>>,
    /// The daemon generation the open page was loaded against.
    loaded_generation: u64,
    /// The window was asked for before a daemon was reachable.
    pending_show: bool,
    /// Open the window as soon as the app starts (not when login starts it).
    show_at_launch: bool,
    socket: std::path::PathBuf,
}

impl App {
    fn run(
        background: bool,
        paths: RuntimePaths,
        port: u16,
        listener: UnixListener,
        socket: std::path::PathBuf,
    ) -> ! {
        let mut event_loop = EventLoopBuilder::<Msg>::with_user_event().build();
        event_loop.set_activation_policy(ActivationPolicy::Accessory);

        let proxy = event_loop.create_proxy();
        std::thread::spawn(move || {
            for mut connection in listener.incoming().flatten() {
                let mut buf = [0u8; 16];
                if connection
                    .read(&mut buf)
                    .is_ok_and(|n| buf[..n].starts_with(b"open"))
                {
                    let _ = proxy.send_event(Msg::Open);
                }
            }
        });
        let proxy = event_loop.create_proxy();
        MenuEvent::set_event_handler(Some(move |event| {
            let _ = proxy.send_event(Msg::Menu(event));
        }));

        let (actions, receiver) = tokio::sync::mpsc::unbounded_channel();
        tokio::spawn(poller::run(
            paths,
            port,
            event_loop.create_proxy(),
            receiver,
        ));
        // Bring a daemon up at launch, so the menu has something to show.
        let _ = actions.send(Action::Ensure);

        let mut app = App {
            actions,
            snapshot: Snapshot::default(),
            tray: None,
            app_menu: AppMenu::install(login::starts_at_login()),
            window: None,
            webview: None,
            origin: Rc::new(RefCell::new(String::new())),
            loaded_generation: 0,
            pending_show: false,
            show_at_launch: !background,
            socket,
        };
        event_loop.run(move |event, target, flow| {
            *flow = ControlFlow::Wait;
            app.handle(event, target, flow);
        })
    }

    fn handle(
        &mut self,
        event: Event<Msg>,
        target: &EventLoopWindowTarget<Msg>,
        flow: &mut ControlFlow,
    ) {
        match event {
            Event::NewEvents(StartCause::Init) => {
                self.tray = TrayIconBuilder::new()
                    .with_icon(icon::tray_icon())
                    .with_icon_as_template(true)
                    .with_tooltip("NoMoreIDE")
                    .build()
                    .ok();
                self.refresh_menu();
                if self.show_at_launch {
                    self.show(target);
                }
            }
            Event::UserEvent(Msg::Open) | Event::Reopen { .. } => self.show(target),
            Event::UserEvent(Msg::Snapshot(snapshot)) => self.update(snapshot, target),
            Event::UserEvent(Msg::Quit) => self.quit(flow),
            Event::UserEvent(Msg::Menu(event)) => {
                if let Some(command) = Command::parse(&event.id.0) {
                    self.command(command, target, flow);
                }
            }
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => {
                if let Some(window) = &self.window {
                    window.set_visible(false);
                }
                target.set_activation_policy_at_runtime(ActivationPolicy::Accessory);
            }
            _ => {}
        }
    }

    fn command(
        &mut self,
        command: Command,
        target: &EventLoopWindowTarget<Msg>,
        flow: &mut ControlFlow,
    ) {
        match command {
            Command::OpenWindow => self.show(target),
            Command::OpenBrowser => match &self.snapshot.url {
                Some(url) => open_externally(url),
                None => self.send(Action::Ensure),
            },
            Command::OpenUrl(url) => open_externally(&url),
            Command::ToggleLogin => {
                if let Err(error) = login::set_login(!login::starts_at_login()) {
                    eprintln!("nomoreide menubar: {error}");
                }
                self.app_menu.set_login(login::starts_at_login());
                self.refresh_menu();
            }
            Command::StartDaemon => self.send(Action::Ensure),
            Command::Service(verb, name) => self.send(Action::Service(verb, name)),
            Command::Bundle(verb, name) => self.send(Action::Bundle(verb, name)),
            Command::Reload => {
                if let Some(webview) = &self.webview {
                    let _ = webview.reload();
                }
            }
            Command::Quit => self.quit(flow),
            Command::StopDaemonAndQuit => self.send(Action::StopDaemonAndQuit),
        }
    }

    fn send(&self, action: Action) {
        let _ = self.actions.send(action);
    }

    fn quit(&mut self, flow: &mut ControlFlow) {
        let _ = std::fs::remove_file(&self.socket);
        self.tray.take();
        *flow = ControlFlow::Exit;
    }

    fn refresh_menu(&self) {
        let Some(tray) = &self.tray else { return };
        match tray_menu(&self.snapshot, login::starts_at_login()) {
            Ok(menu) => tray.set_menu(Some(Box::new(menu))),
            Err(error) => eprintln!("nomoreide menubar: cannot build the menu: {error}"),
        }
        let _ = tray.set_tooltip(Some(format!("NoMoreIDE — {}", summary(&self.snapshot))));
    }

    fn update(&mut self, snapshot: Snapshot, target: &EventLoopWindowTarget<Msg>) {
        self.snapshot = snapshot;
        self.refresh_menu();
        let Some(url) = self.snapshot.url.clone() else {
            return;
        };
        // A replaced daemon has a new credential; the open page holds the old one.
        if self.snapshot.generation != self.loaded_generation {
            if let Some(webview) = &self.webview {
                *self.origin.borrow_mut() = url.clone();
                let _ = webview.load_url(&url);
                self.loaded_generation = self.snapshot.generation;
            }
        }
        if std::mem::take(&mut self.pending_show) {
            self.show(target);
        }
    }

    fn show(&mut self, target: &EventLoopWindowTarget<Msg>) {
        let Some(url) = self.snapshot.url.clone() else {
            // No daemon yet: start one, and open the window when it answers.
            self.pending_show = true;
            self.send(Action::Ensure);
            return;
        };
        if self.window.is_none() {
            self.create_window(target, &url);
        }
        target.set_activation_policy_at_runtime(ActivationPolicy::Regular);
        set_dock_icon(DOCK_ICON);
        if let Some(window) = &self.window {
            window.set_visible(true);
            // macOS may refuse focus to a request that came from a terminal;
            // lifting the window above the others at least makes it seen.
            window.set_always_on_top(true);
            window.set_always_on_top(false);
            window.set_focus();
        }
        activate();
    }

    fn create_window(&mut self, target: &EventLoopWindowTarget<Msg>, url: &str) {
        let window = WindowBuilder::new()
            .with_title("NoMoreIDE")
            .with_inner_size(tao::dpi::LogicalSize::new(1400.0, 900.0))
            .with_min_inner_size(tao::dpi::LogicalSize::new(900.0, 600.0))
            .build(target);
        let window = match window {
            Ok(window) => window,
            Err(error) => {
                eprintln!("nomoreide menubar: cannot open a window: {error}");
                return;
            }
        };
        *self.origin.borrow_mut() = url.to_string();
        let origin = Rc::clone(&self.origin);
        let webview = WebViewBuilder::new()
            .with_url(url)
            .with_navigation_handler(move |to| stays_in_app(&origin.borrow(), &to))
            .with_new_window_req_handler(|to, _| {
                open_externally(&to);
                wry::NewWindowResponse::Deny
            })
            .build(&window);
        match webview {
            Ok(webview) => self.webview = Some(webview),
            Err(error) => eprintln!("nomoreide menubar: cannot show the dashboard: {error}"),
        }
        self.loaded_generation = self.snapshot.generation;
        self.window = Some(window);
    }
}

/// Whether a navigation stays in the window. The dashboard's own origin and
/// non-web schemes (`about:`, `blob:`, `data:`) do; any other web page opens
/// in the browser instead, where the person's sessions and password manager are.
fn stays_in_app(origin: &str, to: &str) -> bool {
    if to.starts_with(origin) {
        return true;
    }
    if to.starts_with("http://") || to.starts_with("https://") {
        open_externally(to);
        return false;
    }
    true
}

fn open_externally(url: &str) {
    let _ = std::process::Command::new("open").arg(url).status();
}

/// Bring the app in front of whichever one the person is in.
fn activate() {
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSApplication;
    if let Some(mtm) = MainThreadMarker::new() {
        #[allow(deprecated)]
        NSApplication::sharedApplication(mtm).activateIgnoringOtherApps(true);
    }
}

/// Give the app NoMoreIDE's icon in the Dock and the app switcher; a bare
/// binary has no bundle to take one from.
fn set_dock_icon(png: &[u8]) {
    use objc2::{AnyThread, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSImage};
    use objc2_foundation::NSData;
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let data = NSData::with_bytes(png);
    if let Some(image) = NSImage::initWithData(NSImage::alloc(), &data) {
        // SAFETY: on the main thread, with a valid image.
        unsafe { NSApplication::sharedApplication(mtm).setApplicationIconImage(Some(&image)) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_dashboard_stays_and_the_web_leaves() {
        let origin = "http://127.0.0.1:4317/";
        assert!(stays_in_app(origin, "http://127.0.0.1:4317/#/git"));
        assert!(stays_in_app(origin, "about:blank"));
    }

    #[test]
    fn the_dock_icon_is_a_png() {
        assert!(DOCK_ICON.starts_with(b"\x89PNG\r\n\x1a\n"));
    }
}
