//! The registry of live PTY sessions and their lifecycle.
//!
//! A session is identified by its id and, within that id, by a *generation* —
//! a fresh uuid per spawn. Every mutation checks the generation it started
//! from, so a reader thread or a waiter belonging to a replaced session can
//! never publish state over its successor.

use super::session::{
    encode_agent_prompt_paste, validate_agent_prompt_target, TerminalPresentation, TerminalSession,
};
use crate::event_sink::{emit_event, EventSink, SharedEventSink};
use portable_pty::{Child, ChildKiller};
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

#[cfg(target_os = "macos")]
use super::external::{
    reset_external_presentation, revoke_external_attachment, run_external_listener,
    validate_external_launch, ExternalAttachment, ExternalOutputSink,
};
#[cfg(target_os = "macos")]
use crate::external_terminal::{
    external_terminal_title, launch_terminal, new_socket_path, SocketPathGuard,
};
#[cfg(target_os = "macos")]
use std::collections::VecDeque;
#[cfg(target_os = "macos")]
use uuid::Uuid;

/// How long a process group is given to disappear after its leader is killed.
#[cfg(unix)]
const PROCESS_GROUP_EXIT_TIMEOUT: Duration = Duration::from_secs(5);
/// How long the waiter is given to publish the exited state once the group has
/// been signalled. The waiter confirms every descendant is gone before it
/// publishes, which is what can take seconds.
#[cfg(unix)]
const TERMINAL_CLEANUP_CONFIRM_TIMEOUT: Duration = Duration::from_secs(6);

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

/// Gates PTY output behind the frontend attaching its event listener. The shell
/// prints its prompt within milliseconds of spawning — well before the async
/// `listen()` on the JS side resolves — so without this the first prompt is lost
/// and the terminal looks dead until the user presses Enter. Output is buffered
/// until `start_terminal_stream` flushes it and switches to live emission.
#[derive(Default)]
pub(super) struct OutputGate {
    pub(super) pending: Vec<u8>,
    pub(super) streaming: bool,
    #[cfg(target_os = "macos")]
    pub(super) replay: VecDeque<u8>,
    #[cfg(target_os = "macos")]
    pub(super) external: Option<ExternalOutputSink>,
    #[cfg(target_os = "macos")]
    pub(super) closed: bool,
}

pub(super) struct PtySession {
    pub(super) control: Arc<Mutex<()>>,
    pub(super) prompt_write_active: bool,
    pub(super) generation: String,
    pub(super) pid: Option<u32>,
    pub(super) group_cleanup_complete: bool,
    pub(super) metadata: TerminalSession,
    pub(super) writer: Arc<Mutex<Box<dyn std::io::Write + Send>>>,
    pub(super) killer: Box<dyn ChildKiller + Send + Sync>,
    #[allow(dead_code)]
    pub(super) master: Box<dyn portable_pty::MasterPty + Send>,
    pub(super) gate: Arc<Mutex<OutputGate>>,
    #[cfg(target_os = "macos")]
    pub(super) attachment: Option<ExternalAttachment>,
}

#[derive(Default)]
pub(super) struct TerminalRegistry {
    pub(super) sessions: HashMap<String, PtySession>,
    /// Ids in the order they were first created.
    ///
    /// The map behind them has no order of its own, and a tab strip that
    /// reshuffled on every read would be unusable — so the order a caller sees
    /// is recorded rather than derived. It is also what makes two runs of the
    /// same sequence comparable.
    pub(super) order: Vec<String>,
    pub(super) creating: HashSet<String>,
    pub(super) closing: HashMap<String, String>,
    pub(super) shutting_down: bool,
}

impl TerminalRegistry {
    /// The one way a session enters the registry, so `order` cannot be
    /// bypassed: a session recorded in the map but not in the order would be
    /// live and invisible.
    pub(super) fn insert(&mut self, id: String, session: PtySession) {
        if !self.sessions.contains_key(&id) {
            self.order.push(id.clone());
        }
        self.sessions.insert(id, session);
    }

    /// The one way it leaves.
    pub(super) fn remove(&mut self, id: &str) -> Option<PtySession> {
        self.order.retain(|recorded| recorded != id);
        self.sessions.remove(id)
    }
}

#[derive(Debug)]
pub(super) enum IdReservation {
    Existing(TerminalSession),
    Reserved,
}

#[derive(Clone)]
pub struct TerminalManager {
    pub(super) registry: Arc<(Mutex<TerminalRegistry>, Condvar)>,
}

impl Default for TerminalManager {
    fn default() -> Self {
        Self::new()
    }
}

impl TerminalManager {
    pub fn new() -> Self {
        TerminalManager {
            registry: Arc::new((Mutex::new(TerminalRegistry::default()), Condvar::new())),
        }
    }

    /// Every live session, oldest first.
    pub fn list_sessions(&self) -> Vec<TerminalSession> {
        let registry = self.registry.0.lock().unwrap();
        registry
            .order
            .iter()
            .filter_map(|id| registry.sessions.get(id))
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
    pub fn open_in_terminal(
        &self,
        sink: SharedEventSink,
        id: &str,
    ) -> Result<TerminalSession, String> {
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
            if session.generation != control_generation || !Arc::ptr_eq(&control, &session.control)
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
            if session.generation != control_generation || !Arc::ptr_eq(&control, &session.control)
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
        emit_terminal_session(sink.as_ref(), &snapshot);

        let registry = self.registry.clone();
        let listener_sink = Arc::clone(&sink);
        let id_owned = id.to_string();
        let token_owned = token.clone();
        let socket_owned = socket_path.clone();
        let lease_owned = lease.clone();
        let listener_generation = generation.clone();
        std::thread::spawn(move || {
            run_external_listener(
                registry,
                listener_sink,
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
                emit_terminal_session(sink.as_ref(), session);
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
    pub fn open_in_terminal(
        &self,
        _sink: SharedEventSink,
        _id: &str,
    ) -> Result<TerminalSession, String> {
        Err("External Terminal is currently available on macOS only".to_string())
    }

    pub fn reclaim_to_dock(
        &self,
        sink: &dyn EventSink,
        id: &str,
    ) -> Result<TerminalSession, String> {
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
            if session.generation != control_generation || !Arc::ptr_eq(&control, &session.control)
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
        emit_terminal_session(sink, &snapshot);
        Ok(snapshot)
    }

    pub fn insert_agent_prompt(&self, id: &str, prompt: &str) -> Result<TerminalSession, String> {
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
            if session.generation != control_generation || !Arc::ptr_eq(&control, &session.control)
            {
                return Err(format!(
                    "Terminal session changed while inserting a prompt: {id}"
                ));
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

    pub fn rename_session(&self, id: &str, label: String) -> Result<TerminalSession, String> {
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

    pub(super) fn reserve_id(&self, id: &str) -> Result<IdReservation, String> {
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

    pub(super) fn release_reservation(&self, id: &str) {
        let mut registry = self.registry.0.lock().unwrap();
        registry.creating.remove(id);
        self.registry.1.notify_all();
    }

    pub(super) fn complete_reservation(&self, id: String, session: PtySession) {
        let mut registry = self.registry.0.lock().unwrap();
        registry.creating.remove(&id);
        registry.insert(id, session);
        self.registry.1.notify_all();
    }

    pub(super) fn start_child_waiter(
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
    pub(super) fn mark_child_state(&self, id: &str, generation: &str, state: &str) {
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
            registry.remove(id);
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

    pub fn close_session(&self, id: &str) -> Result<(), String> {
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
            if session.generation != control_generation || !Arc::ptr_eq(&control, &session.control)
            {
                return Err(format!("Terminal session changed while closing: {id}"));
            }
            #[cfg(target_os = "macos")]
            revoke_external_attachment(session, None);
            if session.metadata.state != "running" {
                if session.group_cleanup_complete {
                    registry.remove(id);
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

pub(super) fn emit_terminal_session(sink: &dyn EventSink, session: &TerminalSession) {
    let _ = emit_event(sink, "terminal-session-changed", session);
}

/// The dock's side of a live session: what it draws, what it types, how big it
/// is. Each one refuses a session whose presentation has moved to an external
/// terminal — the PTY has one controller at a time, and while Terminal.app
/// holds it the dock is a spectator.
impl TerminalManager {
    /// Hand back whatever the session printed before anyone was listening, and
    /// switch it to live emission.
    ///
    /// The shell prints its prompt within milliseconds of spawning — well
    /// before a listener is in place — so without this the first prompt is lost
    /// and the terminal looks dead until the user presses Enter. The buffer is
    /// taken under the gate lock so it cannot interleave behind output the
    /// reader thread is about to emit.
    pub fn take_pending_output(&self, id: &str) -> Option<Vec<u8>> {
        let gate = {
            let registry = self.registry.0.lock().unwrap();
            registry
                .sessions
                .get(id)
                .map(|session| session.gate.clone())
        }?;
        let mut gate = gate.lock().unwrap();
        let pending = std::mem::take(&mut gate.pending);
        gate.streaming = true;
        Some(pending)
    }

    /// Type into a session from the dock.
    ///
    /// An unknown id is silently accepted: a keystroke arriving just after a
    /// tab closed is a race, not an error worth showing anyone.
    pub fn write_input(&self, id: &str, data: &[u8]) -> Result<(), String> {
        let Some((control, control_generation)) = ({
            let registry = self.registry.0.lock().unwrap();
            registry
                .sessions
                .get(id)
                .map(|session| (session.control.clone(), session.generation.clone()))
        }) else {
            return Ok(());
        };
        let _control = control.lock().unwrap();
        let writer = {
            let registry = self.registry.0.lock().unwrap();
            let Some(session) = registry.sessions.get(id) else {
                return Ok(());
            };
            if session.generation != control_generation || !Arc::ptr_eq(&control, &session.control)
            {
                return Err(format!("Terminal session changed before input: {id}"));
            }
            if session.prompt_write_active {
                return Err("This agent session is receiving a prompt; retry shortly".to_string());
            }
            if session.metadata.presentation != TerminalPresentation::Dock {
                return Err("This terminal session is controlled by Terminal".to_string());
            }
            session.writer.clone()
        };
        let result = writer
            .lock()
            .unwrap()
            .write_all(data)
            .map_err(|error| error.to_string());
        result
    }

    /// Resize a session's PTY to the dock's viewport.
    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let mut registry = self.registry.0.lock().unwrap();
        let Some(session) = registry.sessions.get_mut(id) else {
            return Ok(());
        };
        if session.metadata.presentation != TerminalPresentation::Dock {
            return Err("This terminal session is controlled by Terminal".to_string());
        }
        session
            .master
            .resize(portable_pty::PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| error.to_string())?;
        session.metadata.cols = cols;
        session.metadata.rows = rows;
        Ok(())
    }
}
