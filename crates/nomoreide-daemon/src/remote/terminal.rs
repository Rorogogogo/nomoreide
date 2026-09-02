//! Mirroring an agent terminal to a phone.
//!
//! **The one place the dispatcher does not route through the router.** Every
//! other command resolves to a method and a path on the daemon's own axum
//! router, called in-process with `oneshot` — that is the rule this module
//! documents an exception to, so it is worth saying why rather than leaving it
//! to be discovered.
//!
//! A mirror is not a request and an answer. It is a byte stream in both
//! directions, and the router's representation of it is a **websocket
//! upgrade**, which `oneshot` cannot perform: there is no socket to hijack when
//! the request never came from one. The alternatives were worse than the
//! exception — a loopback connection to the daemon's own port would reintroduce
//! the network hop the in-process call exists to avoid, and a second HTTP shape
//! invented for this would be the duplicate surface the whole design is against.
//!
//! So this holds a [`TerminalManager`] directly. What it must not do — and does
//! not — is become a general back door: the only operations here are the four
//! the protocol defines, and the agent-only rule they enforce lives on the
//! manager, beside the sessions, so the listing and the attach cannot disagree.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use nomoreide_core::remote::connector::EventSender;
use nomoreide_core::remote::protocol::device_bound::{
    TerminalAttachRequest, TerminalDetach, TerminalInput, TerminalResize, TerminalSpawnRequest,
};
use nomoreide_core::remote::protocol::errors::{ErrorCode, ProtocolError};
use nomoreide_core::remote::protocol::limits;
use nomoreide_core::remote::protocol::platform_bound::{
    TerminalAck, TerminalAttachAccepted, TerminalCloseReason, TerminalClosed, TerminalOutput,
    TerminalSessionsResponse, TerminalSpawned,
};
use nomoreide_core::remote::protocol::snapshot::RemoteTerminalSession;
use nomoreide_core::remote::protocol::PlatformBound;
use nomoreide_core::remote::protocol::TerminalBytes;
use nomoreide_core::terminal::TerminalManager;
use tokio::sync::broadcast::error::RecvError;

/// The mirrors this device has open.
#[derive(Clone, Default)]
pub(crate) struct Mirrors {
    open: Arc<Mutex<HashMap<String, Mirror>>>,
}

struct Mirror {
    session_id: String,
    /// Ends the pump. Dropping it is how a detach, a revocation or a replaced
    /// socket stops the stream — the pump selects on it, so there is no path
    /// where a mirror outlives the session that owns it.
    _cancel: tokio::sync::oneshot::Sender<()>,
}

impl Mirrors {
    /// Begin mirroring one agent terminal.
    pub(crate) fn attach(
        &self,
        terminal: &TerminalManager,
        request: &TerminalAttachRequest,
        events: EventSender,
    ) -> Result<PlatformBound, ProtocolError> {
        // The gate. A shell session is arbitrary command execution, which is
        // the one thing remote control promises it cannot reach, and a session
        // whose child has exited has nothing to mirror.
        if !terminal.is_mirrorable(&request.session_id) {
            return Err(ProtocolError::new(
                ErrorCode::CapabilityUnavailable,
                "That is not an agent terminal this machine will mirror.",
            )
            .with_detail(request.session_id.clone()));
        }

        let mut open = self.open.lock().unwrap();
        if open.len() >= limits::MAX_TERMINAL_STREAMS {
            return Err(ProtocolError::new(
                ErrorCode::CapabilityUnavailable,
                "Too many terminals are already mirrored from this machine.",
            ));
        }

        // **The mirror does not resize.** A PTY has exactly one size, and this
        // session is very likely also on somebody's screen at their desk — the
        // dock and the phone are looking at the same child. Setting it to a
        // phone's viewport would reflow a terminal being worked in, and a TUI
        // re-laying itself out to 40 columns under your hands is worse than a
        // phone that has to scroll. So the requested `cols`/`rows` are read as
        // what the phone *can* draw, and the answer tells it what it *will* be
        // drawing instead.
        let (cols, rows) = terminal
            .session_size(&request.session_id)
            .unwrap_or((80, 24));

        let Some((replay, updates)) = terminal.mirror_output(&request.session_id) else {
            return Err(ProtocolError::new(
                ErrorCode::CapabilityUnavailable,
                "That terminal is no longer running.",
            )
            .with_detail(request.session_id.clone()));
        };

        let stream_id = format!("stream_{}", uuid::Uuid::new_v4());
        let (cancel, cancelled) = tokio::sync::oneshot::channel();
        open.insert(
            stream_id.clone(),
            Mirror {
                session_id: request.session_id.clone(),
                _cancel: cancel,
            },
        );
        drop(open);

        tokio::spawn(pump(
            stream_id.clone(),
            replay,
            updates,
            cancelled,
            events,
            self.clone(),
        ));

        Ok(PlatformBound::TerminalAttachAccepted(
            TerminalAttachAccepted {
                stream_id,
                session_id: request.session_id.clone(),
                cols,
                rows,
            },
        ))
    }

    /// Type into a mirrored terminal.
    pub(crate) fn input(
        &self,
        terminal: &TerminalManager,
        request: &TerminalInput,
    ) -> Result<PlatformBound, ProtocolError> {
        if request.data.len() > limits::MAX_TERMINAL_INPUT_BYTES {
            return Err(ProtocolError::new(
                ErrorCode::MalformedFrame,
                "That is more input than one frame may carry.",
            ));
        }
        let session_id = self.session_for(&request.stream_id)?;
        terminal
            .write_input(&session_id, request.data.as_slice())
            .map_err(|reason| {
                ProtocolError::new(ErrorCode::CapabilityUnavailable, "That terminal is gone.")
                    .with_detail(reason)
            })?;
        Ok(PlatformBound::TerminalAck(TerminalAck {
            stream_id: request.stream_id.clone(),
        }))
    }

    /// Answer a viewport change with the geometry that is actually in use.
    ///
    /// Deliberately **not** a resize, for the reason [`Self::attach`] gives: the
    /// PTY is shared with whatever is rendering it locally. Turning a phone
    /// rotation into a reflow of somebody's desk terminal is not a feature. The
    /// frame is answered rather than refused because a viewer is entitled to
    /// ask what size it should be drawing at, and that is what it gets back.
    pub(crate) fn resize(
        &self,
        terminal: &TerminalManager,
        request: &TerminalResize,
    ) -> Result<PlatformBound, ProtocolError> {
        let session_id = self.session_for(&request.stream_id)?;
        let (cols, rows) = terminal.session_size(&session_id).unwrap_or((80, 24));
        Ok(PlatformBound::TerminalAttachAccepted(
            TerminalAttachAccepted {
                stream_id: request.stream_id.clone(),
                session_id,
                cols,
                rows,
            },
        ))
    }

    /// Stop mirroring. The PTY keeps running; only the mirror ends.
    pub(crate) fn detach(&self, request: &TerminalDetach) -> Result<PlatformBound, ProtocolError> {
        self.close(&request.stream_id);
        Ok(PlatformBound::TerminalClosed(TerminalClosed {
            stream_id: request.stream_id.clone(),
            reason: TerminalCloseReason::Detached,
        }))
    }

    /// Drop every mirror. Called when the socket goes, so a revoked device
    /// cannot leave a pump writing into a channel nobody reads.
    pub(crate) fn close_all(&self) {
        self.open.lock().unwrap().clear();
    }

    fn close(&self, stream_id: &str) {
        self.open.lock().unwrap().remove(stream_id);
    }

    fn session_for(&self, stream_id: &str) -> Result<String, ProtocolError> {
        self.open
            .lock()
            .unwrap()
            .get(stream_id)
            .map(|mirror| mirror.session_id.clone())
            .ok_or_else(|| {
                ProtocolError::new(
                    ErrorCode::CapabilityUnavailable,
                    "That terminal is not mirrored.",
                )
                .with_detail(stream_id.to_string())
            })
    }
}

/// Turn one local session into what a phone may know about it.
///
/// The single place that reshaping happens, so a spawn cannot answer with
/// fields the listing would have dropped.
pub(crate) fn describe(
    session: nomoreide_core::terminal::TerminalSession,
) -> RemoteTerminalSession {
    RemoteTerminalSession {
        id: session.id,
        label: session.label,
        provider: session.provider,
        // The final component only. A phone needs to tell one agent from
        // another; it does not need a map of somebody's disk.
        workspace: std::path::Path::new(&session.cwd)
            .file_name()
            .map(|name| name.to_string_lossy().into_owned()),
        running: session.exit.is_none(),
    }
}

/// What a spawn answers with, given the session the router just created.
pub(crate) fn spawned(session: nomoreide_core::terminal::TerminalSession) -> PlatformBound {
    PlatformBound::TerminalSpawned(TerminalSpawned {
        session: describe(session),
    })
}

/// Reject a prompt a phone should never have sent.
pub(crate) fn check_prompt(request: &TerminalSpawnRequest) -> Result<(), ProtocolError> {
    if request.prompt.trim().is_empty() {
        return Err(ProtocolError::new(
            ErrorCode::MalformedFrame,
            "An agent needs something to work on.",
        ));
    }
    if request.prompt.len() > limits::MAX_AGENT_PROMPT_BYTES {
        return Err(ProtocolError::new(
            ErrorCode::MalformedFrame,
            "That prompt is larger than one frame may carry.",
        ));
    }
    Ok(())
}

/// Everything a phone may know about the terminals on this machine.
pub(crate) fn sessions(terminal: &TerminalManager) -> PlatformBound {
    PlatformBound::TerminalSessions(TerminalSessionsResponse {
        sessions: terminal
            .mirrorable_sessions()
            .into_iter()
            .map(describe)
            .collect(),
    })
}

/// Carry one terminal's output to the phone until something stops it.
///
/// Coalescing is the whole job. A TUI repaints far faster than anyone reads,
/// and a frame per `read()` would spend a phone's battery drawing frames it
/// never displays — so bytes are gathered for
/// [`limits::TERMINAL_COALESCE_INTERVAL`] and sent as one.
async fn pump(
    stream_id: String,
    replay: Vec<u8>,
    mut updates: tokio::sync::broadcast::Receiver<Arc<[u8]>>,
    mut cancelled: tokio::sync::oneshot::Receiver<()>,
    events: EventSender,
    mirrors: Mirrors,
) {
    let mut seq = 0u64;
    let mut pending: Vec<u8> = replay;

    let reason = loop {
        // Send whatever has gathered, in chunks the protocol will accept.
        while !pending.is_empty() {
            let take = pending.len().min(limits::MAX_TERMINAL_CHUNK_BYTES);
            let chunk: Vec<u8> = pending.drain(..take).collect();
            let frame = PlatformBound::TerminalOutput(TerminalOutput {
                stream_id: stream_id.clone(),
                seq,
                data: TerminalBytes::new(chunk),
            });
            seq += 1;
            if events.send(frame).await.is_err() {
                break;
            }
        }

        tokio::select! {
            _ = &mut cancelled => break TerminalCloseReason::Detached,
            received = updates.recv() => match received {
                Ok(data) => {
                    pending.extend_from_slice(&data);
                    // Gather for a moment before waking the socket again.
                    tokio::time::sleep(limits::TERMINAL_COALESCE_INTERVAL).await;
                    while let Ok(more) = updates.try_recv() {
                        pending.extend_from_slice(&more);
                    }
                }
                // The session ended: its gate, and the sender inside it, are
                // gone with it.
                Err(RecvError::Closed) => break TerminalCloseReason::Exited,
                // The phone could not keep up. Bytes are missing, and a screen
                // with a hole in it is worse than one that redraws.
                Err(RecvError::Lagged(_)) => break TerminalCloseReason::Overrun,
            },
        }
    };

    mirrors.close(&stream_id);
    let _ = events
        .send(PlatformBound::TerminalClosed(TerminalClosed {
            stream_id,
            reason,
        }))
        .await;
}
