#[cfg(target_os = "macos")]
use crate::core::process_manager::service_path;
use crate::AppState;
use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::ffi::OsString;
use std::fmt::Display;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSession {
    pub id: String,
    pub service_name: Option<String>,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
    pub shell: String,
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTerminalRequest {
    provider: String,
    prompt: String,
    label: Option<String>,
}

#[derive(Debug, PartialEq)]
struct AgentInvocation {
    executable: String,
    args: Vec<String>,
}

fn derive_agent_invocation(
    provider: &str,
    prompt: &str,
    claude_bin: &str,
    codex_bin: &str,
) -> Result<AgentInvocation, String> {
    if prompt.trim().is_empty() {
        return Err("Prompt is required".to_string());
    }

    match provider {
        "claude" => Ok(AgentInvocation {
            executable: claude_bin.to_string(),
            args: vec![prompt.to_string()],
        }),
        "codex" => Ok(AgentInvocation {
            executable: codex_bin.to_string(),
            args: vec!["--no-alt-screen".to_string(), prompt.to_string()],
        }),
        _ => Err(format!("Unsupported agent provider: {provider}")),
    }
}

fn agent_binary(env_name: &str, default: &str) -> String {
    std::env::var(env_name)
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| default.to_string())
}

fn resolve_config_load<T, E: Display>(
    required: bool,
    result: Result<T, E>,
) -> Result<Option<T>, String> {
    if required {
        result.map(Some).map_err(|error| error.to_string())
    } else {
        Ok(result.ok())
    }
}

#[cfg(unix)]
fn default_terminal_shell_from(shell: Option<OsString>) -> OsString {
    shell
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| OsString::from("/bin/sh"))
}

#[cfg(windows)]
fn default_terminal_shell_from(comspec: Option<OsString>) -> OsString {
    comspec
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| OsString::from("cmd.exe"))
}

#[cfg(unix)]
fn default_terminal_shell() -> OsString {
    default_terminal_shell_from(std::env::var_os("SHELL"))
}

#[cfg(windows)]
fn default_terminal_shell() -> OsString {
    default_terminal_shell_from(std::env::var_os("COMSPEC"))
}

#[cfg(target_os = "macos")]
fn agent_path_override() -> Option<OsString> {
    Some(OsString::from(service_path()))
}

#[cfg(not(target_os = "macos"))]
fn agent_path_override() -> Option<OsString> {
    None
}

fn normalize_agent_label(provider: &str, label: Option<&str>) -> String {
    let requested = label.map(str::trim).filter(|label| !label.is_empty());
    let fallback = if provider == "codex" {
        "Codex task"
    } else {
        "Claude task"
    };
    requested.unwrap_or(fallback).chars().take(60).collect()
}

#[derive(Debug, PartialEq)]
struct SessionScope {
    service_name: Option<String>,
    work_dir: String,
}

fn resolve_session_scope(
    is_agent: bool,
    supplied_service_name: Option<String>,
    supplied_cwd: Option<String>,
    configured_service_cwd: Option<String>,
    workspace_cwd: Option<String>,
    current_dir: String,
) -> SessionScope {
    if is_agent {
        return SessionScope {
            service_name: None,
            work_dir: workspace_cwd.unwrap_or(current_dir),
        };
    }

    SessionScope {
        service_name: supplied_service_name,
        work_dir: supplied_cwd
            .or(configured_service_cwd)
            .unwrap_or(current_dir),
    }
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
    metadata: TerminalSession,
    writer: Box<dyn std::io::Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
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
        self.sessions
            .lock()
            .unwrap()
            .values()
            .map(|session| session.metadata.clone())
            .collect()
    }

    fn start_child_waiter(&self, id: String, mut child: Box<dyn Child + Send + Sync>) {
        let sessions = self.sessions.clone();
        std::thread::spawn(move || {
            let state = if child.wait().is_ok() {
                "exited"
            } else {
                "error"
            };
            if let Some(session) = sessions.lock().unwrap().get_mut(&id) {
                session.metadata.state = state.to_string();
            }
        });
    }

    fn close_session(&self, id: &str) -> Result<(), String> {
        let session = { self.sessions.lock().unwrap().remove(id) };
        if let Some(mut session) = session {
            session.killer.kill().map_err(|error| error.to_string())?;
        }
        Ok(())
    }
}

#[tauri::command]
pub async fn list_terminal_sessions(
    state: State<'_, AppState>,
) -> Result<Vec<TerminalSession>, String> {
    Ok(state.terminal_manager.list_sessions())
}

#[tauri::command]
pub async fn create_terminal_session(
    app: AppHandle,
    state: State<'_, AppState>,
    service_name: Option<String>,
    cwd: Option<String>,
    agent: Option<AgentTerminalRequest>,
) -> Result<TerminalSession, String> {
    let is_agent = agent.is_some();
    let config = if is_agent || (cwd.is_none() && service_name.is_some()) {
        resolve_config_load(is_agent, state.config_store.load().await)?
    } else {
        None
    };
    let configured_service_cwd = if is_agent {
        None
    } else {
        service_name.as_ref().and_then(|name| {
            config
                .as_ref()
                .and_then(|config| config.services.iter().find(|service| &service.name == name))
                .and_then(|service| service.cwd.clone())
        })
    };
    let workspace_cwd = if is_agent {
        config.as_ref().and_then(|config| {
            config
                .selected_git_repository
                .as_ref()
                .and_then(|selected| {
                    config
                        .git_repositories
                        .iter()
                        .find(|repo| &repo.name == selected)
                })
                .or_else(|| config.git_repositories.first())
                .map(|repo| repo.path.clone())
        })
    } else {
        None
    };
    let current_dir = std::env::current_dir()
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .into_owned();
    let scope = resolve_session_scope(
        is_agent,
        service_name,
        cwd,
        configured_service_cwd,
        workspace_cwd,
        current_dir,
    );
    let session_service_name = scope.service_name;
    let work_dir = scope.work_dir;

    let id = if is_agent {
        format!("agent:{}", Uuid::new_v4())
    } else {
        session_service_name
            .as_ref()
            .map(|name| format!("svc:{name}"))
            .unwrap_or_else(|| Uuid::new_v4().to_string())
    };

    if let Some(existing) = state.terminal_manager.sessions.lock().unwrap().get(&id) {
        return Ok(existing.metadata.clone());
    }

    let (shell, args, label, kind, provider) = if let Some(request) = &agent {
        let claude_bin = agent_binary("NOMOREIDE_CLAUDE_BIN", "claude");
        let codex_bin = agent_binary("NOMOREIDE_CODEX_BIN", "codex");
        let invocation =
            derive_agent_invocation(&request.provider, &request.prompt, &claude_bin, &codex_bin)?;
        (
            OsString::from(invocation.executable),
            invocation.args,
            Some(normalize_agent_label(
                &request.provider,
                request.label.as_deref(),
            )),
            Some("agent".to_string()),
            Some(request.provider.clone()),
        )
    } else {
        let shell = default_terminal_shell();
        let kind = if session_service_name.is_some() {
            "service"
        } else {
            "shell"
        };
        (
            shell,
            Vec::new(),
            session_service_name.clone(),
            Some(kind.to_string()),
            None,
        )
    };
    let session = TerminalSession {
        id: id.clone(),
        service_name: session_service_name,
        cwd: work_dir.clone(),
        cols: 80,
        rows: 24,
        shell: shell.to_string_lossy().into_owned(),
        state: "running".to_string(),
        label,
        kind,
        provider,
    };

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new(&shell);
    cmd.args(&args);
    cmd.cwd(&work_dir);
    // Finder-launched macOS apps inherit a minimal PATH. Other platforms keep
    // the environment copied by CommandBuilder unchanged.
    if let Some(path) = agent_path_override() {
        cmd.env("PATH", path);
    }

    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    // Complete every fallible PTY-handle setup step before spawning. Once a
    // child exists, it is always handed to the waiter below for reaping.
    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    let killer = child.clone_killer();

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
        metadata: session.clone(),
        writer,
        killer,
        master: pair.master,
        gate,
    };
    state
        .terminal_manager
        .sessions
        .lock()
        .unwrap()
        .insert(id.clone(), pty_session);
    state.terminal_manager.start_child_waiter(id, child);

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
        session
            .writer
            .write_all(data.as_bytes())
            .map_err(|e| e.to_string())?;
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
    let mut sessions = state.terminal_manager.sessions.lock().unwrap();
    if let Some(session) = sessions.get_mut(&id) {
        session
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;
        session.metadata.cols = cols;
        session.metadata.rows = rows;
    }
    Ok(())
}

#[tauri::command]
pub async fn close_terminal_session(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.terminal_manager.close_session(&id)
}

// Needed so std::io::Read is available in the spawned thread
use std::io::Read;
use std::io::Write;

#[cfg(test)]
mod tests {
    use super::{
        derive_agent_invocation, normalize_agent_label, resolve_config_load, resolve_session_scope,
    };

    #[test]
    fn agent_config_load_errors_are_propagated() {
        let result = resolve_config_load::<(), _>(true, Err("config unavailable"));

        assert_eq!(result.unwrap_err(), "config unavailable");
    }

    #[test]
    fn legacy_non_agent_config_load_errors_remain_best_effort() {
        let result = resolve_config_load::<(), _>(false, Err("config unavailable"));

        assert_eq!(result.unwrap(), None);
    }

    #[cfg(unix)]
    #[test]
    fn unix_shell_resolution_uses_shell_then_bin_sh() {
        use super::default_terminal_shell_from;
        use std::ffi::{OsStr, OsString};

        assert_eq!(
            default_terminal_shell_from(Some(OsString::from("/custom/shell"))),
            OsStr::new("/custom/shell")
        );
        assert_eq!(default_terminal_shell_from(None), OsStr::new("/bin/sh"));
    }

    #[cfg(windows)]
    #[test]
    fn windows_shell_resolution_uses_comspec_then_cmd_and_preserves_path() {
        use super::default_terminal_shell_from;
        use std::ffi::{OsStr, OsString};

        assert_eq!(
            default_terminal_shell_from(Some(OsString::from("custom-cmd.exe"))),
            OsStr::new("custom-cmd.exe")
        );
        assert_eq!(default_terminal_shell_from(None), OsStr::new("cmd.exe"));
        assert!(super::agent_path_override().is_none());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_agent_path_is_enriched() {
        assert!(super::agent_path_override().is_some());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    #[test]
    fn non_macos_agent_path_preserves_inherited_environment() {
        assert!(super::agent_path_override().is_none());
    }

    #[cfg(unix)]
    fn spawn_test_session(manager: &super::TerminalManager, id: &str, script: &str) -> u32 {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        use std::sync::{Arc, Mutex};

        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut command = CommandBuilder::new("/bin/sh");
        command.args(["-c", script]);
        let child = pair.slave.spawn_command(command).unwrap();
        let pid = child.process_id().unwrap();
        let killer = child.clone_killer();
        let writer = pair.master.take_writer().unwrap();
        let session = super::PtySession {
            metadata: super::TerminalSession {
                id: id.to_string(),
                service_name: None,
                cwd: "/tmp".to_string(),
                cols: 80,
                rows: 24,
                shell: "/bin/sh".to_string(),
                state: "running".to_string(),
                label: None,
                kind: Some("shell".to_string()),
                provider: None,
            },
            writer,
            killer,
            master: pair.master,
            gate: Arc::new(Mutex::new(super::OutputGate::default())),
        };
        manager
            .sessions
            .lock()
            .unwrap()
            .insert(id.to_string(), session);
        manager.start_child_waiter(id.to_string(), child);
        pid
    }

    #[cfg(unix)]
    #[test]
    fn natural_child_exit_is_reaped_and_reported_as_exited() {
        let manager = super::TerminalManager::new();
        let pid = spawn_test_session(&manager, "natural", "exit 0");

        for _ in 0..100 {
            let state = manager
                .list_sessions()
                .into_iter()
                .find(|session| session.id == "natural")
                .unwrap()
                .state;
            if state == "exited" {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }

        let session = manager
            .list_sessions()
            .into_iter()
            .find(|session| session.id == "natural")
            .unwrap();
        assert_eq!(session.state, "exited");
        assert!(!process_exists(pid));
    }

    #[cfg(unix)]
    #[test]
    fn closing_a_session_terminates_and_reaps_a_long_running_child() {
        let manager = super::TerminalManager::new();
        let pid = spawn_test_session(&manager, "long-running", "sleep 30");
        assert!(process_exists(pid));

        manager.close_session("long-running").unwrap();

        for _ in 0..100 {
            if !process_exists(pid) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(!process_exists(pid));
        assert!(manager.list_sessions().is_empty());
    }

    #[cfg(unix)]
    fn process_exists(pid: u32) -> bool {
        let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
        result == 0 || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
    }

    #[test]
    fn agent_scope_ignores_browser_service_and_cwd_in_favor_of_workspace() {
        let scope = resolve_session_scope(
            true,
            Some("browser-service".to_string()),
            Some("/browser/cwd".to_string()),
            Some("/configured/service".to_string()),
            Some("/workspace/repository".to_string()),
            "/current/dir".to_string(),
        );

        assert_eq!(scope.service_name, None);
        assert_eq!(scope.work_dir, "/workspace/repository");
    }

    #[test]
    fn agent_scope_falls_back_to_current_dir_without_a_workspace_repository() {
        let scope = resolve_session_scope(
            true,
            Some("browser-service".to_string()),
            Some("/browser/cwd".to_string()),
            Some("/configured/service".to_string()),
            None,
            "/current/dir".to_string(),
        );

        assert_eq!(scope.service_name, None);
        assert_eq!(scope.work_dir, "/current/dir");
    }

    #[test]
    fn non_agent_scope_preserves_plain_and_service_precedence() {
        let requested = resolve_session_scope(
            false,
            Some("api".to_string()),
            Some("/requested/cwd".to_string()),
            Some("/configured/service".to_string()),
            Some("/workspace/repository".to_string()),
            "/current/dir".to_string(),
        );
        let configured = resolve_session_scope(
            false,
            Some("api".to_string()),
            None,
            Some("/configured/service".to_string()),
            Some("/workspace/repository".to_string()),
            "/current/dir".to_string(),
        );

        assert_eq!(requested.service_name.as_deref(), Some("api"));
        assert_eq!(requested.work_dir, "/requested/cwd");
        assert_eq!(configured.service_name.as_deref(), Some("api"));
        assert_eq!(configured.work_dir, "/configured/service");
    }

    #[test]
    fn claude_invocation_uses_default_binary_and_preserves_the_full_prompt() {
        let prompt = "  inspect this project\nthen explain it  ";

        let invocation = derive_agent_invocation("claude", prompt, "claude", "codex").unwrap();

        assert_eq!(invocation.executable, "claude");
        assert_eq!(invocation.args, vec![prompt]);
    }

    #[test]
    fn codex_invocation_disables_alt_screen_and_preserves_the_full_prompt() {
        let prompt = "  inspect this project\nthen explain it  ";

        let invocation = derive_agent_invocation("codex", prompt, "claude", "codex").unwrap();

        assert_eq!(invocation.executable, "codex");
        assert_eq!(invocation.args, vec!["--no-alt-screen", prompt]);
    }

    #[test]
    fn blank_agent_prompt_is_rejected() {
        let error = derive_agent_invocation("claude", " \n\t ", "claude", "codex").unwrap_err();

        assert_eq!(error, "Prompt is required");
    }

    #[test]
    fn unknown_agent_provider_is_rejected() {
        let error = derive_agent_invocation("other", "do work", "claude", "codex").unwrap_err();

        assert_eq!(error, "Unsupported agent provider: other");
    }

    #[test]
    fn agent_invocation_uses_resolved_executable_overrides() {
        let claude = derive_agent_invocation(
            "claude",
            "do work",
            "/custom/bin/claude",
            "/custom/bin/codex",
        )
        .unwrap();
        let codex = derive_agent_invocation(
            "codex",
            "do work",
            "/custom/bin/claude",
            "/custom/bin/codex",
        )
        .unwrap();

        assert_eq!(claude.executable, "/custom/bin/claude");
        assert_eq!(codex.executable, "/custom/bin/codex");
    }

    #[test]
    fn agent_label_is_trimmed_and_capped_at_sixty_characters() {
        let requested = format!("  {}  ", "A".repeat(70));

        assert_eq!(
            normalize_agent_label("codex", Some(&requested)),
            "A".repeat(60)
        );
    }

    #[test]
    fn agent_label_uses_provider_default_when_missing_or_blank() {
        assert_eq!(normalize_agent_label("claude", None), "Claude task");
        assert_eq!(normalize_agent_label("codex", Some(" \t ")), "Codex task");
    }
}
