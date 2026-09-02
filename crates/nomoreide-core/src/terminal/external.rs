//! Presenting a running agent session in macOS Terminal.app, and taking it
//! back.
//!
//! The PTY never moves. A one-use Unix socket relays its output to the external
//! terminal and its keystrokes back, under a lease: everything here is scoped
//! to that lease so a stale attachment can never reset a presentation the next
//! one established.

use super::manager::{emit_terminal_session, OutputGate, PtySession, TerminalRegistry};
use super::session::{TerminalPresentation, TerminalSession};
use crate::event_sink::{EventSink, SharedEventSink};
use crate::external_terminal::{
    accept_authenticated, read_frame, write_frame, SocketPathGuard, ATTACHED, DETACH, INPUT,
    OUTPUT, RESIZE, REVOKED,
};
use portable_pty::PtySize;
use std::net::Shutdown;
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::sync::mpsc::{sync_channel, SyncSender, TrySendError};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

#[derive(Clone)]
pub(super) struct ExternalOutputSink {
    pub(super) lease: String,
    pub(super) sender: SyncSender<ExternalOutput>,
    pub(super) revoke: Arc<UnixStream>,
}

pub(super) enum ExternalOutput {
    Replay(Vec<u8>),
    Data(Vec<u8>),
    Revoked,
}

pub(super) fn forward_external_output(gate: &mut OutputGate, data: &[u8]) -> Option<String> {
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

pub(super) struct ExternalAttachment {
    pub(super) lease: String,
    pub(super) socket_path: PathBuf,
    pub(super) revoke: Option<UnixStream>,
}

pub(super) fn validate_external_launch(session: &PtySession) -> Result<(), String> {
    if session.metadata.kind.as_deref() != Some("agent") {
        return Err("Only agent sessions can open in Terminal.".to_string());
    }
    if session.metadata.state != "running" || session.gate.lock().unwrap().closed {
        return Err("Only a running agent session can open in Terminal.".to_string());
    }
    if session.metadata.presentation != TerminalPresentation::Dock || session.attachment.is_some() {
        return Err("This agent session is already opening or active in Terminal.".to_string());
    }
    if session.prompt_write_active {
        return Err("This agent session is receiving a prompt; retry shortly".to_string());
    }
    Ok(())
}

pub(super) fn revoke_external_attachment(
    session: &mut PtySession,
    expected_lease: Option<&str>,
) -> bool {
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

#[allow(clippy::too_many_arguments)]
pub(super) fn run_external_listener(
    registry: Arc<(Mutex<TerminalRegistry>, Condvar)>,
    sink: SharedEventSink,
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
        emit_reset_external_presentation(&registry, sink.as_ref(), &id, &generation, &lease);
        return;
    };

    let (sender, receiver) = sync_channel::<ExternalOutput>(128);
    let writer_stream = match stream.try_clone() {
        Ok(clone) => clone,
        Err(_) => {
            emit_reset_external_presentation(&registry, sink.as_ref(), &id, &generation, &lease);
            return;
        }
    };
    let revoke = Arc::new(match stream.try_clone() {
        Ok(clone) => clone,
        Err(_) => {
            emit_reset_external_presentation(&registry, sink.as_ref(), &id, &generation, &lease);
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
            emit_reset_external_presentation(&registry, sink.as_ref(), &id, &generation, &lease);
            return;
        }
        let mut gate = session.gate.lock().unwrap();
        if gate.closed {
            drop(gate);
            drop(locked);
            emit_reset_external_presentation(&registry, sink.as_ref(), &id, &generation, &lease);
            return;
        }
        let replay: Vec<u8> = gate.replay.iter().copied().collect();
        if sender.send(ExternalOutput::Replay(replay)).is_err() {
            drop(gate);
            drop(locked);
            emit_reset_external_presentation(&registry, sink.as_ref(), &id, &generation, &lease);
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
    emit_terminal_session(sink.as_ref(), &snapshot);

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
    emit_reset_external_presentation(&registry, sink.as_ref(), &id, &generation, &lease);
}

pub(super) fn reset_external_presentation(
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

pub(super) fn emit_reset_external_presentation(
    registry: &Arc<(Mutex<TerminalRegistry>, Condvar)>,
    sink: &dyn EventSink,
    id: &str,
    generation: &str,
    lease: &str,
) {
    if let Some(session) = reset_external_presentation(registry, id, generation, lease).as_ref() {
        emit_terminal_session(sink, session);
    }
}
