use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServiceDiscovery {
    pub services: Vec<ServiceDefinition>,
    pub bundles: Vec<BundleDefinition>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum ServiceDefinition {
    Local(LocalServiceDefinition),
    DockerCompose(DockerComposeServiceDefinition),
    Ssh(SshServiceDefinition),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalServiceDefinition {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub test: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub depends_on: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    pub command: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    pub cwd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env_keys: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DockerComposeServiceDefinition {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub test: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub depends_on: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_path: Option<String>,
    pub kind: String,
    pub cwd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compose_file: Option<String>,
    pub compose_service: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SshServiceDefinition {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub test: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub depends_on: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_path: Option<String>,
    pub kind: String,
    pub host: String,
    pub cwd: String,
    pub command: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env_keys: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BundleDefinition {
    pub name: String,
    pub services: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServiceDiscoveryEnvelope {
    pub ok: bool,
    pub services: Vec<ServiceDefinition>,
    pub bundles: Vec<BundleDefinition>,
}

impl From<ServiceDiscoveryEnvelope> for ServiceDiscovery {
    fn from(value: ServiceDiscoveryEnvelope) -> Self {
        Self {
            services: value.services,
            bundles: value.bundles,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ErrorEnvelope {
    pub ok: bool,
    pub error: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ServiceRuntimeState {
    Stopped,
    Starting,
    Running,
    Stopping,
    Exited,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServiceRuntimeStatus {
    pub name: String,
    pub state: ServiceRuntimeState,
    /// What the service was launched as. Absent only for a service the daemon
    /// has never run — nothing was launched, so nothing has a kind.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// The host a remote service runs on. Only an `ssh` service has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    /// The container behind a compose service, which is what identifies it in
    /// place of a pid.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub container_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    // No `pgid`. The daemon knows the process group — it is what a stop
    // signals — but the reference's status has no such field, and nothing
    // reads one back off the wire.
    /// Once a run has ended the reference reports **both** halves of how it
    /// ended, with whichever one does not apply written as an explicit
    /// `null` — a process killed by a signal has no exit code, and a process
    /// that returned one was killed by no signal. Hence the nesting: the outer
    /// `None` skips the key entirely, `Some(None)` writes `null`.
    ///
    /// Flattening this to `Option<i32>` is not a cosmetic loss. It makes
    /// `nomoreide stop <service> | jq .exitCode` answer nothing instead of
    /// `null`, and it makes "the service is still running" indistinguishable
    /// from "the service was killed by a signal".
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_or_null"
    )]
    pub exit_code: Option<Option<i32>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// ISO-8601 UTC, to the millisecond, for the launch this status describes.
    /// Absent for a service the daemon has never run. It outlives the process
    /// so a reader can tell this run's output from an earlier run's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    /// ISO-8601 UTC for when this launch ended. Present exactly when the
    /// launch has ended, which is what tells a reader that `exitCode` and
    /// `signal` being empty means "killed the other way" rather than "still
    /// running".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exited_at: Option<String>,
    /// The name of the signal that killed the process, never its number.
    /// Nested for the same reason as [`ServiceRuntimeStatus::exit_code`], and
    /// written at the same moment: the pair travels together or not at all.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_or_null"
    )]
    pub signal: Option<Option<String>>,
    /// The HTTP inspector in front of this service, when one was asked for.
    ///
    /// Absent rather than disabled when it is off: the reference reports
    /// `undefined`, and the dashboard tests the key's presence.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inspector: Option<InspectorRuntimeStatus>,
}

/// Where a service's inspector is listening, and what it is listening to.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InspectorRuntimeStatus {
    pub enabled: bool,
    /// Absent until the proxy is up. An inspector enabled on a service that
    /// has not announced a URL yet has nothing to proxy to, and starts when it
    /// does.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upstream_port: Option<u16>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServiceMutationEnvelope {
    pub ok: bool,
    pub status: ServiceRuntimeStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
/// The three fields the reference puts on the wire, and no more.
///
/// The core's own `PortHolder` also carries a uid and a start token, which are
/// what an owner check compares before anything is signalled. Neither belongs
/// in a response: they are inputs to a decision the daemon makes, and the
/// reference has no equivalent for either.
pub struct PortHolderIdentity {
    pub pid: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pgid: Option<u32>,
    pub command: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PortConflict {
    /// Always `PORT_IN_USE`. The reference puts its error class's own code
    /// here, inside the conflict rather than beside it, and the dashboard
    /// branches on it — so it is part of the shape, not a redundant label.
    pub code: String,
    pub port: u16,
    pub holder: Option<PortHolderIdentity>,
}

/// The one code the wire carries, and only ever inside a [`PortConflict`].
pub const PORT_IN_USE: &str = "PORT_IN_USE";

/// One buffered line of a service's output.
///
/// The reference carries exactly these four fields; the severity its log store
/// derives feeds timeline events rather than this shape, so it stays a core
/// concern and does not reach the wire.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServiceLogEntry {
    pub service: String,
    pub stream: String,
    pub text: String,
    pub timestamp: String,
}

/// One deduped incident as it travels over the wire.
///
/// A twin of the core type rather than a re-export: this crate deliberately
/// does not depend on `nomoreide-core`, so the daemon converts on the way out
/// and clients read this without pulling the runtime in behind it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Incident {
    pub id: u64,
    pub service: String,
    pub level: String,
    pub signature: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    pub first_seen: String,
    pub last_seen: String,
    pub count: u64,
    pub log_excerpt: Vec<String>,
}

/// The incidents the inbox is holding, most recently active first.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IncidentsEnvelope {
    pub ok: bool,
    pub incidents: Vec<Incident>,
}

/// One incident, the file it was traced to, and the prompt built from both.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IncidentPromptEnvelope {
    pub ok: bool,
    pub incident: Incident,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    pub prompt: String,
}

/// The daemon's acknowledgement that it will stop. It says nothing about
/// whether the services are down yet — that takes as long as they take.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ShutdownEnvelope {
    pub ok: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LogsEnvelope {
    pub ok: bool,
    pub logs: Vec<ServiceLogEntry>,
}

/// The taxonomy the reference fixes for timeline events. Mirrored rather than
/// relayed as a string so a kind that does not exist cannot reach a client.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum TimelineEventKind {
    #[serde(rename = "service.lifecycle")]
    ServiceLifecycle,
    #[serde(rename = "service.log")]
    ServiceLog,
    #[serde(rename = "service.health")]
    ServiceHealth,
    #[serde(rename = "service.port")]
    ServicePort,
    #[serde(rename = "service.http")]
    ServiceHttp,
    #[serde(rename = "mcp.tool")]
    McpTool,
    #[serde(rename = "git.change")]
    GitChange,
    #[serde(rename = "user.action")]
    UserAction,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TimelineSeverity {
    Info,
    Warning,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TimelineEvent {
    pub id: String,
    pub timestamp: String,
    pub kind: TimelineEventKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service: Option<String>,
    pub severity: TimelineSeverity,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TimelineEnvelope {
    pub ok: bool,
    pub timeline: Vec<TimelineEvent>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StatusEnvelope {
    pub ok: bool,
    pub status: ServiceStatusSnapshot,
}

/// The status body, which is a **map keyed by service name** rather than a
/// list.
///
/// A `BTreeMap` rather than an insertion-ordered map, so two consecutive reads
/// of the same runtime compare equal — the reference's is in whatever order the
/// process manager happened to record the services. That is the documented
/// difference; a parsed object compares the same either way.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServiceStatusSnapshot {
    pub services: std::collections::BTreeMap<String, ServiceRuntimeStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BundleMutationEnvelope {
    pub ok: bool,
    pub statuses: Vec<ServiceRuntimeStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MutationErrorEnvelope {
    pub ok: bool,
    pub error: String,
    /// Present only for a port conflict, which is the single failure the
    /// reference's routes catch and describe rather than rethrow. Everything
    /// else is prose and a 500, so there is no machine-readable code to carry.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conflict: Option<PortConflict>,
}

// ---------------------------------------------------------------------------
// Terminal sessions
// ---------------------------------------------------------------------------

/// A terminal session as the daemon reports it.
///
/// The field order here is load-bearing. A tool renders this straight to JSON
/// for an agent to read, and the reference emits an id, then the session's own
/// snapshot — whose keys are alphabetical — and appends the presentation last.
/// Reordering the struct reorders the payload.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionInfo {
    pub id: String,
    pub cols: u16,
    pub cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit: Option<TerminalExitInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    pub rows: u16,
    pub shell: String,
    pub state: String,
    pub presentation: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalExitInfo {
    pub exit_code: u32,
    pub signal: u32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TerminalSessionsEnvelope {
    pub ok: bool,
    #[serde(default)]
    pub sessions: Vec<TerminalSessionInfo>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TerminalSessionEnvelope {
    pub ok: bool,
    pub session: TerminalSessionInfo,
}

/// Read a field that is meaningfully absent, meaningfully `null`, or set.
///
/// `serde` collapses the first two by default — a JSON `null` deserializes
/// into `Option<Option<T>>` as the outer `None`, the same as a missing key.
/// Pairing this with `#[serde(default)]` restores the distinction: `default`
/// supplies the outer `None` when the key is absent, and this is only reached
/// when the key is present, so a `null` becomes `Some(None)`.
fn present_or_null<'de, T, D>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}
