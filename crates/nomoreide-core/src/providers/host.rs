//! The vendor-neutral shapes every *host* provider reports in.
//!
//! The Rust half of `src/core/providers/host-provider.ts`. A host provider owns
//! machines rather than deployments, which is why this is its own contract
//! instead of a widening of `deploy.rs`: a deploy provider's every read is
//! scoped to a project, and a host provider's is scoped to nothing but the
//! account.
//!
//! Fields are omitted rather than reported as `null` wherever the vendor's own
//! answer was empty — the dashboard renders what is present, and a machine with
//! no address is not a machine whose address is the empty string.

use serde::Serialize;

/// The five states a machine is reported in, whatever the vendor calls them.
///
/// `Unknown` is deliberate rather than a fallback to something plausible: a
/// vendor value nobody has mapped is worth showing as unmapped, because the
/// alternative is a dashboard that confidently says "running" about a machine
/// nobody has classified.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum HostInstanceState {
    Running,
    Stopped,
    Provisioning,
    Error,
    Unknown,
}

impl HostInstanceState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Stopped => "stopped",
            Self::Provisioning => "provisioning",
            Self::Error => "error",
            Self::Unknown => "unknown",
        }
    }
}

/// A machine's hardware, as the dashboard shows it.
///
/// Every field optional, and a zero is an absence rather than a size: a vendor
/// reports zeroes for a machine it has not finished building, and a row
/// claiming 0 GB of disk reads as a fact rather than as "not yet known".
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInstanceSpecs {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vcpus: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_mb: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disk_gb: Option<u64>,
}

/// One machine.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInstance {
    pub id: String,
    pub label: String,
    pub state: HostInstanceState,
    /// The vendor's own word for the state, kept so the UI can show what the
    /// vendor said when the mapping lands on `Unknown`.
    pub raw_state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ipv4: Option<String>,
    /// A v6-only machine is reachable, and one whose v4 has not been assigned
    /// yet is reachable *only* here — so this is not decoration.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ipv6: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hostname: Option<String>,
    /// The three below are absent rather than empty on a machine the vendor
    /// has not finished placing.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub os: Option<String>,
    pub specs: HostInstanceSpecs,
    pub tags: Vec<String>,
    /// Epoch milliseconds. The vendor sends an ISO string; every other
    /// timestamp the dashboard handles is epoch ms, so this is converted once
    /// here rather than in each caller.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<i64>,
    /// The account a terminal should open as. Not a constant: Vultr's `limited`
    /// user scheme provisions a sudo-capable `linuxuser` instead of enabling
    /// root, and a target that says `root` cannot log in to one of those.
    pub default_user: String,
}
