use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;
use crate::AppState;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSession {
    pub id: String,
    pub service_name: Option<String>,
}

struct PtySession {
    writer: Box<dyn std::io::Write + Send>,
    #[allow(dead_code)]
    child: Box<dyn portable_pty::Child + Send>,
    #[allow(dead_code)]
    master: Box<dyn portable_pty::MasterPty + Send>,
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
            .keys()
            .map(|id| TerminalSession { id: id.clone(), service_name: None })
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
    let id = Uuid::new_v4().to_string();
    let session = TerminalSession { id: id.clone(), service_name };

    let pty_system = native_pty_system();
    let pair = pty_system.openpty(PtySize {
        rows: 24,
        cols: 80,
        pixel_width: 0,
        pixel_height: 0,
    }).map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new(std::env::var("SHELL").unwrap_or_else(|_| "sh".into()));
    if let Some(dir) = &cwd {
        cmd.cwd(dir);
    }

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

    // Stream PTY output as Tauri events
    let event_id = id.clone();
    let app_clone = app.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).into_owned();
                    let _ = app_clone.emit(&format!("terminal-output-{event_id}"), data);
                }
            }
        }
    });

    let pty_session = PtySession { writer, child, master: pair.master };
    state.terminal_manager.sessions.lock().unwrap().insert(id.clone(), pty_session);

    Ok(session)
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
