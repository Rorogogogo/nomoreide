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
use super::snapshot::{
    DeviceSnapshot, LogLine, RemoteAgentProvider, RemoteAgentUsage, RemoteBundle, RemoteIncident,
    RemotePullRequest, RemoteService, RemoteTimelineEntry, RemoteWorkflowJob, RemoteWorkflowRun,
};
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

    /// An agent terminal was started, and this is it. **v2.**
    #[serde(rename = "terminal.spawned")]
    TerminalSpawned(TerminalSpawned),
    /// The agent terminals that could be mirrored. **v2.**
    #[serde(rename = "terminal.sessions.response")]
    TerminalSessions(TerminalSessionsResponse),
    /// The mirror is open, and this is its id. **v2.**
    #[serde(rename = "terminal.attach.accepted")]
    TerminalAttachAccepted(TerminalAttachAccepted),
    /// A coalesced chunk of what the terminal drew. **v2.**
    #[serde(rename = "terminal.output")]
    TerminalOutput(TerminalOutput),
    /// The mirrored session was resized *on the machine*. **v2.**
    #[serde(rename = "terminal.geometry")]
    TerminalGeometry(TerminalGeometry),
    /// A terminal command was carried out and had nothing to report. **v2.**
    #[serde(rename = "terminal.ack")]
    TerminalAck(TerminalAck),
    /// The mirror ended. **v2.**
    #[serde(rename = "terminal.closed")]
    TerminalClosed(TerminalClosed),

    /// Recent GitHub Actions runs.
    #[serde(rename = "github.runs.response")]
    GithubRuns(GithubRunsResponse),
    /// One run's jobs.
    #[serde(rename = "github.run.jobs.response")]
    GithubRunJobs(GithubRunJobsResponse),
    /// Pull requests on the selected repository.
    #[serde(rename = "github.prs.response")]
    GithubPulls(GithubPullsResponse),
    /// One pull request.
    #[serde(rename = "github.pr.response")]
    GithubPull(GithubPullResponse),
    #[serde(rename = "linear.response")]
    /// Boxed: the variant is ~1500 bytes against ~270 for the next largest, so
    /// every `PlatformBound` on the socket would carry that width. `Box` is
    /// transparent to serde, so the wire format is unchanged.
    Linear(Box<super::linear::LinearResponse>),
    /// What the agents have spent.
    #[serde(rename = "agent.usage.response")]
    AgentUsage(AgentUsageResponse),
    /// The error inbox.
    #[serde(rename = "errors.response")]
    Errors(ErrorsResponse),
    /// The runtime timeline.
    #[serde(rename = "timeline.response")]
    Timeline(TimelineResponse),

    /// A refusal. Always carries `replyTo`, because an error with nothing to
    /// answer is a log line, not a frame.
    #[serde(rename = "command.error")]
    CommandError(CommandErrorResponse),
}

/// Every list answer here carries `truncated` for the same reason
/// [`ServiceLogsResponse`] does: a phone showing thirty runs must be able to say
/// "the most recent thirty" rather than implying the repository has thirty.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GithubRunsResponse {
    pub runs: Vec<RemoteWorkflowRun>,
    /// Echoed back, so an answer that arrives after the filter changed can be
    /// told apart from one for the branch now on screen.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GithubRunJobsResponse {
    pub run_id: String,
    pub jobs: Vec<RemoteWorkflowJob>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GithubPullsResponse {
    pub pulls: Vec<RemotePullRequest>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GithubPullResponse {
    pub pull: RemotePullRequest,
}

/// Both agents' readings, or as many of them as this machine has.
///
/// An empty answer is a real answer — "no agent has ever run here" — and is not
/// an error. The phone renders that as a state, not as a failure.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentUsageResponse {
    pub usage: RemoteAgentUsage,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ErrorsResponse {
    pub incidents: Vec<RemoteIncident>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimelineResponse {
    pub entries: Vec<RemoteTimelineEntry>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
}

/// The session a spawn produced, described exactly like any other.
///
/// The same sanitized shape the listing uses, so a phone can attach to it
/// without a second code path — and so a spawn cannot answer with fields the
/// listing would have dropped.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalSpawned {
    pub session: super::snapshot::RemoteTerminalSession,
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

/// The session changed size, and every byte after this frame is drawn for it.
///
/// **Why this has to be said rather than inferred.** A PTY has exactly one
/// geometry, and the mirror does not own it — the person at the desk does, by
/// resizing the dock the session is running in. A viewer told the size once at
/// attach keeps drawing into the old grid forever, and because a TUI positions
/// with absolute column escapes (`ESC[nG`), the result is not a slightly wrong
/// margin but text landing on top of other text. That is what a permission
/// prompt looks like when it goes wrong, and it is why this exists.
///
/// Sent *before* the repaint it explains, which costs nothing to arrange: the
/// notification fires when the `ioctl` returns, and the child's redraw cannot
/// begin until it has seen the `SIGWINCH` that follows. A viewer that resizes
/// on this frame is therefore already the right shape when the bytes arrive.
///
/// A platform too old to know this name skips it and stays connected — an
/// unknown event is refused, not fatal — so the phone simply keeps the
/// behaviour it had before this frame existed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalGeometry {
    pub stream_id: String,
    pub cols: u16,
    pub rows: u16,
}

/// Nothing to say beyond "done".
///
/// Its own frame because the alternative was answering a keystroke with
/// [`TerminalAttachAccepted`] carrying a geometry nobody set — an ack that has
/// to lie about a field is a worse economy than one more variant. A *resize*
/// still answers with `attach.accepted`, because reporting the geometry that
/// was actually applied is precisely what that frame is for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalAck {
    pub stream_id: String,
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
        "terminal.spawned",
        "terminal.sessions.response",
        "terminal.attach.accepted",
        "terminal.output",
        "terminal.geometry",
        "terminal.ack",
        "terminal.closed",
        "github.runs.response",
        "github.run.jobs.response",
        "github.prs.response",
        "github.pr.response",
        "linear.response",
        "agent.usage.response",
        "errors.response",
        "timeline.response",
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
            Self::TerminalSpawned(_) => "terminal.spawned",
            Self::TerminalSessions(_) => "terminal.sessions.response",
            Self::TerminalAttachAccepted(_) => "terminal.attach.accepted",
            Self::TerminalOutput(_) => "terminal.output",
            Self::TerminalGeometry(_) => "terminal.geometry",
            Self::TerminalAck(_) => "terminal.ack",
            Self::TerminalClosed(_) => "terminal.closed",
            Self::GithubRuns(_) => "github.runs.response",
            Self::GithubRunJobs(_) => "github.run.jobs.response",
            Self::GithubPulls(_) => "github.prs.response",
            Self::GithubPull(_) => "github.pr.response",
            Self::Linear(_) => "linear.response",
            Self::AgentUsage(_) => "agent.usage.response",
            Self::Errors(_) => "errors.response",
            Self::Timeline(_) => "timeline.response",
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
            // The machine resizing is news, not an answer: nobody on the phone
            // asked for it, and the request it would otherwise name was
            // answered when the mirror opened.
            | Self::TerminalGeometry(_)
            | Self::TerminalClosed(_) => false,
            Self::DeviceSnapshot(_)
            | Self::ServiceList(_)
            | Self::ServiceAction(_)
            | Self::ServiceLogs(_)
            | Self::BundleList(_)
            | Self::AgentProviders(_)
            | Self::AgentTurnAccepted(_)
            | Self::TerminalSpawned(_)
            | Self::TerminalSessions(_)
            | Self::TerminalAttachAccepted(_)
            | Self::TerminalAck(_)
            | Self::Linear(_)
            | Self::GithubRuns(_)
            | Self::GithubRunJobs(_)
            | Self::GithubPulls(_)
            | Self::GithubPull(_)
            | Self::AgentUsage(_)
            | Self::Errors(_)
            | Self::Timeline(_)
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
