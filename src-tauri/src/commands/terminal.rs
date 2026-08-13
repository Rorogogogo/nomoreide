use crate::core::agent_transcripts::{
    list_agent_transcripts as read_agent_transcripts, AgentTranscript, DEFAULT_TRANSCRIPT_LIMIT,
};
use crate::core::context_library::{ContextAttachment, ContextLibrary};
#[cfg(target_os = "macos")]
use crate::core::external_terminal::{
    accept_authenticated, external_terminal_title, launch_terminal, new_socket_path, read_frame,
    write_frame, SocketPathGuard, ATTACHED, DETACH, INPUT, OUTPUT, RESIZE, REVOKED,
};
use crate::core::one_time_skills::{
    compose_one_time_skill_prompt, resolve_one_time_skill, OneTimeSkillSelection,
};
#[cfg(target_os = "macos")]
use crate::core::process_manager::service_path;
use crate::AppState;
use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};
#[cfg(target_os = "macos")]
use std::collections::VecDeque;
use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::fmt::Display;
#[cfg(target_os = "macos")]
use std::net::Shutdown;
#[cfg(target_os = "macos")]
use std::os::unix::net::UnixStream;
#[cfg(target_os = "macos")]
use std::path::PathBuf;
#[cfg(target_os = "macos")]
use std::sync::mpsc::{sync_channel, SyncSender, TrySendError};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

#[cfg(unix)]
const PROCESS_GROUP_EXIT_TIMEOUT: Duration = Duration::from_secs(5);
#[cfg(unix)]
const TERMINAL_CLEANUP_CONFIRM_TIMEOUT: Duration = Duration::from_secs(6);
const MAX_AGENT_PROMPT_BYTES: usize = 512 * 1024;

fn encode_agent_prompt_paste(prompt: &str) -> Result<String, String> {
    if prompt.is_empty() {
        return Err("Agent prompt must not be empty".to_string());
    }
    if prompt.len() > MAX_AGENT_PROMPT_BYTES {
        return Err("Agent prompt is too large".to_string());
    }
    let normalized = prompt.replace("\r\n", "\n");
    if normalized
        .chars()
        .any(|character| character.is_control() && character != '\n' && character != '\t')
    {
        return Err("Agent prompt contains unsupported terminal control characters".to_string());
    }
    Ok(format!(
        "\u{1b}[200~{}\u{1b}[201~",
        normalized.replace('\n', "\r")
    ))
}

fn validate_agent_prompt_target(session: &TerminalSession) -> Result<(), String> {
    if session.kind.as_deref() != Some("agent") {
        return Err("Only agent sessions can receive a prompt".to_string());
    }
    if session.state != "running" {
        return Err("Only a running agent session can receive a prompt".to_string());
    }
    if session.presentation == TerminalPresentation::TerminalLaunching {
        return Err("An agent prompt cannot be inserted while Terminal is opening".to_string());
    }
    Ok(())
}

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
    #[serde(default)]
    pub presentation: TerminalPresentation,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TerminalPresentation {
    #[default]
    Dock,
    TerminalLaunching,
    Terminal,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTerminalRequest {
    provider: String,
    prompt: String,
    label: Option<String>,
    one_time_skill: Option<OneTimeSkillSelection>,
    resume_id: Option<String>,
    context: Option<ContextAttachment>,
}

#[derive(Debug, PartialEq)]
struct AgentInvocation {
    executable: String,
    args: Vec<String>,
}

fn derive_agent_invocation(
    provider: &str,
    prompt: &str,
    resume_id: Option<&str>,
    claude_bin: &str,
    codex_bin: &str,
) -> Result<AgentInvocation, String> {
    if let Some(id) = resume_id {
        if !(8..=64).contains(&id.len())
            || !id
                .chars()
                .all(|character| character.is_ascii_hexdigit() || character == '-')
        {
            return Err(format!("Invalid session id: {id}"));
        }
    }

    // Both CLIs accept a positional initial prompt and queue it until the TUI
    // is ready — far more reliable than injecting keystrokes after spawn. A
    // blank prompt simply opens the provider's interactive TUI.
    match provider {
        "claude" => {
            let mut args = Vec::new();
            if let Some(id) = resume_id {
                args.extend(["--resume".to_string(), id.to_string()]);
            }
            if !prompt.trim().is_empty() {
                args.push(prompt.to_string());
            }
            Ok(AgentInvocation {
                executable: claude_bin.to_string(),
                args,
            })
        }
        "codex" => {
            let mut args = vec!["--no-alt-screen".to_string()];
            if let Some(id) = resume_id {
                args.extend(["resume".to_string(), id.to_string()]);
            }
            if !prompt.trim().is_empty() {
                args.push(prompt.to_string());
            }
            Ok(AgentInvocation {
                executable: codex_bin.to_string(),
                args,
            })
        }
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

fn normalize_session_label(label: &str) -> Result<String, String> {
    let trimmed = label.trim();
    if trimmed.is_empty() {
        return Err("Terminal session label must not be empty".to_string());
    }
    if trimmed.encode_utf16().count() > 60 {
        return Err("Terminal session label must be at most 60 characters".to_string());
    }
    Ok(trimmed.to_string())
}

fn configure_interactive_terminal_environment(
    command: &mut CommandBuilder,
    provider: Option<&str>,
) {
    command.env_remove("NO_COLOR");
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    if provider == Some("codex") {
        command.env("FORCE_COLOR", "1");
    }
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
            .or(workspace_cwd)
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
    #[cfg(target_os = "macos")]
    replay: VecDeque<u8>,
    #[cfg(target_os = "macos")]
    external: Option<ExternalOutputSink>,
    #[cfg(target_os = "macos")]
    closed: bool,
}

#[cfg(target_os = "macos")]
const TERMINAL_REPLAY_BYTES: usize = 1024 * 1024;

#[cfg(target_os = "macos")]
#[derive(Clone)]
struct ExternalOutputSink {
    lease: String,
    sender: SyncSender<ExternalOutput>,
    revoke: Arc<UnixStream>,
}

#[cfg(target_os = "macos")]
enum ExternalOutput {
    Replay(Vec<u8>),
    Data(Vec<u8>),
    Revoked,
}

#[cfg(target_os = "macos")]
fn forward_external_output(gate: &mut OutputGate, data: &[u8]) -> Option<String> {
    let sink = gate.external.as_ref()?;
    match sink.sender.try_send(ExternalOutput::Data(data.to_vec())) {
        Ok(()) => None,
        Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => {
            let lease = sink.lease.clone();
            let _ = sink.revoke.shutdown(Shutdown::Both);
            gate.external = None;
            Some(lease)
        }
    }
}

#[cfg(target_os = "macos")]
struct ExternalAttachment {
    lease: String,
    socket_path: PathBuf,
    revoke: Option<UnixStream>,
}

#[cfg(target_os = "macos")]
fn validate_external_launch(session: &PtySession) -> Result<(), String> {
    if session.metadata.kind.as_deref() != Some("agent") {
        return Err("Only agent sessions can open in Terminal".to_string());
    }
    if session.metadata.state != "running" || session.gate.lock().unwrap().closed {
        return Err("Only a running agent session can open in Terminal".to_string());
    }
    if session.metadata.presentation != TerminalPresentation::Dock || session.attachment.is_some() {
        return Err("This agent session is already opening or active in Terminal".to_string());
    }
    if session.prompt_write_active {
        return Err("This agent session is receiving a prompt; retry shortly".to_string());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn revoke_external_attachment(session: &mut PtySession, expected_lease: Option<&str>) -> bool {
    let Some(attachment) = session.attachment.as_ref() else {
        return false;
    };
    if expected_lease.is_some_and(|lease| lease != attachment.lease) {
        return false;
    }
    let mut attachment = session.attachment.take().unwrap();
    let mut gate = session.gate.lock().unwrap();
    if gate.external.as_ref().map(|sink| sink.lease.as_str()) == Some(attachment.lease.as_str()) {
        if let Some(sink) = gate.external.take() {
            let _ = sink.sender.try_send(ExternalOutput::Revoked);
            let _ = sink.revoke.shutdown(Shutdown::Both);
        }
    }
    drop(gate);
    if let Some(stream) = attachment.revoke.take() {
        let _ = stream.shutdown(Shutdown::Both);
    }
    let _ = std::fs::remove_file(attachment.socket_path);
    session.metadata.presentation = TerminalPresentation::Dock;
    true
}

struct PtySession {
    control: Arc<Mutex<()>>,
    prompt_write_active: bool,
    generation: String,
    pid: Option<u32>,
    group_cleanup_complete: bool,
    metadata: TerminalSession,
    writer: Arc<Mutex<Box<dyn std::io::Write + Send>>>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    #[allow(dead_code)]
    master: Box<dyn portable_pty::MasterPty + Send>,
    gate: Arc<Mutex<OutputGate>>,
    #[cfg(target_os = "macos")]
    attachment: Option<ExternalAttachment>,
}

#[derive(Default)]
struct TerminalRegistry {
    sessions: HashMap<String, PtySession>,
    creating: HashSet<String>,
    closing: HashMap<String, String>,
    shutting_down: bool,
}

#[derive(Debug)]
enum IdReservation {
    Existing(TerminalSession),
    Reserved,
}

#[derive(Clone)]
pub struct TerminalManager {
    registry: Arc<(Mutex<TerminalRegistry>, Condvar)>,
}

impl TerminalManager {
    pub fn new() -> Self {
        TerminalManager {
            registry: Arc::new((Mutex::new(TerminalRegistry::default()), Condvar::new())),
        }
    }

    pub fn list_sessions(&self) -> Vec<TerminalSession> {
        self.registry
            .0
            .lock()
            .unwrap()
            .sessions
            .values()
            .map(|session| session.metadata.clone())
            .collect()
    }

    pub fn has_external_presentations(&self) -> bool {
        self.registry
            .0
            .lock()
            .unwrap()
            .sessions
            .values()
            .any(|session| session.metadata.presentation != TerminalPresentation::Dock)
    }

    #[cfg(target_os = "macos")]
    fn open_in_terminal(&self, app: &AppHandle, id: &str) -> Result<TerminalSession, String> {
        let (control, control_generation) = {
            let registry = self.registry.0.lock().unwrap();
            let session = registry
                .sessions
                .get(id)
                .ok_or_else(|| format!("Unknown terminal session: {id}"))?;
            (session.control.clone(), session.generation.clone())
        };
        let _control = control.lock().unwrap();
        {
            let registry = self.registry.0.lock().unwrap();
            let session = registry
                .sessions
                .get(id)
                .ok_or_else(|| format!("Unknown terminal session: {id}"))?;
            if session.generation != control_generation
                || !Arc::ptr_eq(&control, &session.control)
            {
                return Err(format!("Terminal session changed while opening: {id}"));
            }
            validate_external_launch(session)?;
        }
        let socket_path = new_socket_path();
        let (listener, socket_guard) = SocketPathGuard::bind(socket_path.clone())
            .map_err(|error| format!("Could not prepare Terminal attachment: {error}"))?;
        let token = Uuid::new_v4().as_simple().to_string();
        let lease = Uuid::new_v4().to_string();

        let (generation, snapshot) = {
            let mut registry = self.registry.0.lock().unwrap();
            let session = registry
                .sessions
                .get_mut(id)
                .ok_or_else(|| format!("Unknown terminal session: {id}"))?;
            if session.generation != control_generation
                || !Arc::ptr_eq(&control, &session.control)
            {
                return Err(format!("Terminal session changed while opening: {id}"));
            }
            validate_external_launch(session)?;
            session.metadata.presentation = TerminalPresentation::TerminalLaunching;
            session.attachment = Some(ExternalAttachment {
                lease: lease.clone(),
                socket_path: socket_path.clone(),
                revoke: None,
            });
            (session.generation.clone(), session.metadata.clone())
        };
        emit_terminal_session(app, &snapshot);

        let registry = self.registry.clone();
        let app_clone = app.clone();
        let id_owned = id.to_string();
        let token_owned = token.clone();
        let socket_owned = socket_path.clone();
        let lease_owned = lease.clone();
        let listener_generation = generation.clone();
        std::thread::spawn(move || {
            run_external_listener(
                registry,
                app_clone,
                id_owned,
                listener_generation,
                lease_owned,
                token_owned,
                socket_owned,
                listener,
                socket_guard,
            );
        });

        let title =
            external_terminal_title(snapshot.provider.as_deref(), snapshot.label.as_deref());
        if let Err(error) = launch_terminal(&socket_path, &token, &title) {
            let rollback = reset_external_presentation(&self.registry, id, &generation, &lease);
            if let Some(session) = rollback.as_ref() {
                emit_terminal_session(app, session);
            }
            return Err(error);
        }
        let registry = self.registry.0.lock().unwrap();
        let session = registry
            .sessions
            .get(id)
            .filter(|session| session.generation == generation)
            .ok_or_else(|| "Agent session ended while Terminal was opening".to_string())?;
        if session
            .attachment
            .as_ref()
            .is_some_and(|attachment| attachment.lease != lease)
        {
            return Err("Terminal attachment was superseded while opening".to_string());
        }
        Ok(session.metadata.clone())
    }

    #[cfg(not(target_os = "macos"))]
    fn open_in_terminal(&self, _app: &AppHandle, _id: &str) -> Result<TerminalSession, String> {
        Err("External Terminal is currently available on macOS only".to_string())
    }

    fn reclaim_to_dock(&self, app: &AppHandle, id: &str) -> Result<TerminalSession, String> {
        let (control, control_generation) = {
            let registry = self.registry.0.lock().unwrap();
            let session = registry
                .sessions
                .get(id)
                .ok_or_else(|| format!("Unknown terminal session: {id}"))?;
            (session.control.clone(), session.generation.clone())
        };
        let _control = control.lock().unwrap();
        let snapshot = {
            let mut registry = self.registry.0.lock().unwrap();
            let session = registry
                .sessions
                .get_mut(id)
                .ok_or_else(|| format!("Unknown terminal session: {id}"))?;
            if session.generation != control_generation
                || !Arc::ptr_eq(&control, &session.control)
            {
                return Err(format!("Terminal session changed while reclaiming: {id}"));
            }
            if session.prompt_write_active {
                return Err("This agent session is receiving a prompt; retry shortly".to_string());
            }
            #[cfg(target_os = "macos")]
            revoke_external_attachment(session, None);
            session.metadata.presentation = TerminalPresentation::Dock;
            session.metadata.clone()
        };
        emit_terminal_session(app, &snapshot);
        Ok(snapshot)
    }

    fn insert_agent_prompt(&self, id: &str, prompt: &str) -> Result<TerminalSession, String> {
        let encoded = encode_agent_prompt_paste(prompt)?;
        let (control, control_generation) = {
            let registry = self.registry.0.lock().unwrap();
            let session = registry
                .sessions
                .get(id)
                .ok_or_else(|| format!("Unknown terminal session: {id}"))?;
            (session.control.clone(), session.generation.clone())
        };
        let (generation, writer) = {
            let _control = control.lock().unwrap();
            let mut registry = self.registry.0.lock().unwrap();
            if registry.shutting_down {
                return Err("Terminal manager is shutting down".to_string());
            }
            if registry.closing.contains_key(id) {
                return Err(format!("Terminal session is closing; retry shortly: {id}"));
            }
            let session = registry
                .sessions
                .get_mut(id)
                .ok_or_else(|| format!("Unknown terminal session: {id}"))?;
            if session.generation != control_generation
                || !Arc::ptr_eq(&control, &session.control)
            {
                return Err(format!("Terminal session changed while inserting a prompt: {id}"));
            }
            validate_agent_prompt_target(&session.metadata)?;
            if session.prompt_write_active {
                return Err("This agent session is already receiving a prompt".to_string());
            }
            session.prompt_write_active = true;
            (session.generation.clone(), session.writer.clone())
        };
        let write_result = writer
            .lock()
            .unwrap()
            .write_all(encoded.as_bytes())
            .map_err(|error| error.to_string());
        let mut registry = self.registry.0.lock().unwrap();
        if let Some(session) = registry
            .sessions
            .get_mut(id)
            .filter(|session| session.generation == generation)
        {
            session.prompt_write_active = false;
        }
        write_result?;
        if registry.shutting_down || registry.closing.contains_key(id) {
            return Err(format!("Terminal session is closing; retry shortly: {id}"));
        }
        let session = registry
            .sessions
            .get(id)
            .filter(|session| session.generation == generation)
            .ok_or_else(|| format!("Agent session ended while inserting a prompt: {id}"))?;
        validate_agent_prompt_target(&session.metadata)?;
        Ok(session.metadata.clone())
    }

    fn rename_session(&self, id: &str, label: String) -> Result<TerminalSession, String> {
        let mut registry = self.registry.0.lock().unwrap();
        if registry.shutting_down {
            return Err("Terminal manager is shutting down".to_string());
        }
        if registry.closing.contains_key(id) {
            return Err(format!("Terminal session is closing; retry shortly: {id}"));
        }
        let session = registry
            .sessions
            .get_mut(id)
            .ok_or_else(|| format!("Unknown terminal session: {id}"))?;
        session.metadata.label = Some(label);
        Ok(session.metadata.clone())
    }

    fn reserve_id(&self, id: &str) -> Result<IdReservation, String> {
        let mut registry = self.registry.0.lock().unwrap();
        if registry.shutting_down {
            return Err("Terminal manager is shutting down".to_string());
        }
        if registry.closing.contains_key(id) {
            return Err(format!("Terminal session is closing; retry shortly: {id}"));
        }
        if let Some(session) = registry.sessions.get(id) {
            return Ok(IdReservation::Existing(session.metadata.clone()));
        }
        if !registry.creating.insert(id.to_string()) {
            return Err(format!(
                "Terminal session creation already in progress: {id}"
            ));
        }
        self.registry.1.notify_all();
        Ok(IdReservation::Reserved)
    }

    fn release_reservation(&self, id: &str) {
        let mut registry = self.registry.0.lock().unwrap();
        registry.creating.remove(id);
        self.registry.1.notify_all();
    }

    fn complete_reservation(&self, id: String, session: PtySession) {
        let mut registry = self.registry.0.lock().unwrap();
        registry.creating.remove(&id);
        registry.sessions.insert(id, session);
        self.registry.1.notify_all();
    }

    fn start_child_waiter(
        &self,
        id: String,
        generation: String,
        mut child: Box<dyn Child + Send + Sync>,
    ) {
        let registry = self.registry.clone();
        std::thread::spawn(move || {
            let pid = child.process_id();
            let wait_succeeded = child.wait().is_ok();
            let group_cleanup_complete = if wait_succeeded {
                cleanup_process_group_after_wait(pid)
            } else {
                false
            };
            let state = if wait_succeeded && group_cleanup_complete {
                "exited"
            } else {
                "error"
            };
            let mut locked = registry.0.lock().unwrap();
            if let Some(session) = locked.sessions.get_mut(&id) {
                if session.generation == generation {
                    session.group_cleanup_complete = group_cleanup_complete;
                    session.metadata.state = state.to_string();
                }
            }
            registry.1.notify_all();
        });
    }

    #[cfg(test)]
    fn mark_child_state(&self, id: &str, generation: &str, state: &str) {
        let mut registry = self.registry.0.lock().unwrap();
        if let Some(session) = registry.sessions.get_mut(id) {
            if session.generation == generation {
                session.metadata.state = state.to_string();
            }
        }
        self.registry.1.notify_all();
    }

    fn wait_for_terminal_cleanup(&self, id: &str, generation: &str, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let mut registry = self.registry.0.lock().unwrap();
        loop {
            let confirmed = registry
                .sessions
                .get(id)
                .map(|session| {
                    session.generation == generation
                        && session.metadata.state == "exited"
                        && session.group_cleanup_complete
                })
                .unwrap_or(false);
            if confirmed {
                return true;
            }
            let now = Instant::now();
            if now >= deadline {
                return false;
            }
            let (next, wait) = self
                .registry
                .1
                .wait_timeout(registry, deadline.saturating_duration_since(now))
                .unwrap();
            registry = next;
            if wait.timed_out() {
                return false;
            }
        }
    }

    fn remove_generation(&self, id: &str, generation: &str) -> bool {
        let mut registry = self.registry.0.lock().unwrap();
        let matches = registry
            .sessions
            .get(id)
            .map(|session| session.generation == generation)
            .unwrap_or(false);
        if matches {
            registry.sessions.remove(id);
        }
        if registry.closing.get(id).map(String::as_str) == Some(generation) {
            registry.closing.remove(id);
        }
        self.registry.1.notify_all();
        matches
    }

    fn clear_closing(&self, id: &str, generation: &str) {
        let mut registry = self.registry.0.lock().unwrap();
        if registry.closing.get(id).map(String::as_str) == Some(generation) {
            registry.closing.remove(id);
        }
        self.registry.1.notify_all();
    }

    #[cfg(unix)]
    fn signal_running_process_group(
        &self,
        id: &str,
        generation: &str,
        pid: u32,
        signal: libc::c_int,
    ) -> Result<bool, String> {
        let registry = self.registry.0.lock().unwrap();
        let is_running_generation = registry
            .sessions
            .get(id)
            .map(|session| session.generation == generation && session.metadata.state == "running")
            .unwrap_or(false);
        if !is_running_generation {
            return Ok(false);
        }
        signal_process_group(pid, signal)
            .map(|()| true)
            .map_err(|error| error.to_string())
    }

    #[cfg(unix)]
    fn shutdown_running_session(
        &self,
        id: &str,
        generation: &str,
        pid: Option<u32>,
        killer: &mut Box<dyn ChildKiller + Send + Sync>,
    ) -> Result<(), String> {
        let Some(pid) = pid else {
            let kill_result = killer.kill();
            if self.wait_for_terminal_cleanup(id, generation, Duration::from_secs(2)) {
                return Ok(());
            }
            return Err(kill_result
                .err()
                .map(|error| error.to_string())
                .unwrap_or_else(|| format!("Terminal session did not exit: {id}")));
        };

        self.signal_running_process_group(id, generation, pid, libc::SIGHUP)?;
        let mut confirmed =
            self.wait_for_terminal_cleanup(id, generation, Duration::from_millis(250));

        // The main process may honor SIGHUP while an agent-spawned descendant
        // ignores it. Only signal while the matching generation is still
        // recorded as running; the waiter owns final descendant cleanup and
        // records completion before publishing the exited state.
        if !confirmed {
            self.signal_running_process_group(id, generation, pid, libc::SIGKILL)?;
            // The waiter may spend several seconds confirming that the
            // process group disappeared before it publishes the final state.
            confirmed =
                self.wait_for_terminal_cleanup(id, generation, TERMINAL_CLEANUP_CONFIRM_TIMEOUT);
        }
        if !confirmed {
            return Err(format!(
                "Terminal session termination was not confirmed: {id}"
            ));
        }
        Ok(())
    }

    #[cfg(not(unix))]
    fn shutdown_running_session(
        &self,
        id: &str,
        generation: &str,
        _pid: Option<u32>,
        killer: &mut Box<dyn ChildKiller + Send + Sync>,
    ) -> Result<(), String> {
        let kill_result = killer.kill();
        if self.wait_for_terminal_cleanup(id, generation, Duration::from_secs(2)) {
            return Ok(());
        }
        Err(kill_result
            .err()
            .map(|error| error.to_string())
            .unwrap_or_else(|| format!("Terminal session termination was not confirmed: {id}")))
    }

    fn close_session(&self, id: &str) -> Result<(), String> {
        let target = {
            let registry = self.registry.0.lock().unwrap();
            if registry.creating.contains(id) {
                return Err(format!(
                    "Terminal session creation is still in progress: {id}"
                ));
            }
            registry
                .sessions
                .get(id)
                .map(|session| (session.control.clone(), session.generation.clone()))
        };
        let Some((control, control_generation)) = target else {
            return Ok(());
        };
        let _control = control.lock().unwrap();
        let (generation, pid, mut killer) = {
            let mut registry = self.registry.0.lock().unwrap();
            if registry.closing.contains_key(id) {
                return Ok(());
            }
            let Some(session) = registry.sessions.get_mut(id) else {
                if registry.creating.contains(id) {
                    return Err(format!(
                        "Terminal session creation is still in progress: {id}"
                    ));
                }
                return Ok(());
            };
            if session.generation != control_generation
                || !Arc::ptr_eq(&control, &session.control)
            {
                return Err(format!("Terminal session changed while closing: {id}"));
            }
            #[cfg(target_os = "macos")]
            revoke_external_attachment(session, None);
            if session.metadata.state != "running" {
                if session.group_cleanup_complete {
                    registry.sessions.remove(id);
                    return Ok(());
                } else {
                    return Err(format!(
                        "Terminal lifecycle cleanup was not confirmed; refusing to signal a stale process group: {id}"
                    ));
                }
            } else {
                let generation = session.generation.clone();
                let snapshot = (
                    generation.clone(),
                    session.pid,
                    session.killer.clone_killer(),
                );
                registry.closing.insert(id.to_string(), generation);
                self.registry.1.notify_all();
                snapshot
            }
        };

        if let Err(error) = self.shutdown_running_session(id, &generation, pid, &mut killer) {
            self.clear_closing(id, &generation);
            return Err(error);
        }
        if self.remove_generation(id, &generation) {
            Ok(())
        } else {
            Err(format!("Terminal session changed while closing: {id}"))
        }
    }

    pub fn close_all(&self) -> Result<(), String> {
        let ids: Vec<String> = {
            let mut registry = self.registry.0.lock().unwrap();
            registry.shutting_down = true;
            self.registry.1.notify_all();
            while !registry.creating.is_empty() || !registry.closing.is_empty() {
                registry = self.registry.1.wait(registry).unwrap();
            }
            registry.sessions.keys().cloned().collect()
        };
        let mut errors = Vec::new();
        for id in ids {
            if let Err(error) = self.close_session(&id) {
                errors.push(format!("{id}: {error}"));
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }
}

fn emit_terminal_session(app: &AppHandle, session: &TerminalSession) {
    let _ = app.emit("terminal-session-changed", session.clone());
}

#[cfg(target_os = "macos")]
fn run_external_listener(
    registry: Arc<(Mutex<TerminalRegistry>, Condvar)>,
    app: AppHandle,
    id: String,
    generation: String,
    lease: String,
    token: String,
    _socket_path: PathBuf,
    listener: std::os::unix::net::UnixListener,
    _socket_guard: SocketPathGuard,
) {
    let deadline = Instant::now() + Duration::from_secs(30);
    let accepted = accept_authenticated(
        &listener,
        token.as_bytes(),
        deadline,
        Duration::from_millis(500),
        || {
            let locked = registry.0.lock().unwrap();
            locked.sessions.get(&id).is_some_and(|session| {
                session.generation == generation
                    && session.metadata.state == "running"
                    && session.metadata.presentation == TerminalPresentation::TerminalLaunching
                    && session.attachment.as_ref().map(|item| item.lease.as_str())
                        == Some(lease.as_str())
                    && !session.gate.lock().unwrap().closed
            })
        },
    )
    .ok()
    .flatten();
    let Some(mut stream) = accepted else {
        emit_reset_external_presentation(&registry, &app, &id, &generation, &lease);
        return;
    };

    let (sender, receiver) = sync_channel::<ExternalOutput>(128);
    let writer_stream = match stream.try_clone() {
        Ok(clone) => clone,
        Err(_) => {
            emit_reset_external_presentation(&registry, &app, &id, &generation, &lease);
            return;
        }
    };
    let revoke = Arc::new(match stream.try_clone() {
        Ok(clone) => clone,
        Err(_) => {
            emit_reset_external_presentation(&registry, &app, &id, &generation, &lease);
            return;
        }
    });
    std::thread::spawn(move || {
        let mut output = writer_stream;
        if write_frame(&mut output, ATTACHED, &[]).is_err() {
            let _ = output.shutdown(Shutdown::Both);
            return;
        }
        while let Ok(message) = receiver.recv() {
            let revoked = matches!(message, ExternalOutput::Revoked);
            let result = match message {
                ExternalOutput::Replay(data) | ExternalOutput::Data(data) => {
                    write_frame(&mut output, OUTPUT, &data)
                }
                ExternalOutput::Revoked => {
                    let result = write_frame(&mut output, REVOKED, &[]);
                    let _ = output.shutdown(Shutdown::Both);
                    result
                }
            };
            if result.is_err() || revoked {
                let _ = output.shutdown(Shutdown::Both);
                break;
            }
        }
    });

    let snapshot = {
        let mut locked = registry.0.lock().unwrap();
        let Some(session) = locked.sessions.get_mut(&id) else {
            return;
        };
        if session.generation != generation
            || session.attachment.as_ref().map(|item| item.lease.as_str()) != Some(lease.as_str())
        {
            return;
        }
        if session.metadata.state != "running" {
            drop(locked);
            emit_reset_external_presentation(&registry, &app, &id, &generation, &lease);
            return;
        }
        let mut gate = session.gate.lock().unwrap();
        if gate.closed {
            drop(gate);
            drop(locked);
            emit_reset_external_presentation(&registry, &app, &id, &generation, &lease);
            return;
        }
        let replay: Vec<u8> = gate.replay.iter().copied().collect();
        if sender.send(ExternalOutput::Replay(replay)).is_err() {
            drop(gate);
            drop(locked);
            emit_reset_external_presentation(&registry, &app, &id, &generation, &lease);
            return;
        }
        gate.external = Some(ExternalOutputSink {
            lease: lease.clone(),
            sender: sender.clone(),
            revoke: revoke.clone(),
        });
        drop(gate);
        if let Some(attachment) = session.attachment.as_mut() {
            attachment.revoke = stream.try_clone().ok();
        }
        session.metadata.presentation = TerminalPresentation::Terminal;
        session.metadata.clone()
    };
    emit_terminal_session(&app, &snapshot);

    loop {
        match read_frame(&mut stream) {
            Ok((INPUT, data)) => {
                let control = {
                    let locked = registry.0.lock().unwrap();
                    locked.sessions.get(&id).and_then(|session| {
                        (session.generation == generation).then(|| session.control.clone())
                    })
                };
                let Some(control) = control else {
                    break;
                };
                let _control = control.lock().unwrap();
                let mut locked = registry.0.lock().unwrap();
                let Some(session) = locked.sessions.get_mut(&id) else {
                    break;
                };
                if session.prompt_write_active {
                    continue;
                }
                if session.generation != generation
                    || !Arc::ptr_eq(&control, &session.control)
                    || session.metadata.state != "running"
                    || session.metadata.presentation != TerminalPresentation::Terminal
                    || session.attachment.as_ref().map(|item| item.lease.as_str())
                        != Some(lease.as_str())
                {
                    break;
                }
                if session.writer.lock().unwrap().write_all(&data).is_err() {
                    break;
                }
            }
            Ok((RESIZE, data)) if data.len() == 4 => {
                let cols = u16::from_be_bytes([data[0], data[1]]);
                let rows = u16::from_be_bytes([data[2], data[3]]);
                if cols == 0 || rows == 0 {
                    continue;
                }
                let mut locked = registry.0.lock().unwrap();
                let Some(session) = locked.sessions.get_mut(&id) else {
                    break;
                };
                if session.generation != generation
                    || session.metadata.state != "running"
                    || session.metadata.presentation != TerminalPresentation::Terminal
                    || session.attachment.as_ref().map(|item| item.lease.as_str())
                        != Some(lease.as_str())
                {
                    break;
                }
                if session
                    .master
                    .resize(PtySize {
                        rows,
                        cols,
                        pixel_width: 0,
                        pixel_height: 0,
                    })
                    .is_ok()
                {
                    session.metadata.cols = cols;
                    session.metadata.rows = rows;
                }
            }
            Ok((DETACH, _)) | Err(_) => break,
            Ok(_) => {}
        }
    }
    emit_reset_external_presentation(&registry, &app, &id, &generation, &lease);
}

#[cfg(target_os = "macos")]
fn reset_external_presentation(
    registry: &Arc<(Mutex<TerminalRegistry>, Condvar)>,
    id: &str,
    generation: &str,
    lease: &str,
) -> Option<TerminalSession> {
    {
        let mut locked = registry.0.lock().unwrap();
        locked.sessions.get_mut(id).and_then(|session| {
            if session.generation != generation {
                return None;
            }
            revoke_external_attachment(session, Some(lease)).then(|| session.metadata.clone())
        })
    }
}

#[cfg(target_os = "macos")]
fn emit_reset_external_presentation(
    registry: &Arc<(Mutex<TerminalRegistry>, Condvar)>,
    app: &AppHandle,
    id: &str,
    generation: &str,
    lease: &str,
) {
    if let Some(session) = reset_external_presentation(registry, id, generation, lease).as_ref() {
        emit_terminal_session(app, session);
    }
}

#[cfg(unix)]
fn cleanup_process_group_after_wait(pid: Option<u32>) -> bool {
    let Some(pid) = pid else {
        return true;
    };
    if !process_group_exists(pid) {
        return true;
    }
    signal_process_group(pid, libc::SIGKILL).is_ok()
        && wait_for_process_group_exit(pid, PROCESS_GROUP_EXIT_TIMEOUT)
}

#[cfg(not(unix))]
fn cleanup_process_group_after_wait(_pid: Option<u32>) -> bool {
    true
}

#[cfg(unix)]
fn signal_process_group(pid: u32, signal: libc::c_int) -> std::io::Result<()> {
    let result = unsafe { libc::kill(-(pid as libc::pid_t), signal) };
    if result == 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        Ok(())
    } else {
        Err(error)
    }
}

#[cfg(unix)]
fn process_group_exists(pid: u32) -> bool {
    let result = unsafe { libc::kill(-(pid as libc::pid_t), 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

#[cfg(unix)]
fn wait_for_process_group_exit(pid: u32, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while process_group_exists(pid) {
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    true
}

#[tauri::command]
pub async fn list_terminal_sessions(
    state: State<'_, AppState>,
) -> Result<Vec<TerminalSession>, String> {
    Ok(state.terminal_manager.list_sessions())
}

#[tauri::command]
pub async fn list_agent_transcripts(
    state: State<'_, AppState>,
    scope: Option<String>,
) -> Result<Vec<AgentTranscript>, String> {
    let config = state
        .config_store
        .load()
        .await
        .map_err(|error| error.to_string())?;
    let repo_path = config
        .selected_git_repository
        .as_ref()
        .and_then(|selected| {
            config
                .git_repositories
                .iter()
                .find(|repo| &repo.name == selected)
        })
        .or_else(|| config.git_repositories.first())
        .map(|repo| repo.active_worktree_path.clone().unwrap_or_else(|| repo.path.clone()))
        .unwrap_or(
            std::env::current_dir()
                .map_err(|error| error.to_string())?
                .to_string_lossy()
                .into_owned(),
        );
    let home = dirs::home_dir().ok_or_else(|| "Home directory is unavailable".to_string())?;
    let codex_home = std::env::var_os("CODEX_HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| home.join(".codex"));
    tauri::async_runtime::spawn_blocking(move || {
        read_agent_transcripts(
            &home,
            &codex_home,
            (scope.as_deref() != Some("all")).then_some(repo_path.as_str()),
            DEFAULT_TRANSCRIPT_LIMIT,
        )
    })
    .await
    .map_err(|error| error.to_string())
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
    let config = if is_agent || cwd.is_none() {
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
    let workspace_cwd = if is_agent || service_name.is_none() {
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
                .map(|repo| repo.active_worktree_path.clone().unwrap_or_else(|| repo.path.clone()))
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

    let (shell, args, label, kind, provider) = if let Some(request) = &agent {
        if request.resume_id.is_some() && request.one_time_skill.is_some() {
            return Err("A temporary skill cannot be attached to a resumed session.".into());
        }
        let context_prompt = if let Some(attachment) = &request.context {
            let library = ContextLibrary::default();
            let notes = library.notes()?;
            let configured = config
                .as_ref()
                .ok_or_else(|| "Agent configuration is unavailable.".to_string())?;
            let items = crate::commands::context::all_context_items(configured, &notes).await?;
            library.assemble_prompt(&request.prompt, attachment, &items)?
        } else {
            request.prompt.clone()
        };
        let prompt = if let Some(selection) = &request.one_time_skill {
            let skill_prompt = resolve_one_time_skill(selection).await?;
            compose_one_time_skill_prompt(&skill_prompt, &context_prompt)?
        } else {
            context_prompt
        };
        let claude_bin = agent_binary("NOMOREIDE_CLAUDE_BIN", "claude");
        let codex_bin = agent_binary("NOMOREIDE_CODEX_BIN", "codex");
        let invocation = derive_agent_invocation(
            &request.provider,
            &prompt,
            request.resume_id.as_deref(),
            &claude_bin,
            &codex_bin,
        )?;
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
        provider: provider.clone(),
        presentation: TerminalPresentation::Dock,
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
    // The app may itself be launched by a tool that sets NO_COLOR. Every PTY
    // rendered by xterm.js must advertise its actual capabilities, including
    // shells that launch Claude or Codex later.
    configure_interactive_terminal_environment(&mut cmd, provider.as_deref());
    // Finder-launched macOS apps inherit a minimal PATH. Other platforms keep
    // the environment copied by CommandBuilder unchanged.
    if let Some(path) = agent_path_override() {
        cmd.env("PATH", path);
    }

    let writer = Arc::new(Mutex::new(
        pair.master.take_writer().map_err(|e| e.to_string())?,
    ));
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    match state.terminal_manager.reserve_id(&id)? {
        IdReservation::Existing(existing) => return Ok(existing),
        IdReservation::Reserved => {}
    }
    // Complete every fallible PTY-handle setup step before reservation. If
    // spawn fails, release the reservation; otherwise the child is always
    // handed to the waiter below for reaping.
    let child = match pair.slave.spawn_command(cmd) {
        Ok(child) => child,
        Err(error) => {
            state.terminal_manager.release_reservation(&id);
            return Err(error.to_string());
        }
    };
    let generation = Uuid::new_v4().to_string();
    let pid = child.process_id();
    let killer = child.clone_killer();

    let gate = Arc::new(Mutex::new(OutputGate::default()));

    // Stream PTY output as Tauri events (buffering until the frontend attaches).
    let event_id = id.clone();
    let app_clone = app.clone();
    let reader_gate = gate.clone();
    #[cfg(target_os = "macos")]
    let reader_registry = state.terminal_manager.registry.clone();
    #[cfg(target_os = "macos")]
    let reader_generation = generation.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let mut g = reader_gate.lock().unwrap();
                    #[cfg(target_os = "macos")]
                    let external_failure = {
                        g.replay.extend(&buf[..n]);
                        while g.replay.len() > TERMINAL_REPLAY_BYTES {
                            g.replay.pop_front();
                        }
                        forward_external_output(&mut g, &buf[..n])
                    };
                    if g.streaming {
                        drop(g);
                        let data = String::from_utf8_lossy(&buf[..n]).into_owned();
                        let _ = app_clone.emit(&format!("terminal-output-{event_id}"), data);
                    } else {
                        g.pending.extend_from_slice(&buf[..n]);
                        drop(g);
                    }
                    #[cfg(target_os = "macos")]
                    if let Some(lease) = external_failure {
                        emit_reset_external_presentation(
                            &reader_registry,
                            &app_clone,
                            &event_id,
                            &reader_generation,
                            &lease,
                        );
                    }
                }
            }
        }
        #[cfg(target_os = "macos")]
        {
            let active_lease = {
                let mut gate = reader_gate.lock().unwrap();
                gate.closed = true;
                if let Some(sink) = gate.external.take() {
                    let lease = sink.lease.clone();
                    let _ = sink.sender.try_send(ExternalOutput::Revoked);
                    let _ = sink.revoke.shutdown(Shutdown::Both);
                    Some(lease)
                } else {
                    None
                }
            };
            let lease = active_lease.or_else(|| {
                let locked = reader_registry.0.lock().unwrap();
                locked.sessions.get(&event_id).and_then(|session| {
                    (session.generation == reader_generation)
                        .then(|| session.attachment.as_ref().map(|item| item.lease.clone()))
                        .flatten()
                })
            });
            if let Some(lease) = lease {
                emit_reset_external_presentation(
                    &reader_registry,
                    &app_clone,
                    &event_id,
                    &reader_generation,
                    &lease,
                );
            }
        }
    });

    let pty_session = PtySession {
        control: Arc::new(Mutex::new(())),
        prompt_write_active: false,
        generation: generation.clone(),
        pid,
        group_cleanup_complete: false,
        metadata: session.clone(),
        writer,
        killer,
        master: pair.master,
        gate,
        #[cfg(target_os = "macos")]
        attachment: None,
    };
    state
        .terminal_manager
        .complete_reservation(id.clone(), pty_session);
    state
        .terminal_manager
        .start_child_waiter(id, generation, child);

    Ok(session)
}

#[tauri::command]
pub async fn rename_terminal_session(
    state: State<'_, AppState>,
    id: String,
    label: String,
) -> Result<TerminalSession, String> {
    state
        .terminal_manager
        .rename_session(&id, normalize_session_label(&label)?)
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
        let registry = state.terminal_manager.registry.0.lock().unwrap();
        registry.sessions.get(&id).map(|s| s.gate.clone())
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
    let target = {
        let registry = state.terminal_manager.registry.0.lock().unwrap();
        registry
            .sessions
            .get(&id)
            .map(|session| (session.control.clone(), session.generation.clone()))
    };
    if let Some((control, generation)) = target {
        let _control = control.lock().unwrap();
        let registry = state.terminal_manager.registry.0.lock().unwrap();
        let Some(session) = registry.sessions.get(&id) else {
            return Ok(());
        };
        if session.generation != generation || !Arc::ptr_eq(&control, &session.control) {
            return Err(format!("Terminal session changed before input: {id}"));
        }
        if session.prompt_write_active {
            return Err("This agent session is receiving a prompt; retry shortly".to_string());
        }
        if session.metadata.presentation != TerminalPresentation::Dock {
            return Err("This terminal session is controlled by Terminal".to_string());
        }
        session
            .writer
            .lock()
            .unwrap()
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
    let mut registry = state.terminal_manager.registry.0.lock().unwrap();
    if let Some(session) = registry.sessions.get_mut(&id) {
        if session.metadata.presentation != TerminalPresentation::Dock {
            return Err("This terminal session is controlled by Terminal".to_string());
        }
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCapabilities {
    external_terminal: bool,
}

#[tauri::command]
pub async fn get_terminal_capabilities() -> TerminalCapabilities {
    TerminalCapabilities {
        external_terminal: cfg!(target_os = "macos"),
    }
}

#[tauri::command]
pub async fn open_terminal_in_system_terminal(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<TerminalSession, String> {
    state.terminal_manager.open_in_terminal(&app, &id)
}

#[tauri::command]
pub async fn reclaim_terminal_to_dock(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<TerminalSession, String> {
    state.terminal_manager.reclaim_to_dock(&app, &id)
}

#[tauri::command]
pub async fn insert_agent_prompt(
    state: State<'_, AppState>,
    id: String,
    prompt: String,
) -> Result<TerminalSession, String> {
    let manager = state.terminal_manager.clone();
    tauri::async_runtime::spawn_blocking(move || manager.insert_agent_prompt(&id, &prompt))
        .await
        .map_err(|error| error.to_string())?
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
        configure_interactive_terminal_environment, derive_agent_invocation,
        encode_agent_prompt_paste, normalize_agent_label, normalize_session_label,
        resolve_config_load, resolve_session_scope, validate_agent_prompt_target,
    };

    #[test]
    fn agent_prompt_paste_is_unsubmitted_and_rejects_terminal_controls() {
        assert_eq!(
            encode_agent_prompt_paste("Review this\r\nwithout submitting").unwrap(),
            "\u{1b}[200~Review this\rwithout submitting\u{1b}[201~"
        );
        assert!(encode_agent_prompt_paste("").is_err());
        assert!(encode_agent_prompt_paste("submit\r").is_err());
        assert!(encode_agent_prompt_paste("escape\u{1b}").is_err());
    }

    #[test]
    fn agent_prompt_target_allows_dock_and_terminal_but_not_launching() {
        let mut session = super::TerminalSession {
            id: "agent".to_string(),
            service_name: None,
            cwd: "/tmp".to_string(),
            cols: 120,
            rows: 40,
            shell: "codex".to_string(),
            state: "running".to_string(),
            label: None,
            kind: Some("agent".to_string()),
            provider: Some("codex".to_string()),
            presentation: super::TerminalPresentation::Dock,
        };
        assert!(validate_agent_prompt_target(&session).is_ok());
        session.presentation = super::TerminalPresentation::Terminal;
        assert!(validate_agent_prompt_target(&session).is_ok());
        session.presentation = super::TerminalPresentation::TerminalLaunching;
        assert!(validate_agent_prompt_target(&session).is_err());
        session.presentation = super::TerminalPresentation::Dock;
        session.kind = Some("shell".to_string());
        assert!(validate_agent_prompt_target(&session).is_err());
        session.kind = Some("agent".to_string());
        session.state = "exited".to_string();
        assert!(validate_agent_prompt_target(&session).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn manager_inserts_prompt_without_changing_session_ownership_or_size() {
        let manager = super::TerminalManager::new();
        spawn_test_session(&manager, "agent-prompt", "read line");
        {
            let mut registry = manager.registry.0.lock().unwrap();
            let session = registry.sessions.get_mut("agent-prompt").unwrap();
            session.metadata.kind = Some("agent".to_string());
            session.metadata.provider = Some("codex".to_string());
            session.metadata.presentation = super::TerminalPresentation::Terminal;
        }

        let inserted = manager
            .insert_agent_prompt("agent-prompt", "Review this\nwithout submitting")
            .unwrap();

        assert_eq!(inserted.presentation, super::TerminalPresentation::Terminal);
        assert_eq!((inserted.cols, inserted.rows), (80, 24));
        std::thread::sleep(std::time::Duration::from_millis(100));
    }

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

    #[test]
    fn interactive_terminal_enables_color_when_the_parent_suppresses_it() {
        let mut command = portable_pty::CommandBuilder::new("shell");
        command.env("NO_COLOR", "1");

        configure_interactive_terminal_environment(&mut command, None);

        assert!(command.get_env("NO_COLOR").is_none());
        assert_eq!(
            command.get_env("TERM"),
            Some(std::ffi::OsStr::new("xterm-256color"))
        );
        assert_eq!(
            command.get_env("COLORTERM"),
            Some(std::ffi::OsStr::new("truecolor"))
        );
    }

    #[test]
    fn embedded_codex_uses_palette_driven_ansi_colors() {
        let mut command = portable_pty::CommandBuilder::new("codex");
        command.env("FORCE_COLOR", "3");

        configure_interactive_terminal_environment(&mut command, Some("codex"));

        assert_eq!(
            command.get_env("FORCE_COLOR"),
            Some(std::ffi::OsStr::new("1"))
        );
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
        let generation = uuid::Uuid::new_v4().to_string();
        let killer = child.clone_killer();
        let writer = Arc::new(Mutex::new(pair.master.take_writer().unwrap()));
        let session = super::PtySession {
            control: Arc::new(Mutex::new(())),
            prompt_write_active: false,
            generation: generation.clone(),
            pid: Some(pid),
            group_cleanup_complete: false,
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
                presentation: super::TerminalPresentation::Dock,
            },
            writer,
            killer,
            master: pair.master,
            gate: Arc::new(Mutex::new(super::OutputGate::default())),
            #[cfg(target_os = "macos")]
            attachment: None,
        };
        manager
            .registry
            .0
            .lock()
            .unwrap()
            .sessions
            .insert(id.to_string(), session);
        manager.start_child_waiter(id.to_string(), generation, child);
        pid
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn external_presentation_transitions_are_lease_scoped_and_idempotent() {
        use std::io::Read;
        use std::os::unix::net::{UnixListener, UnixStream};
        use std::sync::mpsc::sync_channel;
        use std::sync::Arc;

        let manager = super::TerminalManager::new();
        spawn_test_session(&manager, "external-transition", "sleep 30");
        let path = super::new_socket_path();
        let _listener = UnixListener::bind(&path).unwrap();
        let (revoke, mut peer) = UnixStream::pair().unwrap();
        peer.set_read_timeout(Some(std::time::Duration::from_millis(100)))
            .unwrap();
        let (sender, _receiver) = sync_channel(1);
        {
            let mut registry = manager.registry.0.lock().unwrap();
            let session = registry.sessions.get_mut("external-transition").unwrap();
            session.metadata.kind = Some("agent".to_string());
            session.metadata.presentation = super::TerminalPresentation::Terminal;
            session.attachment = Some(super::ExternalAttachment {
                lease: "current".to_string(),
                socket_path: path.clone(),
                revoke: Some(revoke.try_clone().unwrap()),
            });
            session.gate.lock().unwrap().external = Some(super::ExternalOutputSink {
                lease: "current".to_string(),
                sender,
                revoke: Arc::new(revoke),
            });

            assert!(!super::revoke_external_attachment(session, Some("stale")));
            assert_eq!(
                session.metadata.presentation,
                super::TerminalPresentation::Terminal
            );
            assert!(super::revoke_external_attachment(session, Some("current")));
            assert_eq!(
                session.metadata.presentation,
                super::TerminalPresentation::Dock
            );
            assert!(!super::revoke_external_attachment(session, Some("current")));
        }

        let mut byte = [0u8; 1];
        assert_eq!(peer.read(&mut byte).unwrap(), 0);
        assert!(!path.exists());
        manager.close_session("external-transition").unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn output_overflow_and_disconnect_revoke_the_external_sink() {
        use std::os::unix::net::UnixStream;
        use std::sync::mpsc::sync_channel;
        use std::sync::Arc;

        for disconnected in [false, true] {
            let (revoke, _peer) = UnixStream::pair().unwrap();
            let (sender, receiver) = sync_channel(1);
            if disconnected {
                drop(receiver);
            } else {
                sender
                    .send(super::ExternalOutput::Replay(Vec::new()))
                    .unwrap();
            }
            let mut gate = super::OutputGate::default();
            gate.external = Some(super::ExternalOutputSink {
                lease: "overflow".to_string(),
                sender,
                revoke: Arc::new(revoke),
            });

            assert_eq!(
                super::forward_external_output(&mut gate, b"next"),
                Some("overflow".to_string())
            );
            assert!(gate.external.is_none());
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn closed_output_gate_rejects_a_new_external_launch() {
        let manager = super::TerminalManager::new();
        spawn_test_session(&manager, "closed-launch", "sleep 30");
        {
            let mut registry = manager.registry.0.lock().unwrap();
            let session = registry.sessions.get_mut("closed-launch").unwrap();
            session.metadata.kind = Some("agent".to_string());
            session.gate.lock().unwrap().closed = true;
            assert_eq!(
                super::validate_external_launch(session).unwrap_err(),
                "Only a running agent session can open in Terminal",
            );
        }
        manager.close_session("closed-launch").unwrap();
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
        manager.close_session("natural").unwrap();
        assert!(manager.list_sessions().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn stale_waiter_generation_cannot_mark_a_replacement_exited() {
        let manager = super::TerminalManager::new();
        spawn_test_session(&manager, "replacement", "sleep 30");

        manager.mark_child_state("replacement", "old-generation", "exited");

        let session = manager
            .list_sessions()
            .into_iter()
            .find(|session| session.id == "replacement")
            .unwrap();
        assert_eq!(session.state, "running");
        manager.close_session("replacement").unwrap();
    }

    #[test]
    fn stable_id_reservation_allows_only_one_concurrent_creator() {
        use std::sync::{Arc, Barrier};

        let manager = Arc::new(super::TerminalManager::new());
        let barrier = Arc::new(Barrier::new(3));
        let mut threads = Vec::new();
        for _ in 0..2 {
            let manager = manager.clone();
            let barrier = barrier.clone();
            threads.push(std::thread::spawn(move || {
                barrier.wait();
                manager.reserve_id("svc:api")
            }));
        }
        barrier.wait();
        let results: Vec<_> = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect();

        assert_eq!(
            results
                .iter()
                .filter(|result| matches!(result, Ok(super::IdReservation::Reserved)))
                .count(),
            1
        );
        assert_eq!(results.iter().filter(|result| result.is_err()).count(), 1);
    }

    #[test]
    fn close_during_reserved_creation_returns_an_error() {
        let manager = super::TerminalManager::new();
        assert!(matches!(
            manager.reserve_id("svc:api"),
            Ok(super::IdReservation::Reserved)
        ));

        let error = manager.close_session("svc:api").unwrap_err();

        assert!(error.contains("creation"));
        assert!(manager.reserve_id("svc:api").is_err());
        manager.release_reservation("svc:api");
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
    #[test]
    fn close_kills_sighup_resistant_child_and_descendant_process_group() {
        let manager = super::TerminalManager::new();
        let descendant_file = std::env::temp_dir().join(format!(
            "nomoreide-terminal-descendant-{}",
            uuid::Uuid::new_v4()
        ));
        let script = format!(
            "trap '' HUP; /bin/sh -c 'trap \"\" HUP; echo $$ > {}; exec sleep 30' & wait",
            descendant_file.to_string_lossy()
        );
        let parent_pid = spawn_test_session(&manager, "process-group", &script);
        let descendant_pid = (0..100)
            .find_map(|_| {
                let pid = std::fs::read_to_string(&descendant_file)
                    .ok()
                    .and_then(|value| value.trim().parse::<u32>().ok());
                if pid.is_none() {
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                pid
            })
            .expect("descendant pid should be written");
        assert!(process_exists(parent_pid));
        assert!(process_exists(descendant_pid));

        manager.close_session("process-group").unwrap();

        assert!(!process_exists(parent_pid));
        assert!(!process_exists(descendant_pid));
        let _ = std::fs::remove_file(descendant_file);
    }

    #[cfg(unix)]
    #[test]
    fn reserve_is_blocked_and_second_close_is_idempotent_while_closing() {
        use std::sync::Arc;

        let manager = Arc::new(super::TerminalManager::new());
        spawn_test_session(
            &manager,
            "svc:closing",
            "trap '' HUP; exec sleep 30",
        );
        std::thread::sleep(std::time::Duration::from_millis(50));
        let closer = {
            let manager = manager.clone();
            std::thread::spawn(move || manager.close_session("svc:closing"))
        };
        for _ in 0..100 {
            if manager
                .registry
                .0
                .lock()
                .unwrap()
                .closing
                .contains_key("svc:closing")
            {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }

        let reserve_error = manager.reserve_id("svc:closing").unwrap_err();
        assert!(reserve_error.contains("closing"));
        assert!(manager.close_session("svc:closing").is_ok());
        assert!(closer.join().unwrap().is_ok());
        assert!(manager.list_sessions().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn close_all_kills_and_reaps_every_session_and_descendant() {
        let manager = super::TerminalManager::new();
        let descendant_file = std::env::temp_dir().join(format!(
            "nomoreide-terminal-close-all-descendant-{}",
            uuid::Uuid::new_v4()
        ));
        let resistant_script = format!(
            "trap '' HUP; /bin/sh -c 'trap \"\" HUP; echo $$ > {}; exec sleep 30' & wait",
            descendant_file.to_string_lossy()
        );
        let resistant_pid = spawn_test_session(&manager, "resistant", &resistant_script);
        let ordinary_pid = spawn_test_session(&manager, "ordinary", "sleep 30");
        let descendant_pid = (0..100)
            .find_map(|_| {
                let pid = std::fs::read_to_string(&descendant_file)
                    .ok()
                    .and_then(|value| value.trim().parse::<u32>().ok());
                if pid.is_none() {
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                pid
            })
            .expect("descendant pid should be written");

        manager.close_all().unwrap();

        assert!(!process_exists(resistant_pid));
        assert!(!process_exists(ordinary_pid));
        assert!(!process_exists(descendant_pid));
        assert!(manager.list_sessions().is_empty());
        let _ = std::fs::remove_file(descendant_file);
    }

    #[cfg(unix)]
    #[test]
    fn waiter_cleans_live_descendant_before_reporting_leader_exited() {
        let manager = super::TerminalManager::new();
        let descendant_file = std::env::temp_dir().join(format!(
            "nomoreide-terminal-exited-leader-descendant-{}",
            uuid::Uuid::new_v4()
        ));
        let script = format!(
            "/bin/sh -c 'trap \"\" HUP; echo $$ > {}; exec sleep 30' & while [ ! -s {} ]; do sleep 0.01; done; exit 0",
            descendant_file.to_string_lossy(),
            descendant_file.to_string_lossy()
        );
        let leader_pid = spawn_test_session(&manager, "exited-leader", &script);
        let descendant_pid = (0..100)
            .find_map(|_| {
                let pid = std::fs::read_to_string(&descendant_file)
                    .ok()
                    .and_then(|value| value.trim().parse::<u32>().ok());
                if pid.is_none() {
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                pid
            })
            .expect("descendant pid should be written");
        for _ in 0..100 {
            let exited = manager
                .list_sessions()
                .into_iter()
                .find(|session| session.id == "exited-leader")
                .map(|session| session.state == "exited")
                .unwrap_or(false);
            if exited {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let session = manager
            .list_sessions()
            .into_iter()
            .find(|session| session.id == "exited-leader")
            .unwrap();
        assert_eq!(session.state, "exited");
        assert!(!process_exists(leader_pid));
        assert!(!process_exists(descendant_pid));
        std::thread::sleep(std::time::Duration::from_millis(50));

        assert!(manager.close_session("exited-leader").is_ok());
        assert!(manager.list_sessions().is_empty());
        let _ = std::fs::remove_file(descendant_file);
    }

    #[cfg(unix)]
    #[test]
    fn close_removes_cleanup_complete_session_without_touching_stored_pid() {
        let manager = super::TerminalManager::new();
        spawn_test_session(&manager, "stale-pid", "sleep 30");
        let mut test_killer = {
            let mut registry = manager.registry.0.lock().unwrap();
            let session = registry.sessions.get_mut("stale-pid").unwrap();
            let killer = session.killer.clone_killer();
            session.pid = Some(u32::MAX);
            session.metadata.state = "exited".to_string();
            session.group_cleanup_complete = true;
            killer
        };

        assert!(manager.close_session("stale-pid").is_ok());
        assert!(manager.list_sessions().is_empty());

        // The deliberately invalid stored PID above must never be inspected or
        // signaled. Clean up through the retained direct-child handle instead.
        let _ = test_killer.kill();
    }

    #[cfg(unix)]
    #[test]
    fn non_running_session_without_confirmed_group_cleanup_is_retained_without_signaling() {
        let manager = super::TerminalManager::new();
        let pid = spawn_test_session(&manager, "unsafe-terminal", "sleep 30");
        {
            let mut registry = manager.registry.0.lock().unwrap();
            let session = registry.sessions.get_mut("unsafe-terminal").unwrap();
            session.metadata.state = "error".to_string();
            session.group_cleanup_complete = false;
        }

        let error = manager.close_session("unsafe-terminal").unwrap_err();

        assert!(error.contains("cleanup"));
        assert!(process_exists(pid));
        assert!(manager
            .list_sessions()
            .iter()
            .any(|session| session.id == "unsafe-terminal"));
        {
            let mut registry = manager.registry.0.lock().unwrap();
            registry
                .sessions
                .get_mut("unsafe-terminal")
                .unwrap()
                .metadata
                .state = "running".to_string();
        }
        manager.close_session("unsafe-terminal").unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn close_all_waits_for_an_active_close_to_finish() {
        use std::sync::{mpsc, Arc};

        let manager = Arc::new(super::TerminalManager::new());
        let pid = spawn_test_session(
            &manager,
            "active-close",
            "trap '' HUP; exec sleep 30",
        );
        std::thread::sleep(std::time::Duration::from_millis(50));
        let closer = {
            let manager = manager.clone();
            std::thread::spawn(move || manager.close_session("active-close"))
        };
        for _ in 0..100 {
            if manager
                .registry
                .0
                .lock()
                .unwrap()
                .closing
                .contains_key("active-close")
            {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        let (tx, rx) = mpsc::channel();
        let shutdown = {
            let manager = manager.clone();
            std::thread::spawn(move || tx.send(manager.close_all()).unwrap())
        };

        assert!(rx
            .recv_timeout(std::time::Duration::from_millis(50))
            .is_err());
        assert!(closer.join().unwrap().is_ok());
        assert!(rx
            .recv_timeout(std::time::Duration::from_secs(3))
            .unwrap()
            .is_ok());
        shutdown.join().unwrap();
        assert!(!process_exists(pid));
        assert!(manager.list_sessions().is_empty());
    }

    #[test]
    fn close_all_waits_for_reservations_and_fences_future_creation() {
        use std::sync::{mpsc, Arc};

        let manager = Arc::new(super::TerminalManager::new());
        assert!(matches!(
            manager.reserve_id("svc:reserved"),
            Ok(super::IdReservation::Reserved)
        ));
        let (tx, rx) = mpsc::channel();
        let shutdown = {
            let manager = manager.clone();
            std::thread::spawn(move || tx.send(manager.close_all()).unwrap())
        };

        assert!(rx
            .recv_timeout(std::time::Duration::from_millis(50))
            .is_err());
        manager.release_reservation("svc:reserved");
        assert!(rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap()
            .is_ok());
        shutdown.join().unwrap();
        let error = manager.reserve_id("svc:later").unwrap_err();
        assert!(error.contains("shutting down"));
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
    fn claude_invocation_passes_the_prompt_as_a_positional_argument() {
        let prompt = "  inspect this project\nthen explain it  ";

        let invocation =
            derive_agent_invocation("claude", prompt, None, "claude", "codex").unwrap();

        assert_eq!(invocation.executable, "claude");
        assert_eq!(invocation.args, vec![prompt]);
    }

    #[test]
    fn codex_invocation_disables_alt_screen_and_passes_the_prompt() {
        let prompt = "  inspect this project\nthen explain it  ";

        let invocation = derive_agent_invocation("codex", prompt, None, "claude", "codex").unwrap();

        assert_eq!(invocation.executable, "codex");
        assert_eq!(invocation.args, vec!["--no-alt-screen", prompt]);
    }

    #[test]
    fn blank_agent_prompt_opens_an_interactive_session() {
        let claude = derive_agent_invocation("claude", " \n\t ", None, "claude", "codex").unwrap();
        let codex = derive_agent_invocation("codex", "", None, "claude", "codex").unwrap();

        assert!(claude.args.is_empty());
        assert_eq!(codex.args, vec!["--no-alt-screen"]);
    }

    #[test]
    fn unknown_agent_provider_is_rejected() {
        let error =
            derive_agent_invocation("other", "do work", None, "claude", "codex").unwrap_err();

        assert_eq!(error, "Unsupported agent provider: other");
    }

    #[test]
    fn agent_invocation_uses_resolved_executable_overrides() {
        let claude = derive_agent_invocation(
            "claude",
            "do work",
            None,
            "/custom/bin/claude",
            "/custom/bin/codex",
        )
        .unwrap();
        let codex = derive_agent_invocation(
            "codex",
            "do work",
            None,
            "/custom/bin/claude",
            "/custom/bin/codex",
        )
        .unwrap();

        assert_eq!(claude.executable, "/custom/bin/claude");
        assert_eq!(codex.executable, "/custom/bin/codex");
    }

    #[test]
    fn agent_invocation_resumes_provider_sessions_without_a_prompt() {
        let id = "dce2b69c-0fb4-4bd3-b456-b2bef4230c81";
        let claude = derive_agent_invocation("claude", "", Some(id), "claude", "codex").unwrap();
        let codex = derive_agent_invocation("codex", "", Some(id), "claude", "codex").unwrap();

        assert_eq!(claude.args, vec!["--resume", id]);
        assert_eq!(codex.args, vec!["--no-alt-screen", "resume", id]);
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

    #[test]
    fn session_rename_requires_a_trimmed_label_within_sixty_characters() {
        assert_eq!(
            normalize_session_label("  Build watcher  ").unwrap(),
            "Build watcher"
        );
        assert!(normalize_session_label(" \t ").is_err());
        assert!(normalize_session_label(&"A".repeat(61)).is_err());
        assert!(normalize_session_label(&"😀".repeat(30)).is_ok());
        assert!(normalize_session_label(&"😀".repeat(31)).is_err());
    }

    #[test]
    fn session_rename_rejects_closing_and_shutting_down_managers() {
        let manager = super::TerminalManager::new();
        {
            let mut registry = manager.registry.0.lock().unwrap();
            registry
                .closing
                .insert("term_closing".to_string(), "generation".to_string());
        }
        assert!(manager
            .rename_session("term_closing", "Renamed".to_string())
            .unwrap_err()
            .contains("closing"));

        {
            let mut registry = manager.registry.0.lock().unwrap();
            registry.closing.clear();
            registry.shutting_down = true;
        }
        assert!(manager
            .rename_session("term_missing", "Renamed".to_string())
            .unwrap_err()
            .contains("shutting down"));
    }
}
