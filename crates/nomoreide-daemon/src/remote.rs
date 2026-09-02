//! Attaching this daemon to the relay, if the machine has been paired.
//!
//! The connector lives in `nomoreide-core`; what lives here is the decision to
//! start one, and what it does with a command when it arrives.
//!
//! **Only the machine-global daemon connects.** The desktop app runs its own
//! daemon in-process on a private port, and if both dialled in with the same
//! credential the relay would keep whichever connected last — so a phone would
//! be talking to whichever of the user's two daemons had most recently
//! restarted, which is nobody's idea of a machine. The one that owns the
//! runtime lock is the one that speaks for the machine.

use std::sync::Arc;

use nomoreide_core::remote::connector::{Answer, CommandSink, ConnectorConfig};
use nomoreide_core::remote::credentials::RemoteCredentials;
use nomoreide_core::remote::protocol::errors::{ErrorCode, ProtocolError};
use nomoreide_core::remote::protocol::platform_bound::{
    CommandErrorResponse, DeviceSnapshotResponse,
};
use nomoreide_core::remote::protocol::snapshot::DeviceSnapshot;
use nomoreide_core::remote::protocol::version::{capabilities, CapabilitySet, PROTOCOL_VERSION};
use nomoreide_core::remote::protocol::{DeviceBound, PlatformBound};

/// What this daemon can actually serve today.
///
/// Advertised rather than assumed, and deliberately narrower than the protocol
/// allows: a capability the relay believes in but the daemon cannot honour
/// becomes a button on a phone that does nothing. Service control and agent
/// runs join this list when the dispatcher lands.
fn served_capabilities() -> CapabilitySet {
    CapabilitySet::from_names([capabilities::DEVICE_SNAPSHOT])
}

/// Start the relay connection, if this machine is paired.
///
/// Returns `false` when there is nothing to do — not paired, which is the
/// normal state for most installs and not worth a log line on every start.
pub(crate) fn spawn_if_paired(state_dir: &std::path::Path) -> bool {
    let credentials = RemoteCredentials::new(state_dir);
    let Some(stored) = credentials.load() else {
        return false;
    };

    let mut config = ConnectorConfig::from_credential(&stored);
    config.capabilities = served_capabilities();
    let device_name = stored.device_name.clone();
    let sink: Arc<dyn CommandSink> = Arc::new(SnapshotSink {
        device_id: stored.device_id.clone(),
        device_name: stored.device_name,
        platform: config.platform.clone(),
        capabilities: config.capabilities.clone(),
    });

    eprintln!("nomoreide: remote control connecting as \"{device_name}\"");
    tokio::spawn(nomoreide_core::remote::connector::run_forever(config, sink));
    true
}

/// The command surface, as it stands: the machine describing itself.
///
/// Everything else answers [`ErrorCode::CapabilityUnavailable`], which is the
/// protocol's "your machine's NoMoreIDE does not support this yet" — a sentence
/// a phone can show, rather than a failure it has to interpret. That is the
/// same answer an older daemon gives a newer platform, so the phone needs no
/// special case for a daemon that is merely early.
struct SnapshotSink {
    device_id: String,
    device_name: String,
    platform: String,
    capabilities: CapabilitySet,
}

impl CommandSink for SnapshotSink {
    fn dispatch<'a>(&'a self, _request_id: &'a str, command: DeviceBound) -> Answer<'a> {
        Box::pin(async move {
            match command {
                DeviceBound::DeviceSnapshot(_) => {
                    PlatformBound::DeviceSnapshot(DeviceSnapshotResponse {
                        device: DeviceSnapshot {
                            device_id: self.device_id.clone(),
                            name: self.device_name.clone(),
                            platform: self.platform.clone(),
                            daemon_version: env!("CARGO_PKG_VERSION").to_string(),
                            protocol_version: PROTOCOL_VERSION,
                            capabilities: self.capabilities.clone(),
                        },
                    })
                }
                other => PlatformBound::CommandError(CommandErrorResponse {
                    error: ProtocolError::new(
                        ErrorCode::CapabilityUnavailable,
                        "This machine's NoMoreIDE does not support that yet.",
                    )
                    .with_detail(other.kind()),
                }),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sink() -> SnapshotSink {
        SnapshotSink {
            device_id: "11111111-2222-3333-4444-555555555555".into(),
            device_name: "Studio".into(),
            platform: "macos".into(),
            capabilities: served_capabilities(),
        }
    }

    #[tokio::test]
    async fn a_snapshot_describes_this_machine() {
        let answer = sink()
            .dispatch("req_1", DeviceBound::DeviceSnapshot(Default::default()))
            .await;

        let PlatformBound::DeviceSnapshot(response) = answer else {
            panic!("expected a snapshot, got {}", answer.kind());
        };
        assert_eq!(response.device.name, "Studio");
        assert_eq!(response.device.daemon_version, env!("CARGO_PKG_VERSION"));
        assert_eq!(response.device.protocol_version, PROTOCOL_VERSION);
    }

    /// Everything the dispatcher has not reached yet answers the same way an
    /// out-of-date daemon does, so the phone needs no special case for "early".
    #[tokio::test]
    async fn everything_else_is_reported_as_unavailable_rather_than_failing() {
        for command in nomoreide_core::remote::protocol::fixtures::every_command() {
            if matches!(command, DeviceBound::DeviceSnapshot(_)) {
                continue;
            }
            // Control frames never reach a sink; the connector handles them.
            if command.required_capability().is_none() {
                continue;
            }
            let kind = command.kind();
            let answer = sink().dispatch("req_1", command).await;
            let PlatformBound::CommandError(error) = answer else {
                panic!("{kind} was answered with {}", answer.kind());
            };
            assert_eq!(error.error.code, ErrorCode::CapabilityUnavailable, "{kind}");
        }
    }

    /// What is advertised has to be what is served, or a phone offers buttons
    /// that do nothing.
    #[tokio::test]
    async fn every_advertised_capability_is_one_this_sink_answers() {
        let advertised = served_capabilities();
        for command in nomoreide_core::remote::protocol::fixtures::every_command() {
            let Some(required) = command.required_capability() else {
                continue;
            };
            if !advertised.contains(required) {
                continue;
            }
            let kind = command.kind();
            let answer = sink().dispatch("req_1", command).await;
            assert!(
                !matches!(answer, PlatformBound::CommandError(_)),
                "{kind} is advertised but refused"
            );
        }
    }
}
