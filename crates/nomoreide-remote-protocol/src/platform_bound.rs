//! Everything a daemon may send to the platform — the frozen v1 event union.
//!
//! The mirror of [`super::device_bound`], and refused just as exhaustively. The
//! asymmetry worth noticing is which direction each end distrusts: the daemon
//! refuses unknown commands because a hostile relay could otherwise reach the
//! machine, and the platform refuses unknown events because a hostile *daemon*
//! is a real device in someone's account, and the relay fans its frames out to
//! a browser.
//!
//! Nothing here carries prompts, tool input beyond the approval card, log
//! bodies past their bounds, terminal data, environment, or local credentials
//! — and none of it is persisted by the platform. The database learns that a
//! command happened, not what was in it.

use super::errors::ProtocolError;
use super::snapshot::{DeviceSnapshot, LogLine, RemoteAgentProvider, RemoteBundle, RemoteService};
use super::version::CapabilitySet;
use serde::{Deserialize, Serialize};

/// One frame travelling daemon → platform.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload")]
pub enum PlatformBound {
    /// The first frame on every socket. Until this arrives the connection has a
    /// credential but no identity, and routes nothing.
    #[serde(rename = "session.hello")]
    SessionHello(SessionHello),
    /// Liveness, every [`super::limits::HEARTBEAT_INTERVAL`]. Missing them for
    /// [`super::limits::PRESENCE_TIMEOUT`] marks the device offline, which
    /// suspends routing rather than queueing.
    #[serde(rename = "session.heartbeat")]
    SessionHeartbeat(super::device_bound::Empty),

    #[serde(rename = "device.snapshot.response")]
    DeviceSnapshot(DeviceSnapshotResponse),
    #[serde(rename = "service.list.response")]
    ServiceList(ServiceListResponse),
    #[serde(rename = "service.action.response")]
    ServiceAction(ServiceActionResponse),
    #[serde(rename = "service.logs.response")]
    ServiceLogs(ServiceLogsResponse),
    #[serde(rename = "bundle.list.response")]
    BundleList(BundleListResponse),

    #[serde(rename = "agent.providers.response")]
    AgentProviders(AgentProvidersResponse),
    /// The turn was accepted and has an id. Sent before any run event, so a
    /// phone always knows the run it is about to watch.
    #[serde(rename = "agent.turn.accepted")]
    AgentTurnAccepted(AgentTurnAccepted),
    /// One sequenced event from a run.
    #[serde(rename = "agent.turn.event")]
    AgentTurnEvent(super::agent_event::AgentEvent),

    /// The agent terminals that could be mirrored. **v2.**
    #[serde(rename = "terminal.sessions.response")]
    TerminalSessions(TerminalSessionsResponse),
    /// The mirror is open, and this is its id. **v2.**
    #[serde(rename = "terminal.attach.accepted")]
    TerminalAttachAccepted(TerminalAttachAccepted),
    /// A coalesced chunk of what the terminal drew. **v2.**
    #[serde(rename = "terminal.output")]
    TerminalOutput(TerminalOutput),
    /// The mirror ended. **v2.**
    #[serde(rename = "terminal.closed")]
    TerminalClosed(TerminalClosed),

    /// A refusal. Always carries `replyTo`, because an error with nothing to
    /// answer is a log line, not a frame.
    #[serde(rename = "command.error")]
    CommandError(CommandErrorResponse),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalSessionsResponse {
    pub sessions: Vec<super::snapshot::RemoteTerminalSession>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalAttachAccepted {
    /// Minted by the daemon. Every later frame for this mirror names it, so a
    /// stale frame from a mirror that has already closed cannot be applied to
    /// the one that replaced it.
    pub stream_id: String,
    pub session_id: String,
    /// What the daemon actually set, which may be smaller than what was asked
    /// for — the request is clamped, not rejected.
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalOutput {
    pub stream_id: String,
    /// Monotonic within a stream, from zero. A reader that sees a gap has lost
    /// bytes to backpressure and must repaint rather than render a hole it
    /// cannot see — the same contract the run-event stream uses.
    pub seq: u64,
    pub data: super::terminal_bytes::TerminalBytes,
}

/// Why a mirror ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TerminalCloseReason {
    /// The phone asked to stop mirroring.
    Detached,
    /// The child exited. The tab is over, not just the mirror.
    Exited,
    /// The session was closed on the machine.
    SessionClosed,
    /// The reader could not keep up and the mirror was dropped to protect the
    /// device socket. Reattaching is the remedy, and it replays.
    Overrun,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalClosed {
    pub stream_id: String,
    pub reason: TerminalCloseReason,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionHello {
    /// Every major protocol version this daemon can serve.
    pub supported_versions: Vec<u32>,
    pub daemon_version: String,
    /// Coarse: `macos`, `linux`, `windows`.
    pub platform: String,
    pub capabilities: CapabilitySet,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceSnapshotResponse {
    pub device: DeviceSnapshot,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServiceListResponse {
    pub services: Vec<RemoteService>,
}

/// The state after the action, not a claim that it succeeded.
///
/// A `start` that answers `errored` is a complete, honest answer; the phone
/// shows the state and the user decides. Failures that stopped the action from
/// happening at all come back as [`PlatformBound::CommandError`] instead.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServiceActionResponse {
    pub service: String,
    pub action: super::device_bound::ServiceAction,
    pub state: super::snapshot::ServiceState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServiceLogsResponse {
    pub service: String,
    pub lines: Vec<LogLine>,
    /// Set when older lines were dropped to fit the bounds, so the phone can
    /// say "showing the last 200" rather than implying this is everything.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BundleListResponse {
    pub bundles: Vec<RemoteBundle>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentProvidersResponse {
    pub providers: Vec<RemoteAgentProvider>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTurnAccepted {
    pub run_id: String,
    /// The sequence the next event will carry. `0` for a new run; for a resumed
    /// one, where the daemon is picking up.
    pub next_seq: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandErrorResponse {
    pub error: ProtocolError,
}

impl PlatformBound {
    /// Every accepted `type`, in the order the union declares them.
    pub const KINDS: &'static [&'static str] = &[
        "session.hello",
        "session.heartbeat",
        "device.snapshot.response",
        "service.list.response",
        "service.action.response",
        "service.logs.response",
        "bundle.list.response",
        "agent.providers.response",
        "agent.turn.accepted",
        "agent.turn.event",
        "terminal.sessions.response",
        "terminal.attach.accepted",
        "terminal.output",
        "terminal.closed",
        "command.error",
    ];

    pub fn kind(&self) -> &'static str {
        match self {
            Self::SessionHello(_) => "session.hello",
            Self::SessionHeartbeat(_) => "session.heartbeat",
            Self::DeviceSnapshot(_) => "device.snapshot.response",
            Self::ServiceList(_) => "service.list.response",
            Self::ServiceAction(_) => "service.action.response",
            Self::ServiceLogs(_) => "service.logs.response",
            Self::BundleList(_) => "bundle.list.response",
            Self::AgentProviders(_) => "agent.providers.response",
            Self::AgentTurnAccepted(_) => "agent.turn.accepted",
            Self::AgentTurnEvent(_) => "agent.turn.event",
            Self::TerminalSessions(_) => "terminal.sessions.response",
            Self::TerminalAttachAccepted(_) => "terminal.attach.accepted",
            Self::TerminalOutput(_) => "terminal.output",
            Self::TerminalClosed(_) => "terminal.closed",
            Self::CommandError(_) => "command.error",
        }
    }

    /// Whether this frame must name the request it answers.
    ///
    /// Unsolicited frames — hello, heartbeat, run events — must **not** carry
    /// `replyTo`, and answers must. Enforced rather than assumed, because a
    /// response that arrives with no correlation is one the relay would have to
    /// guess a destination for, and guessing means fanning a private answer to
    /// the wrong browser.
    pub fn requires_reply_to(&self) -> bool {
        match self {
            Self::SessionHello(_)
            | Self::SessionHeartbeat(_)
            | Self::AgentTurnEvent(_)
            // A mirror is a stream, not an exchange: output and its closing
            // arrive on their own schedule, long after the attach they belong
            // to was answered.
            | Self::TerminalOutput(_)
            | Self::TerminalClosed(_) => false,
            Self::DeviceSnapshot(_)
            | Self::ServiceList(_)
            | Self::ServiceAction(_)
            | Self::ServiceLogs(_)
            | Self::BundleList(_)
            | Self::AgentProviders(_)
            | Self::AgentTurnAccepted(_)
            | Self::TerminalSessions(_)
            | Self::TerminalAttachAccepted(_)
            | Self::CommandError(_) => true,
        }
    }

    /// Parse one frame's `type` and `payload`. Same two-failure split as
    /// [`super::device_bound::DeviceBound::parse`].
    pub fn parse(kind: &str, payload: serde_json::Value) -> Result<Self, ProtocolError> {
        use super::errors::ErrorCode;
        if !Self::KINDS.contains(&kind) {
            return Err(
                ProtocolError::new(ErrorCode::UnknownCommand, "Unknown remote event.")
                    .with_detail(kind),
            );
        }
        let tagged = serde_json::json!({ "type": kind, "payload": payload });
        serde_json::from_value(tagged).map_err(|error| {
            ProtocolError::new(ErrorCode::MalformedFrame, "Event payload is not valid.")
                .with_detail(error.to_string())
        })
    }

    /// The `payload` half of the envelope.
    pub fn payload(&self) -> serde_json::Value {
        let tagged = serde_json::to_value(self).expect("an event always serialises");
        tagged
            .get("payload")
            .cloned()
            .unwrap_or(serde_json::Value::Null)
    }
}
