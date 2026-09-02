//! Everything the platform may send to a daemon — the frozen v1 command union.
//!
//! This union **is** the remote attack surface. A phone cannot ask the machine
//! for anything that is not a variant below, and no variant carries a command,
//! argument, working directory, environment, port, SSH host, process id or kill
//! strategy. Adding one is a protocol change, not a feature.
//!
//! What is deliberately absent, and must stay absent in v1: raw terminal input,
//! arbitrary shell, filesystem browsing or writes, git mutations, database
//! queries or unlock, service and config registration, environment and
//! credential reads, provider and deployment mutations, daemon shutdown,
//! port-holder killing, and generic HTTP forwarding. The exclusion list is not
//! commentary — [`DeviceBound::KINDS`] is exhaustive and the parser refuses
//! everything else by name.

use super::errors::{ErrorCode, ProtocolError};
use serde::{Deserialize, Serialize};

/// One frame travelling platform → daemon.
///
/// Adjacently tagged, so `type` and `payload` in the envelope are the enum's
/// own discriminant and content rather than a second hand-written mapping that
/// could drift from it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload")]
pub enum DeviceBound {
    /// The relay's answer to the daemon's hello: the negotiated version, and
    /// how much of the protocol this session may use.
    #[serde(rename = "session.welcome")]
    SessionWelcome(SessionWelcome),
    /// The device has been revoked. Advisory only — the socket closing is the
    /// revocation, and a daemon that ignores this must still be unable to act.
    #[serde(rename = "session.revoke")]
    SessionRevoke(SessionRevoke),

    /// Sanitized machine snapshot: name, platform, daemon version, presence.
    #[serde(rename = "device.snapshot.request")]
    DeviceSnapshot(Empty),
    /// Registered service names, descriptions, kinds, ports and runtime states.
    #[serde(rename = "service.list.request")]
    ServiceList(Empty),
    /// `start`, `stop` or `restart` on one exactly-named registered service.
    #[serde(rename = "service.action.request")]
    ServiceAction(ServiceActionRequest),
    /// Bounded, redacted recent logs for one exactly-named registered service.
    #[serde(rename = "service.logs.request")]
    ServiceLogs(ServiceLogsRequest),
    /// Registered bundle names and states. Read-only: there is no bundle
    /// mutation in the v1 allowlist.
    #[serde(rename = "bundle.list.request")]
    BundleList(Empty),

    /// Which agent providers are installed, and what they can do.
    #[serde(rename = "agent.providers.request")]
    AgentProviders(Empty),
    /// Start or resume one agent turn in the daemon's selected workspace.
    #[serde(rename = "agent.turn.start")]
    AgentTurnStart(AgentTurnStart),
    /// Cancel an active turn.
    #[serde(rename = "agent.turn.cancel")]
    AgentTurnCancel(AgentTurnCancel),
    /// Allow or deny one pending mutating tool request.
    #[serde(rename = "agent.approval.resolve")]
    AgentApprovalResolve(AgentApprovalResolve),

    /// Start a new agent terminal on the machine. **v2.**
    #[serde(rename = "terminal.spawn.request")]
    TerminalSpawn(TerminalSpawnRequest),
    /// Which agent terminals are running and could be mirrored. **v2.**
    #[serde(rename = "terminal.sessions.request")]
    TerminalSessions(Empty),
    /// Begin mirroring one agent terminal. **v2.**
    #[serde(rename = "terminal.attach.request")]
    TerminalAttach(TerminalAttachRequest),
    /// Keystrokes for a mirrored terminal. **v2.**
    #[serde(rename = "terminal.input")]
    TerminalInput(TerminalInput),
    /// The viewport changed size. **v2.**
    #[serde(rename = "terminal.resize")]
    TerminalResize(TerminalResize),
    /// Stop mirroring. The PTY keeps running; only the mirror ends. **v2.**
    #[serde(rename = "terminal.detach")]
    TerminalDetach(TerminalDetach),
}

/// A payload with no fields.
///
/// A unit variant would serialise as a missing `payload`, and "absent" is a
/// second shape for a reader to handle. An empty object is one shape, and
/// `deny_unknown_fields` still refuses anything smuggled into it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Empty {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionWelcome {
    /// The version both ends will speak for the rest of this session.
    pub version: u32,
    pub mode: super::version::SessionMode,
    pub device_id: String,
    /// The platform's own build, for the daemon's logs. Never parsed.
    pub server_version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionRevoke {
    /// Prose for the daemon's log and the local `nomoreide remote status`, so a
    /// user is told "revoked from your account" rather than "connection lost".
    pub reason: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ServiceAction {
    Start,
    Stop,
    Restart,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServiceActionRequest {
    /// An exact registered service name. Never a pattern, never a path.
    pub service: String,
    pub action: ServiceAction,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServiceLogsRequest {
    pub service: String,
    /// Clamped to [`super::limits::MAX_LOG_LINES`] by the daemon. Absent means
    /// the maximum — an omitted bound is the safest bound, not an unbounded
    /// one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTurnStart {
    /// Resume this run, or start a new one when absent. The daemon mints run
    /// ids; a caller-supplied one is only ever a reference to a run it was
    /// already told about.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    /// Which installed provider to use. Absent means the daemon's selection.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    /// Bounded by [`super::limits::MAX_AGENT_PROMPT_BYTES`].
    pub prompt: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTurnCancel {
    pub run_id: String,
}

/// A remote verdict on one tool call.
///
/// Its own type rather than a reuse of the local approval broker's, because
/// this one is frozen: the broker is free to grow a "always allow" the day the
/// local UI wants one, and that must never become reachable from a phone.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ApprovalVerdict {
    Allow,
    Deny,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentApprovalResolve {
    pub run_id: String,
    /// The approval's id, not the frame's. One turn can have several pending.
    pub approval_id: String,
    pub verdict: ApprovalVerdict,
}

/// Start an agent, in a terminal, on the machine.
///
/// **There is deliberately no working directory here.** The daemon runs the
/// agent in the workspace it already has selected, the same one the dashboard
/// would use. A caller-supplied path would be the filesystem reach that remote
/// control does not have, and no field for it is the way to not have it.
///
/// Nor is there an argv: `provider` picks between the agent CLIs this machine
/// knows, and everything else about the invocation is the daemon's.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalSpawnRequest {
    /// `claude` or `codex`. Absent means the machine's own selection.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    /// The first thing to say to it. Bounded by
    /// [`super::limits::MAX_AGENT_PROMPT_BYTES`], like any other prompt from a
    /// phone.
    pub prompt: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalAttachRequest {
    /// An exact session id the daemon already reported. The daemon refuses any
    /// session that is not an *agent* session, so this is never a way to reach
    /// a shell — see the dispatcher, which is where that is enforced.
    pub session_id: String,
    /// The viewport the phone will render into. Bounded by
    /// [`super::limits::MAX_TERMINAL_DIMENSION`] before it reaches an `ioctl`.
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalInput {
    pub stream_id: String,
    /// Bounded by [`super::limits::MAX_TERMINAL_INPUT_BYTES`].
    pub data: super::terminal_bytes::TerminalBytes,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalResize {
    pub stream_id: String,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalDetach {
    pub stream_id: String,
}

impl DeviceBound {
    /// Every accepted `type`, in the order the union declares them.
    ///
    /// This is the allowlist. A name absent from it is refused with
    /// [`ErrorCode::UnknownCommand`], whatever its payload looks like.
    pub const KINDS: &'static [&'static str] = &[
        "session.welcome",
        "session.revoke",
        "device.snapshot.request",
        "service.list.request",
        "service.action.request",
        "service.logs.request",
        "bundle.list.request",
        "agent.providers.request",
        "agent.turn.start",
        "agent.turn.cancel",
        "agent.approval.resolve",
        "terminal.spawn.request",
        "terminal.sessions.request",
        "terminal.attach.request",
        "terminal.input",
        "terminal.resize",
        "terminal.detach",
    ];

    pub fn kind(&self) -> &'static str {
        match self {
            Self::SessionWelcome(_) => "session.welcome",
            Self::SessionRevoke(_) => "session.revoke",
            Self::DeviceSnapshot(_) => "device.snapshot.request",
            Self::ServiceList(_) => "service.list.request",
            Self::ServiceAction(_) => "service.action.request",
            Self::ServiceLogs(_) => "service.logs.request",
            Self::BundleList(_) => "bundle.list.request",
            Self::AgentProviders(_) => "agent.providers.request",
            Self::AgentTurnStart(_) => "agent.turn.start",
            Self::AgentTurnCancel(_) => "agent.turn.cancel",
            Self::AgentApprovalResolve(_) => "agent.approval.resolve",
            Self::TerminalSpawn(_) => "terminal.spawn.request",
            Self::TerminalSessions(_) => "terminal.sessions.request",
            Self::TerminalAttach(_) => "terminal.attach.request",
            Self::TerminalInput(_) => "terminal.input",
            Self::TerminalResize(_) => "terminal.resize",
            Self::TerminalDetach(_) => "terminal.detach",
        }
    }

    /// Whether this frame can change the state of the user's machine.
    ///
    /// Drives two rules that must not be decided case by case at the call site:
    /// a mutation is never automatically retried, and no mutation routes in
    /// [`super::version::SessionMode::Degraded`].
    pub fn mutating(&self) -> bool {
        match self {
            Self::ServiceAction(_)
            | Self::AgentTurnStart(_)
            | Self::AgentTurnCancel(_)
            | Self::AgentApprovalResolve(_)
            // Typing is the most mutating thing there is, and a retried
            // keystroke is a second keystroke. Attaching, resizing and
            // detaching only move the mirror, so they are safe to repeat.
            | Self::TerminalInput(_)
            // A retried spawn is a second agent, running a second time.
            | Self::TerminalSpawn(_) => true,
            Self::SessionWelcome(_)
            | Self::SessionRevoke(_)
            | Self::DeviceSnapshot(_)
            | Self::ServiceList(_)
            | Self::ServiceLogs(_)
            | Self::BundleList(_)
            | Self::AgentProviders(_)
            | Self::TerminalSessions(_)
            | Self::TerminalAttach(_)
            | Self::TerminalResize(_)
            | Self::TerminalDetach(_) => false,
        }
    }

    /// The capability a daemon must advertise for this frame to be routable, or
    /// `None` for the control frames, which are part of every session.
    pub fn required_capability(&self) -> Option<&'static str> {
        use super::version::capabilities as capability;
        match self {
            Self::SessionWelcome(_) | Self::SessionRevoke(_) => None,
            Self::DeviceSnapshot(_) => Some(capability::DEVICE_SNAPSHOT),
            Self::ServiceList(_) => Some(capability::SERVICE_LIST),
            Self::ServiceAction(_) => Some(capability::SERVICE_ACTION),
            Self::ServiceLogs(_) => Some(capability::SERVICE_LOGS),
            Self::BundleList(_) => Some(capability::BUNDLE_LIST),
            Self::AgentProviders(_) => Some(capability::AGENT_PROVIDERS),
            Self::AgentTurnStart(_) | Self::AgentTurnCancel(_) => Some(capability::AGENT_TURNS),
            Self::AgentApprovalResolve(_) => Some(capability::AGENT_APPROVALS),
            Self::TerminalSpawn(_) => Some(capability::TERMINAL_SPAWN),
            Self::TerminalSessions(_) => Some(capability::TERMINAL_SESSIONS),
            Self::TerminalAttach(_)
            | Self::TerminalInput(_)
            | Self::TerminalResize(_)
            | Self::TerminalDetach(_) => Some(capability::TERMINAL_ATTACH),
        }
    }

    /// Parse one frame's `type` and `payload`.
    ///
    /// Two failures, kept apart on purpose: a name outside [`Self::KINDS`] is
    /// [`ErrorCode::UnknownCommand`], and a known name whose body does not fit
    /// is [`ErrorCode::MalformedFrame`]. A phone told "unknown command" should
    /// stop sending it; a phone told "malformed" has a bug to fix.
    pub fn parse(kind: &str, payload: serde_json::Value) -> Result<Self, ProtocolError> {
        if !Self::KINDS.contains(&kind) {
            return Err(
                ProtocolError::new(ErrorCode::UnknownCommand, "Unknown remote command.")
                    .with_detail(kind),
            );
        }
        let tagged = serde_json::json!({ "type": kind, "payload": payload });
        serde_json::from_value(tagged).map_err(|error| {
            ProtocolError::new(ErrorCode::MalformedFrame, "Command payload is not valid.")
                .with_detail(error.to_string())
        })
    }

    /// The `payload` half of the envelope.
    pub fn payload(&self) -> serde_json::Value {
        let tagged = serde_json::to_value(self).expect("a command always serialises");
        tagged
            .get("payload")
            .cloned()
            .unwrap_or(serde_json::Value::Null)
    }
}
