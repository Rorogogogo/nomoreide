//! Creating a session: what it runs, where, and under which id.
//!
//! The PTY handles are all opened before the id is reserved, so a failure while
//! setting them up leaves the registry untouched. Once the child exists it is
//! always handed to the waiter, which is what reaps it.

use super::agent::{agent_path_override, default_terminal_shell};
use super::manager::{IdReservation, PtySession, TerminalManager};
use super::session::{
    configure_interactive_terminal_environment, TerminalPresentation, TerminalSession,
};
use crate::event_sink::{emit_event, SharedEventSink};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::ffi::OsString;
use std::io::Read;
use std::sync::{Arc, Mutex};
use uuid::Uuid;

#[cfg(target_os = "macos")]
use super::external::{
    emit_reset_external_presentation, forward_external_output, ExternalOutput,
    TERMINAL_REPLAY_BYTES,
};
#[cfg(target_os = "macos")]
use std::net::Shutdown;

/// Everything a caller decides about a session before the PTY exists. The
/// manager owns the spawn; the caller owns the policy — which repository a
/// shell opens in, what an agent's argv is, what the tab is called.
pub struct TerminalSpawnSpec {
    pub id: String,
    pub service_name: Option<String>,
    pub cwd: String,
    pub shell: OsString,
    pub args: Vec<String>,
    /// Assignments layered over the inherited environment, in the order the
    /// caller listed them. A pair rather than a map: a service's `env` is the
    /// user's own data and the order they wrote it in is what a spawned argv
    /// should reproduce.
    pub env: Vec<(String, String)>,
    pub label: Option<String>,
    pub kind: Option<String>,
    pub provider: Option<String>,
}

impl TerminalSpawnSpec {
    /// A plain interactive shell, which is what the `+` tab opens.
    pub fn shell(id: String, cwd: String) -> Self {
        Self {
            id,
            service_name: None,
            cwd,
            shell: default_terminal_shell(),
            args: Vec::new(),
            env: Vec::new(),
            label: None,
            kind: Some("shell".to_string()),
            provider: None,
        }
    }
}

impl TerminalManager {
    /// Spawn a session, or hand back the one already holding this id.
    ///
    /// Returning the existing session rather than refusing is what makes a
    /// stable id (`svc:<name>`) reattach on reopen instead of spawning a
    /// duplicate shell beside the first.
    pub fn create(
        &self,
        sink: SharedEventSink,
        spec: TerminalSpawnSpec,
    ) -> Result<TerminalSession, String> {
        let TerminalSpawnSpec {
            id,
            service_name,
            cwd,
            shell,
            args,
            env,
            label,
            kind,
            provider,
        } = spec;

        let session = TerminalSession {
            id: id.clone(),
            service_name,
            cwd: cwd.clone(),
            cols: 80,
            rows: 24,
            shell: shell.to_string_lossy().into_owned(),
            state: "running".to_string(),
            label,
            kind,
            provider: provider.clone(),
            exit: None,
            error: None,
            presentation: TerminalPresentation::Dock,
        };

        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| error.to_string())?;

        let mut command = CommandBuilder::new(&shell);
        command.args(&args);
        command.cwd(&cwd);
        // Whatever launched this process may itself have set NO_COLOR. Every
        // PTY has to advertise its own capabilities, including shells that go
        // on to launch Claude or Codex.
        configure_interactive_terminal_environment(&mut command, provider.as_deref());
        // A Finder-launched macOS app inherits a minimal PATH. Elsewhere the
        // environment CommandBuilder copied stands.
        if let Some(path) = agent_path_override() {
            command.env("PATH", path);
        }
        // The service's own assignments land last so they win over both the
        // inherited environment and the interactive defaults above.
        for (key, value) in &env {
            command.env(key, value);
        }

        let writer = Arc::new(Mutex::new(
            pair.master.take_writer().map_err(|e| e.to_string())?,
        ));
        let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

        match self.reserve_id(&id)? {
            IdReservation::Existing(existing) => return Ok(*existing),
            IdReservation::Reserved => {}
        }
        let child = match pair.slave.spawn_command(command) {
            Ok(child) => child,
            Err(error) => {
                self.release_reservation(&id);
                return Err(error.to_string());
            }
        };
        let generation = Uuid::new_v4().to_string();
        let pid = child.process_id();
        let killer = child.clone_killer();
        let gate = Arc::new(Mutex::new(super::manager::OutputGate::default()));

        self.start_output_reader(
            Arc::clone(&sink),
            id.clone(),
            generation.clone(),
            gate.clone(),
            reader,
        );

        self.complete_reservation(
            id.clone(),
            PtySession {
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
            },
        );
        self.start_child_waiter(id, generation, child);
        Ok(session)
    }
}

impl TerminalManager {
    /// Pump PTY output into events, buffering until a client attaches.
    ///
    /// The shell prints its prompt within milliseconds of spawning — well
    /// before a listener is in place — so without the gate the first prompt is
    /// lost and the terminal looks dead until the user presses Enter.
    fn start_output_reader(
        &self,
        sink: SharedEventSink,
        id: String,
        generation: String,
        gate: Arc<Mutex<super::manager::OutputGate>>,
        mut reader: Box<dyn Read + Send>,
    ) {
        #[cfg(target_os = "macos")]
        let registry = self.registry.clone();
        #[cfg(not(target_os = "macos"))]
        let _ = &generation;
        std::thread::spawn(move || {
            let mut buffer = [0u8; 4096];
            loop {
                let read = match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(read) => read,
                };
                let mut locked = gate.lock().unwrap();
                #[cfg(target_os = "macos")]
                let external_failure = {
                    locked.replay.extend(&buffer[..read]);
                    while locked.replay.len() > TERMINAL_REPLAY_BYTES {
                        locked.replay.pop_front();
                    }
                    forward_external_output(&mut locked, &buffer[..read])
                };
                if locked.streaming {
                    drop(locked);
                    let data = String::from_utf8_lossy(&buffer[..read]).into_owned();
                    let _ = emit_event(sink.as_ref(), &format!("terminal-output-{id}"), data);
                } else {
                    locked.pending.extend_from_slice(&buffer[..read]);
                    drop(locked);
                }
                #[cfg(target_os = "macos")]
                if let Some(lease) = external_failure {
                    emit_reset_external_presentation(
                        &registry,
                        sink.as_ref(),
                        &id,
                        &generation,
                        &lease,
                    );
                }
            }
            #[cfg(target_os = "macos")]
            {
                let active = {
                    let mut locked = gate.lock().unwrap();
                    locked.closed = true;
                    locked.external.take().map(|sink| {
                        let lease = sink.lease.clone();
                        let _ = sink.sender.try_send(ExternalOutput::Revoked);
                        let _ = sink.revoke.shutdown(Shutdown::Both);
                        lease
                    })
                };
                let lease = active.or_else(|| {
                    let locked = registry.0.lock().unwrap();
                    locked.sessions.get(&id).and_then(|session| {
                        (session.generation == generation)
                            .then(|| {
                                session
                                    .attachment
                                    .as_ref()
                                    .map(|attachment| attachment.lease.clone())
                            })
                            .flatten()
                    })
                });
                if let Some(lease) = lease {
                    emit_reset_external_presentation(
                        &registry,
                        sink.as_ref(),
                        &id,
                        &generation,
                        &lease,
                    );
                }
            }
        });
    }
}
