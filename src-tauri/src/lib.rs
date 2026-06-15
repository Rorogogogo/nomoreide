use std::sync::{Arc, Mutex};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, RunEvent, State, WindowEvent,
};
use tauri_plugin_shell::ShellExt;

struct AppState {
    server_child: Arc<Mutex<Option<tauri_plugin_shell::process::CommandChild>>>,
}

#[tauri::command]
fn get_server_url() -> String {
    "http://127.0.0.1:4317".to_string()
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show Window", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit NoMoreIDE", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    TrayIconBuilder::new()
        .icon(app.default_window_icon().unwrap().clone())
        .menu(&menu)
        .tooltip("NoMoreIDE")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }
        })
        .build(app)?;
    Ok(())
}

fn spawn_server(app: &AppHandle, state: &AppState) {
    // In dev mode the Vite dev server and `nomoreide web` are started externally.
    // In release mode we look for `node` on PATH and run `dist/index.js web`.
    if cfg!(debug_assertions) {
        return;
    }

    let app_dir = app
        .path()
        .resource_dir()
        .expect("could not resolve resource dir");
    let server_script = app_dir.join("dist").join("index.js");

    if !server_script.exists() {
        eprintln!(
            "[nomoreide] server script not found at {}",
            server_script.display()
        );
        return;
    }

    let shell = app.shell();
    match shell
        .command("node")
        .args([server_script.to_string_lossy().as_ref(), "web"])
        .spawn()
    {
        Ok((_rx, child)) => {
            *state.server_child.lock().unwrap() = Some(child);
            eprintln!("[nomoreide] web server started");
        }
        Err(e) => {
            eprintln!("[nomoreide] failed to start web server: {e}");
        }
    }
}

fn kill_server(state: &AppState) {
    if let Some(child) = state.server_child.lock().unwrap().take() {
        let _ = child.kill();
        eprintln!("[nomoreide] web server stopped");
    }
}

pub fn run() {
    let state = AppState {
        server_child: Arc::new(Mutex::new(None)),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .manage(state)
        .setup(|app| {
            build_tray(app.handle())?;

            let state: State<AppState> = app.state();
            spawn_server(app.handle(), &state);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_server_url])
        .on_window_event(|window, event| {
            // Minimise to tray instead of closing on macOS / Windows.
            if let WindowEvent::CloseRequested { api, .. } = event {
                window.hide().unwrap();
                api.prevent_close();
            }
        })
        .build(tauri::generate_context!())
        .expect("error building tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                let state: State<AppState> = app.state();
                kill_server(&state);
            }
        });
}
