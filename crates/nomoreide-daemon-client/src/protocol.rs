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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pgid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signal: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServiceMutationEnvelope {
    pub ok: bool,
    pub status: ServiceRuntimeStatus,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DaemonErrorCode {
    ServiceNotFound,
    UnsupportedServiceKind,
    PortInUse,
    DaemonDraining,
    DaemonCleanupFailed,
    ConfigLoadFailed,
    ServiceStartFailed,
    CleanupFailed,
    BundleNotFound,
    DependencyCycle,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PortHolderIdentity {
    pub pid: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pgid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uid: Option<u32>,
    pub command: String,
    pub start_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PortConflict {
    pub service: String,
    pub port: u16,
    pub holder: Option<PortHolderIdentity>,
}

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
    pub services: Vec<ServiceRuntimeStatus>,
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
    pub code: DaemonErrorCode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conflict: Option<PortConflict>,
}
