use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;
use crate::AppState;
use crate::core::process_manager::service_path;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSession {
    pub id: String,
    pub service_name: Option<String>,
}

/// Gates PTY output behind the frontend attaching its event listener. The shell
/// prints its prompt within milliseconds of spawning — well before the async
/// `listen()` on the JS side resolves — so without this the first prompt is lost
/// and the terminal looks dead until the user presses Enter. Output is buffered
/// until `start_terminal_stream` flushes it and switches to live emission.
#[derive(Default)]
struct OutputGate {
    pending: Vec<u8>,
    streaming: bool,
}

struct PtySession {
    service_name: Option<String>,
    writer: Box<dyn std::io::Write + Send>,
    #[allow(dead_code)]
    child: Box<dyn portable_pty::Child + Send>,
    #[allow(dead_code)]
    master: Box<dyn portable_pty::MasterPty + Send>,
    gate: Arc<Mutex<OutputGate>>,
}

pub struct TerminalManager {
    sessions: Arc<Mutex<HashMap<String, PtySession>>>,
}

impl TerminalManager {
    pub fn new() -> Self {
        TerminalManager {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn list_sessions(&self) -> Vec<TerminalSession> {
        self.sessions.lock().unwrap()
            .iter()
            .map(|(id, session)| TerminalSession {
                id: id.clone(),
                service_name: session.service_name.clone(),
            })
            .collect()
    }
}

#[tauri::command]
pub async fn list_terminal_sessions(state: State<'_, AppState>) -> Result<Vec<TerminalSession>, String> {
    Ok(state.terminal_manager.list_sessions())
}

#[tauri::command]
pub async fn create_terminal_session(
    app: AppHandle,
    state: State<'_, AppState>,
    service_name: Option<String>,
    cwd: Option<String>,
) -> Result<TerminalSession, String> {
    let id = service_name
        .as_ref()
        .map(|name| format!("svc:{name}"))
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let session = TerminalSession { id: id.clone(), service_name: service_name.clone() };

    if state.terminal_manager.sessions.lock().unwrap().contains_key(&id) {
        return Ok(session);
    }

    // Default the working dir to the service's own cwd so "the terminal in the
    // service" actually lands in the project, not the app's launch directory.
    let mut work_dir = cwd;
    if work_dir.is_none() {
        if let Some(name) = &service_name {
            if let Ok(config) = state.config_store.load().await {
                work_dir = config.services.iter()
                    .find(|s| &s.name == name)
                    .and_then(|s| s.cwd.clone());
            }
        }
    }

    let pty_system = native_pty_system();
    let pair = pty_system.openpty(PtySize {
        rows: 24,
        cols: 80,
        pixel_width: 0,
        pixel_height: 0,
    }).map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new(std::env::var("SHELL").unwrap_or_else(|_| "sh".into()));
    if let Some(dir) = &work_dir {
        cmd.cwd(dir);
    }
    // A Finder-launched macOS app inherits only a minimal PATH, so `npm`/`node`
    // etc. would be missing in the shell. Seed the resolved dev PATH.
    cmd.env("PATH", service_path());

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

    let gate = Arc::new(Mutex::new(OutputGate::default()));

    // Stream PTY output as Tauri events (buffering until the frontend attaches).
    let event_id = id.clone();
    let app_clone = app.clone();
    let reader_gate = gate.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let mut g = reader_gate.lock().unwrap();
                    if g.streaming {
                        drop(g);
                        let data = String::from_utf8_lossy(&buf[..n]).into_owned();
                        let _ = app_clone.emit(&format!("terminal-output-{event_id}"), data);
                    } else {
                        g.pending.extend_from_slice(&buf[..n]);
                    }
                }
            }
        }
    });

    let pty_session = PtySession {
        service_name,
        writer,
        child,
        master: pair.master,
        gate,
    };
    state.terminal_manager.sessions.lock().unwrap().insert(id.clone(), pty_session);

    Ok(session)
}

/// Flush buffered startup output and switch the session to live emission. The
/// frontend calls this once its listener is attached. Emission of the snapshot
/// happens while the gate lock is held, so it can't interleave behind live
/// output the reader thread is about to emit.
#[tauri::command]
pub async fn start_terminal_stream(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let gate = {
        let sessions = state.terminal_manager.sessions.lock().unwrap();
        sessions.get(&id).map(|s| s.gate.clone())
    };
    let Some(gate) = gate else { return Ok(()) };

    let mut g = gate.lock().unwrap();
    if !g.pending.is_empty() {
        let data = String::from_utf8_lossy(&g.pending).into_owned();
        let _ = app.emit(&format!("terminal-output-{id}"), data);
        g.pending.clear();
    }
    g.streaming = true;
    Ok(())
}

#[tauri::command]
pub async fn write_terminal_input(
    state: State<'_, AppState>,
    id: String,
    data: String,
) -> Result<(), String> {
    let mut sessions = state.terminal_manager.sessions.lock().unwrap();
    if let Some(session) = sessions.get_mut(&id) {
        session.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn resize_terminal(
    state: State<'_, AppState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = state.terminal_manager.sessions.lock().unwrap();
    if let Some(session) = sessions.get(&id) {
        session.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn close_terminal_session(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    state.terminal_manager.sessions.lock().unwrap().remove(&id);
    Ok(())
}

// Needed so std::io::Read is available in the spawned thread
use std::io::Read;
use std::io::Write;
