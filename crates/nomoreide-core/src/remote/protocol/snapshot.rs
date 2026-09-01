//! The sanitized shapes a daemon is allowed to describe itself with.
//!
//! Read this for what is **not** here. A service on this wire has a name, a
//! description, a kind, a port and a state — and no command, no arguments, no
//! working directory, no environment, no process id, no log path and no URL.
//! Those are the fields a remote attacker would want most, and the cheapest way
//! to guarantee they never leave the machine is for the type that crosses the
//! boundary to have nowhere to put them.
//!
//! Every struct is `deny_unknown_fields` in both directions. That is not only
//! about hostile input: it means a local shape growing a field cannot silently
//! start publishing it, because the wire struct is written out by hand and a
//! new field has to be added here on purpose.

use super::version::CapabilitySet;
use serde::{Deserialize, Serialize};

/// What the phone shows at the top of a device page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceSnapshot {
    pub device_id: String,
    /// The name the user gave the machine when pairing. Not the hostname —
    /// a hostname is often an employer, a location or a person's full name.
    pub name: String,
    /// `macos`, `linux`, `windows`. Coarse on purpose: an exact kernel build is
    /// a fingerprint and helps nobody hold a phone.
    pub platform: String,
    pub daemon_version: String,
    pub protocol_version: u32,
    pub capabilities: CapabilitySet,
}

/// A registered service's runtime state, flattened to the few words a phone can
/// act on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ServiceState {
    Stopped,
    Starting,
    Running,
    Stopping,
    Errored,
    /// The daemon knows the service exists but cannot say what it is doing —
    /// a foreign process on its port, most often. Deliberately distinct from
    /// `Running`, because the remote surface must never imply it owns something
    /// it did not start.
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteService {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// The service kind as config records it — `node`, `docker`, and so on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    pub state: ServiceState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BundleState {
    Stopped,
    Partial,
    Running,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteBundle {
    pub name: String,
    pub state: BundleState,
    /// The services it names, so a phone can show what a bundle covers without
    /// a second round trip. Names only.
    pub services: Vec<String>,
}

/// One installed agent provider.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteAgentProvider {
    pub id: String,
    pub name: String,
    /// Whether the CLI behind it is actually installed and runnable.
    pub available: bool,
    /// Whether a *write-capable* turn may be started remotely.
    ///
    /// False for any provider whose native runtime adapter cannot give the same
    /// approval guarantees as the reference one. Such a provider may still be
    /// offered read-only, and the phone must label it that way rather than
    /// hiding it — a missing provider reads as a bug, a labelled one reads as a
    /// decision.
    pub remote_writes: bool,
}

/// One log line, already truncated and redacted by the daemon.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LogLine {
    /// RFC 3339, UTC.
    pub at: String,
    pub stream: LogStream,
    pub text: String,
    /// Set when the line was cut at [`super::limits::MAX_LOG_LINE_BYTES`], so
    /// the phone can say so rather than showing a sentence that stops.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogStream {
    Stdout,
    Stderr,
    /// The daemon's own commentary about the service — "started", "exited 1".
    System,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The point of the whole module. If any of these ever parses, a field that
    /// should never cross the boundary has been added to a wire struct.
    #[test]
    fn a_service_cannot_carry_the_fields_that_matter() {
        for smuggled in [
            r#"{"name":"api","state":"running","command":"npm run dev"}"#,
            r#"{"name":"api","state":"running","cwd":"/Users/someone/work"}"#,
            r#"{"name":"api","state":"running","env":{"TOKEN":"x"}}"#,
            r#"{"name":"api","state":"running","pid":4317}"#,
        ] {
            assert!(
                serde_json::from_str::<RemoteService>(smuggled).is_err(),
                "accepted {smuggled}"
            );
        }
    }

    /// A state this build has not heard of must read as `Unknown`, not as a
    /// parse failure — otherwise a newer daemon's new state breaks an older
    /// phone's whole service list.
    #[test]
    fn an_unfamiliar_state_degrades_to_unknown() {
        let service: RemoteService =
            serde_json::from_str(r#"{"name":"api","state":"quiescing"}"#).expect("parse");
        assert_eq!(service.state, ServiceState::Unknown);
    }

    #[test]
    fn optional_fields_are_omitted_rather_than_null() {
        let service = RemoteService {
            name: "api".into(),
            description: None,
            kind: None,
            port: None,
            state: ServiceState::Stopped,
        };
        let json = serde_json::to_string(&service).expect("serialise");
        assert_eq!(json, r#"{"name":"api","state":"stopped"}"#);
    }

    #[test]
    fn a_clean_log_line_omits_the_truncation_flag() {
        let line = LogLine {
            at: "2026-09-01T00:00:00Z".into(),
            stream: LogStream::Stdout,
            text: "listening".into(),
            truncated: false,
        };
        let json = serde_json::to_string(&line).expect("serialise");
        assert!(!json.contains("truncated"), "{json}");
    }
}
