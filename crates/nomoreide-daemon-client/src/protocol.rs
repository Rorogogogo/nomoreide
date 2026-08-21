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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pgid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MutationErrorEnvelope {
    pub ok: bool,
    pub error: String,
    pub code: DaemonErrorCode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conflict: Option<PortConflict>,
}
