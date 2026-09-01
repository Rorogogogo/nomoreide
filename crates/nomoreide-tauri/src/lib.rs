mod commands;

pub fn run_terminal_attach(socket_path: &str, token: &str) -> Result<(), String> {
    nomoreide_core::external_terminal::run_attach(socket_path, token)
}

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex as StdMutex;
use std::time::{Duration, Instant};
use tauri::{Manager, RunEvent, State, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tokio::net::TcpListener;

use nomoreide_core::config::ConfigStore;

// ---------------------------------------------------------------------------
// Shared application state
// ---------------------------------------------------------------------------

pub struct AppState {
    embedded_daemon: StdMutex<Option<EmbeddedDaemonTask>>,
    shutdown_started: AtomicBool,
    exit_ready: AtomicBool,
}

const DAEMON_STARTUP_TIMEOUT: Duration = Duration::from_secs(20);
const DAEMON_STARTUP_POLL: Duration = Duration::from_millis(50);
const DAEMON_CONTROL_TIMEOUT: Duration = Duration::from_secs(2);
const DAEMON_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(30);

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

pub fn run() {
    let state = AppState {
        embedded_daemon: StdMutex::new(None),
        shutdown_started: AtomicBool::new(false),
        exit_ready: AtomicBool::new(false),
    };

    let mut context = tauri::generate_context!();
    let main_window = context
        .config()
        .app
        .windows
        .first()
        .cloned()
        .expect("the Tauri config must define the main window");
    for window in &mut context.config_mut().app.windows {
        window.create = false;
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(state)
        .setup(move |app| {
            let app_handle = app.handle().clone();
            let runtime_paths = nomoreide_daemon_client::RuntimePaths::new(
                app.path().app_local_data_dir()?.join("runtime"),
            );
            let window_config = main_window.clone();
            tauri::async_runtime::spawn(async move {
                match start_embedded_daemon(runtime_paths).await {
                    Ok(daemon) => {
                        let state: State<AppState> = app_handle.state();
                        state
                            .embedded_daemon
                            .lock()
                            .expect("embedded daemon task mutex poisoned")
                            .replace(daemon.runtime);

                        let window_app = app_handle.clone();
                        let error_app = app_handle.clone();
                        let initialization_script =
                            desktop_initialization_script(&daemon.base_url, &daemon.credential);
                        if let Err(error) = app_handle.run_on_main_thread(move || {
                            if let Err(error) =
                                WebviewWindowBuilder::from_config(&window_app, &window_config)
                                    .map(|builder| {
                                        builder.initialization_script(initialization_script)
                                    })
                                    .and_then(WebviewWindowBuilder::build)
                            {
                                show_startup_error(&window_app, &error.to_string());
                            }
                        }) {
                            show_startup_error(&error_app, &error.to_string());
                        }
                    }
                    Err(error) => show_startup_error(&app_handle, &error),
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![commands::system::open_external])
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let app = window.app_handle().clone();
                let window = window.clone();
                tauri::async_runtime::spawn(async move {
                    match has_external_terminal_sessions(&app).await {
                        Ok(true) => {
                            let _ = window.hide();
                        }
                        Ok(false) => begin_app_shutdown(app),
                        Err(error) => {
                            eprintln!("failed to inspect desktop terminal sessions: {error}");
                            begin_app_shutdown(app);
                        }
                    }
                });
            }
        })
        .build(context)
        .expect("error building tauri application")
        .run(|app, event| match event {
            RunEvent::ExitRequested { api, .. } => {
                let state: State<AppState> = app.state();
                if !state.exit_ready.load(Ordering::Acquire) {
                    api.prevent_exit();
                    begin_app_shutdown(app.clone());
                }
            }
            RunEvent::Exit => {
                let state: State<AppState> = app.state();
                let daemon = state
                    .embedded_daemon
                    .lock()
                    .expect("embedded daemon task mutex poisoned")
                    .take();
                if let Some(daemon) = daemon {
                    daemon.task.abort();
                }
            }
            RunEvent::Reopen { .. } => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            _ => {}
        });
}

async fn start_embedded_daemon(
    runtime_paths: nomoreide_daemon_client::RuntimePaths,
) -> Result<StartedEmbeddedDaemon, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|error| format!("failed to reserve a private daemon port: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("failed to inspect the private daemon port: {error}"))?
        .port();
    let options = nomoreide_daemon::DaemonOptions {
        port,
        runtime_paths,
        config_path: ConfigStore::default_path(),
    };
    let credential = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let daemon_credential = credential.clone();
    let (shutdown, shutdown_requests) = tokio::sync::mpsc::channel(1);
    let daemon_shutdown = shutdown.clone();
    let mut daemon_task = tauri::async_runtime::spawn(async move {
        nomoreide_daemon::run_embedded_with_shutdown_requests(
            options,
            listener,
            daemon_credential,
            daemon_shutdown,
            shutdown_requests,
        )
        .await
    });

    let base_url = format!("http://127.0.0.1:{port}");
    let health_url = format!("{base_url}/api/health");
    let http = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_millis(250))
        .build()
        .map_err(|error| format!("failed to create the daemon health client: {error}"))?;
    let deadline = Instant::now() + DAEMON_STARTUP_TIMEOUT;
    loop {
        tokio::select! {
            result = &mut daemon_task => {
                return Err(match result {
                    Ok(Ok(())) => "the embedded daemon stopped during startup".to_string(),
                    Ok(Err(error)) => format!("the embedded daemon failed during startup: {error:#}"),
                    Err(error) => format!("the embedded daemon task failed during startup: {error}"),
                });
            }
            response = http.get(&health_url).send() => {
                if response.is_ok_and(|response| response.status().is_success()) {
                    return Ok(StartedEmbeddedDaemon {
                        base_url: base_url.clone(),
                        credential: credential.clone(),
                        runtime: EmbeddedDaemonTask {
                            base_url: base_url.clone(),
                            credential: credential.clone(),
                            shutdown,
                            task: daemon_task,
                        },
                    });
                }
            }
        }

        if Instant::now() >= deadline {
            daemon_task.abort();
            return Err(format!(
                "the embedded daemon did not become ready within {} seconds",
                DAEMON_STARTUP_TIMEOUT.as_secs()
            ));
        }
        tokio::time::sleep(DAEMON_STARTUP_POLL).await;
    }
}

struct StartedEmbeddedDaemon {
    base_url: String,
    credential: String,
    runtime: EmbeddedDaemonTask,
}

struct EmbeddedDaemonTask {
    base_url: String,
    credential: String,
    shutdown: tokio::sync::mpsc::Sender<()>,
    task: tauri::async_runtime::JoinHandle<anyhow::Result<()>>,
}

async fn has_external_terminal_sessions(app: &tauri::AppHandle) -> Result<bool, String> {
    let (url, credential) = {
        let state: State<AppState> = app.state();
        let daemon = state
            .embedded_daemon
            .lock()
            .map_err(|_| "embedded daemon task mutex poisoned".to_string())?;
        let daemon = daemon
            .as_ref()
            .ok_or_else(|| "embedded daemon is not running".to_string())?;
        (
            format!("{}/api/terminal/sessions", daemon.base_url),
            daemon.credential.clone(),
        )
    };
    let http = reqwest::Client::builder()
        .no_proxy()
        .timeout(DAEMON_CONTROL_TIMEOUT)
        .build()
        .map_err(|error| error.to_string())?;
    let response = http
        .get(url)
        .bearer_auth(credential)
        .send()
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?
        .json::<nomoreide_daemon_client::protocol::TerminalSessionsEnvelope>()
        .await
        .map_err(|error| error.to_string())?;
    Ok(response
        .sessions
        .iter()
        .any(|session| session.presentation != "dock"))
}

fn begin_app_shutdown(app: tauri::AppHandle) {
    let state: State<AppState> = app.state();
    if state.shutdown_started.swap(true, Ordering::AcqRel) {
        return;
    }

    tauri::async_runtime::spawn(async move {
        let state: State<AppState> = app.state();
        let daemon = state
            .embedded_daemon
            .lock()
            .expect("embedded daemon task mutex poisoned")
            .take();
        if let Some(mut daemon) = daemon {
            if daemon.shutdown.send(()).await.is_err() {
                refuse_app_shutdown(&app, "the embedded daemon shutdown channel closed");
                return;
            }
            match tokio::time::timeout(DAEMON_SHUTDOWN_TIMEOUT, &mut daemon.task).await {
                Ok(Ok(Ok(()))) => {}
                Ok(Ok(Err(error))) => {
                    refuse_app_shutdown(
                        &app,
                        &format!("the embedded daemon failed while stopping: {error:#}"),
                    );
                    return;
                }
                Ok(Err(error)) => {
                    refuse_app_shutdown(
                        &app,
                        &format!("the embedded daemon task failed while stopping: {error}"),
                    );
                    return;
                }
                Err(_) => {
                    state
                        .embedded_daemon
                        .lock()
                        .expect("embedded daemon task mutex poisoned")
                        .replace(daemon);
                    refuse_app_shutdown(
                        &app,
                        &format!(
                            "the embedded daemon did not stop within {} seconds",
                            DAEMON_SHUTDOWN_TIMEOUT.as_secs()
                        ),
                    );
                    return;
                }
            }
        }

        state.exit_ready.store(true, Ordering::Release);
        app.exit(0);
    });
}

fn refuse_app_shutdown(app: &tauri::AppHandle, error: &str) {
    let state: State<AppState> = app.state();
    state.shutdown_started.store(false, Ordering::Release);
    eprintln!("NoMoreIDE refused to exit: {error}");
    app.dialog()
        .message(format!(
            "NoMoreIDE could not safely stop its local service. The app will remain open.\n\n{error}"
        ))
        .title("NoMoreIDE could not quit")
        .kind(MessageDialogKind::Error)
        .show(|_| {});
}

fn desktop_initialization_script(base_url: &str, credential: &str) -> String {
    let runtime = serde_json::json!({
        "apiBaseUrl": base_url,
        "credential": credential,
    });
    format!(
        "Object.defineProperty(window, '__NOMOREIDE_DESKTOP__', {{ value: Object.freeze({runtime}), enumerable: false, configurable: false, writable: false }});"
    )
}

fn show_startup_error(app: &tauri::AppHandle, error: &str) {
    let exit_app = app.clone();
    app.dialog()
        .message(format!(
            "NoMoreIDE could not start its local service.\n\n{error}"
        ))
        .title("NoMoreIDE startup failed")
        .kind(MessageDialogKind::Error)
        .show(move |_| exit_app.exit(1));
}
